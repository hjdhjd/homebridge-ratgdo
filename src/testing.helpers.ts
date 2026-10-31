/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: Cross-cutting test helpers shared across every unit test in homebridge-ratgdo.
 *
 * The plugin's production code reads and writes through Homebridge's HAP shapes (Service, Characteristic, PlatformAccessory) on every per-accessory configure path,
 * and it drives the device over the esphome-client API. A unit test meets the HAP the plugin meets at runtime and never a real ESPHome connection, so this file owns
 * the harness each of those surfaces needs:
 *
 *   - The Homebridge runtime, loaded once from this repository's tree through the homebridge-plugin-utils Homebridge test double: Homebridge's own PlatformAccessory
 *     over the hap-nodejs copy Homebridge loads, whose Service and Characteristic namespaces this file exports so every suite reads HAP's classes and constants from
 *     one source. Every API double is the kit's TestHomebridgeApi over that runtime, built through the kit's server-warning watcher so a test fails when Homebridge
 *     logs a warning or an error it leaves untaken. homebridge-plugin-utils' REAL acquireService / validService run against real HAP services, so HAP's own
 *     defaults, value validation and name writes apply, and a read or a write goes through HAP's own request path.
 *   - A platform double (makeTestPlatform) carrying the kit's API, a REAL FeatureOptions engine (so userOptions thread through the production feature-option logic), a
 *     capturing log, an optional recording MQTT double, and a fake esphome-client.
 *   - A fake esphome-client (TestEspHomeClient) that records command dispatch and lets a test drive lifecycle / telemetry / log subscriptions and the session's
 *     health, plus typed telemetry factories that build the initial-state snapshot the accessory is born from.
 *   - A real-platform builder (buildPlatform) that constructs the production platform on the kit's API with the platform's injectable defaults set to the doubles -
 *     a TestClock, the library's mDNS browser double, a fake client factory, and the MQTT double - so a suite drives discovery, admission, restore and shutdown
 *     through the platform's own code with no network and no real time.
 *
 * Co-located under src/ so the broad tsconfig.json type-checks this file alongside everything else; tsconfig.build.json excludes the *.helpers.ts pattern so it never
 * reaches the published dist/.
 */
// The explicit-resource-management bridge, first here as it is first in the plugin's entry point: this file is the suite's composition root, so every test that
// constructs a feed or an accessory reads against globals that are guaranteed to exist.
import "homebridge-plugin-utils/polyfills";
import type { API, HAP, Logging } from "homebridge";
import type { Clock, HomebridgePluginLogging, MdnsService, MqttClient, Nullable } from "homebridge-plugin-utils";
import { ConnectionError, CoverOperation, EncryptionKeyMissingError, EncryptionRequiredError, EspHomeError, HealthState, LockState, PermanentError, disconnectedHealth,
  entityId } from "esphome-client";
import type { ConnectionHealth, DeviceInfo, EntityId, EspHomeClient, LifecycleEvent, LogEventData, NoiseServerHello, PskResolver, TelemetryEvent } from "esphome-client";
import { FeatureOptions, onAbort } from "homebridge-plugin-utils";
import { PLATFORM_NAME, PLUGIN_NAME, RATGDO_MDNS_SERVICE_TYPE } from "./settings.ts";
import { TestClock, TestMdnsBrowserFactory, TestMqttClient, capturingLog, expectAt, loadHomebridge, makeService, makeTxtStrings,
  watchServerWarnings } from "homebridge-plugin-utils/testing";
