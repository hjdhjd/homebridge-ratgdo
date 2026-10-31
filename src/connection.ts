/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * connection.ts: Establish an ESPHome client connection and capture the device's initial state, with the client factory as an injectable port.
 *
 * The platform's discovery path needs a connected client whose LatestStateCache already holds initial state for every required entity before it constructs the
 * accessory. That sequence - open the client, wait for the state burst, and classify every failure mode - lives here as free functions rather than platform methods,
 * so the dependency on esphome-client's `openEspHomeClient` factory is an explicit, injectable parameter (defaulting to the real factory) instead of a hard module edge.
 * A unit test passes a fake factory and drives every branch (fast / slow / timeout / shutdown, plus the error taxonomy) without a live device or fake timers.
 *
 * Two entry points open a connection, and they differ in one thing only: a discovered device is already identified when its connect begins, while a device reached at
 * an address the user typed is identified from the device-info record the connect produces. Both therefore run through one private core that owns the open, the
 * failure taxonomy, every diagnostic, and the single teardown of a client no caller will receive; each entry point supplies only the step that answers what to wait
 * for on the connected client. Keeping the taxonomy in one body is what keeps the two paths from classifying the same fault differently.
 *
 * The caller supplies where encryption keys are stored, as a lookup; this module decides which MAC a key is chosen for, and refuses a device that is not the one its
 * connection is for. Every connection the plugin and its settings page open passes through here, so holding the rule in this one core is what keeps the paths from
 * keying a device, or admitting one, differently. The lookup and the client-factory port are the module's only external dependencies, which keeps the functions
 * testable without a live device or a feature-option engine.
 */
import { EncryptionKeyInvalidError, EncryptionKeyMissingError, EncryptionRequiredError, NegotiationFailedError, PermanentError, openEspHomeClient } from "esphome-client";
import type { EntityId, EspHomeClient, NoiseServerHello, PskResolver, TelemetryEvent } from "esphome-client";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { classifyDeviceInfo, normalizeMac } from "./discovery.ts";
import { presentEntityIds, ratgdoInitialStateEntityIds } from "./entities.ts";
import type { DiscoveredRatgdo } from "./discovery.ts";
import { RATGDO_INITIAL_STATE_TIMEOUT } from "./settings.ts";
import type { RatgdoDevice } from "./types.ts";
import util from "node:util";
import { waitWithSignal } from "homebridge-plugin-utils";

/* The injectable ESPHome client-factory port. Aliased to the real factory's type so the boundary stays bound to esphome-client's signature: if `openEspHomeClient`'s
 * shape changes, this alias and every default-arg site that resolves to it move with it. Production never passes it (the default real factory runs); a unit test passes
 * a fake that resolves a synthetic client or rejects with a typed error.
 */
export type OpenEspHomeClient = typeof openEspHomeClient;

/* Where a caller's encryption keys are stored, as the connect core reads them: the key stored for a device, called with the MAC in the plugin's identity form, or with
 * no MAC for the global key. An empty, null, or undefined answer means no key. The core calls it with the MAC the device announced in its server hello, else the MAC
 * the connection was dialed for, else with none - the choice is the core's, so every caller keys every device by one rule and only says where keys are kept.
 */
export type EncryptionKeyLookup = (mac?: string) => Nullable<string | undefined>;

/* The refusal of a device that is not the one its connection is for: a server hello announcing another MAC, or a device-info record naming a MAC other than the one
 * the connection is for, or naming none. It is a PermanentError, so esphome-client neither retries the construction nor continues a reconnect loop past it - a device
 * answering as another MAC does not become the right device on the next attempt - and the connect core classifies it once, as `identity-mismatch`.
 *
 * @param identity.expected - The MAC the connection is for, in the plugin's identity form.
 * @param identity.reported - The MAC the device announced or reported, in the same form, or an empty string when it named none.
 */
export class DeviceIdentityError extends PermanentError {

  public constructor({ expected, reported }: { expected: string; reported: string }) {

    super(((reported.length > 0) ? reported : "a device reporting no MAC address") + " answered, but this connection is for " + expected + ".",
      "IDENTITY_MISMATCH");
  }
}

