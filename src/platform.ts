/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.ts: homebridge-ratgdo platform class.
 */
import type { API, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import type { EspHomeClient, LifecycleEvent, LogEventData, TelemetryEvent } from "esphome-client";
import { FeatureOptions, MqttClient, sanitizeName } from "homebridge-plugin-utils";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { PLATFORM_NAME, PLUGIN_NAME, RATGDO_AUTODISCOVERY_INTERVAL, RATGDO_AUTODISCOVERY_TYPES, RATGDO_AUTODISCOVERY_WARMUP_OFFSETS,
  RATGDO_MQTT_TOPIC } from "./settings.ts";
import { featureOptionCategories, featureOptions, normalizeConfig } from "./options.ts";
import { isEncryptionError, openConnection } from "./connection.ts";
import { setInterval as setIntervalAsync, setTimeout as setTimeoutAsync } from "node:timers/promises";
import { Bonjour } from "bonjour-service";
import { LogLevel } from "esphome-client";
import { RatgdoAccessory } from "./device.ts";
import type { RatgdoDevice } from "./types.ts";
import type { RatgdoOptions } from "./options.ts";
import type { Service } from "bonjour-service";
import { parseBatteryState } from "./protocol/battery.ts";
import { parseRatgdoService } from "./discovery.ts";
import { performance } from "node:perf_hooks";
import { ratgdoInitialStateEntityIds } from "./entities.ts";
import { translateTelemetry } from "./protocol/telemetry.ts";
import util from "node:util";

/* Per-device connection state. The ESPHome client owns its auto-reconnect supervisor and lazy heartbeat (defaults: 30s ping interval, 60s stall budget), so the platform
 * needs no per-device watchdog or reconnect controller. The connection record carries only the live client and the disposables we release on
 * shutdown - everything else (liveness checking, transient-disconnect recovery, subscription continuity across reconnects) is the ESPHome client's responsibility.
 *
 * @property client        - The ESPHome client, owns the connection lifecycle.
 * @property subscriptions - Disposables returned by `client.on(event, handler)`. Disposing them detaches the listeners so subsequent events do not re-enter our state.
 */
interface RatgdoConnection {

  client: EspHomeClient;
  subscriptions: Disposable[];
}

export class RatgdoPlatform implements DynamicPlatformPlugin {

  // Cached platform accessories keyed by HAP UUID. Map storage matches the rest of the platform's per-device stores (configuredDevices, connections) and gives O(1)
  // lookup at discoverRatgdoDevice's "have we seen this UUID before?" check.
  private readonly accessories: Map<string, PlatformAccessory>;
  public readonly api: API;
  public readonly config: RatgdoOptions;
  public readonly configuredDevices: Map<string, RatgdoAccessory>;
  private readonly connections: Map<string, RatgdoConnection>;
  private readonly discoveredDevices: Set<string>;
  public readonly featureOptions: FeatureOptions;
  public readonly hap: HAP;
  public readonly log: Logging;
  // mDNS Bonjour instance, populated lazily in configureRatgdo() and destroyed in the constructor's shutdown handler. Holding a field reference keeps shutdown
  // ownership in one place instead of fragmenting it across multiple api.on("shutdown") registrations.
  private mdns?: Bonjour;
  public readonly mqtt: Nullable<MqttClient>;
  // AbortController scoped to the platform's lifetime. Aborted on Homebridge shutdown so that every signal-aware resource we own (the MQTT client, any future
  // signal-driven primitive) tears itself down through one composed signal instead of per-resource imperative cleanup.
  private readonly shutdownController: AbortController;

  constructor(log: Logging, config: PlatformConfig | undefined, api: API) {

    this.accessories = new Map();
    this.api = api;
    this.config = normalizeConfig(config);
    this.configuredDevices = new Map();
    this.connections = new Map();
    this.discoveredDevices = new Set();
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, this.config.options);
    this.hap = api.hap;
    this.log = log;
    // In-place override: this redirects the injected Homebridge Logging instance's own debug() method through the plugin's debug() method below, which gates
    // output on the opt-in config.debug setting. Any caller holding this same log reference therefore gets the plugin's config.debug behavior rather than
    // Homebridge's global debug switch.
    this.log.debug = (message: string, ...parameters: unknown[]): void => this.debug(message, ...parameters);
    this.mqtt = null;
    this.shutdownController = new AbortController();

    // We can't start without being configured.
    if(!config) {

      return;
    }

    // Initialize MQTT, if needed. The HBPU MqttClient throws synchronously on an invalid broker URL, so we wrap construction in a try/catch and degrade gracefully -
    // a single bad MQTT entry should not block the rest of the plugin from loading. The composed shutdown signal ties the client's lifetime to ours so we never have
    // to imperatively disconnect it.
    if(this.config.mqttUrl) {

      try {

        this.mqtt = new MqttClient({ brokerUrl: this.config.mqttUrl, log: this.log, topicPrefix: this.config.mqttTopic ?? RATGDO_MQTT_TOPIC },
          { signal: this.shutdownController.signal });
      } catch(error) {

        // We use util.inspect to preserve the full error chain. HBPU attaches the underlying mqtt.js failure as `cause`, which has the actual diagnostic detail
        // (invalid URL, ENOTFOUND, etc.). A plain `error.message` log would surface only the HBPU wrapper text and discard the root cause.
        this.log.error("Unable to initialize MQTT client: %s", util.inspect(error, { depth: null }));
      }
    }

    this.log.debug("Debug logging on. Expect a lot of data.");

    // Fire up the Ratgdo API once Homebridge has loaded all the cached accessories it knows about and called configureAccessory() on each.
    api.on("didFinishLaunching", () => this.configureRatgdo());

    // Make sure we take ourselves offline when we shutdown. This is the single owner of platform shutdown - every cleanup (signal abort, ESPHome teardown, accessory
    // offline announcement, mDNS destroy) flows through here in one ordered pass, so future readers find the entire teardown sequence in one place.
    api.on("shutdown", () => {

      // Abort the platform signal first. This cancels every signal-aware resource (MQTT client, anything else composed onto our lifetime) before the imperative
      // teardown below runs, so nothing scheduled on a later event-loop tick can race against the synchronous cleanup.
      this.shutdownController.abort("shutdown");

      // Detach event subscriptions and disconnect each ESPHome client. We dispose subscriptions before disconnecting so the disconnect event does not re-enter our
      // lifecycle handler and try to schedule any further state updates during teardown. The ESPHome client's auto-reconnect supervisor sees the manual disconnect as
      // intentional and does not try to reconnect.
      for(const conn of this.connections.values()) {

        for(const sub of conn.subscriptions) {

          sub[Symbol.dispose]();
        }

        conn.client.disconnect();
      }

      this.connections.clear();

      // Inform our accessories we're going offline, then dispose them so any pending one-shot timers (motion timeout, occupancy timeout, UI revert, etc.) are cancelled
      // before they fire into a torn-down accessory and keep the Node event loop alive past shutdown.
      for(const device of this.configuredDevices.values()) {

        device.updateState({ id: "availability", state: "offline" });
        device[Symbol.dispose]();
      }

      // Teardown the mDNS browser, if it was started. configureRatgdo() runs only after didFinishLaunching, so a shutdown that fires before discovery began leaves
      // mdns undefined - the optional-chain handles that path silently.
      this.mdns?.destroy();
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

  // Configure and connect to Ratgdo ESPHome clients.
  private configureRatgdo(): void {

    // Field-tracked Bonjour instance so the constructor's shutdown handler owns its teardown. Avoids fragmenting shutdown ownership across multiple api.on("shutdown")
    // registrations.
    this.mdns = new Bonjour();

    // Start ESPHome device discovery.
    for(const mdnsType of RATGDO_AUTODISCOVERY_TYPES) {

      const mdnsBrowser = this.mdns.find({ type: mdnsType }, (service) => {

        // The discovery callback is sync but the ESPHome connect path is async. We fire-and-forget into a background promise and surface any unhandled error so a single
        // device's connection failure does not silently swallow diagnostics.
        void this.discoverRatgdoDevice(service).catch((error: unknown) => {

          this.log.error("Discovery error: %s", util.inspect(error, { depth: null }));
        });
      });

      // Start the background discovery schedule, which fires every mDNS query for the lifetime of the browser: the bootstrap warmup burst followed by the
      // steady-state refresh loop, both bounded by the platform's shutdown signal.
      void this.runDiscoverySchedule(mdnsBrowser);
    }
  }

  /* Single source of truth for the mDNS query cadence over the platform's lifetime. The warmup phase walks RATGDO_AUTODISCOVERY_WARMUP_OFFSETS (an RFC 6762 §5.2
   * doubling-interval burst that starts with the initial query at t=0) to catch devices whose mDNS responders missed the first packet; the steady-state phase then
   * loops at RATGDO_AUTODISCOVERY_INTERVAL for the rest of the platform's lifetime. Both phases compose onto the shutdown signal so cancellation is one path
   * regardless of which phase is active when shutdown fires, and both share one catch so AbortError is recognised as the expected exit while every other error
   * surfaces as a real failure.
   *
   * `configureRatgdo` does not issue `update()` directly: the warmup offsets include t=0, so this method fires every query the schedule ever sends. The cadence
   * lives here in two declarative inputs (the warmup list plus the steady-state interval) and nowhere else.
   */
  private async runDiscoverySchedule(mdnsBrowser: { update(): void }): Promise<void> {

    try {

      /* Warmup phase. Each offset becomes an independent timer keyed to an absolute deadline from this phase's start, so the queries fire at their exact target
       * times rather than accumulating drift across sequential sleeps. The shutdown signal flows into every timer; an abort cancels the full burst in one shot, and
       * Promise.all settles on the first rejection (which the catch below treats as the expected exit). The offset=0 entry produces a non-positive remaining time
       * and skips the sleep, firing the initial query immediately - the schedule owns every query, including the bootstrap.
       *
       * Timing uses `performance.now()` rather than `Date.now()` because the schedule fires during system startup, exactly when NTP and other wall-clock adjusters
       * are likely to run. A monotonic clock is immune to those adjustments; a wall-clock anchor would let an NTP jump during warmup either collapse every remaining
       * timer to fire immediately (forward jump) or delay them by the jump magnitude (backward jump).
       */
      const warmupStartedAt = performance.now();

      await Promise.all(RATGDO_AUTODISCOVERY_WARMUP_OFFSETS.map(async (offset): Promise<void> => {

        const remainingMs = (warmupStartedAt + (offset * 1000)) - performance.now();

        if(remainingMs > 0) {

          await setTimeoutAsync(remainingMs, undefined, { signal: this.shutdownController.signal });
        }

        mdnsBrowser.update();
      }));

      // Steady-state phase. After the warmup burst lands, refresh on the configured interval until shutdown aborts the signal.
      for await (const _ of setIntervalAsync(RATGDO_AUTODISCOVERY_INTERVAL * 1000, undefined, { signal: this.shutdownController.signal })) {

        mdnsBrowser.update();
      }
    } catch(error) {

      // AbortError is the expected path on shutdown - everything else is worth surfacing.
      if((error instanceof Error) && (error.name === "AbortError")) {

        return;
      }

      this.log.error("Discovery schedule error: %s", util.inspect(error, { depth: null }));
    }
  }

  /* Ratgdo ESPHome device discovery. The discovery flow lives entirely in this function and runs in phases - parse mDNS, dedup, build the device record, log
   * discovery, gate on the disabled feature option, connect, capture initial state, register the platform accessory, construct the RatgdoAccessory with real state,
   * wire ongoing subscriptions, and finalize. Each phase is a single block; the function reads top-to-bottom as a timeline.
   *
   * The central design choice: `RatgdoAccessory` is constructed AFTER the ESPHome client has connected AND the LatestStateCache has populated with the device's
   * initial state. The "we do not know yet" window is eliminated rather than modeled - the accessory is born with real telemetry data, configureXxx writes real
   * values to HAP from frame zero, and no Not-Responding / placeholder-default machinery is needed.
   */
  private async discoverRatgdoDevice(service: Service): Promise<void> {

    // Parse and classify the mDNS service into a recognized Ratgdo identity. parseRatgdoService owns the pure wire-derivation - the validity guard, the project-pattern
    // classification, and the MAC normalization - returning null for any service that is not a device we configure. The platform-state layering below (UUID generation,
    // the dedup gates, the resolved log name) stays here because it depends on this instance's hap, feature options, and per-run device maps.
    const discovered = parseRatgdoService(service);

    if(!discovered) {

      return;
    }

    const { address, firmwareVersion, friendlyName, macColon, model, strippedMac, variant } = discovered;
    const uuid = this.hap.uuid.generate(macColon);

    /* Short-circuit when we have already finished processing this device for this run. Two distinct dedup gates apply:
     *
     *   - configuredDevices holds every device whose RatgdoAccessory we constructed. The set is keyed on the same HAP UUID we are about to recompute, so subsequent
     *     mDNS broadcasts for the same MAC short-circuit here in O(1) without touching any of the discovery, log, or feature-option machinery below.
     *   - discoveredDevices holds MACs we've decided not to configure for reasons that will not change without user action (the device is disabled in feature options).
     *     Keeping it separate from configuredDevices means a transient connection failure does not stick the device in either set, so the next mDNS refresh retries
     *     the connect path automatically without requiring a Homebridge restart.
     */
    if(this.configuredDevices.has(uuid) || this.discoveredDevices.has(macColon)) {

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
    const connectLog = this.buildConnectLog(device.name);
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

    // Refresh device.model from the authoritative deviceInfo. mDNS TXT exposes project_version, but the client's deviceInfo() is the canonical source - a firmware
    // upgrade may produce a different model string than the cached mDNS record carries. The two usually agree; the refresh is the safety net.
    const remoteModel = client.deviceInfo()?.projectVersion;

    if((remoteModel !== undefined) && (remoteModel !== device.model)) {

      device.model = remoteModel;
    }

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

    /* The telemetry listener is attached AFTER the accessory is constructed, and the order matters: openConnection already drained the initial-state burst
     * for every entity the seed reads into the client cache, and the constructor wrote each characteristic from that captured snapshot. Attaching the listener only
     * now means the seed is never re-driven by a replayed burst - this listener carries genuine post-construction changes - so each characteristic is written once
     * from real device state rather than shown at a default and then corrected, and HomeKit does not flicker on startup. Each listener is built by a small factory
     * method that captures `ratgdo` and (for lifecycle) `client`; the EventBus persists these subscriptions across reconnects, so we wire each handler exactly once
     * at discovery time. The returned Disposable[] is owned by the connection record and disposed by the platform's shutdown handler.
     */
    const subscriptions: Disposable[] = [

      client.on("lifecycle", this.buildLifecycleListener(ratgdo, client)),
      client.on("telemetry", this.buildTelemetryListener(ratgdo))
    ];

    if(ratgdo.hints.discoBattery) {

      subscriptions.push(client.on("log", this.buildLogListener(ratgdo)));
    }

    /* Run the post-connect setup through the same `onConnect()` chokepoint the lifecycle "connect" handler uses on every subsequent reconnect. Both initial discovery
     * and reconnect therefore funnel through one path - markOnline() (refresh model, log the connection, dispatch availability=online) plus setupBatteryLogs() (re-
     * issue the per-connection SUBSCRIBE_LOGS_REQUEST for Disco variants). Any future post-connect concern gets added to `onConnect()` once and lights up on both
     * paths automatically.
     */
    this.onConnect(ratgdo, client, client.capabilities().encryption.active);

    this.connections.set(strippedMac, { client, subscriptions });
    this.configuredDevices.set(uuid, ratgdo);
    this.api.updatePlatformAccessories([accessory]);
  }

  // Build a static-prefix log adapter bound to a device name. Used as the ESPHome client's `logger` parameter so client-internal messages (handshake, retries, heartbeat)
  // carry the device's mDNS-discovered name; the adapter persists for the client's lifetime. Per-accessory logging (info, warn, error, debug) for everything outside
  // the client's internals routes through the dynamic-name channel on RatgdoAccessory instead.
  private buildConnectLog(name: string): HomebridgePluginLogging {

    return {

      debug: (message: string, ...parameters: unknown[]): void => this.debug(name + ": " + message, ...parameters),
      error: (message: string, ...parameters: unknown[]): void => this.log.error(name + ": " + message, ...parameters),
      info: (message: string, ...parameters: unknown[]): void => this.log.info(name + ": " + message, ...parameters),
      warn: (message: string, ...parameters: unknown[]): void => this.log.warn(name + ": " + message, ...parameters)
    };
  }

  /* Lifecycle subscription. The lifecycle event is a discriminated union over connect/disconnect transitions. Switching on `kind` with a never-typed default gives
   * us compile-time exhaustiveness: any future LifecycleEvent variant added upstream surfaces here as a type error rather than silently falling into the disconnect
   * path. The "connect" branch fires only on RECONNECTS - the initial connect's lifecycle event was emitted during connect() before this subscription existed, so
   * discoverRatgdoDevice invokes `onConnect()` directly after construction to bridge that gap. Both paths therefore funnel through `onConnect()`.
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

          // Compile-time exhaustiveness: if a new LifecycleEvent kind is added upstream, this assignment fails to type-check and forces us to handle it explicitly.
          const _exhaust: never = event;

          void _exhaust;

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

  /* Shared online-transition path. Refreshes the device's model from the latest deviceInfo (handles firmware upgrades over reconnect cycles), announces the
   * connection in the log (with the encryption indicator), and dispatches availability=online so HomeKit's StatusActive characteristics light up. The log fires
   * unconditionally rather than gating on a status transition: initial discovery already set `status.availability = true` in buildInitialStatus, so a transition
   * check would suppress the log on first connect. Owning the announcement here keeps the "we connected" signal at exactly one site, regardless of whether the
   * caller is the initial-discovery path or the lifecycle "connect" handler firing on a reconnect.
   */
  private markOnline(ratgdo: RatgdoAccessory, client: EspHomeClient, encrypted: boolean): void {

    const info = client.deviceInfo();

    if(info?.projectVersion !== undefined) {

      ratgdo.device.model = info.projectVersion;
    }

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

  // Plugin-owned debug logging, gated on the config.debug opt-in. We route it through log.warn rather than log.debug because Homebridge suppresses DEBUG-level lines
  // unless its own global debug switch is on, so surfacing our opt-in debug stream at WARN level is what makes config.debug output actually appear in the log.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debug) {

      this.log.warn(util.format(message, ...parameters));
    }
  }
}