import type { TestHomebridgeApi, TestLogEntry, TestMdnsBrowser, TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import { featureOptionCategories, featureOptions } from "./options.ts";
import type { OpenEspHomeClient } from "./connection.ts";
import { RatgdoAccessory } from "./device.ts";
import type { RatgdoDevice } from "./types.ts";
import { RatgdoPlatform } from "./platform.ts";
import type { RatgdoPlatformDefaults } from "./platform.ts";
import type { RatgdoResolvedConfig } from "./options.ts";
import type { RatgdoTxtKey } from "./discovery.ts";
import { RatgdoVariant } from "./types.ts";

// The Homebridge runtime every suite runs on, loaded once from this repository's tree: the hap-nodejs copy and the PlatformAccessory class Homebridge itself loads
// here, so the handlers the accessory binds meet the HAP they meet at runtime.
const runtime = await loadHomebridge(import.meta.url);

// Every API double the suites build comes from this builder. Created at this module's top level, it registers its check once in each suite that imports the
// harness, and after every test, once that test's own cleanups have run, it fails the test when Homebridge's server logged a warning or an error the test left
// untaken.
const makeApi = watchServerWarnings(runtime);

// The runtime's HAP Service and Characteristic namespaces, the one source the suites read HAP's service and characteristic classes and their constants from.
export const { Characteristic, Service } = runtime.hap;

// A recorded esphome-client command dispatch. id is the branded entity id the device resolved through its registry; payload is the command options object.
export interface RecordedCommand {

  id: string;
  payload: unknown;
}

/* Construction options for TestEspHomeClient. Each field seeds one of the configurable reads so a test tailors the device's view of the wire without a live connection.
 * `onListen` and `throwOnListen` seed the two registration behaviors a consumer's connect body has to survive: a client that emits the instant a listener attaches, and
 * one whose registration fails outright.
 */
export interface TestEspHomeClientOptions {

  capabilities?: { encryption: { active: boolean } };
  deviceInfo?: Nullable<DeviceInfo>;
  entities?: { objectId: string; type: string }[];
  isEncrypted?: boolean;
  onListen?: (event: string, client: TestEspHomeClient) => void;
  snapshot?: ReadonlyMap<EntityId, TelemetryEvent>;
  throwOnListen?: boolean;
}

/* A fake esphome-client covering the surface the plugin calls: command (recorded), deviceInfo / snapshot / entitiesByDevice / capabilities / isEncrypted
 * (configurable), disconnect / subscribeToLogs (recorded), and on (registers a handler and returns a Disposable that records its own disposal). emit lets a test drive
 * a lifecycle / telemetry / log event through the registered handlers. Construction options seed the configurable reads so a test tailors the device's view of the wire
 * without a live connection.
 *
 * Disposal emits a disconnect through the handler map on every call, which is a deliberate modeling choice: a TestEspHomeClient stands for a client the open factory
 * already returned, and such a client always has a transport for its teardown to tear down. The real client emits only where a transport or a receiver existed, so a
 * never-connected client disposed straight away would emit nothing...the double does not model that arm, because no consumer disposes a client it never opened.
 */
export class TestEspHomeClient implements Disposable {

  public readonly commands: RecordedCommand[] = [];
  // Each listener Disposable pushes its own event name here when it runs, so a test can prove every listener a connect registered was released, and released once.
  public readonly listenerDisposals: string[] = [];
  public readonly logSubscriptions: number[] = [];
  public disconnected = false;
  // A counter rather than a boolean, because one counter answers both "was it disposed" and "how many times", where a boolean beside a counter would be two statements
  // of one fact and a double-dispose would read the same as a single one.
  public disposeCount = 0;
  // Whether the client holds a live session, the one fact health() reports. A client the open factory returned is connected, so it starts live; a lifecycle connect
  // or disconnect driven through emit keeps it in step, and a test sets it directly to model a client between sessions that has announced nothing.
  public live = true;
  private readonly capabilitiesValue: { encryption: { active: boolean } };
  private readonly deviceInfoValue: Nullable<DeviceInfo>;
  private readonly entities: { objectId: string; type: string }[];
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>();
  private readonly isEncryptedValue: boolean;
  private readonly onListen: ((event: string, client: TestEspHomeClient) => void) | undefined;
  // The latest-state cache is a MUTABLE Map copied from the seed snapshot, because captureInitialState reads snapshot() ONCE and its telemetry handler re-checks
  // completeness against THAT Map reference: deliverState must add the entity to this map before notifying, mirroring the ESPHome client's mutate-then-notify ordering.
  // Copying (rather than aliasing options.snapshot) keeps a caller's passed-in map immune to our mutations.
  private readonly stateCache: Map<EntityId, TelemetryEvent>;
  private readonly throwOnListen: boolean;

  public constructor(options: TestEspHomeClientOptions = {}) {

    this.capabilitiesValue = options.capabilities ?? { encryption: { active: false } };
    this.deviceInfoValue = options.deviceInfo ?? null;
    this.entities = options.entities ?? [];
    this.isEncryptedValue = options.isEncrypted ?? false;
    this.onListen = options.onListen;
    this.stateCache = new Map(options.snapshot ?? []);
    this.throwOnListen = options.throwOnListen ?? false;
  }

  // Record a command dispatch. The device resolves the branded id through its entity registry before calling, so the recorded id is the resolved wire id.
  public command(id: string, payload: unknown): void {

    this.commands.push({ id, payload });
  }

  // Return the configured device info, mirroring the ESPHome client's deviceInfo().
  public deviceInfo(): Nullable<DeviceInfo> {

    return this.deviceInfoValue;
  }

  // Return the configured latest-state snapshot, mirroring the ESPHome client's snapshot().
  public snapshot(): ReadonlyMap<EntityId, TelemetryEvent> {

    return this.stateCache;
  }

  /* Commit a state event to the cache and THEN notify telemetry listeners, mirroring the ESPHome client's mutate-then-notify ordering. captureInitialState's slow path
   * relies on this ordering: its telemetry handler re-reads completeness from the snapshot Map, so the entity must be present in the cache before the handler fires.
   * Tests drive the slow path by calling deliverState per entity until the required set completes.
   */
  public deliverState(event: TelemetryEvent): void {

    this.stateCache.set(entityId(event.type, event.entity), event);
    this.emit("telemetry", event);
  }

  // Return the configured discovered-entity list for device 0, mirroring the ESPHome client's entitiesByDevice(0).
  public entitiesByDevice(): { objectId: string; type: string }[] {

    return this.entities;
  }

  // Return the configured capability set, mirroring the ESPHome client's capabilities().
  public capabilities(): { encryption: { active: boolean } } {

    return this.capabilitiesValue;
  }

  // Mirror the real client's isEncrypted getter, so a snapshot's encryption state can be driven from a fixture.
  public get isEncrypted(): boolean {

    return this.isEncryptedValue;
  }

  /* Mirror the ESPHome client's health(): a real health record, so isConnectionLive reads the library's own union. A live client answers a connected record carrying
   * its encryption state, and any other answers the library's disconnected baseline.
   */
  public health(): ConnectionHealth {

    return this.live ? { connectedAtMs: 0, consecutiveStalls: 0, encrypted: this.isEncryptedValue, lastInboundActivityAt: 0, state: HealthState.CONNECTED } :
      disconnectedHealth();
  }

  // Record a manual disconnect.
  public disconnect(): void {

    this.disconnected = true;
  }

  /* Count the disposal and emit a disconnect, mirroring the ESPHome client's `[Symbol.dispose]`. openConnection's catch calls `client?.[Symbol.dispose]()` on every
   * failure branch, so a connection test reads `disposeCount` to confirm the partially-constructed client was torn down. The emit is synchronous and runs through the
   * handler map, so a teardown-ordering test can prove a consumer detached its listeners before the client went down: a listener still registered here hears the
   * disconnect, and one already released does not.
   */
  public [Symbol.dispose](): void {

    this.disposeCount++;
    this.emit("lifecycle", { cause: undefined, kind: "disconnect" });
  }

  // Record a per-connection log subscription request.
  public subscribeToLogs(level: number): void {

    this.logSubscriptions.push(level);
  }

  /* Register an event handler and return a Disposable that detaches it, mirroring the EventBus on() contract the platform composes onto the connection record. A
   * `throwOnListen` client refuses before anything is recorded, so a consumer's totality catch runs against a client that registered nothing; an `onListen` client
   * fires the hook synchronously once the handler is in the map, which is the window where a real client can deliver an event to a listener that has only just
   * attached. The returned Disposable records its own event name before detaching, so `listenerDisposals` reads as the release log.
   */
  public on(event: string, handler: (event: never) => void): Disposable {

    if(this.throwOnListen) {

      throw new Error("listener registration failed");
    }

    const list = this.handlers.get(event) ?? [];

    list.push(handler as (event: unknown) => void);
    this.handlers.set(event, list);
    this.onListen?.(event, this);

    return { [Symbol.dispose]: (): void => {

      this.listenerDisposals.push(event);
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((entry) => entry !== handler));
    } };
  }

  /* Drive every handler registered for an event. Tests use this to deliver a lifecycle / telemetry / log event through the same path production wired. A lifecycle
   * connect or disconnect moves the live state first, as the real client publishes its health record before it announces the session boundary, so a handler reading
   * health() sees the session the event describes.
   */
  public emit(event: "lifecycle", data: LifecycleEvent): void;
  public emit(event: "telemetry", data: TelemetryEvent): void;
  public emit(event: "log", data: LogEventData): void;
  public emit(event: string, data: unknown): void {

    if(event === "lifecycle") {

      const kind = (data as LifecycleEvent).kind;

      if([ "connect", "disconnect" ].includes(kind)) {

        this.live = kind === "connect";
      }
    }

    for(const handler of this.handlers.get(event) ?? []) {

      handler(data);
    }
  }
}