/* The success payload of `openConnection`: the live, connected client plus the initial-state snapshot `captureInitialState` waited for. It is carried by the `ok: true`
 * arm of the `ConnectionOutcome` union; the failure arms carry a typed `ConnectionFailureReason` instead, so a caller branches on `outcome.ok` and, on failure, acts on
 * the classified reason without parsing log output.
 */
export interface ConnectionResult {

  client: EspHomeClient;
  initialState: ReadonlyMap<EntityId, TelemetryEvent>;
}

/* The classification of every way `openConnection` can fail. `shutdown` is not a fault - the platform is tearing down - and a caller acts on it by standing down
 * silently; `encryption-invalid` marks a configured key that does not match the device and `encryption-missing` marks a device that requires an API key that was not
 * supplied; `identity-mismatch` marks a device that announced or authenticated as a MAC other than the one its connection is for; `permanent` and `unknown` mark a
 * device that is unreachable or failed for an unclassified reason; `timeout` marks a device that opened the connection but did not push its initial state in the
 * budget; `unsupported` marks a device announcing an ESPHome API version outside the range this plugin's client speaks, which no amount of retrying changes - only a
 * firmware or plugin update does. This is the typed sentinel a second consumer branches on in place of scraping the log line each branch emits.
 */
export type ConnectionFailureReason = "encryption-invalid" | "encryption-missing" | "identity-mismatch" | "permanent" | "shutdown" | "timeout" | "unknown" |
  "unsupported";

/* `openConnection`'s outcome, a discriminated union on `ok`: `ok: true` carries the connected client and its captured initial state, `ok: false` carries the classified
 * failure reason. Every failure branch has already logged its diagnostic and disposed the partially-constructed client, so a caller reads the outcome purely to decide
 * what to do next - construct the accessory, surface an error to the user, or stand down on shutdown.
 */
export type ConnectionOutcome = ({ ok: true } & ConnectionResult) | { ok: false; reason: ConnectionFailureReason };

/* Everything `openManualConnection` can fail with: every way a connection fails, plus the one refusal only an address dial can make. `unrecognized` marks a device that
 * answered and negotiated perfectly well but is not an opener this plugin supports, which no retry changes - the user typed the address of something else. A
 * discovered device cannot reach this verdict, because its advertisement was classified before anything dialed it.
 */
export type ManualConnectionFailureReason = ConnectionFailureReason | "unrecognized";

/* The success payload of `openManualConnection`: everything `openConnection` yields, plus the identity the device-info record named. The identity is the point of the
 * call - an address alone says nothing about which device answers there - so it is carried beside the client rather than left for the caller to re-derive.
 */
export interface ManualConnectionResult extends ConnectionResult {

  discovered: DiscoveredRatgdo;
}

// `openManualConnection`'s outcome, the same discriminated union `ConnectionOutcome` is over the wider reason set and the identity-bearing success arm.
export type ManualConnectionOutcome = ({ ok: true } & ManualConnectionResult) | { ok: false; reason: ManualConnectionFailureReason };

/* What `describePermanentCause` answers for a refusal a user can act on: the one sentence that tells the user about it, and the reason a connect classifies it as.
 *
 * @property diagnostic - The arguments of the line a caller logs at error, spread into the call: a complete sentence as the format, and the device's own words about
 *                        the fault as its parameter. The device's words are never the format, so no `%` in them is ever read as a format token.
 * @property reason     - The classified reason a connect that ended on this cause reports.
 */
export interface PermanentCauseDescription {

  diagnostic: readonly [format: string, message: string];
  reason: Extract<ConnectionFailureReason, "encryption-invalid" | "encryption-missing" | "identity-mismatch" | "unsupported">;
}

