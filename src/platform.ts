/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.ts: homebridge-ratgdo platform class.
 */
import type { API, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import type { Clock, HomebridgePluginLogging, MdnsDiscovery, MdnsDiscoveryEvent, MqttClient, Nullable } from "homebridge-plugin-utils";
import { CoalescingTask, FeatureOptions, HbpuAbortError, createMqttClient, debugGatedLog, discoverServices, formatErrorMessage, mqttConnectionSettings,
  prefixedLog, sanitizeName, superviseLoop, systemClock } from "homebridge-plugin-utils";
import type { EspHomeClient, LifecycleEvent, LogEventData, TelemetryEvent } from "esphome-client";
import { PLATFORM_NAME, PLUGIN_NAME, RATGDO_MDNS_SERVICE_TYPE } from "./settings.ts";
import { applyDeviceInfo, isEncryptionError, openConnection } from "./connection.ts";
import { consolidatedFlag, featureOptionCategories, featureOptions, normalizeConfig } from "./options.ts";
import { isAdvertisedAt, parseRatgdoService } from "./discovery.ts";
import type { DiscoveredRatgdo } from "./discovery.ts";
import { LogLevel } from "esphome-client";
import { RatgdoAccessory } from "./device.ts";
import type { RatgdoDevice } from "./types.ts";
import type { RatgdoResolvedConfig } from "./options.ts";
import { parseBatteryState } from "./protocol/battery.ts";
import { ratgdoInitialStateEntityIds } from "./entities.ts";
import { translateTelemetry } from "./protocol/telemetry.ts";
import util from "node:util";

/* Per-device connection state. The ESPHome client owns its auto-reconnect supervisor and lazy heartbeat (defaults: 30s ping interval, 60s stall budget), so the platform
 * needs no per-device watchdog or reconnect controller. Liveness checking, transient-disconnect recovery, and subscription continuity across reconnects are all the
 * ESPHome client's responsibility.
 *
 * @property client - The ESPHome client, which owns the connection lifecycle. Held beside the stack because `getEspHomeClient` hands it to the device class for command
 *                    dispatch.
 * @property stack  - The connection's disposables: the client first, then every listener registered on it. A stack disposes in reverse, so the listeners come off before
 *                    the client's synchronous disconnect and that disconnect event reaches no handler.
 */
interface RatgdoConnection {

  client: EspHomeClient;
  stack: DisposableStack;
}

export class RatgdoPlatform implements DynamicPlatformPlugin {

  // Cached platform accessories keyed by HAP UUID. Map storage matches the rest of the platform's per-device stores (configuredDevices, connections) and gives O(1)
  // lookup at the reconcile pass's "have we seen this UUID before?" check.
  private readonly accessories: Map<string, PlatformAccessory>;
  public readonly api: API;
  /* The one time source every timer the plugin arms reads: each accessory's timer registry and the discovery stream's own deadlines. It is the production clock in the
   * field and a controllable one under a platform double, so a suite drives every deadline on a virtual timeline instead of serving it out in real seconds.
   */
  public readonly clock: Clock;
  public readonly config: RatgdoResolvedConfig;
  public readonly configuredDevices: Map<string, RatgdoAccessory>;
  private readonly connections: Map<string, RatgdoConnection>;
  private readonly discoveredDevices: Set<string>;
  public readonly featureOptions: FeatureOptions;
  public readonly hap: HAP;
  public readonly log: HomebridgePluginLogging;
  public readonly mqtt: Nullable<MqttClient>;
  // AbortController scoped to the platform's lifetime. Aborted on Homebridge shutdown so that every signal-aware resource we own (the MQTT client, any future
  // signal-driven primitive) tears itself down through one composed signal instead of per-resource imperative cleanup.
  private readonly shutdownController: AbortController;

  constructor(log: Logging, config: PlatformConfig | undefined, api: API) {

    this.accessories = new Map();
    this.api = api;
    this.clock = systemClock;

    const legacy = normalizeConfig(config);

    this.configuredDevices = new Map();
    this.connections = new Map();
    this.discoveredDevices = new Set();
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, legacy.options);

    /* Assemble the effective configuration. This is where a raw configuration property and a configured feature option meet for every setting the plugin resolves
     * for itself, so no reader downstream has to know that a setting has two possible homes. The broker URL and the topic prefix are resolved by the library at the
     * client's construction below, under the same precedence, so they never take a detour through this shape.
     */
    this.config = {

      debug: consolidatedFlag(this.featureOptions, "Log.Debug", legacy.debug),
      options: legacy.options
    };

    this.hap = api.hap;
    /* Wrap the logger Homebridge handed us in the library's config-gated composition. The plugin offers a debug setting of its own, read live on every call, and the
     * gated channel emits through warn because Homebridge prints its DEBUG lines only when Homebridge's own global debug switch is on...warn is the level that
     * actually reaches the user's log. Wrapping rather than overwriting a method on Homebridge's own instance leaves that object exactly as Homebridge owns it.
     */
    this.log = debugGatedLog(log, (): boolean => this.config.debug);
    this.mqtt = null;
    this.shutdownController = new AbortController();

    // We can't start without being configured.
    if(!config) {

      return;
    }

    /* Initialize MQTT, if needed. The resolver and the guarded factory each answer for a way MQTT can fail to start, and both land on the same degradation - MQTT
     * stays off and the rest of the plugin loads. The resolver answers null when no broker is configured anywhere or the user turned the option off; the factory
     * answers null for a URL the client cannot parse, reporting that one once at error level with the URL redacted so a broker password embedded in it never reaches
     * the log. The platform's shutdown signal ties the client's lifetime to ours, so we never have to imperatively disconnect it.
     */
    const settings = mqttConnectionSettings({ config: legacy, featureOptions: this.featureOptions });

    this.mqtt = settings && createMqttClient({ ...settings, log: this.log }, { signal: this.shutdownController.signal });

    this.log.debug("Debug logging on. Expect a lot of data.");

    // Fire up the Ratgdo API once Homebridge has loaded all the cached accessories it knows about and called configureAccessory() on each.
    api.on("didFinishLaunching", () => this.configureRatgdo());

    // Make sure we take ourselves offline when we shutdown. This is the single owner of platform shutdown - every cleanup (signal abort, ESPHome teardown, accessory
    // offline announcement) flows through here in one ordered pass, so future readers find the entire teardown sequence in one place.
    api.on("shutdown", () => {

      // Abort the platform signal first. This cancels every signal-aware resource (the MQTT client, the discovery stream, anything else composed onto our lifetime)
      // before the imperative teardown below runs, so nothing scheduled on a later event-loop tick can race against the synchronous cleanup. The discovery stream
      // ends on this abort and disposes itself inside its own supervised loop, which is why there is no browser teardown step here.
      this.shutdownController.abort(new HbpuAbortError("shutdown"));

      // Release each connection's stack. A stack disposes in reverse of the order things went onto it, so every listener comes off before the client's disconnect:
      // the disconnect event therefore re-enters no lifecycle handler and schedules no further state update during teardown. The ESPHome client's auto-reconnect
      // supervisor sees the manual disconnect as intentional and does not try to reconnect.
      for(const conn of this.connections.values()) {

        conn.stack.dispose();
      }

      this.connections.clear();

      // Inform our accessories we're going offline, then dispose them so any pending one-shot timers (motion timeout, occupancy timeout, UI revert, etc.) are cancelled
      // before they fire into a torn-down accessory and keep the Node event loop alive past shutdown.
      for(const device of this.configuredDevices.values()) {

        device.updateState({ id: "availability", state: "offline" });
        device[Symbol.dispose]();
      }
    });
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save all that logic for device
  // discovery.
  public configureAccessory(accessory: PlatformAccessory): void {

    this.accessories.set(accessory.UUID, accessory);
  }

  // Public accessor for an ESPHome client by device MAC. Wraps the internal connections map so the device class can dispatch commands without reaching into platform
  // internals.
  public getEspHomeClient(mac: string): EspHomeClient | undefined {

    return this.connections.get(mac)?.client;
  }

  /* Single source of truth for the `Device.LogName` feature option. Performs the featureOptions lookup AND normalizes the result so null, undefined, and the empty
   * string all collapse to `undefined`. Empty string is not a valid log name - treating it as "set" would surface bare `": message"` prefixes for users who clear the
   * field through the UI or write an empty value in JSON. Every consumer of the log-name decision (the discovery path composing device.name, RatgdoAccessory.buildHints
   * caching hints.logName) calls through here so the "what counts as set?" decision lives in one place.
   */
  public resolveLogName(mac: string): string | undefined {

    const raw = this.featureOptions.value("Device.LogName", mac);

    return raw?.length ? raw : undefined;
  }

  /* Configure and connect to Ratgdo ESPHome clients, for as long as this platform runs.
   *
   * Two lifetimes meet here. The loop's is the platform's: it listens until the shutdown signal aborts, and `superviseLoop` swallows that unwind silently because an
   * abort we caused is not a fault. `onError` is for the other case - a throw out of the loop body, which would be a defect in this platform rather than anything the
   * network did. A browser that loses its sockets is neither: it ends the stream in order, and `runDiscovery` reports that from the loop's own end.
   */
  private configureRatgdo(): void {

    void superviseLoop({ loop: (): Promise<void> => this.runDiscovery(),
      onError: (error: unknown): void => this.log.error("Device discovery failed and will not restart until Homebridge restarts: %s.", formatErrorMessage(error)),
      signal: this.shutdownController.signal });
  }

  /* Listen to the network for the whole of this platform's life, and reconcile what it says.
   *
   * The library owns the mechanism - the sockets, the record cache, and the RFC 6762 query cadence - and this plugin owns the policy: what a Ratgdo is
   * (`parseRatgdoService`), and what to do when one appears or moves (`reconcileDevice`). The stream and its task are locals of this method, alive for exactly the
   * stream's lifetime, so no field can hold a pass over a discovery that has already finished.
   */
  private async runDiscovery(): Promise<void> {

    await using discovery = discoverServices<DiscoveredRatgdo>({ classify: parseRatgdoService, clock: this.clock, log: this.log,
      serviceType: RATGDO_MDNS_SERVICE_TYPE, signal: this.shutdownController.signal });

    /* One reconciliation pass at a time, over the discovery's own snapshot. Every event asks for a pass, and a burst of events arriving during a pass buys exactly
     * one follow-up rather than one pass apiece, so an address change that lands while a device is mid-connect is applied after that connect settles instead of
     * racing it. The task's lifetime is the stream's own signal, which aborts on our shutdown and on the browser's own end alike, so a follow-up queued as the
     * stream ends is abandoned and no pass ever reads a finished stream.
     */
    const reconcile = new CoalescingTask({ label: "device discovery", log: this.log, run: (): Promise<void> => this.reconcileDevices(discovery),
      signal: discovery.signal });

    for await (const event of discovery) {

      this.observeDiscovery(event, reconcile);
    }

    /* The browser ends the stream rather than throwing when it loses its last network socket, so the loop's own end is the one place this platform can see that
     * fault. Connected devices keep their ESPHome clients and their own reconnect supervisors; what stops is the discovery of new devices and of moved ones.
     */
    if(!this.shutdownController.signal.aborted) {

      this.log.error("Device discovery stopped because the mDNS browser lost its network sockets, and it will not restart until Homebridge restarts: %s.",
        formatErrorMessage(discovery.signal.reason));
    }
  }

  /* Take in one thing the network said about a device.
   *
   * The event carries the device, but a pass reads the snapshot rather than the event, which is what lets a burst collapse into one pass and still act on each
   * device's latest advertisement. A lost advertisement is noted and nothing more: a device we hold a connection to is the ESPHome client's to report on, and a
   * device we do not is simply one we will hear from again.
   *
   * @param event     - The transition the discovery derived.
   * @param reconcile - The single-flight pass every transition asks for.
   */
  private observeDiscovery(event: MdnsDiscoveryEvent<DiscoveredRatgdo>, reconcile: CoalescingTask): void {

    switch(event.kind) {

      case "found":
      case "updated": {

        reconcile.schedule();

        return;
      }

      case "lost": {

        this.log.debug("%s: mDNS advertisement lost.", event.device.friendlyName ?? event.device.strippedMac);

        return;
      }

      default: {

        // Compile-time exhaustiveness: if a new MdnsDiscoveryEvent kind is added upstream, this statement fails to type-check and forces us to handle it explicitly.
        event satisfies never;

        return;
      }
    }
  }

  /* One reconciliation pass: every device the browser currently knows, reconciled against what this platform holds.
   *
   * Devices go in parallel because their connects are independent of each other and a slow handshake must not hold up a sibling. The task's single-flight contract
   * is what keeps two passes from ever touching one device at the same time, so no per-device sequencer is needed underneath this.
   *
   * @param discovery - The live discovery whose snapshot this pass reads.
   */
  private async reconcileDevices(discovery: MdnsDiscovery<DiscoveredRatgdo>): Promise<void> {

    await Promise.all([...discovery.devices.values()].map((discovered): Promise<void> => this.reconcileDevice(discovered)));
  }

  /* Reconcile one advertised device against what this platform holds. TOTAL by contract: the whole body sits in one try/catch so a single device's fault neither
   * rejects the pass nor stops a sibling's reconcile.
   *
   * Three outcomes, in the order they are decided: a device the user disabled is already settled and returns; a device we have configured takes the address-change
   * path, which is a no-op unless the advertised address has actually moved; anything else is a first discovery and runs the full flow in phases - build the device
   * record, log discovery, gate on the disabled feature option, connect, capture initial state, register the platform accessory, construct the RatgdoAccessory with
   * real state, and bind the connection. Each phase is a single block; the function reads top-to-bottom as a timeline.
   *
   * The central design choice: `RatgdoAccessory` is constructed AFTER the ESPHome client has connected AND the LatestStateCache has populated with the device's
   * initial state. The "we do not know yet" window is eliminated rather than modeled - the accessory is born with real telemetry data, configureXxx writes real
   * values to HAP from frame zero, and no Not-Responding / placeholder-default machinery is needed.
   *
   * @param discovered - The recognized identity the classify derived from the device's advertisement.
   */
  private async reconcileDevice(discovered: DiscoveredRatgdo): Promise<void> {

    try {

      const { address, firmwareVersion, friendlyName, macColon, model, strippedMac, variant } = discovered;
      const uuid = this.hap.uuid.generate(macColon);

      /* Devices the user disabled are settled for this run: discoveredDevices holds MACs we have decided not to configure for a reason that will not change without
       * user action. Keeping it separate from configuredDevices means a transient connection failure sticks the device in neither set, so a later pass retries the
       * connect path automatically without requiring a Homebridge restart.
       */
      if(this.discoveredDevices.has(macColon)) {

        return;
      }

      // A device we have already configured is reconciled against its advertisement rather than discovered again. The accessory, its services, and its HomeKit
      // identity all stand; only the connection is replaced, and only when the address it was opened against has left the set the device advertises.
      const configured = this.configuredDevices.get(uuid);

      if(configured) {

        await this.reconnectOnAddressChange(configured, discovered);

        return;
      }

      // See if we already know about this accessory or if it's truly new; the Map gives O(1) membership lookup.
      let accessory = this.accessories.get(uuid);

      const device: RatgdoDevice = {

        address: address,
        firmwareVersion: firmwareVersion,
        mac: strippedMac,
        model: model,
        name: this.resolveLogName(strippedMac) ?? friendlyName ?? "Ratgdo",
        variant: variant
      };

      const deviceSummary = device.name + " (address: " + device.address + " mac: " + device.mac + " firmware: v" + device.firmwareVersion + " variant: " +
        device.variant + (device.model ? (" [" + device.model + "]") : "") + ")";

      this.log.info("Discovered: %s.", deviceSummary);

      // Disabled by the user. Unregister any cached accessory, mark the MAC as discovered-and-skipped so subsequent mDNS broadcasts do not re-log it, and return.
      if(!this.featureOptions.test("Device", device.mac)) {

        if(accessory) {

          this.log.info("%s: Removing device from HomeKit.", accessory.displayName);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.delete(uuid);
        }

        this.discoveredDevices.add(macColon);

        return;
      }

      /* Connect to the device AND wait for the initial-state burst before we construct the accessory. The connect path lives in openConnection() so the dual await
       * (openEspHomeClient + captureInitialState) shares a single try/catch with consistent error logging and cleanup. We pass only the platform-wide shutdown signal -
       * captureInitialState composes its own per-call timeout internally, so the state-capture budget covers exactly what its name implies (state capture, not the
       * preceding handshake). The `expected` list is built from the same canonical entity registry that buildInitialStatus reads, so the two are hand-kept in sync -
       * there is currently no type-level check that would catch a future divergence, so any change to what buildInitialStatus reads must be mirrored in
       * ratgdoInitialStateEntityIds.
       */
      // The client's own log adapter. The plain platform log is the right base: the constructor redirects `this.log.debug` through the plugin's gated debug(), so
      // client-internal messages (handshake, retries, heartbeat) honor the config.debug opt-in without a second wrapper. The name read is live in form but static in
      // practice - RatgdoDevice.name is readonly, fixed at discovery - which keeps those messages titled by the mDNS-discovered name even after a HomeKit rename;
      // per-accessory logging routes through RatgdoAccessory's dynamic-name channel instead.
      const connectLog = prefixedLog(this.log, () => device.name);
      const expected = ratgdoInitialStateEntityIds(device.variant);
      const connection = await openConnection({

        expected,
        host: address,
        log: connectLog,
        psk: this.featureOptions.value("Device.Encryption.Key", strippedMac),
        shutdownSignal: this.shutdownController.signal
      });

      if(!connection.ok) {

        return;
      }

      const { client, initialState } = connection;

      // openConnection's fast paths hand back a connected client without consulting the shutdown signal, so a shutdown landing during the handshake can resolve here
      // after the shutdown handler has already torn every connection down. Re-checking after the connect resolves is what keeps a client from outliving the platform.
      if(this.shutdownController.signal.aborted) {

        client.disconnect();

        return;
      }

      applyDeviceInfo(device, client);

      // Register the PlatformAccessory with Homebridge if it is new. Cached accessories (restored on startup) reuse their persisted services via the acquireService
      // path inside the RatgdoAccessory constructor's configureDevice chain.
      if(!accessory) {

        accessory = new this.api.platformAccessory(sanitizeName(device.name), uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }

      this.log.info("Configuring: %s.", deviceSummary);

      // Construct the accessory with the real telemetry data we just captured. configureDevice walks the configureXxx chain inside the constructor; each method writes
      // the corresponding HAP characteristic from the populated `status`, so HomeKit sees the device's actual current state from the first read.
      const ratgdo = new RatgdoAccessory(this, accessory, device, initialState);

      this.bindConnection(ratgdo, client);
      this.configuredDevices.set(uuid, ratgdo);
      this.api.updatePlatformAccessories([accessory]);
    } catch(error) {

      this.log.error("Discovery error: %s.", formatErrorMessage(error));
    }
  }

  /* Bind a connected client to an accessory: own the client, attach the listeners it drives, and run the post-connect setup.
   *
   * Ordering matters at both ends. The listeners are attached AFTER the accessory has been constructed, because openConnection already drained the initial-state
   * burst for every entity the seed reads and the constructor wrote each characteristic from that captured snapshot: attaching only now means the seed is never
   * re-driven, so each characteristic is written once from real device state rather than shown at a default and then corrected, and HomeKit does not flicker. The
   * reconnect path's replay is the deliberate exception to that, and it is stated where it happens. The client goes onto the stack FIRST and each listener after it,
   * so disposal releases the listeners before the client's synchronous disconnect and that disconnect reaches no handler.
   *
   * Each listener is built by a small factory method that captures `ratgdo` and, for lifecycle, `client`; the client's event bus persists these subscriptions across
   * its own reconnects, so each handler is wired exactly once per connection.
   *
   * @param ratgdo - The accessory the client drives.
   * @param client - The connected ESPHome client.
   */
  private bindConnection(ratgdo: RatgdoAccessory, client: EspHomeClient): void {

    const stack = new DisposableStack();

    stack.use(client);
    stack.use(client.on("lifecycle", this.buildLifecycleListener(ratgdo, client)));
    stack.use(client.on("telemetry", this.buildTelemetryListener(ratgdo)));

    if(ratgdo.hints.discoBattery) {

      stack.use(client.on("log", this.buildLogListener(ratgdo)));
    }

    /* Run the post-connect setup through the same `onConnect()` chokepoint the lifecycle "connect" handler uses on every subsequent reconnect. Both initial discovery
     * and reconnect therefore funnel through one path - markOnline() (refresh the identity fields, log the connection, dispatch availability=online) plus
     * setupBatteryLogs() (re-issue the per-connection SUBSCRIBE_LOGS_REQUEST for Disco variants). Any future post-connect concern gets added to `onConnect()` once and
     * lights up on both paths automatically.
     */
    this.onConnect(ratgdo, client, client.capabilities().encryption.active);
    this.connections.set(ratgdo.device.mac, { client, stack });
  }

  /* Follow a configured device to a new address.
   *
   * ESPHome clients reconnect to the host they were opened against, so a device that moves - a changed DHCP reservation, a new subnet - is unreachable until its
   * connection is replaced. Its advertisement is what tells us it moved, and this is the one place that acts on it: the accessory, its HomeKit identity, and every
   * service it owns stand untouched, and only the connection underneath is re-dialed.
   *
   * `device.address` is written only once the new address has connected, so the field always names the address the live connection was actually opened against. A
   * failed dial therefore leaves the device offline at its last good address and the next pass retries, which is the same next-refresh-retries rule a failed first
   * connect follows.
   *
   * @param ratgdo     - The configured accessory whose connection is reconciled.
   * @param discovered - The identity derived from the advertisement that triggered this pass.
   */
  private async reconnectOnAddressChange(ratgdo: RatgdoAccessory, discovered: DiscoveredRatgdo): Promise<void> {

    // A live connection at an address the device still advertises needs nothing, whether or not that address is the one the pick now favors: a re-advertisement
    // carrying only a changed TXT record, a changed port, or a changed address list lands here, and the identity fields it might have moved are refreshed through
    // markOnline on the client's own next connect.
    if(this.connections.has(ratgdo.device.mac) && isAdvertisedAt(discovered, ratgdo.device.address)) {

      return;
    }

    // Two ways to arrive here, and the operator is told which: a live connection whose device moved, or no connection at all, which is a device whose last reconnect
    // attempt failed and left it without one.
    if(this.connections.has(ratgdo.device.mac)) {

      ratgdo.log.info("Address changed from %s to %s. Reconnecting.", ratgdo.device.address, discovered.address);
    } else {

      ratgdo.log.info("Reconnecting at %s.", discovered.address);
    }

    ratgdo.updateState({ id: "availability", state: "offline" });
    this.connections.get(ratgdo.device.mac)?.stack.dispose();
    this.connections.delete(ratgdo.device.mac);

    const outcome = await openConnection({

      expected: ratgdoInitialStateEntityIds(ratgdo.device.variant),
      host: discovered.address,
      log: prefixedLog(this.log, () => ratgdo.device.name),
      psk: this.featureOptions.value("Device.Encryption.Key", ratgdo.device.mac),
      shutdownSignal: this.shutdownController.signal
    });

    // openConnection has already logged what went wrong, so there is nothing to say here.
    if(!outcome.ok) {

      return;
    }

    // The same re-check the first-discovery path makes, for the same reason: openConnection's fast paths do not consult the shutdown signal.
    if(this.shutdownController.signal.aborted) {

      outcome.client.disconnect();

      return;
    }

    ratgdo.device.address = discovered.address;

    this.bindConnection(ratgdo, outcome.client);

    /* Replay the captured initial state into the accessory through the same translation the live listener uses. A fresh client's initial-state burst landed inside
     * openConnection before any listener existed, so the accessory learns it from the snapshot here - exactly as it learns the full-state burst the device sends
     * after every ordinary reconnect through the retained telemetry listener. This runs after bindConnection so markOnline has already run and the replay carries
     * the post-reconnect truth.
     */
    const telemetry = this.buildTelemetryListener(ratgdo);

    for(const event of outcome.initialState.values()) {

      telemetry(event);
    }
  }

  /* Lifecycle subscription. The lifecycle event is a discriminated union over connect/disconnect transitions. Switching on `kind` with a never-typed default gives
   * us compile-time exhaustiveness: any future LifecycleEvent variant added upstream surfaces here as a type error rather than silently falling into the disconnect
   * path. The "connect" branch fires only on RECONNECTS - the connect that opened this client emitted its lifecycle event before this subscription existed, so
   * `bindConnection` invokes `onConnect()` directly after registering the listeners to bridge that gap. Both paths therefore funnel through `onConnect()`.
   */
  private buildLifecycleListener(ratgdo: RatgdoAccessory, client: EspHomeClient): (event: LifecycleEvent) => void {

    return (event: LifecycleEvent): void => {

      switch(event.kind) {

        case "connect":

          this.onConnect(ratgdo, client, event.encrypted);

          return;

        case "disconnect":

          ratgdo.updateState({ id: "availability", state: "offline" });

          // Disconnect cause narrows through the typed error hierarchy. The auto-reconnect supervisor already filters PermanentError subclasses out of the retry
          // budget, so the encryption-key cases below are diagnostic only - the device will not come back without a configuration fix.
          if(isEncryptionError(event.cause)) {

            ratgdo.log.error("Encryption configuration error - check the device's API encryption key: %s", event.cause.message);
          }

          return;

        default: {

          // Compile-time exhaustiveness: if a new LifecycleEvent kind is added upstream, this statement fails to type-check and forces us to handle it explicitly.
          event satisfies never;

          return;
        }
      }
    };
  }

  /* Telemetry subscription. The pure wire-to-EspHomeEvent translation lives in protocol/telemetry.ts (translateTelemetry); this listener is the thin I/O wrapper that
   * logs the raw event lazily and dispatches the translated payload into the device class.
   */
  private buildTelemetryListener(ratgdo: RatgdoAccessory): (event: TelemetryEvent) => void {

    return (data: TelemetryEvent): void => {

      // Lazy debug: util.inspect runs only when debug is on. Telemetry fires per state event - skipping the inspect work in production saves real CPU on slow hosts.
      // We omit colors because Homebridge's logger is not a TTY destination, so ANSI escapes would render as raw control bytes.
      ratgdo.debugLazy(() => util.inspect(data, { depth: null, sorted: true }));

      // translateTelemetry maps the wire event to the accessory-facing EspHomeEvent (the pure transform lives in protocol/telemetry.ts); dispatch the result here.
      ratgdo.updateState(translateTelemetry(data));
    };
  }

  /* Log subscription. The Disco firmware variant only - we extract battery state from verbose log lines because ESPHome does not expose it as an entity. The
   * wire-level SUBSCRIBE_LOGS_REQUEST that backs this listener is owned by `setupBatteryLogs()`, which `onConnect()` invokes on every connect and reconnect (the log
   * subscription is per-connection wire state and must be re-issued).
   */
  private buildLogListener(ratgdo: RatgdoAccessory): (event: LogEventData) => void {

    return (logEntry: LogEventData): void => {

      // Lazy debug: util.inspect runs only when debug is on. The Disco firmware emits verbose log lines at high frequency - skipping the inspect when debug is off
      // is the difference between a few microseconds per line and effectively zero.
      ratgdo.debugLazy(() => "Log event received: " + util.inspect(logEntry, { sorted: true }));

      // parseBatteryState extracts and normalizes the battery charging state (the pure transform, including the firmware CHARGING/FULL remap, lives in
      // protocol/battery.ts); a null result means the line carried no battery state and is ignored. The raw line is already in the lazy debug dump above for diagnostics.
      const state = parseBatteryState(logEntry.message);

      if(state === null) {

        return;
      }

      ratgdo.log.debug("Battery state update: %s.", state);
      ratgdo.updateState({ id: "battery", state });
    };
  }

  /* Single source of truth for the post-connect setup sequence. Called from the initial-connect bridge (after openEspHomeClient resolves) AND from the lifecycle
   * "connect" branch (every subsequent reconnect). Future post-connect concerns (e.g., re-publishing device metadata to MQTT, re-subscribing to additional feature
   * channels) get added here in one place rather than duplicated across both call sites.
   */
  private onConnect(ratgdo: RatgdoAccessory, client: EspHomeClient, encrypted: boolean): void {

    this.markOnline(ratgdo, client, encrypted);
    this.setupBatteryLogs(ratgdo, client);
  }

  /* Shared online-transition path. Refreshes both identity fields - the model and the firmware version - from the latest deviceInfo, announces the connection in the
   * log (with the encryption indicator), and dispatches availability=online so HomeKit's StatusActive characteristics light up. A firmware upgrade is the case both
   * refreshes exist for: the device comes back over a reconnect cycle carrying a new version, and the availability event that follows is what carries both fields
   * into HomeKit. The log fires unconditionally rather than gating on a status transition: initial discovery already set `status.availability = true` in
   * buildInitialStatus, so a transition check would suppress the log on first connect. Owning the announcement here keeps the "we connected" signal at exactly one
   * site, regardless of whether the caller is the initial-discovery path or the lifecycle "connect" handler firing on a reconnect.
   */
  private markOnline(ratgdo: RatgdoAccessory, client: EspHomeClient, encrypted: boolean): void {

    applyDeviceInfo(ratgdo.device, client);

    // The encryption indicator is a lock glyph followed by U+FE0E (the text-presentation variation selector, which forces a monochrome glyph rather than a color emoji
    // in the Homebridge log) and two spaces of padding before the message. The selector is required - stripping it lets terminals render a wide color emoji.
    ratgdo.log.info("%sRatgdo connected.", encrypted ? "\u{1F512}︎  " : "");
    ratgdo.updateState({ id: "availability", state: "online" });
  }

  /* Re-issue the per-connection SUBSCRIBE_LOGS_REQUEST when the Disco firmware variant is in play. The Disco does not expose battery state as a dedicated entity - we
   * extract it from verbose log lines instead - and ESPHome's log subscription is per-connection wire state, so it must be re-issued on every connect cycle.
   */
  private setupBatteryLogs(ratgdo: RatgdoAccessory, client: EspHomeClient): void {

    if(ratgdo.hints.discoBattery) {

      client.subscribeToLogs(LogLevel.VERBOSE);
    }
  }
}