// Cast a TestEspHomeClient at the boundary to the EspHomeClient type captureInitialState and openConnection consume directly. The cast lives here in the harness so
// connection-test bodies that call captureInitialState directly carry no `as unknown` casts of their own; the double implements every method those functions reach.
export function asEspHomeClient(client: TestEspHomeClient): EspHomeClient {

  return client as unknown as EspHomeClient;
}

/* One recorded factory invocation, narrowed to the open-options fields a connection test asserts on: the static clientId, the host, the key resolver the connection
 * core hands the client (or null for a connection opened plaintext-first), and the logger and cancellation signal it forwards. Recording these is what lets a test
 * prove openConnection forwarded the right values across the injected boundary (the headline of the client-factory port), rather than merely that the call returned a
 * result. The logger and the signal are required rather than optional because openConnection forwards its own log argument and the caller's shutdown signal
 * unconditionally, so a recorded invocation always carries both and optionality would misstate the contract.
 */
export interface RecordedOpenOptions {

  clientId?: Nullable<string>;
  host: string;
  logger: HomebridgePluginLogging;
  psk?: Nullable<string> | PskResolver;
  signal: AbortSignal;
}

/* A per-call open handler: it answers each invocation on its own terms, receiving the options that invocation carried and its zero-based call index. This is what a
 * caller reaches for when the outcome has to differ between calls - a first connect that defers while a second resolves, a per-host answer, a failure only the retry
 * recovers from.
 */
export type OpenClientHandler = (options: RecordedOpenOptions, index: number) => Promise<TestEspHomeClient>;

/* A permanent connection failure esphome-client does not name. The library's PermanentError is the abstract root its reconnect supervisor refuses to retry, and
 * every subclass it ships is an encryption or negotiation failure with a branch of its own in the connection core. The core's PermanentError branch is the
 * contract for any other subclass a release may add, so the suite drives that branch with a subclass of its own rather than a shipped class whose meaning the core
 * already reads in an earlier branch.
 */
export class TestPermanentError extends PermanentError {}

/* Build a fake `openEspHomeClient` factory for openConnection and status-feed tests. Pass a TestEspHomeClient to model a successful open (the factory resolves it), an
 * Error to model a failed open (the factory rejects with it - an EncryptionKeyInvalidError, a PermanentError subclass, etc.), or a handler to answer each call on its
 * own terms. The fixed forms are wrapped into a handler at construction, so there is exactly one recording path and one `calls` array however the factory was built.
 * The returned function matches openEspHomeClient's port type through the one construction-boundary cast a test needs, so the test body itself stays cast-free, and the
 * `calls` array records the options each invocation received so a test can assert what openConnection forwarded across the boundary (every recorded field, the logger
 * adapter included).
 */