/* Options for `captureInitialState`. The caller supplies the connected client, the wait-list of entities that must appear in the cache before construction proceeds,
 * and the one signal the wait honors. The function owns no budget, so a caller that wants the wait bounded composes its deadline into that signal, and a test bounds
 * it in milliseconds with any signal it likes rather than with a Clock port or fake timers.
 *
 * @property client   - The connected ESPHome client whose LatestStateCache we observe.
 * @property expected - The caller's declaration of which entities matter for initial state; intersected with the device's advertised entity list.
 * @property signal   - The one cancellation source the wait honors, whatever the caller composed it from. An abort rejects the wait with this signal's reason.
 */
export interface CaptureInitialStateOptions {

  client: EspHomeClient;
  expected: readonly EntityId[];
  signal: AbortSignal;
}

/* Options for `openConnection`. The factory port (`openClient`) defaults to the real `openEspHomeClient`; the caller passes a lookup over wherever it stores keys, so
 * this module never touches the feature-option engine and the caller never decides which MAC a key is chosen for.
 *
 * @property expected       - The initial-state wait-list, forwarded to `captureInitialState`.
 * @property host           - The device's hostname or IP address.
 * @property keyFor         - Where the caller's encryption keys are stored. See EncryptionKeyLookup.
 * @property log            - The static-prefix logging adapter the client uses for connect-internal messages.
 * @property mac            - The MAC discovery named, in the plugin's identity form: the device this connection is for.
 * @property openClient     - The injectable client-factory port. Defaults to the real `openEspHomeClient`.
 * @property shutdownSignal - The platform-wide shutdown signal. Cancels the client-factory call and is composed with the capture deadline.
 * @property timeoutSeconds - The budget, in seconds, of the capture deadline the core builds once the client is open. Defaults to `RATGDO_INITIAL_STATE_TIMEOUT`.
 */
export interface OpenConnectionOptions {

  expected: readonly EntityId[];
  host: string;
  keyFor: EncryptionKeyLookup;
  log: HomebridgePluginLogging;
  mac: string;
  openClient?: OpenEspHomeClient;
  shutdownSignal: AbortSignal;
  timeoutSeconds?: number;
}

/* Options for `openManualConnection`, which is `OpenConnectionOptions` without the wait-list and without the MAC: the caller cannot declare which entities matter until
 * the connected device has said which variant it is, so this call derives the wait-list for itself out of the identity it classifies, and an address names no device,
 * so the connection is for no MAC until one answers.
 */
export type OpenManualConnectionOptions = Omit<OpenConnectionOptions, "expected" | "mac">;

// What the connect core takes: the address dial's options, widened by the MAC a discovered device's connection is for. Both entry points' options satisfy it.
type OpenAndCaptureOptions = OpenManualConnectionOptions & Partial<Pick<OpenConnectionOptions, "mac">>;

/* What a caller's wait-list step answers once the client is connected: the entities to wait for and whatever else that caller derived from the same client, or a
 * refusal of what answered. The refusal arm is generic and defaults to nothing, so an entry point that cannot refuse - the discovered path, which knows its device
 * before it dials - carries no refusal arm at all and its outcome's reason set stays exactly `ConnectionFailureReason`.
 */
type WaitListOutcome<TIdentity, TRefusal> = { expected: readonly EntityId[]; identity: TIdentity; ok: true } | { ok: false; reason: TRefusal };

/* What the shared core answers its two entry points: the connected client, whatever that caller's step derived from it, and the captured initial state - or the
 * classified reason the connect produced no usable device. Each entry point then reshapes this into its own published outcome, naming the identity in its own terms.
 */
type CaptureOutcome<TIdentity, TRefusal> = { client: EspHomeClient; identity: TIdentity; initialState: ReadonlyMap<EntityId, TelemetryEvent>; ok: true } |
  { ok: false; reason: ConnectionFailureReason | TRefusal };

/* Establish the ESPHome client connection for a device discovery already identified, AND wait for the LatestStateCache to populate with initial state for every
 * stateful entity. The core below owns the open, the wait, and the classification of anything that goes wrong: any failure tears down the partially-constructed
 * client and returns a failure outcome carrying the classified `ConnectionFailureReason`, signalling the caller to skip this discovery attempt (the next mDNS
 * refresh will retry). The platformAccessory (if any) stays registered with Homebridge - acquireService() is safe to call more than once and reuses existing service
 * objects on the retry's RatgdoAccessory construction.
 *
 * The factory's `logger` field accepts the EspHomeLogging shape; the caller passes a static-prefix adapter built from device.name so client-internal messages (connect
 * retries, heartbeat, encryption fallback) carry device context. The adapter is permanent for the client's lifetime, so a HomeKit rename later does not retitle
 * client-internal logs - the accessory's dynamic-name logger is used for everything else.
 */
