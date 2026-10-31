/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.ts: homebridge-ratgdo platform class.
 */
import type { API, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import type { Clock, HomebridgePluginLogging, MdnsBrowserFactory, MdnsDiscovery, MdnsDiscoveryEvent, MqttClient, Nullable } from "homebridge-plugin-utils";
import { CoalescingTask, FeatureOptions, HbpuAbortError, MQTT_AVAILABILITY_OFFLINE, Perms, WakeableWait, createMqttClient, debugGatedLog, discoverServices,
  formatErrorMessage, isAdvertisedAt, mdnsBrowserFactory, mqttConnectionSettings, mqttTopic, notResponding, prefixedLog, sanitizeName, superviseLoop,
  systemClock } from "homebridge-plugin-utils";
import { DeviceIdentityError, applyDeviceInfo, isEncryptionError, openConnection, openManualConnection } from "./connection.ts";
import type { EncryptionKeyLookup, OpenEspHomeClient } from "./connection.ts";
import type { EntityId, EspHomeClient, LifecycleEvent, LogEventData, TelemetryEvent } from "esphome-client";
import { LogLevel, openEspHomeClient } from "esphome-client";
import { PLATFORM_NAME, PLUGIN_NAME, RATGDO_MANUAL_RETRY_INTERVAL, RATGDO_MDNS_SERVICE_TYPE } from "./settings.ts";
import { featureOptionCategories, featureOptions, normalizeConfig } from "./options.ts";
import { governingAddress, isZonedAddress, manualAddressList, runManualAddress } from "./manual.ts";
import { normalizeMac, parseRatgdoService } from "./discovery.ts";
import type { DiscoveredRatgdo } from "./discovery.ts";
import type { ManualDialOutcome } from "./manual.ts";
import { RatgdoAccessory } from "./device.ts";
import type { RatgdoDevice } from "./types.ts";
import type { RatgdoResolvedConfig } from "./options.ts";
import { mqttTopics } from "./mqtt.ts";
import { parseBatteryState } from "./protocol/battery.ts";
import { ratgdoInitialStateEntityIds } from "./entities.ts";
import { translateLifecycle } from "./protocol/lifecycle.ts";
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

/* What the one post-connect admit decision is handed, whichever source connected.
 *
 * @property client       - The connected client, which this decision either keeps for the device or disposes.
 * @property device       - The device record the screening built, carrying the governing manual address when a listed address is what connected.
 * @property discovered   - The identity the connect derived, read for the colon MAC the HomeKit UUID comes from.
 * @property initialState - The state burst the connect captured, replayed into an accessory whose connection this one replaces.
 */
interface AdmitConnectionOptions {

  client: EspHomeClient;
  device: RatgdoDevice;
  discovered: DiscoveredRatgdo;
  initialState: ReadonlyMap<EntityId, TelemetryEvent>;
}

/* The platform's injectable defaults: the boundaries a suite substitutes to drive the real lifecycle with no network and no real time. Homebridge constructs the
 * platform with three arguments, so every member takes its production default and the field never sees anything else.
 *
 * @property browserFactory - How the mDNS browser underneath discovery is built. Defaults to the library's real browser.
 * @property clock          - The time source every timer the plugin arms reads. Defaults to the system clock.
 * @property mqttFactory    - How the MQTT client is built, handed the broker settings and the platform's lifetime signal. Defaults to the library's guarded factory.
 * @property openClient     - How an ESPHome client is opened, for every dial the platform makes. Defaults to esphome-client's own factory.
 */
export interface RatgdoPlatformDefaults {

  browserFactory?: MdnsBrowserFactory;
  clock?: Clock;
  mqttFactory?: typeof createMqttClient;
  openClient?: OpenEspHomeClient;
}

/* The encryption indicator a connection announcement leads with, read from the client's current session: a lock glyph followed by U+FE0E (the text-presentation
 * variation selector, which forces a monochrome glyph rather than a color emoji in the Homebridge log) and the padding before the message, or nothing for a plaintext
 * session. The selector is required - stripping it lets terminals render a wide color emoji.
 */
function encryptionGlyph(client: EspHomeClient): string {

  return client.capabilities().encryption.active ? "\u{1F512}\u{FE0E}  " : "";
}

export class RatgdoPlatform implements DynamicPlatformPlugin {

  // Cached platform accessories keyed by HAP UUID. Map storage matches the rest of the platform's per-device stores (configuredDevices, connections) and gives O(1)
  // lookup at the reconcile pass's "have we seen this UUID before?" check.
  private readonly accessories: Map<string, PlatformAccessory>;
  // One entry per MAC-and-announced-address pair already warned about, never cleared: the line is advice about a configuration only a restart changes, so saying it
  // twice would be nagging rather than informing.
  private readonly announcedElsewhere: Set<string>;
  public readonly api: API;
  // How the mDNS browser underneath discovery is built, the production browser in the field and a suite's double under test.
  private readonly browserFactory: MdnsBrowserFactory;
  /* The one time source every timer the plugin arms reads: each accessory's timer registry and the discovery stream's own deadlines. It is the production clock in the
   * field and a controllable one a suite injects, so a suite drives every deadline on a virtual timeline instead of serving it out in real seconds.
   */
  public readonly clock: Clock;
  public readonly config: RatgdoResolvedConfig;
  public readonly configuredDevices: Map<string, RatgdoAccessory>;
  private readonly connections: Map<string, RatgdoConnection>;
  private readonly discoveredDevices: Set<string>;
  public readonly featureOptions: FeatureOptions;
  public readonly hap: HAP;
  // The one encryption-key lookup every connect this platform opens hands the connection core, which decides which MAC it is read at.
  private readonly keyFor: EncryptionKeyLookup;
  public readonly log: HomebridgePluginLogging;
  // Every address the user listed, canonical and in the user's own order, read once because a configuration change reaches this plugin only through a restart. The
  // order is what settles which of two addresses reaching one device governs it, so it is carried rather than re-derived per decision.
  private readonly manualAddresses: readonly string[];
  // The wakeable pause each address's loop is sitting in, keyed by that address, so the admit chokepoint can end a pause whose address has just been served.
  private readonly manualPauses: Map<string, WakeableWait>;
  public readonly mqtt: Nullable<MqttClient>;
  // How every dial this platform makes opens its ESPHome client, the production factory in the field and a suite's fake under test.
  private readonly openClient: OpenEspHomeClient;
  // AbortController scoped to the platform's lifetime. Aborted on Homebridge shutdown so that every signal-aware resource we own (the MQTT client, any future
  // signal-driven primitive) tears itself down through one composed signal instead of per-resource imperative cleanup.
  private readonly shutdownController: AbortController;

  constructor(log: Logging, config: PlatformConfig | undefined, api: API, { browserFactory = mdnsBrowserFactory, clock = systemClock,
    mqttFactory = createMqttClient, openClient = openEspHomeClient }: RatgdoPlatformDefaults = {}) {

    this.accessories = new Map();
    this.announcedElsewhere = new Set();
    this.api = api;
    this.browserFactory = browserFactory;
    this.clock = clock;

    const legacy = normalizeConfig(config);

    this.configuredDevices = new Map();
    this.connections = new Map();
    this.discoveredDevices = new Set();
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, legacy.options);
    this.manualAddresses = manualAddressList(this.featureOptions.valueList({ option: "Device.Address" }));
    this.manualPauses = new Map();

    /* Assemble the effective configuration. This is where a raw configuration property and a configured feature option meet for every setting the plugin resolves
     * for itself, so no reader downstream has to know that a setting has two possible homes. The configuration property's fallback is transitional and ends at the
     * plugin's next major version, when the option is the setting's only home. The broker URL and the topic prefix are resolved by the library at the client's
     * construction below, under the same precedence, so they never take a detour through this shape.
     */
    this.config = {

      debug: this.featureOptions.consolidatedFlag({ fallback: legacy.debug, option: "Log.Debug" }),
      options: legacy.options
    };

    this.hap = api.hap;
    this.keyFor = (mac?: string): Nullable<string | undefined> => this.featureOptions.value("Device.Encryption.Key", mac);
    /* Wrap the logger Homebridge handed us in the library's config-gated composition. The plugin offers a debug setting of its own, read live on every call, and the
     * gated channel emits through warn because Homebridge prints its DEBUG lines only when Homebridge's own global debug switch is on...warn is the level that
     * actually reaches the user's log. Wrapping rather than overwriting a method on Homebridge's own instance leaves that object exactly as Homebridge owns it.
     */
    this.log = debugGatedLog(log, (): boolean => this.config.debug);
    this.mqtt = null;
    this.openClient = openClient;
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

    this.mqtt = settings && mqttFactory({ ...settings, log: this.log }, { signal: this.shutdownController.signal });

    // On every broker session, state each opener this run holds but has not configured as unreachable. The client's lifetime is the platform's, so the registration
    // carries no signal of its own.
    this.mqtt?.onConnect(() => this.publishUnconfiguredAvailability());

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

  /* The platform's only availability statement: a retained offline for every MAC this run knows and has not configured, stated on each broker session. A MAC this
   * run has not configured cannot be reached, and nothing else speaks for it...a configured opener states its own reachability, so no MAC is stated by both. The
   * targets are derived here from state the platform already holds and are kept nowhere else. A held accessory's MAC is the serial number the device wrote on its
   * information service, which Homebridge restores from its cache before the first session can arrive, and a device removed as disabled before the first session
   * is still stated here, since the disabled set keeps its MAC for the rest of the run. A MAC reached both ways is stated once.
   */
  private publishUnconfiguredAvailability(): void {

    const macs = new Set<string>();

    for(const [ uuid, accessory ] of this.accessories) {

      if(this.configuredDevices.has(uuid)) {

        continue;
      }

      const serial = accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.SerialNumber).value;

      if(typeof serial === "string") {

        macs.add(serial);
      }
    }

    // discoveredDevices means "settled as disabled this run"; this read depends on that, so a writer adding a MAC for any other reason would state it offline here.
    for(const macColon of this.discoveredDevices) {

      macs.add(normalizeMac(macColon));
    }

    for(const mac of macs) {

      this.mqtt?.publishGuarded(mqttTopic(mac, mqttTopics.availability.topic), MQTT_AVAILABILITY_OFFLINE, { retain: true });
    }
  }

  /* Homebridge calls this for each cached accessory it restores at startup, before the first discovery pass and long before this run can reach the opener behind it.
   * Until this run's construction claims the accessory, it answers HomeKit with No Response: every characteristic of every service but AccessoryInformation is bound
   * here, a read and, where the characteristic takes writes, a write, each refusing while the claim is absent. The claim is `configuredDevices`, the one set the MQTT
   * unconfigured statement reads too, so HomeKit and MQTT cannot disagree about a restored opener, and a device this run never reaches keeps refusing for the run.
   *
   * Construction's own bindings replace these wherever it binds, and it binds nothing on some characteristics - a sensor's state, StatusActive, the door's target
   * read, every ConfiguredName. Each of those keeps its restore binding once the claim stands, and the binding answers the live value for a read and does nothing for
   * a write, so HAP stores a write exactly as it would with no handler at all, which is what keeps a Home app rename working. That leaves a restored accessory with
   * read handlers a fresh one never has: after a refused write, a fresh characteristic with no read handler keeps HAP's stored refusal until the next update writes
   * a value over it, while a restored one answers its value.
   */
  public configureAccessory(accessory: PlatformAccessory): void {

    this.accessories.set(accessory.UUID, accessory);

    const unclaimed = notResponding({ errorClass: this.hap.HapStatusError, unavailable: () => !this.configuredDevices.has(accessory.UUID) });

    for(const service of accessory.services) {

      if(service.UUID === this.hap.Service.AccessoryInformation.UUID) {

        continue;
      }

      for(const characteristic of service.characteristics) {

        characteristic.onGet(unclaimed(() => characteristic.value));

        if(characteristic.props.perms.includes(Perms.PAIRED_WRITE)) {

          characteristic.onSet(unclaimed(() => undefined));
        }
      }
    }
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
   * Two ways a device reaches this plugin, and each gets a supervised loop of its own: one listening to the network for as long as the platform runs, and one per
   * address the user listed. They are separate loops on purpose. The discovery pass is single-flight over every device the browser knows, so a listed address that
   * is not answering would hold every later discovery event behind its connect timeout if it were dialed inside that pass. Keeping them apart costs the two paths
   * one meeting point instead - the synchronous admit below, which is where they agree about who owns a device.
   *
   * Two lifetimes meet here. Each loop's is the platform's: it runs until the shutdown signal aborts, and `superviseLoop` swallows that unwind silently because an
   * abort we caused is not a fault. `onError` is for the other case - a throw out of a loop body, which would be a defect in this platform rather than anything the
   * network did. A browser that loses its sockets is neither: it ends the stream in order, and `runDiscovery` reports that from the loop's own end.
   */
  private configureRatgdo(): void {

    void superviseLoop({ loop: (): Promise<void> => this.runDiscovery(),
      onError: (error: unknown): void => this.log.error("Device discovery failed and will not restart until Homebridge restarts: %s.", formatErrorMessage(error)),
      signal: this.shutdownController.signal });

    for(const address of this.manualAddresses) {

      /* An address naming a zone is refused here, before anything is launched for it. A zone identifier names the interface a link-local address was heard on and
       * means nothing without that link, which is why autodiscovery drops a zoned candidate before it can be chosen at all; a typed one deserves the same answer
       * rather than a loop that cannot succeed and retries every interval forever. This is the one site where the option's values become loops, so this is where the
       * refusal belongs.
       */
      if(isZonedAddress(address)) {

        this.log.warn("%s: an address with a zone identifier cannot be dialed. List the device's routable address or hostname instead.", address);

        continue;
      }

      /* The pause this address's loop takes between attempts, held here so the admit chokepoint can end it early. The clock is the platform's own, matching
       * the one time source every other timer on this platform reads.
       */
      const pause = new WakeableWait({ clock: this.clock, signal: this.shutdownController.signal });

      this.manualPauses.set(address, pause);

      // A listed address is the user departing from the default, which is the kind of thing the startup log exists to report.
      this.log.info("Connecting directly to %s.", address);

      void superviseLoop({ loop: (): Promise<void> => this.runManualAddressLoop(address, pause),
        onError: (error: unknown): void => this.log.error("The connection to %s failed and will not restart until Homebridge restarts: %s.", address,
          formatErrorMessage(error)),
        signal: this.shutdownController.signal });
    }
  }

  /* Compose one listed address's connect loop out of platform state. The loop itself is pure and lives in manual.ts; this is the only place its ports are bound to
   * anything instance-shaped, which is what lets every rule the loop follows be driven in a test without a platform at all.
   *
   * @param address - The listed address this loop keeps connected.
   * @param pause   - The wakeable pause this loop waits on between attempts.
   *
   * @returns The loop, running until the address is served, gives up, or the platform shuts down.
   */
  private runManualAddressLoop(address: string, pause: WakeableWait): Promise<void> {

    return runManualAddress({

      address,
      dial: (log: HomebridgePluginLogging): Promise<ManualDialOutcome> => this.dialManualAddress(address, log),
      isServed: (): boolean => this.isAddressServed(address),
      log: this.log,
      pause,
      retrySeconds: RATGDO_MANUAL_RETRY_INTERVAL
    });
  }

  /* Open a connection to one listed address, identify what answers there, and hand it to the admit decision.
   *
   * This is the manual loop's whole interaction with the platform, and it resolves what became of the address rather than what became of the connection: every way
   * the admit can go - configured, adopted, yielded to an address listed earlier, refused because the user disabled this device - leaves the address needing no
   * further dial, so each of them is a success as far as the loop is concerned. Only a connect that produced no usable device comes back as a failure with a reason
   * the loop can act on.
   *
   * An address names no device, so this connection is dialed for no MAC: its key is chosen for the MAC the device announces as it answers, exactly as a discovered
   * device's key is read at its MAC. The screening runs after the connect for a related reason: a device the user disabled is disabled by MAC, and nothing here
   * knows the MAC until the device has answered.
   *
   * @param address - The listed address to dial.
   * @param log     - The log this attempt speaks through, which the loop quiets when the same failure is repeating.
   *
   * @returns What became of the address.
   */
  private async dialManualAddress(address: string, log: HomebridgePluginLogging): Promise<ManualDialOutcome> {

    const outcome = await openManualConnection({

      host: address,
      keyFor: this.keyFor,
      log: prefixedLog(log, () => address),
      openClient: this.openClient,
      shutdownSignal: this.shutdownController.signal
    });

    if(!outcome.ok) {

      return { ok: false, reason: outcome.reason };
    }

    /* Everything after the connect is contained, so that the two admit callers answer a fault the same way. The discovered path runs its screening and its admit
     * inside reconcileDevice's own try/catch and simply retries on the next pass; without the same containment here, a throw would unwind into the supervising
     * loop's onError and end THIS ADDRESS's loop for the life of the plugin, with the client it opened still connected and no longer referenced.
     *
     * The failure is reported as `unknown`, which the retry predicate treats as retryable - a fault in our own admit is exactly the kind of thing a later attempt may
     * get past, and it is the same class the discovered path's retry assumes.
     */
    try {

      const device = this.screenDevice(outcome.discovered, address);

      // A device the user disabled. The connection was the only way to find out, so it is closed here rather than admitted.
      if(!device) {

        outcome.client[Symbol.dispose]();

        return { ok: true };
      }

      this.admitConnection({ client: outcome.client, device, discovered: outcome.discovered, initialState: outcome.initialState });

      return { ok: true };
    } catch(error) {

      this.disposeIfUnowned(outcome.discovered.strippedMac, outcome.client);
      log.error("%s: the connection could not be completed: %s.", address, formatErrorMessage(error));

      return { ok: false, reason: "unknown" };
    }
  }

  // Whether a configured device already holds this address, which is the one condition that leaves a listed address's loop with nothing to do.
  private isAddressServed(address: string): boolean {

    for(const ratgdo of this.configuredDevices.values()) {

      if(ratgdo.device.address.toLowerCase() === address) {

        return true;
      }
    }

    return false;
  }

  /* Listen to the network for the whole of this platform's life, and reconcile what it says.
   *
   * The library owns the mechanism - the sockets, the record cache, and the RFC 6762 query cadence - and this plugin owns the policy: what a Ratgdo is
   * (`parseRatgdoService`), and what to do when one appears or moves (`reconcileDevice`). The stream and its task are locals of this method, alive for exactly the
   * stream's lifetime, so no field can hold a pass over a discovery that has already finished.
   */
  private async runDiscovery(): Promise<void> {

    await using discovery = discoverServices<DiscoveredRatgdo>({ browserFactory: this.browserFactory, classify: parseRatgdoService, clock: this.clock,
      log: this.log, serviceType: RATGDO_MDNS_SERVICE_TYPE, signal: this.shutdownController.signal });

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
   * initial state. The accessory is born with real telemetry data and configureXxx writes real values to HAP from frame zero, so no placeholder default ever reaches
   * HomeKit. A cached accessory waiting on this point answers No Response through the bindings configureAccessory gave it, until this construction claims it.
   *
   * @param discovered - The recognized identity the classify derived from the device's advertisement.
   */
  private async reconcileDevice(discovered: DiscoveredRatgdo): Promise<void> {

    // The client this pass has opened but not yet handed over, held where the catch can reach it. A fault anywhere after the connect would otherwise leave it running
    // against a real device with nothing referencing it; the disposal below is conditioned on ownership, so a fault after the handover leaves it alone.
    let opened: Nullable<EspHomeClient> = null;

    try {

      const uuid = this.hap.uuid.generate(discovered.macColon);

      // A device we have already configured is reconciled against its advertisement rather than discovered again. The accessory, its services, and its HomeKit
      // identity all stand; only the connection is replaced, and only when the address it was opened against has left the set the device advertises.
      const configured = this.configuredDevices.get(uuid);

      if(configured) {

        await this.reconnectOnAddressChange(configured, discovered);

        return;
      }

      // The screening runs before the connect on this path, which is what keeps a device the user disabled from ever being dialed: its advertisement carries the MAC,
      // so the answer is already knowable here.
      const device = this.screenDevice(discovered);

      if(!device) {

        return;
      }

      /* Connect to the device AND wait for the initial-state burst before we construct the accessory. The connect path lives in openConnection() so the dual await
       * (openEspHomeClient + captureInitialState) shares a single try/catch with consistent error logging and cleanup. We pass only the platform-wide shutdown signal -
       * openConnection builds the capture deadline once the client is open, so the state-capture budget covers exactly what its name implies (state capture, not the
       * preceding handshake). The `expected` list is built from the same canonical entity registry that buildInitialStatus reads, so the two are hand-kept in sync -
       * there is no type-level check that would catch a future divergence, so any change to what buildInitialStatus reads must be mirrored in
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
        host: device.address,
        keyFor: this.keyFor,
        log: connectLog,
        mac: device.mac,
        openClient: this.openClient,
        shutdownSignal: this.shutdownController.signal
      });

      if(!connection.ok) {

        return;
      }

      opened = connection.client;

      this.admitConnection({ client: connection.client, device, discovered, initialState: connection.initialState });
    } catch(error) {

      /* The same ownership rule the address dial's containment follows, so a fault on either admit path answers the same way. A throw before the handover leaves a
       * client nothing holds, and it is closed; a throw after it would otherwise close the device's own live connection, and it is left alone.
       */
      if(opened) {

        this.disposeIfUnowned(discovered.strippedMac, opened);
      }

      this.log.error("Discovery error: %s.", formatErrorMessage(error));
    }
  }

  /* Dispose an in-flight client after a fault, IF AND ONLY IF nothing has taken ownership of it.
   *
   * Both admit callers need this, and the two sides of the handover need opposite answers. The admit chokepoint hands a client to `bindConnection`, which puts it on
   * a disposable stack and writes the connection record; from that write on the client is the device's, torn down by the accessory's own lifecycle. Statements still
   * run afterwards, though, so a throw can land on either side of that write.
   *
   * Disposing unconditionally closes a connection the device is now using and leaves the stale record behind it: the next dial of that address finds the MAC
   * configured, takes the equal-address arm, disposes its own client, and the device sits disconnected for the rest of the run. Disposing never leaks a client that
   * nothing holds - connected to a real device, counting against its few API slots, unreachable by shutdown.
   *
   * The test is ownership itself rather than a proxy for it: does this MAC's connection record hold THIS client. Anything else - no record at all, or a record
   * holding some other client - means this one was never adopted, and closing it is what keeps it from being lost.
   *
   * @param mac    - The device whose connection record answers the ownership question.
   * @param client - The client the faulted call was holding.
   */
  private disposeIfUnowned(mac: string, client: EspHomeClient): void {

    if(this.connections.get(mac)?.client === client) {

      return;
    }

    client[Symbol.dispose]();
  }

  /* Decide whether a device may be configured at all, and announce it, at the earliest point its caller knows the MAC.
   *
   * Both sources ask this, and each asks at the earliest moment it can. Discovery asks before it dials, because an advertisement already carries the MAC and a
   * device the user disabled should never be connected to. An address dial asks after it connects, because nothing knows which device answers at an address until
   * one has. That is the whole difference between the two paths here, and it is a difference in timing rather than in policy.
   *
   * It answers with the device record rather than a bare yes, because building that record IS most of the decision - the resolved log name, the address, the
   * governing manual address - and building it twice would let the announcement and the accessory disagree about the same device.
   *
   * @param discovered    - The identity derived from whichever wire record named this device.
   * @param manualAddress - The listed address that is dialing, when a listed address is what found this device.
   *
   * @returns The record to configure this device from, or null when the device is one we are not configuring.
   */
  private screenDevice(discovered: DiscoveredRatgdo, manualAddress?: string): Nullable<RatgdoDevice> {

    const { address, firmwareVersion, friendlyName, macColon, model, strippedMac, variant } = discovered;

    /* Devices the user disabled are settled for this run: discoveredDevices holds MACs we have decided not to configure for a reason that will not change without
     * user action. Keeping it separate from configuredDevices means a transient connection failure sticks the device in neither set, so a later pass retries the
     * connect path automatically without requiring a Homebridge restart. A MAC already settled here is answered without announcing the device a second time.
     */
    if(this.discoveredDevices.has(macColon)) {

      return null;
    }

    const device: RatgdoDevice = {

      address: address,
      firmwareVersion: firmwareVersion,
      mac: strippedMac,
      manualAddress: manualAddress,
      model: model,
      name: this.resolveLogName(strippedMac) ?? friendlyName ?? "Ratgdo",
      variant: variant
    };

    /* Announce a device the first time this run finds it, and only then. Two callers reach this from different places in their own sequences: the discovered path
     * screens BEFORE it dials, having already found the MAC unconfigured, while the manual path can only screen AFTER its connect, because an address says nothing
     * about which device is at it - so a listed address that reaches a device discovery already configured would otherwise announce it a second time. And a connect
     * that resolves during shutdown has nobody to tell. Neither case is a device to announce, so neither announces.
     */
    if(!this.configuredDevices.has(this.hap.uuid.generate(macColon)) && !this.shutdownController.signal.aborted) {

      this.log.info("Discovered: %s.", this.describeDevice(device));
    }

    // Disabled by the user. Unregister any cached accessory, mark the MAC as discovered-and-skipped so subsequent mDNS broadcasts do not re-log it, and refuse.
    if(!this.featureOptions.test("Device", device.mac)) {

      const uuid = this.hap.uuid.generate(macColon);
      const accessory = this.accessories.get(uuid);

      if(accessory) {

        this.log.info("%s: Removing device from HomeKit.", accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }

      this.discoveredDevices.add(macColon);

      return null;
    }

    return device;
  }

  // The one-line description of a device the discovery and configuration announcements share, so an operator reading either sees the same fields in the same shape.
  private describeDevice(device: RatgdoDevice): string {

    return device.name + " (address: " + device.address + " mac: " + device.mac + " firmware: v" + device.firmwareVersion + " variant: " + device.variant +
      (device.model ? (" [" + device.model + "]") : "") + ")";
  }

  /* Decide what becomes of a connection that has just opened and identified its device. The one chokepoint both sources meet at, and SYNCHRONOUS from end to end.
   *
   * That synchrony is the whole design. Two connects can be in flight to one device at once - a listed address dialing while a discovery pass dials the same MAC, or
   * two listed addresses that turn out to reach one device - and each of them arrives here having already awaited. Deciding ownership without awaiting again means
   * the second arrival reads a map the first one has already written, so no path can construct a device twice and no client can be both kept and forgotten. Every
   * path either keeps the client or disposes it.
   *
   * @param options - See AdmitConnectionOptions.
   */
  private admitConnection({ client, device, discovered, initialState }: AdmitConnectionOptions): void {

    // openConnection's fast paths hand back a connected client without consulting the shutdown signal, so a shutdown landing during the handshake can resolve here
    // after the shutdown handler has already torn every connection down. Re-checking after the connect resolves is what keeps a client from outliving the platform.
    if(this.shutdownController.signal.aborted) {

      client.disconnect();

      return;
    }

    const uuid = this.hap.uuid.generate(discovered.macColon);
    const configured = this.configuredDevices.get(uuid);
    const settled = configured ?? this.configureDevice(uuid, { client, device, discovered, initialState });

    if(configured) {

      if(device.manualAddress === undefined) {

        /* Another connect configured this MAC while this one was in flight - the listed address's, or a second advertisement of the same MAC inside one pass, since
         * discovery keys its snapshot by service name and one device can appear under two. The accessory that exists is the one that stands.
         */
        client[Symbol.dispose]();
      } else {

        this.admitManualAddress(configured, device.manualAddress, { client, device, discovered, initialState });
      }
    }

    /* End the pause of whichever listed address this device now answers at. Without this, a loop that failed a moment before discovery configured its device would
     * sit out its whole retry interval before noticing it has nothing left to do. The address a device was discovered at is not canonical, so it is lower-cased here
     * against a map whose keys already are.
     */
    this.manualPauses.get(settled.device.address.toLowerCase())?.wake("configured");
  }

  /* Build the accessory for a device nothing has configured yet, and take ownership of the connection that found it.
   *
   * @param uuid    - The HomeKit UUID derived from the device's colon MAC.
   * @param options - See AdmitConnectionOptions.
   *
   * @returns The constructed accessory.
   */
  private configureDevice(uuid: string, { client, device, initialState }: AdmitConnectionOptions): RatgdoAccessory {

    // The summary is composed before the device info refresh below, so the two announcements about this device describe it identically.
    const summary = this.describeDevice(device);

    applyDeviceInfo(device, client);

    // Register the PlatformAccessory with Homebridge if it is new. Cached accessories (restored on startup) reuse their persisted services via the acquireService
    // path inside the RatgdoAccessory constructor's configureDevice chain. The Map gives O(1) membership lookup.
    let accessory = this.accessories.get(uuid);

    if(!accessory) {

      accessory = new this.api.platformAccessory(sanitizeName(device.name), uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }

    this.log.info("Configuring: %s.", summary);

    // Construct the accessory with the real telemetry data we just captured. configureDevice walks the configureXxx chain inside the constructor; each method writes
    // the corresponding HAP characteristic from the populated `status`, so HomeKit sees the device's actual current state from the first read.
    const ratgdo = new RatgdoAccessory(this, accessory, device, initialState);

    this.bindConnection(ratgdo, client);
    this.configuredDevices.set(uuid, ratgdo);
    this.api.updatePlatformAccessories([accessory]);

    return ratgdo;
  }

  /* Settle a listed address against a device something else already configured.
   *
   * Three outcomes, decided by which address governs. The governing address is the one listed first, never the one that happened to connect first, because two loops
   * racing over a network finish in a different order every run and the address a connection is opened at is the address its client reconnects to forever after.
   *
   * An address that yields is not a standby: nothing dials it again this run, even if the governing address later fails. The device's own client owns its reconnects
   * at that point, and a second address quietly taking over would put the device back at an address the user ranked lower without telling anyone.
   *
   * @param ratgdo  - The accessory this device already has.
   * @param address - The listed address that just connected.
   * @param options - See AdmitConnectionOptions.
   */
  private admitManualAddress(ratgdo: RatgdoAccessory, address: string, { client, initialState }: AdmitConnectionOptions): void {

    const previous = ratgdo.device.manualAddress;
    const governing = governingAddress(previous, address, this.manualAddresses);

    if(governing !== address) {

      client[Symbol.dispose]();
      ratgdo.log.warn("%s and %s reach the same device. Using %s, which is listed first.", address, governing, governing);

      return;
    }

    /* The same news, told from the other side of the race. Two listed addresses reaching one opener is worth saying once however the two connects happen to land: when
     * the later-listed address answers second it yields above and says it there, and when it answered FIRST this address displaces it here - and without this line the
     * user would be told nothing at all about a duplicate list entry, purely because of which connect the network settled sooner.
     *
     * Only when a DIFFERENT listed address governed this device before. A device discovery alone had configured carries no previous address, and that is the ordinary
     * first connect rather than two entries naming one opener.
     */
    if((previous !== undefined) && (previous !== address)) {

      ratgdo.log.warn("%s and %s reach the same device. Using %s, which is listed first.", previous, address, address);
    }

    ratgdo.device.manualAddress = address;

    // The device is already where this address wanted it. Equal address text is a fast path and nothing more, so the connection this dial opened is surplus.
    if(ratgdo.device.address.toLowerCase() === address) {

      client[Symbol.dispose]();

      return;
    }

    // Discovery configured this device at another address first. The connection this dial already opened becomes the device's connection - dialing a second time
    // would cost the device another of its few API slots to reach an address we are already connected to.
    ratgdo.log.info("Address set to %s by the Device.Address option. Reconnecting.", address);
    this.releaseConnection(ratgdo);
    this.installConnection(ratgdo, address, client, initialState);
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

    /* Bridge the fresh client's first session. The client emitted that session's connect before the lifecycle listener existed, and a fresh client never emits
     * recovered, so this runs what the listener runs for the sessions that follow - the per-session identity refresh, and the online statement `recovered` makes -
     * plus the battery-log subscription, which the client keeps and re-sends itself on every reconnect, so it is made once per client, here.
     */
    this.refreshIdentity(ratgdo, client);
    this.markOnline(ratgdo, client);
    this.setupBatteryLogs(ratgdo, client);
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

    const { manualAddress } = ratgdo.device;

    /* A device a listed address governs is dialed at that address and at no other, which is what the user asked for by listing it. Discovery still hears this device
     * and still reconciles it, so this branch sits ahead of everything below: the membership test underneath would otherwise read an advertisement that does not
     * carry the listed address as a device that has moved, and would redial it straight off the address the user chose.
     */
    if(manualAddress !== undefined) {

      this.warnAnnouncedElsewhere(ratgdo, manualAddress, discovered);

      return;
    }

    // A live connection at an address the device still advertises needs nothing, whether or not that address is the one the pick now favors: a re-advertisement
    // carrying only a changed TXT record, a changed port, or a changed address list lands here, and the identity fields it might have moved are refreshed by the
    // per-session refresh on the client's own next connect.
    if(this.connections.has(ratgdo.device.mac) && isAdvertisedAt(discovered.addresses, ratgdo.device.address)) {

      return;
    }

    // Two ways to arrive here, and the operator is told which: a live connection whose device moved, or no connection at all, which is a device whose last reconnect
    // attempt failed and left it without one.
    if(this.connections.has(ratgdo.device.mac)) {

      ratgdo.log.info("Address changed from %s to %s. Reconnecting.", ratgdo.device.address, discovered.address);
    } else {

      ratgdo.log.info("Reconnecting at %s.", discovered.address);
    }

    /* The existing connection goes before the new one is dialed, rather than after it lands. A device that moved is not answering at the address its client keeps
     * retrying, and leaving that client running through the dial would have two clients racing for one device's API slots. The cost is that a failed dial leaves the
     * device offline with no connection, which is the same next-refresh-retries rule a failed first connect follows.
     */
    this.releaseConnection(ratgdo);

    const outcome = await openConnection({

      expected: ratgdoInitialStateEntityIds(ratgdo.device.variant),
      host: discovered.address,
      keyFor: this.keyFor,
      log: prefixedLog(this.log, () => ratgdo.device.name),
      mac: ratgdo.device.mac,
      openClient: this.openClient,
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

    /* The governance re-check, and the reason this method needs one where the admit chokepoint does not. Every other connect decides what it owns synchronously after
     * its own await; this one read the governance BEFORE its await and would write after it. A manual dial that adopted this device inside that window has already
     * installed its connection and set the governing address, and installing over it would replace the connection record without disposing what it replaced - leaving
     * the manual client connected, unreferenced, and beyond the reach of shutdown, with the device sitting at the discovered address the user had overruled.
     *
     * Two things are re-read here rather than trusted from before the await: whether a listed address now governs this device, and whether a connection for this MAC
     * exists that this call did not install - the same question asked of the store rather than of the device. Either one means this dial lost the race, so its client
     * is disposed and nothing is written. Nothing awaits between this check and installConnection, so what is true here is still true at that write.
     */
    if((ratgdo.device.manualAddress !== undefined) || this.connections.has(ratgdo.device.mac)) {

      outcome.client[Symbol.dispose]();

      return;
    }

    this.installConnection(ratgdo, discovered.address, outcome.client, outcome.initialState);
  }

  /* Tell the operator that a device set to a listed address is announcing itself somewhere else, once per address it announces.
   *
   * Only worth saying when the device is actually in trouble. A device that is connected and working at its listed address while advertising others is the ordinary
   * case - a dual-stack device announces an IPv6 address the user did not list, and nothing is wrong. A device that is OFFLINE while announcing an address other
   * than the one it is set to has usually moved, and the listed address is now the thing keeping it unreachable, which the user is the only one who can fix.
   *
   * @param ratgdo        - The governed accessory.
   * @param manualAddress - The listed address governing it.
   * @param discovered    - The identity derived from the advertisement that triggered this pass.
   */
  private warnAnnouncedElsewhere(ratgdo: RatgdoAccessory, manualAddress: string, discovered: DiscoveredRatgdo): void {

    const announced = discovered.address.toLowerCase();

    if((announced === manualAddress) || ratgdo.isOnline) {

      return;
    }

    const said = ratgdo.device.mac + "@" + announced;

    if(this.announcedElsewhere.has(said)) {

      return;
    }

    this.announcedElsewhere.add(said);
    ratgdo.log.warn("This device is set to %s by the Device.Address option, but it is announcing itself at %s. Update the option if the device has moved.",
      manualAddress, discovered.address);
  }

  /* Give up a device's connection: announce it offline and tear the connection record down. Both halves belong together - a connection record this platform no
   * longer holds means a device HomeKit should be showing as unreachable - so neither caller decides them separately.
   *
   * @param ratgdo - The accessory whose connection is released.
   */
  private releaseConnection(ratgdo: RatgdoAccessory): void {

    ratgdo.updateState({ id: "availability", state: "offline" });
    this.connections.get(ratgdo.device.mac)?.stack.dispose();
    this.connections.delete(ratgdo.device.mac);
  }

  /* Put a configured device onto a connection that is already open at a new address: record the address, take ownership of the client, and hand the accessory the
   * state that connection captured on its way up.
   *
   * `device.address` is written only once the new address has connected, so the field always names the address the live connection was actually opened against.
   *
   * @param ratgdo       - The accessory being moved.
   * @param address      - The address the connection was opened at.
   * @param client       - The connected client.
   * @param initialState - The state burst that connection captured.
   */
  private installConnection(ratgdo: RatgdoAccessory, address: string, client: EspHomeClient, initialState: ReadonlyMap<EntityId, TelemetryEvent>): void {

    this.bindConnection(ratgdo, client);

    /* The address is written only once the binding has returned. `bindConnection` runs the post-connect chain, and a fault anywhere in it - the listener
     * registration, the online announcement, the battery-log subscription - leaves this call without a connection. Writing the address first would leave the device
     * claiming an address nothing is connected at, and the listed-address loop reads exactly that field to decide it has nothing left to do: the device would be
     * passed over on every later attempt and sit disconnected for the run. Nothing inside `bindConnection` or the session work it runs reads `device.address`, so
     * moving the write after it costs those callers nothing.
     */
    ratgdo.device.address = address;

    /* Replay the captured initial state into the accessory through the same translation the live listener uses. A fresh client's initial-state burst landed inside
     * the connect before any listener existed, so the accessory learns it from the snapshot here - exactly as it learns the full-state burst the device sends
     * after every ordinary reconnect through the retained telemetry listener. This runs after bindConnection so markOnline has already run and the replay carries
     * the post-reconnect truth.
     */
    const telemetry = this.buildTelemetryListener(ratgdo);

    for(const event of initialState.values()) {

      telemetry(event);
    }
  }

  /* Lifecycle subscription. Availability follows the client's reachability verdicts through the one translation the webUI applies too (protocol/lifecycle.ts), and
   * the statement is applied before anything else so a diagnostic line lands after the disconnect it explains. The work that belongs to a session rather than to
   * availability is this listener's own. Every `connect` refreshes the identity fields, because a session can begin on new firmware whether or not an outage came
   * before it, and a `connect` that finds the opener still online is a drop the client healed on its first attempt, which the log reports at info so a flaky link
   * stays visible without a false offline. A `connect` after `lost` says nothing of its own, since `recovered` follows it and makes the announcement. A `disconnect`
   * carries the encryption and identity diagnostics: only the terminal disconnect is sure to hold a permanent cause, because `lost` carries the first failed
   * attempt's error and a permanent one can arrive on a later attempt. The connect that opened this client emitted before this subscription existed, so
   * `bindConnection` runs that first session's work itself.
   */
  private buildLifecycleListener(ratgdo: RatgdoAccessory, client: EspHomeClient): (event: LifecycleEvent) => void {

    return (event: LifecycleEvent): void => {

      const statement = translateLifecycle(event);

      switch(statement) {

        case "offline":

          ratgdo.updateState({ id: "availability", state: "offline" });

          break;

        case "online":

          this.markOnline(ratgdo, client);

          break;

        case null:

          break;

        default: {

          // Compile-time exhaustiveness: if a new availability statement is added, this statement fails to type-check and forces us to handle it explicitly.
          statement satisfies never;

          break;
        }
      }

      switch(event.kind) {

        case "connect":

          this.refreshIdentity(ratgdo, client);

          if(ratgdo.isOnline) {

            ratgdo.log.info("%sRatgdo reconnected after a brief connection drop.", encryptionGlyph(client));
          }

          return;

        case "disconnect":

          // Disconnect cause narrows through the typed error hierarchy. The auto-reconnect supervisor already filters PermanentError subclasses out of the retry
          // budget, so the encryption-key and wrong-device cases below are diagnostic only - the reconnect loop has ended, and the device will not come back without
          // a configuration fix or, for a device another one has replaced at its address, a fresh connection.
          if(isEncryptionError(event.cause)) {

            ratgdo.log.error("Encryption configuration error - check the device's API encryption key: %s", event.cause.message);
          }

          if(event.cause instanceof DeviceIdentityError) {

            ratgdo.log.error("The wrong device answered, so the connection is refused: %s", event.cause.message);
          }

          return;

        case "lost":
        case "recovered":

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
   * wire-level SUBSCRIBE_LOGS_REQUEST that backs this listener is owned by `setupBatteryLogs()`, which the fresh client's bridge invokes once; the client re-sends
   * the subscribed level itself on every reconnect.
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

  /* The per-session work: refresh the identity fields - the model and the firmware version - from the session's device info, and push them to the accessory's
   * information service. It runs on every session, the fresh client's first through its bridge and each later one through the lifecycle `connect`, because a
   * firmware upgrade is the case the refresh exists for and the device can reboot into one over a drop the client heals on its first attempt, which makes no
   * availability statement at all.
   */
  private refreshIdentity(ratgdo: RatgdoAccessory, client: EspHomeClient): void {

    applyDeviceInfo(ratgdo.device, client);
    ratgdo.refreshInfo();
  }

  /* The online statement: announce the connection in the log, with the encryption indicator, and dispatch availability=online so the accessory answers HomeKit
   * again. It runs at each moment the opener becomes reachable - the fresh client's bridge and the client's `recovered` verdict - so a reconnect after an outage
   * announces exactly once and a drop the client heals before any verdict announces nothing here. The log fires unconditionally rather than gating on a status
   * transition: initial discovery already set `status.availability = true` in buildInitialStatus, so a transition check would suppress the log on first connect.
   */
  private markOnline(ratgdo: RatgdoAccessory, client: EspHomeClient): void {

    ratgdo.log.info("%sRatgdo connected.", encryptionGlyph(client));
    ratgdo.updateState({ id: "availability", state: "online" });
  }

  /* Subscribe the client to verbose logs when the Disco firmware variant is in play. The Disco does not expose battery state as a dedicated entity - we extract it
   * from verbose log lines instead. The client keeps the subscribed level and re-sends it itself on every reconnect, so the fresh client's bridge subscribes once.
   */
  private setupBatteryLogs(ratgdo: RatgdoAccessory, client: EspHomeClient): void {

    if(ratgdo.hints.discoBattery) {

      client.subscribeToLogs(LogLevel.VERBOSE);
    }
  }
}