export function makeFakeOpenClient(result: Error | OpenClientHandler | TestEspHomeClient): OpenEspHomeClient & { calls: RecordedOpenOptions[] } {

  const calls: RecordedOpenOptions[] = [];

  // Normalize the fixed forms into the handler shape up front, so the recording below has one path to take rather than branching per invocation on what it was built
  // from. A function result is already a handler; an Error rejects on every call; a client resolves on every call.
  const handler: OpenClientHandler = (typeof result === "function") ? result : async (): Promise<TestEspHomeClient> => {

    if(result instanceof Error) {

      throw result;
    }

    return result;
  };
  const open = (options: RecordedOpenOptions): Promise<TestEspHomeClient> => {

    const index = calls.length;

    calls.push(options);

    return handler(options, index);
  };

  return Object.assign(open, { calls }) as unknown as OpenEspHomeClient & { calls: RecordedOpenOptions[] };
}

/* The key resolver a recorded factory invocation carried, for a test that plays the device's side of the handshake by hand - a first contact's hello, or a reconnect's
 * after the connection was admitted. It throws when the invocation carried none, so a test reading a resolver that was never handed over fails at the read rather than
 * at a confusing call of null.
 *
 * @param call - The recorded invocation, typically `openClient.calls[n]`.
 *
 * @returns The resolver that invocation carried.
 */
export function resolverOf(call: RecordedOpenOptions | undefined): PskResolver {

  const psk = call?.psk;

  if(typeof psk !== "function") {

    throw new Error("The recorded open carried no key resolver.");
  }

  return psk;
}

/* A per-call open handler that answers as an encrypting device does, for the parts of esphome-client's handshake a consumer can observe. It hands the invocation's
 * resolver the given server hello, exactly as the client does after reading one, and then settles the way the client settles on what the resolver did: an exception
 * the resolver throws rejects as thrown when it is an EspHomeError, and otherwise as a ConnectionError (`CONNECT_FAILED`) carrying it as `cause`; a resolver answering
 * no key fails with EncryptionKeyMissingError; an invocation carrying no resolver at all fails with EncryptionRequiredError, which is how an encrypted device answers a
 * plaintext client; and a resolver answering a key resolves the client. It never checks the key itself - a test asserts on what the resolver answered, and a
 * mismatched key is the fixed-error form's to model.
 *
 * @param options.client - The client the open resolves when the resolver answers a key.
 * @param options.hello  - The server hello the device announces.
 *
 * @returns The handler, for makeFakeOpenClient.
 */
export function openThroughHello({ client, hello }: { client: TestEspHomeClient; hello: NoiseServerHello }): OpenClientHandler {

  return async (options: RecordedOpenOptions): Promise<TestEspHomeClient> => {

    const { psk } = options;

    if(typeof psk !== "function") {

      throw new EncryptionRequiredError("The device requires encryption, and no key resolver was offered.");
    }

    let key: Nullable<string>;

    try {

      key = psk(hello);
    } catch(error) {

      if(error instanceof EspHomeError) {

        throw error;
      }

      throw new ConnectionError("The key resolver threw.", "CONNECT_FAILED", { cause: error });
    }

    if(!key) {

      throw new EncryptionKeyMissingError("The key resolver answered no key for this device.");
    }

    return client;
  };
}

// One answer a scripted dial gives: a client the dial resolves with, an error it rejects with, or a promise the row settles itself when it chooses.
export type ScriptedAnswer = Error | Promise<TestEspHomeClient> | TestEspHomeClient;

/* Build a client factory that answers each host from that host's own script, one answer per dial in order, and parks every dial past the end of its host's script
 * until the dial's own signal aborts. The bound is what lets a loop's row read a dial count: a loop that dials without pausing stops once its script runs out rather
 * than spinning on answers that settle at once and starving the TestClock, so it fails the row's count instead of running the suite out to its timeout. A parked
 * dial ends as a real one does at shutdown, rejecting with the signal's reason, and a dial made under a signal that has already aborted rejects at once, since no
 * abort event is coming for it to wait on.
 *
 * @param scripts - Each host's answers, in the order its dials receive them. A host with no script parks its first dial.
 *
 * @returns The factory, recording every dial as makeFakeOpenClient does.
 */
export function makeScriptedOpenClient(scripts: Readonly<Partial<Record<string, readonly ScriptedAnswer[]>>>): ReturnType<typeof makeFakeOpenClient> {

  const answered = new Map<string, number>();

  return makeFakeOpenClient(async (options: RecordedOpenOptions): Promise<TestEspHomeClient> => {

    const index = answered.get(options.host) ?? 0;

    answered.set(options.host, index + 1);

    const answer = scripts[options.host]?.[index];

    if(answer === undefined) {

      const { promise, reject } = Promise.withResolvers<TestEspHomeClient>();

      onAbort(options.signal, () => reject(options.signal.reason));

      return promise;
    }

    if(answer instanceof Error) {

      throw answer;
    }

    return answer;
  });
}

/* Build a single telemetry event in the wire-faithful shape the esphome-client snapshot carries, mirroring esphome-client's own test factory: a { entity, key, type,
 * ...fields } literal cast to TelemetryEvent at this construction boundary. The cast is the same one esphome-client's own latest-state-cache tests use - the wire shape
 * is a schema-derived union with all-optional value fields, so the boundary cast is the blessed way to synthesize one.
 */
export function makeTelemetry(type: string, objectId: string, fields: Record<string, unknown> = {}): TelemetryEvent {

  return { entity: objectId, key: 0, type, ...fields } as unknown as TelemetryEvent;
}