export async function openConnection({ expected, ...options }: OpenConnectionOptions): Promise<ConnectionOutcome> {

  /* The discovered path's wait-list step: answer the caller's own declaration and nothing else. It never reads device info, because the advertisement already
   * identified this device, and it has no refusal arm at all - which is what keeps this entry point's outcome exactly the union it has always been.
   */
  const outcome = await openAndCapture(options, () => ({ expected, identity: undefined, ok: true }));

  if(!outcome.ok) {

    return outcome;
  }

  return { client: outcome.client, initialState: outcome.initialState, ok: true };
}

/* Establish an ESPHome client connection against a bare address and identify whatever answered there.
 *
 * This is the manual path's whole connect. A user who lists an address has told us where to dial but cannot tell us what is there, so the identity a discovered
 * device carries from its advertisement is derived here instead, from the device-info record the connected client read. Ordering is forced: the variant decides the
 * initial-state wait-list, so the classification has to sit between the open and the capture rather than beside either of them.
 *
 * The connection this call returns IS the device's connection. Nothing probes and hangs up first, because a device with few API slots should not spend two of them
 * to answer one question, and the record the handshake already produced answers it.
 *
 * @param options - Everything `openConnection` takes except the wait-list, which this call derives from the identity it classifies.
 *
 * @returns The connected client, the identity, and the captured initial state, or the classified reason the address yielded no opener.
 */
export async function openManualConnection(options: OpenManualConnectionOptions): Promise<ManualConnectionOutcome> {

  const { host, log } = options;

  /* The manual path's wait-list step, and the one place `unrecognized` is produced. A null classification means something answered at this address that is not an
   * opener we support - a missing MAC, a missing project name, a project name matching no known variant - and the diagnostic names the address, because the address
   * is the only thing the user gave us to correct.
   */
  const outcome = await openAndCapture(options, (client): WaitListOutcome<DiscoveredRatgdo, "unrecognized"> => {

    const discovered = classifyDeviceInfo(client.deviceInfo(), host);

    if(!discovered) {

      log.error("The device at %s is not a Ratgdo or Konnected opener this plugin supports.", host);

      return { ok: false, reason: "unrecognized" };
    }

    return { expected: ratgdoInitialStateEntityIds(discovered.variant), identity: discovered, ok: true };
  });

  if(!outcome.ok) {

    return outcome;
  }

  return { client: outcome.client, discovered: outcome.identity, initialState: outcome.initialState, ok: true };
}