// A cover telemetry event. position is the 0-1 float ESPHome reports; currentOperation is the CoverOperation the device translates into a HomeKit door state.
export function makeCoverEvent(objectId: string, position: number, currentOperation: CoverOperation = CoverOperation.IDLE): TelemetryEvent {

  return makeTelemetry("cover", objectId, { currentOperation, position });
}

// A lock telemetry event carrying a LockState.
export function makeLockEvent(objectId: string, state: LockState = LockState.UNLOCKED): TelemetryEvent {

  return makeTelemetry("lock", objectId, { state });
}

// A light telemetry event carrying the boolean on-state.
export function makeLightEvent(objectId: string, on: boolean): TelemetryEvent {

  return makeTelemetry("light", objectId, { state: on });
}

// A switch telemetry event carrying the boolean on-state.
export function makeSwitchEvent(objectId: string, on: boolean): TelemetryEvent {

  return makeTelemetry("switch", objectId, { state: on });
}

// A binary_sensor telemetry event carrying the boolean detected-state.
export function makeBinarySensorEvent(objectId: string, on: boolean): TelemetryEvent {

  return makeTelemetry("binary_sensor", objectId, { state: on });
}

/* Build the initial-state snapshot the accessory is born from. The device keys its reads by entityId(type, objectId), so we key each event the same way. The default
 * sets cover the Ratgdo variant's required entities at sensible resting values (door closed, light off, lock unlocked, obstruction clear, laser / led / vehicle off);
 * pass overrides to replace individual entries. The Konnected variant uses different object ids, so a Konnected test supplies its own entries.
 */
export function makeRatgdoInitialState(overrides: TelemetryEvent[] = []): Map<EntityId, TelemetryEvent> {

  const base = [

    makeCoverEvent("door", 0),
    makeBinarySensorEvent("obstruction", false),
    makeLightEvent("light", false),
    makeLockEvent("lock_remotes", LockState.UNLOCKED),
    makeSwitchEvent("laser", false),
    makeSwitchEvent("led", false),
    makeBinarySensorEvent("vehicle_detected", false)
  ];

  const state = new Map<EntityId, TelemetryEvent>();

  for(const event of [ ...base, ...overrides ]) {

    state.set(entityId(event.type, event.entity), event);
  }

  return state;
}

// Build a Konnected-variant initial-state snapshot. Konnected exposes different object ids (garage_door / garage_light / lock / str_output) than Ratgdo, so its
// resting snapshot is built separately.
export function makeKonnectedInitialState(overrides: TelemetryEvent[] = []): Map<EntityId, TelemetryEvent> {

  const base = [

    makeCoverEvent("garage_door", 0),
    makeBinarySensorEvent("obstruction", false),
    makeLightEvent("garage_light", false),
    makeLockEvent("lock", LockState.UNLOCKED),
    makeSwitchEvent("str_output", false)
  ];

  const state = new Map<EntityId, TelemetryEvent>();

  for(const event of [ ...base, ...overrides ]) {

    state.set(entityId(event.type, event.entity), event);
  }

  return state;
}

/**
 * Build a RatgdoDevice descriptor with sensible defaults. Pass overrides for the fields a test varies (variant, mac, model, name).
 *
 * @param overrides - partial RatgdoDevice fields to override the defaults.
 *
 * @returns a fully-populated RatgdoDevice.
 */
export function makeTestDevice(overrides: Partial<RatgdoDevice> = {}): RatgdoDevice {

  return {

    address: "192.0.2.10",
    firmwareVersion: "2.0.0",
    mac: "AABBCCDDEEFF",
    model: "1.0.0",
    name: "Test Ratgdo",
    variant: RatgdoVariant.RATGDO,
    ...overrides
  };
}

/** Build the resolved mDNS service a browser derives for a Ratgdo advertisement, composed from the library's own fixture so what a test advertises and what the
 * classify reads cannot disagree. Each TXT field becomes one record string through the library's `makeTxtStrings`, the inverse of the `txtEntries` read the
 * classify performs.
 *
 * The instance name is the TXT `mac` when one is present and the fixed "ratgdo" otherwise - one rule, so two devices advertising two MACs get two instance names,
 * which matters because the library keys its snapshot by instance name and a test advertising two devices must not collide them. The friendly name never names
 * the instance.
 *
 * @param txt       - The TXT fields to advertise, keyed by the ESPHome wire names the classify reads.
 * @param addresses - The advertised IP addresses, in the order the browser would list them. Defaults to a single TEST-NET-1 address.
 *
 * @returns the resolved service parseRatgdoService consumes.
 */
export function makeRatgdoService(txt: Partial<Record<RatgdoTxtKey, Nullable<string>>>, addresses: readonly [string, ...string[]] = ["192.0.2.10"]): MdnsService {

  const label = txt.mac ?? "ratgdo";

  return makeService({ addresses, host: "ratgdo-" + label, instance: label, port: 6053, serviceType: RATGDO_MDNS_SERVICE_TYPE, strings: makeTxtStrings(txt) });
}

// The platform double's read surface, as the accessory and its configure chain consume it. The construction-boundary cast to RatgdoPlatform happens
// in constructRatgdo.
export interface TestPlatform {

  // The kit's Homebridge API double: the accessory reaches HAP through its `hap`, and the harness makes the accessory under test through its platformAccessory.
  api: TestHomebridgeApi;
  // The time source every timer the accessory arms reads, standing in for the production platform's own clock. Typed as the production Clock because that is the whole
  // of what the accessory consumes; the handles that drive it are typed TestClock where a test holds them.
  clock: Clock;
  // The double's config is the platform's RESOLVED shape, not the raw configuration properties, so a test can never seed a legacy property the accessory would never
  // have seen: the platform resolves those into this shape before any accessory is built.
  config: RatgdoResolvedConfig;
  featureOptions: FeatureOptions;
  getEspHomeClient: (mac: string) => TestEspHomeClient | undefined;
  hap: HAP;
  log: HomebridgePluginLogging;
  mqtt: Nullable<TestMqttClient>;
  resolveLogName: (mac: string) => string | undefined;
}

/* Options for makeTestPlatform: the fake client to back getEspHomeClient, the clock the platform double publishes, the platform config, whether to attach a recording
 * MQTT double, and the feature-option strings. The clock is typed TestClock rather than Clock because the option exists to hand a caller a handle it can advance and
 * inspect, which a production Clock offers none of; a caller that omits it gets a fresh one it reads back off the result.
 */
export interface MakeTestPlatformOptions {

  client?: TestEspHomeClient;
  clientUnavailable?: boolean;
  clock?: TestClock;
  config?: TestPlatform["config"];
  mqtt?: boolean;
  userOptions?: string[];
}

// The handles makeTestPlatform returns: the platform double plus the doubles and capture buffer a test asserts against.
export interface MakeTestPlatformResult {

  client: TestEspHomeClient;
  clock: TestClock;
  entries: readonly TestLogEntry[];
  mqtt: Nullable<TestMqttClient>;
  platform: TestPlatform;
}

/* Build a platform double around the kit's Homebridge API and a REAL FeatureOptions engine seeded with the supplied userOptions, so the production feature-option
 * logic (test / value / getInteger / logFeature) runs unchanged. The API comes from the file's server-warning builder, so a warning Homebridge logs on its account
 * fails the test that drew it, and its HAP namespace is the platform double's own, as production's platform reads `api.hap`. A capturing log records every line; an
 * optional recording MQTT double captures subscriptions and publishes; a fake esphome-client backs getEspHomeClient. resolveLogName mirrors the production platform
 * method exactly (empty string collapses to undefined). A TestClock stands in for the production platform's time source, so every deadline an accessory built on
 * this double arms is driven by advancing that clock. The returned handles let a test assert on the captured logs, the recorded commands, and the MQTT traffic, and
 * drive the clock.
 */
export function makeTestPlatform(options: MakeTestPlatformOptions = {}): MakeTestPlatformResult {

  const api = makeApi();
  const log = capturingLog();
  const client = options.client ?? new TestEspHomeClient();
  const clock = options.clock ?? new TestClock();
  // The double reports through the same capturing log the platform double carries, so the guarded publish's failure line lands in `entries` exactly as production
  // would log it and a test can read it there rather than reaching into the double.
  const mqtt = options.mqtt ? new TestMqttClient({ log }) : null;
  const fo = new FeatureOptions(featureOptionCategories, featureOptions, options.userOptions);
  const platform: TestPlatform = {

    api,
    clock,
    config: options.config ?? { debug: false, options: undefined },
    featureOptions: fo,
    getEspHomeClient: (): TestEspHomeClient | undefined => (options.clientUnavailable ? undefined : client),
    hap: api.hap,
    log,
    mqtt,
    resolveLogName: (mac: string): string | undefined => {

      const raw = fo.value("Device.LogName", mac);

      return raw?.length ? raw : undefined;
    }
  };

  return { client, clock, entries: log.entries, mqtt, platform };
}

/* Options for buildRatgdoAccessory: device fields to override, initial-state snapshot, the clock the accessory's timers arm on, platform config, client availability,
 * MQTT double, feature-option strings, and a seed. The seed is how a test describes an install Homebridge restored from its cache: it receives the accessory before
 * the restore and gives it the services a previous run wired on, so the configure chain runs against an accessory that already carries them; left unset, the
 * accessory carries only what Homebridge's own PlatformAccessory is born with, which is the first-run case every other test wants. The clock carries
 * makeTestPlatform's typing and its omit-for-a-fresh-one behavior.
 */
export interface BuildRatgdoAccessoryOptions {

  clientUnavailable?: boolean;
  clock?: TestClock;
  config?: TestPlatform["config"];
  device?: Partial<RatgdoDevice>;
  initialState?: Map<EntityId, TelemetryEvent>;
  mqtt?: boolean;
  seed?: (accessory: TestPlatformAccessory) => void;
  userOptions?: string[];
}

// The handles buildRatgdoAccessory returns: the constructed production accessory plus the underlying doubles and capture buffer a test asserts against.
export interface BuildRatgdoAccessoryResult {

  accessory: TestPlatformAccessory;
  client: TestEspHomeClient;
  clock: TestClock;
  entries: readonly TestLogEntry[];
  mqtt: Nullable<TestMqttClient>;
  platform: TestPlatform;
  ratgdo: RatgdoAccessory;
}