/* The shared connect core: open the client, let the caller's step answer what to wait for, capture initial state, and classify anything that goes wrong. Both entry
 * points run through this body, so the failure taxonomy, every user-facing diagnostic, and the teardown of a client no caller will receive each exist exactly once.
 *
 * The catch reads the signals this core itself holds, the shutdown signal first and then its own capture deadline. Shutdown is checked first because it is not a
 * failure - the platform is going away and any in-flight connect should tear down silently. A capture timeout is recognized by identity, the deadline having fired
 * and the caught value being that deadline's own reason, so a TimeoutError from any other source - the library's connect timeout among them - falls to the generic
 * branch as the library's failure. The refusals a user can act on - the identity refusal, a key fault, and an API version the client cannot speak - share the one
 * branch the describer words, ahead of the branch every other PermanentError takes, so the user sees a focused diagnostic instead of a wrapped stack trace. Everything
 * else falls through to the generic else with the unfiltered util.inspect output.
 *
 * Every failure - a thrown one and a refused one alike - leaves through the single tail below rather than returning from where it was decided, which is what makes
 * the dispose one statement instead of one per branch.
 *
 * The key rule lives here too, and it answers which key a connection offers separately from which device the connection will accept. The two are held apart on
 * purpose, because a single MAC doing both jobs would let what a connection learns about its device change the key it offers.
 *
 * Key choice is a pure function of what is known before the handshake: the MAC the device's server hello announces, else the MAC the connection was dialed for, else
 * no MAC at all, which reads the global key. The client calls its resolver on every connection attempt, reconnects included, so a first contact and every reconnect
 * choose alike, and nothing the connection learns afterward - admission included - ever moves that choice. The resolver records the MAC it keyed for, which is what
 * admission and the firmware warning read. A connection dialed for a MAC whose lookup answers no key gets no resolver at all and opens plaintext first, as a keyless
 * device always has: a resolver would make the client try the encrypted handshake first on every connect and reconnect, and it could only answer no key.
 *
 * Identity is what a connection is FOR, and one rule answers it: the MAC the connection was dialed for, else for an address dial the MAC its key was chosen for, else
 * - once admitted - the MAC its device reported. It feeds only the refusals. A hello announcing another MAC is refused inside the resolver, before the lookup is read,
 * so no key is ever offered to it; and once the open resolves, admission compares the device-info record's MAC with the MAC the connection is for whenever one is
 * known, an absent one included as a mismatch, plaintext connections among them. On a plaintext connection that MAC is the device's own unauthenticated word, so there
 * the rule guards against another device answering at an address the opener has left, not against a device that lies about who it is. Admission compares nothing
 * only on an address dial keyed for no MAC or opened plaintext, which is for the MAC its device reported from then on, so a reconnect whose hello announces another
 * MAC is refused - while the key it offers stays the one its first contact chose. The platform and the settings page put every later session to the same comparison
 * through `identityRefusal`, so a device that takes the opener's address while the client is reconnecting is refused as a first contact would refuse it. Every
 * refusal is the same error, so the catch classifies them once.
 *
 * @param options      - The connect options minus the wait-list.
 * @param resolveWaitList - The caller's step, run on the connected client before anything is captured.
 *
 * @returns The connected client and the step's identity, or the classified failure reason.
 */
async function openAndCapture<TIdentity, TRefusal = never>({ host, keyFor, log, mac, openClient = openEspHomeClient, shutdownSignal,
  timeoutSeconds = RATGDO_INITIAL_STATE_TIMEOUT }: OpenAndCaptureOptions,
resolveWaitList: (client: EspHomeClient) => WaitListOutcome<TIdentity, TRefusal>): Promise<CaptureOutcome<TIdentity, TRefusal>> {

  /* Client is a plain, manually-disposed variable rather than a `using` declaration. A `using` binding runs its disposal on any scope exit, including the
   * success-path return below, which would tear down the freshly-connected client before the caller ever receives it. Manual disposal keeps teardown confined to
   * the one failure tail, where cleanup is actually the intent.
   */
  let client: EspHomeClient | undefined;
  let reason: ConnectionFailureReason | TRefusal;

  // The capture deadline, built only once the client is open so the budget covers state capture and never the handshake, and held here so the catch can recognize
  // its reason.
  let deadline: AbortSignal | undefined;

  // The MAC this connection is for, which only the refusals read.
  let belongsTo = mac;

  // The MAC the resolver's latest call keyed for: a MAC, null for the global key, and undefined while the resolver has never run, as on a plaintext connection.
  let keyedFor: Nullable<string> | undefined;

  const resolver: PskResolver = (hello: NoiseServerHello): Nullable<string> => {

    const announced = (hello.macAddress === undefined) ? undefined : normalizeMac(hello.macAddress);

    if((belongsTo !== undefined) && (announced !== undefined) && (announced !== belongsTo)) {

      throw new DeviceIdentityError({ expected: belongsTo, reported: announced });
    }

    const chosen = announced ?? mac;

    keyedFor = chosen ?? null;

    const key = keyFor(chosen);

    return key?.length ? key : null;
  };

  try {

    /* The caller's shutdown signal cancels the factory call itself, not just the state capture that follows it. The factory applies the signal to its initial
     * attempt and to every construction retry, rejecting with the signal's reason, so an abandoned connect settles within its current attempt or backoff cycle
     * instead of running out the whole retry budget. The composed capture-timeout signal stays out of this call by design: that budget covers state capture, not
     * the handshake, and the factory owns its own construction-retry budget.
     */
    client = await openClient({

      clientId: "homebridge-ratgdo",
      host: host,
      logger: log,
      psk: ((mac !== undefined) && !keyFor(mac)?.length) ? null : resolver,
      signal: shutdownSignal
    });

    // Admission, ahead of the caller's step so a refused device is never classified or captured. It throws rather than returning, so its refusal leaves through
    // the catch below exactly as the resolver's does.
    const expected = belongsTo ?? ((typeof keyedFor === "string") ? keyedFor : undefined);
    const refusal = (expected === undefined) ? null : identityRefusal({ client, expected });

    if(refusal) {

      throw refusal;
    }

    const reported = reportedMac(client);

    belongsTo ??= (reported.length > 0) ? reported : undefined;

    const waitList = resolveWaitList(client);

    if(waitList.ok) {

      deadline = AbortSignal.timeout(timeoutSeconds * 1000);

      const initialState = await captureInitialState({ client, expected: waitList.expected, signal: AbortSignal.any([ shutdownSignal, deadline ]) });

      return { client, identity: waitList.identity, initialState, ok: true };
    }

    // The step refused what answered. Only the step knows what it was looking for, so it has already told the user what it found instead.
    reason = waitList.reason;
  } catch(error) {

    // The refusals a user can act on - the identity refusal from the resolver or from admission alike, a key fault, and an API version this plugin's client cannot
    // speak - are worded and classified by the one describer the platform's lifecycle listener reads at a reconnect's give-up too.
    const permanent = describePermanentCause(error);

    // Shutdown is not a failure - the platform is tearing down and this in-flight connect is no longer interesting. Silent classification so the log is not filled
    // with spurious "Failed to establish connection" lines on every device that happened to be mid-handshake when the user stopped Homebridge.
    if(shutdownSignal.aborted) {

      reason = "shutdown";
    } else if(permanent) {

      // Every cause the describer words is a PermanentError subclass, so this branch sits ahead of the PermanentError one below, where the first matching branch
      // wins and the two in the other order would leave this one unreachable.
      log.error(...permanent.diagnostic);
      reason = permanent.reason;

      // A key chosen for no MAC means the device's firmware announced none, and that limit is worth naming beside the key fault: no key stored for this device can
      // ever be offered to it. A connection that works on the global key never reaches here, so the warning never repeats for a working device.
      if(isEncryptionError(error) && (keyedFor === null)) {

        log.warn("This device can use only the global encryption key, because its firmware does not announce its MAC address. " +
          "Update it to ESPHome 2025.4.0 or newer to give it a key of its own.");
      }
    } else if(error instanceof PermanentError) {

      log.error("Permanent connection error: %s", util.inspect(error, { depth: null }));
      reason = "permanent";
    } else if(deadline?.aborted && (error === deadline.reason)) {

      // The timeout verdict is this core's own deadline, its reason compared by identity, so a TimeoutError of any other source - the library's connect timeout
      // among them - falls to the generic branch below as the library's failure.
      log.error("Initial-state capture timed out after %s seconds. The device opened the connection but failed to push entity state.", timeoutSeconds);
      reason = "timeout";
    } else {

      log.error("Failed to establish connection: %s", util.inspect(error, { depth: null }));
      reason = "unknown";
    }
  }

  // The one teardown, reached by every failure however it was decided, so a partially-constructed client is disposed exactly once and never on the success path.
  client?.[Symbol.dispose]();

  return { ok: false, reason };
}

/* Refresh a device's identity fields from the connected client's device info. The mDNS TXT record seeds both the model and the firmware version at discovery, but the
 * client's deviceInfo() is the authoritative source for each and a firmware upgrade can change either, so both are refreshed from it here. The platform applies this
 * before it constructs the accessory, so the accessory's first characteristic write is already correct, and again on every session through the platform's per-session
 * identity refresh, which is what carries a post-upgrade version into HomeKit. A field whose member the record omits keeps whatever discovery seeded, so a partial
 * record never blanks an identity.
 *
 * @param device - The device record whose model and firmware version are refreshed in place.
 * @param client - The connected client whose device info is read.
 */