/* Construct a REAL RatgdoAccessory against the doubles - the device-test workhorse, analogous to HBPU's per-suite construction helpers. The accessory is Homebridge's
 * own PlatformAccessory, made through the platform double's API with the display name and the identity production gives it, and everything the accessory then does
 * runs the real production code against real HAP. Returns the constructed accessory plus every handle a test asserts on: the PlatformAccessory (to read services /
 * characteristics and the changes HAP raised), the captured log entries, the fake client (to read recorded commands), the clock the accessory's timers arm on (to
 * reach a deadline without waiting), and the recording MQTT double (when enabled).
 *
 * The accessory is on the API double's bridge before the RatgdoAccessory sees it, as it is in production, where a cached accessory joins the bridge at its restore
 * and the platform constructs the RatgdoAccessory afterward. The restore runs Homebridge's own order: the accessory is cached and given Homebridge's FirmwareRevision
 * placeholder, handed to configureAccessory, and bridged once that call returns. No ratgdo platform is constructed here, so a stand-in whose configureAccessory does
 * nothing takes its place.
 */
export function buildRatgdoAccessory(options: BuildRatgdoAccessoryOptions = {}): BuildRatgdoAccessoryResult {

  const device = makeTestDevice(options.device);
  const { client, clock, entries, mqtt, platform } = makeTestPlatform({ clientUnavailable: options.clientUnavailable, clock: options.clock, config: options.config,
    mqtt: options.mqtt, userOptions: options.userOptions });
  const accessory = new platform.api.platformAccessory(device.name, platform.hap.uuid.generate(device.mac));
  const initialState = options.initialState ?? ((device.variant === RatgdoVariant.KONNECTED) ? makeKonnectedInitialState() : makeRatgdoInitialState());

  options.seed?.(accessory);

  platform.api.restorePlatformAccessories({ accessories: [accessory], platform: { configureAccessory: (): void => undefined }, platformName: PLATFORM_NAME,
    pluginIdentifier: PLUGIN_NAME });

  const ratgdo = constructRatgdo(platform, accessory, device, initialState);

  return { accessory, client, clock, entries, mqtt, platform, ratgdo };
}

// Construct a REAL RatgdoAccessory on the platform double. The platform cast bridges the double to the production constructor's parameter type, the one cast a
// device's construction needs, held here so every construction the harness makes goes through it.
function constructRatgdo(platform: TestPlatform, accessory: TestPlatformAccessory, device: RatgdoDevice, initialState: ReadonlyMap<EntityId, TelemetryEvent>):
RatgdoAccessory {

  return new RatgdoAccessory(platform as unknown as ConstructorParameters<typeof RatgdoAccessory>[0], accessory, device, initialState);
}

/* Options for makeCachedAccessory: the API the accessory is made through, and the opener and configuration the previous run served it under.
 *
 * @property api         - The API double of the platform the suite will restore the accessory into.
 * @property mac         - The opener's MAC in the plugin's identity form, from which the accessory's UUID is derived as the platform derives it.
 * @property userOptions - The feature-option strings the previous run carried, which decide the services its construction attached.
 * @property variant     - The opener's variant.
 */
export interface MakeCachedAccessoryOptions {

  api: TestHomebridgeApi;
  mac?: string;
  userOptions?: string[];
  variant?: RatgdoVariant;
}

/* An accessory a previous run left in Homebridge's cache, for a platform suite to restore: made through the given API under the UUID the platform derives for the
 * opener, and given every service and characteristic that run's construction attached by constructing a RatgdoAccessory over it on a device-side platform double
 * and disposing it. What a suite restores is therefore what a real run caches, rather than a list of services kept by hand. Nothing is restored here.
 */
export function makeCachedAccessory({ api, mac = "AABBCCDDEEFF", userOptions, variant = RatgdoVariant.RATGDO }: MakeCachedAccessoryOptions): TestPlatformAccessory {

  const device = makeTestDevice({ mac, name: "Garage", variant });
  const accessory = new api.platformAccessory(device.name, api.hap.uuid.generate(colonMac(mac)));
  const previous = constructRatgdo(makeTestPlatform({ userOptions }).platform, accessory, device, (variant === RatgdoVariant.KONNECTED) ?
    makeKonnectedInitialState() : makeRatgdoInitialState());

  previous[Symbol.dispose]();

  return accessory;
}

/* The MAC a device-info record carries, from the plugin's identity form: the wire spells it with colons and the pipeline keys on the stripped form, so this is the
 * one place a suite turns one into the other.
 */
export function colonMac(mac: string): string {

  return (mac.match(/../g) ?? []).join(":");
}

/* Options for makeOpenerClient: the opener the client stands for, and the session it opens.
 *
 * @property deviceInfo - Members of the device-info record beyond the MAC, as a session of this opener reports them.
 * @property encrypted  - Whether the session negotiated encryption.
 * @property mac        - The opener's MAC in the plugin's identity form, which the record reports in the wire's colon form.
 * @property variant    - The opener's variant, which decides the initial-state snapshot the client already holds.
 */
export interface MakeOpenerClientOptions {

  deviceInfo?: Partial<DeviceInfo>;
  encrypted?: boolean;
  mac?: string;
  variant?: RatgdoVariant;
}

/* The client double an opener's dial answers with: a device-info record naming the opener, so admission reads the MAC the connection is for, and an initial-state
 * snapshot already complete for the variant, so the capture resolves at once and the accessory is born from it.
 */