export function applyDeviceInfo(device: RatgdoDevice, client: EspHomeClient): void {

  const info = client.deviceInfo();

  if(info?.projectVersion !== undefined) {

    device.model = info.projectVersion;
  }

  if(info?.esphomeVersion !== undefined) {

    device.firmwareVersion = info.esphomeVersion;
  }
}

/* Wait until the ESPHome client's LatestStateCache holds an entry for every entity the caller has declared as required for initial state, then return the populated
 * cache. Construction of `RatgdoAccessory` is gated on this so the accessory is born with real telemetry data instead of placeholder defaults - the discovery path
 * eliminates the "we don't know yet" window rather than modeling it.
 *
 * The `expected` list is the caller's declaration of which entities matter for initial state. We intersect it with `client.entitiesByDevice(0)` so a firmware that
 * does not expose an optional entity (a non-Disco Ratgdo without `switch-laser`, etc.) does not cause an indefinite wait - we only require entities the device
 * actually advertises. This split is deliberate: the device class owns "what we care about" (via the registry in entities.ts), and this function owns "what's
 * actually reachable on this firmware" (via the ESPHome client's discovered entity list).
 *
 * Cache observation is correct because the ESPHome client commits each state event to `latestCache` BEFORE notifying telemetry listeners (the cache-then-notify
 * ordering, a documented cache contract). A listener reading from `client.snapshot()` here sees the just-arrived event in the cache, which makes the per-event
 * `required.every((id) => cache.has(id))` completeness check the correct primitive for this wait.
 *
 * The fast path covers devices that finished pushing before the caller invoked us (common on a healthy LAN). The slow path subscribes via `using` for automatic
 * teardown when the helper returns, and resolves the moment the last required entity lands - no polling.
 *
 * The caller supplies the one signal the wait honors, and the wait rejects with that signal's own reason, so the caller that composed it can tell its sources apart
 * by identity. This function owns no budget: a caller that wants the wait bounded passes a signal that carries its deadline.
 */
export async function captureInitialState({ client, expected, signal }: CaptureInitialStateOptions): Promise<ReadonlyMap<EntityId, TelemetryEvent>> {

  const cache = client.snapshot();

  // Intersect the caller's "what we care about" list with the device's "what's actually here" list. presentEntityIds owns that intersection (Set membership over the
  // advertised ids, wanted order preserved); the resulting `required` list is what every completeness check below operates on.
  const required = presentEntityIds(client, expected);

  // Nothing to wait for. Either the caller declared no required entities or the device exposes none of them - in both cases construction can proceed immediately
  // with whatever the cache currently holds (the readers' defaults will fill in any gaps).
  if(required.length === 0) {

    return cache;
  }

  // Fast path: the handshake's `SUBSCRIBE_STATES_REQUEST` send is the last thing connect() does before resolving, but the run-phase dispatcher processes inbound
  // state messages immediately. By the time our caller reaches here, every push may already be in the cache.
  if(required.every((id) => cache.has(id))) {

    return cache;
  }

  /* Slow path: subscribe to telemetry and resolve when the cache completes. The `using` form scopes the bootstrap subscription to this function: at scope exit
   * the implicit `Symbol.dispose()` call removes the handler from the EventBus, so the bootstrap listener never leaks into the runtime telemetry path the platform
   * wires up after construction. The wait below is the library's, and it owns the abort side of the race: it rejects with the reason of the signal the caller
   * passed, unchanged, so the caller's catch handler can recognize which of its own sources aborted.
   */

  // Synchronous gate against an already-aborted signal. An abort that landed before this call leaves nothing worth waiting for, and checking here means we give up
  // before subscribing to telemetry at all rather than subscribing and tearing the subscription straight back down.
  signal.throwIfAborted();

  const { promise, resolve } = Promise.withResolvers<undefined>();

  using _sub = client.on("telemetry", () => {

    if(required.every((id) => cache.has(id))) {

      resolve(undefined);
    }
  });

  await waitWithSignal(promise, signal);

  return cache;
}

// The MAC a session's device-info record reports, in the plugin's identity form, or an empty string when the session has no record or the record names no MAC.
function reportedMac(client: EspHomeClient): string {

  return normalizeMac(client.deviceInfo()?.macAddress ?? "");
}

/* The one identity comparison: whether a session's device is the device its connection is for. The device-info record's MAC, in the plugin's identity form, must be
 * the expected MAC, and a record naming no MAC is a mismatch, since a device that names none cannot be shown to be the one expected. The connect core's admission and
 * every later session's check - the platform's lifecycle listener and the settings page's feed alike - ask it here, so a device is refused by one rule on its first
 * contact and on every reconnect.
 *
 * @param options.client   - The connected client whose session is checked.
 * @param options.expected - The MAC the connection is for, in the plugin's identity form.
 *
 * @returns The refusal to raise or report, or null when the session's device is the one expected.
 */
export function identityRefusal({ client, expected }: { client: EspHomeClient; expected: string }): Nullable<DeviceIdentityError> {

  const reported = reportedMac(client);

  return (reported === expected) ? null : new DeviceIdentityError({ expected, reported });
}

/* Word a permanent cause a user can act on, and classify it: a device other than the one the connection is for, a key the device refused or required, and an API
 * version this plugin's client cannot speak. The connect core meets these causes on a first open and the platform's lifecycle listener meets them at a reconnect's
 * give-up, and each logs what this answers, so a user reads one sentence for one fault whichever path met it. Any other cause answers null, because it is no refusal a
 * user can act on and each caller has its own words for it.
 *
 * @param cause - The error a connect or a reconnect ended on.
 *
 * @returns The diagnostic and the classified reason, or null for a cause this does not word.
 */
export function describePermanentCause(cause: DeviceIdentityError): PermanentCauseDescription;
export function describePermanentCause(cause: unknown): Nullable<PermanentCauseDescription>;
export function describePermanentCause(cause: unknown): Nullable<PermanentCauseDescription> {

  // The message names the MAC that answered and the MAC expected, which is what the user needs to find the stale or reassigned address behind the refusal.
  if(cause instanceof DeviceIdentityError) {

    return { diagnostic: [ "The wrong device answered, so the connection is refused: %s", cause.message ], reason: "identity-mismatch" };
  }

  // A mismatched key reads as `encryption-invalid`, and an absent-but-required one as `encryption-missing`, so a caller acts on which kind it is without
  // re-inspecting the error.
  if(isEncryptionError(cause)) {

    return { diagnostic: [ "Encryption configuration error - check the device's API encryption key: %s", cause.message ],
      reason: (cause instanceof EncryptionKeyInvalidError) ? "encryption-invalid" : "encryption-missing" };
  }

  // A version mismatch is its own verdict rather than a generic permanent failure: the device and this plugin's client cannot agree on an API version, so the user
  // acts by updating one side or the other.
  if(cause instanceof NegotiationFailedError) {

    return { diagnostic: [ "The device's ESPHome API version is not one this plugin supports: %s", cause.message ], reason: "unsupported" };
  }

  return null;
}

/* Type predicate for the "configuration mistake" subset of the typed-error hierarchy. esphome-client exposes EncryptionKeyMissingError, EncryptionKeyInvalidError, and
 * EncryptionRequiredError as PermanentError subclasses; this helper enumerates them once so the cause describer and the connect core's firmware warning share one
 * decision about what counts as an encryption-config error. If esphome-client adds another encryption-related PermanentError subclass, every reader picks up the
 * new branch by extending this predicate.
 */
export function isEncryptionError(error: unknown): error is EncryptionKeyMissingError | EncryptionKeyInvalidError | EncryptionRequiredError {

  return (error instanceof EncryptionKeyMissingError) || (error instanceof EncryptionKeyInvalidError) || (error instanceof EncryptionRequiredError);
}