export function makeOpenerClient({ deviceInfo = {}, encrypted = false, mac = "AABBCCDDEEFF", variant = RatgdoVariant.RATGDO }: MakeOpenerClientOptions = {}):
TestEspHomeClient {

  const snapshot = (variant === RatgdoVariant.KONNECTED) ? makeKonnectedInitialState() : makeRatgdoInitialState();

  return new TestEspHomeClient({ capabilities: { encryption: { active: encrypted } },
    deviceInfo: { esphomeVersion: "2.0.0", macAddress: colonMac(mac), projectVersion: "1.0.0", ...deviceInfo }, isEncrypted: encrypted, snapshot });
}

/* The advertisement an opener answers discovery with, for a platform suite: a Ratgdo or Konnected record carrying the opener's MAC at the given address, in the
 * shape makeRatgdoService builds from the TXT fields the classify reads.
 *
 * @param options.address - The address the opener advertises.
 * @param options.mac     - The opener's MAC in the plugin's identity form.
 * @param options.variant - The opener's variant, which decides the project name it advertises.
 *
 * @returns The resolved service the browser double delivers.
 */
export function makeOpenerService({ address = "192.0.2.10", mac = "AABBCCDDEEFF", variant = RatgdoVariant.RATGDO }: { address?: string; mac?: string;
  variant?: RatgdoVariant; } = {}): MdnsService {

  const project = (variant === RatgdoVariant.KONNECTED) ? "konnected.garage-door-gdov2-s" : "ratgdo.esp32";

  /* eslint-disable camelcase */
  return makeRatgdoService({ esphome_version: "2.0.0", friendly_name: "Garage", mac, project_name: project, project_version: "1.0.0" }, [address]);
  /* eslint-enable camelcase */
}

/* Options for buildPlatform: how the platform's dials are answered, whether its configuration names a broker, and the feature-option strings it carries.
 *
 * @property mqtt        - Name a broker in the configuration, so the platform builds its MQTT client, which the builder's factory answers with the MQTT double.
 * @property openClient  - The client factory every dial the platform makes opens through. Defaults to one refusing every dial, so no row reaches a network.
 * @property userOptions - The feature-option strings the configuration carries.
 */
export interface BuildPlatformOptions {

  mqtt?: boolean;
  openClient?: OpenEspHomeClient;
  userOptions?: string[];
}

// The handles buildPlatform returns: the real platform, the API double and the doubles its defaults were set to, and the platform's captured log entries.
export interface BuildPlatformResult {

  api: TestHomebridgeApi;
  // The browser the platform's discovery built, once Homebridge has finished launching.
  browser: () => TestMdnsBrowser;
  clock: TestClock;
  entries: readonly TestLogEntry[];
  // Emit Homebridge's didFinishLaunching, which starts the platform's discovery, and answer the browser that discovery built.
  launch: () => TestMdnsBrowser;
  // The MQTT double the platform's factory built and the lifetime signal the platform handed that factory, each null when the configuration names no broker.
  mqtt: Nullable<TestMqttClient>;
  mqttSignal: Nullable<AbortSignal>;
  platform: RatgdoPlatform;
}

/* Construct a REAL RatgdoPlatform on the kit's API with every injectable default set to a double - the platform-lifecycle workhorse. The clock is a TestClock, the
 * discovery's browser is the library's double, every dial opens through the factory the caller supplies, and the MQTT client is the MQTT double, so a suite drives
 * discovery, admission, the bridge, restore and shutdown through the platform's own code with no socket and no real time. Constructing it starts nothing: discovery
 * begins only once a suite emits didFinishLaunching, and a configuration naming no broker builds no MQTT client.
 *
 * The MQTT double lives on the signal the platform hands its factory, as the client lives on it, so the platform's abort tears the double down too. The double is
 * cast to the client type here, the one cast the MQTT factory needs, and the log and API casts are the ones a platform constructor needs, because the kit's API
 * deliberately omits registerPlatform, user and version.
 */
export function buildPlatform({ mqtt = false, openClient = makeFakeOpenClient(new ConnectionError("No device answers in this suite.", "CONNECT_FAILED")),
  userOptions }: BuildPlatformOptions = {}): BuildPlatformResult {

  const api = makeApi();
  const browserFactory = new TestMdnsBrowserFactory();
  const clock = new TestClock();
  const log = capturingLog();
  const doubles: { mqtt: Nullable<TestMqttClient>; mqttSignal: Nullable<AbortSignal> } = { mqtt: null, mqttSignal: null };

  const mqttFactory: NonNullable<RatgdoPlatformDefaults["mqttFactory"]> = (config, init) => {

    const double = new TestMqttClient({ clock, log: config.log });
    const signal = init?.signal;

    if(signal) {

      onAbort(signal, () => double.abort(signal.reason));
    }

    doubles.mqtt = double;
    doubles.mqttSignal = signal ?? null;

    return double as unknown as MqttClient;
  };

  const config = { options: userOptions, platform: PLATFORM_NAME, ...(mqtt ? { mqttUrl: "mqtt://broker.test:1883" } : {}) };
  const platform = new RatgdoPlatform(log as unknown as Logging, config, api as unknown as API, { browserFactory, clock, mqttFactory, openClient });
  const browser = (): TestMdnsBrowser => expectAt(browserFactory.createCalls, browserFactory.createCalls.length - 1, "the browser the platform's discovery built")
    .browser;

  return {

    api,
    browser,
    clock,
    entries: log.entries,
    launch: (): TestMdnsBrowser => {

      api.emit("didFinishLaunching");

      return browser();
    },
    mqtt: doubles.mqtt,
    mqttSignal: doubles.mqttSignal,
    platform
  };
}
