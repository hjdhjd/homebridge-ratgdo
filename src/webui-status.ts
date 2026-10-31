/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-status.ts: The live device-status connection pool for the Config UI X settings panel.
 *
 * This module runs exclusively inside the transient custom-UI child process that Config UI X forks for the plugin's settings modal - never inside Homebridge. At panel
 * open the frontend hands the pool the warm set: every device the sidebar knows, and the page's edited configuration. The pool resolves each device's key, its log
 * name, and every listed address from that configuration through the same feature-option engine and the same list function the plugin itself runs on, so the page,
 * the pool, and the runtime cannot disagree about a device. The pool connects to every discovered warm device immediately and holds each connection for the whole
 * settings session, so clicking between devices is an instant view switch rather than a teardown and reconnect. It opens each connection by reusing the platform's own
 * connection.ts / discovery.ts / entities.ts / protocol modules end to end, translates telemetry into status rows, and pushes those rows to the iframe over the
 * plugin-ui-utils bridge. The status wire contract - the StatusEvent union, the StatusRow shape, and the classified StatusErrorReason - lives in
 * homebridge-plugin-utils and is imported here; this module is that contract's ratgdo adapter, owning the ESPHome StatusFeed, the per-device session lifecycle, the row
 * vocabulary, and the warm extension. It consumes openConnection, parseRatgdoService, ratgdoStatusEntityIds, presentEntityIds, idFor, and translateTelemetry, and
 * never touches raw wire semantics.
 *
 * A warm under which a session's key would no longer be the one it was offered reconnects that session, except a healthy, connected, negotiated-plaintext one, which
 * adopts the new key in place - a transport that never used the key has nothing to reconnect for, and the reconnect would only flash the panel. Mid-connect,
 * disconnected, and encrypted sessions reconnect instead; an auth-failed device reconnects only on a changed key, never on a resend of the key that failed; disposal
 * tears down everything. Which MAC a key is read at is the connection core's rule and how a key is inherited is the engine's, so neither lives in this module. A
 * session is never torn down on the word of a transient device-list read - a mac merely absent from a re-warm keeps its live connection. The pool holds per-mac
 * outcome memory because connects happen while no device is selected and their pushes are unrenderable, so a later view of a device that failed while unselected
 * must re-surface the classified failure rather than a permanent "Connecting...".
 *
 * The warm set and its route are ratgdo's extension to the shared protocol: the warm route declared in src/webui/status-routes.ts, which the page and the UI server both
 * import, and narrowStatusWarmRequest here carry the sidebar's devices and the edited configuration to the pool, while the shared contract carries the pushed status
 * back. The configuration is read and never logged, because it can carry encryption keys. Everything the panel renders - rows, updates, availability, and errors -
 * crosses the bridge as ESPHome-free, variant-free, entity-id-free data, so the row vocabulary and the label choices stay ratgdo's while the ESPHome details never reach
 * the wire. That vocabulary lives in src/webui/status-rows.ts, which the page reads too, so the skeleton the panel renders before a snapshot and the rows this pool
 * pushes are built from the same templates.
 */
import type { Clock, HomebridgePluginLogging, MdnsBrowserFactory, MdnsDiscovery, MdnsDiscoveryEvent, Nullable, StatusErrorReason, StatusEvent,
  StatusRow } from "homebridge-plugin-utils";
import type { EntityId, EspHomeClient, LifecycleEvent, TelemetryEvent } from "esphome-client";
import { FeatureOptions, HbpuAbortError, TimerRegistry, composeSignals, discoverServices, isAdvertisedAt, prefixedLog, superviseLoop,
  systemClock } from "homebridge-plugin-utils";
import type { ManualConnectionFailureReason, OpenEspHomeClient } from "./connection.ts";
import { RATGDO_ADDRESS_OPTION, RATGDO_ENCRYPTION_KEY_OPTION, RATGDO_WEBUI_PROBE_TIMEOUT } from "./webui/settings.ts";
import { RATGDO_ENTITIES, idFor, presentEntityIds, ratgdoInitialStateEntityIds, ratgdoStatusEntityIds } from "./entities.ts";
import { RATGDO_MDNS_SERVICE_TYPE, RATGDO_WEBUI_DISCOVERY_TIMEOUT } from "./settings.ts";
import { STATUS_ROW_ORDER, mapRowValue, statusRowTemplate } from "./webui/status-rows.ts";
import { canonicalManualAddress, isZonedAddress } from "./webui/manual-address.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { governingAddress, isRetryableFailure, manualAddressList } from "./manual.ts";
import { identityRefusal, openConnection, openManualConnection } from "./connection.ts";
import type { DiscoveredRatgdo } from "./discovery.ts";
import { RatgdoVariant } from "./types.ts";
import type { StatusRowId } from "./webui/status-rows.ts";
import { isConnectionLive } from "esphome-client";
import { parseRatgdoService } from "./discovery.ts";
import { translateLifecycle } from "./protocol/lifecycle.ts";
import { translateTelemetry } from "./protocol/telemetry.ts";

/* Construction options for StatusFeed. `browserFactory`, `clock`, and `openClient` default to the real implementations (the default-arg port pattern connection.ts
 * establishes), `discoveryTimeoutSeconds` defaults to RATGDO_WEBUI_DISCOVERY_TIMEOUT, and `captureTimeoutSeconds` is left undefined so openConnection's own
 * default applies; a unit test overrides each of them. `push` is the raw bridge sink - StatusFeed guards every push on session identity internally, so `push`
 * itself is unconditional.
 *
 * @property browserFactory          - The library's browser boundary. A test injects TestMdnsBrowserFactory; absent, the library builds its own browser.
 * @property captureTimeoutSeconds   - Seconds any capture the feed opens waits for the device's initial state. Left undefined, openConnection's own default applies.
 * @property clock                   - The time source the not-found timers and the browser arm on. Defaults to systemClock; a test injects TestClock.
 * @property discoveryTimeoutSeconds - Seconds a warmed mac waits for mDNS discovery before it is classified not-found. Defaults to RATGDO_WEBUI_DISCOVERY_TIMEOUT.
 * @property log                     - The logging adapter client-internal and feed-internal messages route through.
 * @property openClient              - The ESPHome client-factory port, threaded straight into openConnection. Defaults to the real factory there.
 * @property push                    - The bridge sink that delivers a status event to the iframe.
 */
export interface StatusFeedOptions {

  browserFactory?: MdnsBrowserFactory;
  captureTimeoutSeconds?: number;
  clock?: Clock;
  discoveryTimeoutSeconds?: number;
  log: HomebridgePluginLogging;
  openClient?: OpenEspHomeClient;
  push: (event: StatusEvent) => void;
}

/* The warm request on the wire: the stripped mac of every device the sidebar knows, and the options array of the configuration the page is editing. This is the single
 * named shape the warm narrowing produces and the warm method consumes, so neither re-declares it inline.
 *
 * The configuration travels whole rather than as values the page resolved, because resolving it is the plugin's own engine's job: the pool builds that engine over
 * the plugin's catalog and reads every key, log name, and listed address through it exactly as the platform does. The listed addresses matter beyond the sidebar,
 * because a device named only by address may be in nobody's sidebar yet - the pool has to dial the address to learn which device is there.
 *
 * @property devices - The sidebar's devices, by stripped mac.
 * @property options - The edited configuration's feature-option entries.
 */
export interface StatusWarmRequest {

  devices: string[];
  options: string[];
}

/* What a connection was offered: the key, and the MAC it was chosen for - undefined when it was chosen for no MAC, which reads the global key. Every store that has to
 * tell a doomed resend of a key from a changed one keeps this record, and the one comparison that asks it reads the key at the record's own MAC, so a connection keyed
 * for no MAC is compared against the global key and a key stored later at its device's MAC moves nothing.
 *
 * @property key - The key the lookup answered, or undefined when it answered none.
 * @property mac - The MAC the key was chosen for, or undefined for the global key.
 */
interface OfferedKey {

  readonly key: string | undefined;
  readonly mac: string | undefined;
}

/* What the pool knows about one device, keyed in `#devices` by stripped mac, whichever source told it: an mDNS advertisement or a manual address it dialed and
 * identified. `device` is the identity, and its `address` is where this pool dials the device - which for a governed mac is the listed address rather than whatever
 * the advertisement picks, because a listed address is the user telling us which one to use. `manualAddress` is that governing address, absent for a device only
 * discovery reached. Keeping the governance on the identity record rather than in a map beside it is what makes "is this mac governed, and by what" a single read.
 */
interface KnownDevice {

  device: DiscoveredRatgdo;
  manualAddress: string | undefined;
}

/* What became of one warmed manual address, keyed in `#addresses` by the address in its canonical lower-cased form. A discriminated union on `state` rather than a
 * record of nullable fields, because the three states are answers to one question and each carries what only it has.
 *
 * `dialing` carries the controller that cancels the dial in flight, and its presence IS the guard against a second concurrent dial of one address: it is installed
 * synchronously before the dial's first await, so a re-warm arriving mid-dial finds it. `resolved` carries the mac that answered, which is how a later warm knows the
 * address needs no re-dial and how a departure knows whose governance to drop. `failed` carries the classified reason and what the attempt was offered - undefined
 * when the dial failed before any key was chosen - so the retry gate can tell a doomed re-send of the key that just failed from a genuine retry with a changed one, the
 * same rule the per-mac outcome memory follows.
 */
type AddressRecord = { controller: AbortController; state: "dialing" } | { mac: string; state: "resolved" } |
  { offered: OfferedKey | undefined; reason: ManualConnectionFailureReason; state: "failed" };

/* What one address probe answers the settings page's Add Device card. A discriminated union on `kind`, because the two answers are what the card renders and it must
 * not have to guess: `ok` carries everything the card shows about the device that answered, and `error` carries the one classified reason it did not. `encrypted`
 * records whether the transport the probe negotiated actually used a key, which is how the card tells a device that accepted a key from one that never needed one.
 * `announcesMac` records whether the device's encrypted handshake named its MAC - false for a device whose firmware names none, and for a device that did not
 * encrypt - which is how the card knows a key stored for that MAC could ever be offered to it.
 */
export type StatusProbeResult = { address: string; announcesMac: boolean; encrypted: boolean; firmwareVersion: string; kind: "ok"; mac: string; model: string |
  undefined; name: string | undefined; variant: RatgdoVariant; } | { kind: "error"; reason: StatusErrorReason };

/* The reason a probe's own deadline aborts its controller with, a module-scope value whose whole job is to be recognizable by identity.
 *
 * A probe's connection can be cut short by two different things, and the card owes the user different words for each: the deadline elapsing is a device that did not
 * answer in time, while the pool's lifetime aborting is the settings modal closing underneath the probe. openManualConnection classifies EVERY abort of its shutdown
 * signal as the same silent `shutdown`, deliberately - it cannot know whose abort it was - so the probe reads the composed signal's own reason back afterward and
 * tells the two apart by this identity. A string or a fresh Error would invite a comparison by message; a single frozen object cannot be mistaken for anything else.
 */
const PROBE_DEADLINE = Object.freeze({ reason: "probe-deadline" });

/* The per-device session record, keyed in `#sessions` by stripped mac. The record carries its own mac so the identity-guarded sink is self-describing: a push through
 * `#pushForSession(session, event)` lands only while `this.#sessions.get(session.mac) === session`. `address` is the address this session's connect dialed, which is
 * what lets the discovery path tell a device that has moved from one whose advertised set merely shifted underneath it - `#devices` holds the advertised truth and the
 * session holds the dialed one, and the address projection reads the dialed one because that is where the panel's connection is; `client` is null until the connection
 * opens; `controller` cancels every in-flight step; `encryptedTransport` records the negotiated transport, captured at connect resolution and re-read from each
 * later session's connect - true when the client negotiated encryption - and backs the key diff and each online push's lock indicator in place of the live isEncrypted
 * getter, which reads false during the client's own reconnect windows; `online` is the device's availability as the client's verdicts state it, through the lifecycle
 * translation the platform applies too - set when the connection is adopted, cleared on `lost` and on a permanent-cause disconnect, set again on `recovered`;
 * `offered` records what the diff last reconciled - what the connection was offered, or the key a healthy plaintext session adopted in place - and, because key
 * choice is pure, what the session's own client offers on its reconnects; it is undefined only on the record a failed address dial mints when that dial failed before
 * any key was chosen; `rowMap` is the entity-id-to-row-id map computed at connect resolution and retained because view() rebuilds a snapshot from it long after the
 * connect; `stack` holds the client and then each retained listener, so teardown releases the listeners before the client's disconnect; `token` is the session's
 * monotonic identity.
 */
interface DeviceSession {

  address: string;
  client: Nullable<EspHomeClient>;
  controller: AbortController;
  encryptedTransport: boolean;
  mac: string;
  offered: OfferedKey | undefined;
  online: boolean;
  rowMap: Map<EntityId, StatusRowId>;
  stack: DisposableStack;
  token: number;
}

/* The status entity universe for a variant: every status entity id mapped to its panel row id, derived from the RATGDO_ENTITIES registry so entity literals never leave
 * that module. The switch is exhaustive over RatgdoVariant, so adding a variant fails compilation here. Motion is a ratgdo-only momentary sensor - Konnected firmware
 * advertises none - so it appears in the ratgdo row set only. The map answers which row an entity feeds and nothing more: its insertion order carries no meaning,
 * because the panel's display order is stated once, by STATUS_ROW_ORDER, and each snapshot lists its rows in that order.
 */
function statusRowIndex(variant: RatgdoVariant): Map<EntityId, StatusRowId> {

  switch(variant) {

    case RatgdoVariant.KONNECTED: {

      const entities = RATGDO_ENTITIES[RatgdoVariant.KONNECTED];

      return new Map<EntityId, StatusRowId>([

        [ idFor(entities.cover), "door" ],
        [ idFor(entities.lock), "lock" ],
        [ idFor(entities.light), "light" ],
        [ idFor(entities.obstruction), "obstruction" ]
      ]);
    }

    case RatgdoVariant.RATGDO: {

      const entities = RATGDO_ENTITIES[RatgdoVariant.RATGDO];

      return new Map<EntityId, StatusRowId>([

        [ idFor(entities.cover), "door" ],
        [ idFor(entities.lock), "lock" ],
        [ idFor(entities.motion), "motion" ],
        [ idFor(entities.light), "light" ],
        [ idFor(entities.obstruction), "obstruction" ]
      ]);
    }
  }
}

/* Translate a connect failure into the panel's own classified reason, the single home for that mapping. Every dial this module makes - the discovered device's, the
 * manual address's, and the settings card's probe - answers with the same vocabulary, so a user reading a verdict cannot tell which path produced it.
 *
 * Shutdown answers null rather than a reason: the pool is tearing down and there is no user to tell, so each caller stands down silently on it. `permanent` and
 * `unknown` collapse to one unreachable verdict, because the difference between them is a detail of the connect layer's own classification that a panel reading
 * "unreachable" would gain nothing from. `unrecognized` reads as misconfigured, since something answered at that address and it was not an opener - which is a typed
 * address, not a broken device. `identity-mismatch` reads as unreachable too: a device other than the one this connection is for answered, which for the panel is the
 * device not being reached.
 *
 * @param reason - The classified reason the connect failed.
 *
 * @returns The panel's reason, or null when there is nothing to surface.
 */
function statusErrorFor(reason: Exclude<ManualConnectionFailureReason, "shutdown">): StatusErrorReason;

function statusErrorFor(reason: ManualConnectionFailureReason): Nullable<StatusErrorReason>;

function statusErrorFor(reason: ManualConnectionFailureReason): Nullable<StatusErrorReason> {

  switch(reason) {

    case "encryption-invalid":

      return "auth-invalid";

    case "encryption-missing":

      return "auth-missing";

    case "shutdown":

      return null;

    case "timeout":

      return "timeout";

    case "unrecognized":

      return "misconfigured";

    case "unsupported":

      return "unsupported";

    case "identity-mismatch":
    case "permanent":
    case "unknown":

      return "unreachable";

    default: {

      // Compile-time exhaustiveness: a new failure reason fails to type-check here until it has been given a panel verdict.
      reason satisfies never;

      return "unreachable";
    }
  }
}

// The probe's optional key, read as an untrusted wire field: a non-empty string is the value, and anything else - a missing key, a number, an empty string - is the
// card offering nothing under that name.
const narrowText = (value: unknown): string | undefined => ((typeof value === "string") && (value.length > 0)) ? value : undefined;

/* Narrow the untrusted warm-request body at the bridge boundary. The body must be an object carrying a `devices` array or the whole request is null. Each device is a
 * non-empty string mac, and a malformed one is dropped without invalidating the request, because one bad device must not blank the whole panel. An empty devices array
 * is valid: it is how the frontend says "the sidebar knows nothing". This lives in the tested module rather than the untestable server adapter.
 *
 * The options array reads as empty when it is absent or is not an array at all, and keeps each string it carries. An empty array is an ordinary configuration - one
 * that sets no option - and must not be refused for saying nothing; what the strings mean is the engine's to read, exactly as it reads the plugin's own configuration,
 * so nothing here interprets them.
 */
export function narrowStatusWarmRequest(body: unknown): Nullable<StatusWarmRequest> {

  if((typeof body !== "object") || (body === null)) {

    return null;
  }

  const record = body as { devices?: unknown; options?: unknown };

  if(!Array.isArray(record.devices)) {

    return null;
  }

  const devices = record.devices.filter((mac): mac is string => (typeof mac === "string") && (mac.length > 0));
  const options = Array.isArray(record.options) ? record.options.filter((entry): entry is string => typeof entry === "string") : [];

  return { devices, options };
}

/* Narrow the untrusted probe-request body at the bridge boundary. One non-empty string address is required and takes its canonical form through the very function the
 * feed's listed addresses go through, so a probe and a warm of one address agree about what that address is called - which is what lets a probe's resolved record be
 * read by the next warm's dial. The key is carried only when it is a non-empty string.
 *
 * An address naming a zone is refused here as it is everywhere else: nothing could dial it, and answering the card a classified refusal is better than opening a
 * connection attempt that was always going to fail. Anything malformed is null, and the adapter answers the card a misconfigured verdict rather than dispatching - a
 * malformed probe is a fault in what was typed or sent, and the card saying so is a truthful thing to say about it.
 */
export function narrowStatusProbeRequest(body: unknown): Nullable<{ address: string; psk?: string }> {

  if((typeof body !== "object") || (body === null)) {

    return null;
  }

  const record = body as { address?: unknown; psk?: unknown };

  if(typeof record.address !== "string") {

    return null;
  }

  const address = canonicalManualAddress(record.address);

  if((address.length === 0) || isZonedAddress(address)) {

    return null;
  }

  return { address, psk: narrowText(record.psk) };
}

/* The status connection pool. It holds one live or in-flight session per warmed device and switches the panel's view between them without teardown. Teardown
 * happens when the key a session was offered moves - which reconnects every session except a healthy, connected, negotiated-plaintext one, that instead adopts the key
 * in place - on an advertisement that moves a warmed device to a different address, which re-dials the session at the new one so the panel follows the device exactly
 * as the platform does, and on disposal; an auth-failed device reconnects only when the key changes. Every push routes through the per-mac identity guard, so a
 * superseded session's late continuation reaches no panel. The pool is disposable; disposal ends the discovery stream, clears the warm set and every timer, and tears
 * down every session.
 *
 * A device reaches the pool by one of two routes. Discovery is the ordinary one: an advertisement names a mac and an address, and the pool dials it. The other is a
 * listed address, which the warmed configuration names: the pool dials the address itself, reads the identity off the device-info record the connection produced,
 * and that one connection becomes the device's session under whichever mac answered. A listed address GOVERNS its device the way it does in the plugin's runtime -
 * the pool dials the listed address, and a later advertisement naming some other address for that mac refreshes what the pool knows about the device without moving
 * its connection, because the user has said which address to use. The identity is re-derived on every dial of an address, so a different opener answering there is
 * served under its own mac rather than under the one that used to be there.
 */
export class StatusFeed implements Disposable {

  // What became of each warmed manual address, keyed by the canonical lower-cased address. See AddressRecord for why the states are a union.
  readonly #addresses = new Map<string, AddressRecord>();
  readonly #browserFactory: MdnsBrowserFactory | undefined;
  readonly #captureTimeoutSeconds: number | undefined;
  readonly #clock: Clock;
  readonly #devices = new Map<string, KnownDevice>();
  // The live discovery while one runs, and null between them: a null field is what makes the next warm's startDiscovery open a new one.
  #discovery: Nullable<MdnsDiscovery<DiscoveredRatgdo>> = null;
  readonly #discoveryTimeoutSeconds: number;
  // The feature-option engine over the plugin's own catalog and the last warm's configuration, built empty here and replaced by every warm. Every key, log name, and
  // listed address the pool reads comes from it, through the same calls the platform makes.
  #engine = new FeatureOptions(featureOptionCategories, featureOptions, []);

  /* The key lookup every connection this pool opens hands the connection core: the key the engine resolves at a MAC, or the global key when called with none, and
   * undefined for an empty entry, so an absent key and an empty one compare alike. It reads the engine live, so it always answers from the latest warm.
   */
  readonly #keyFor = (mac?: string): string | undefined => {

    const key = this.#engine.value(RATGDO_ENCRYPTION_KEY_OPTION, mac);

    return key?.length ? key : undefined;
  };

  // The pool's own lifetime, and the signal every discovery it opens is bound to. Aborted exactly once, at disposal.
  readonly #lifetime = new AbortController();
  readonly #log: HomebridgePluginLogging;
  readonly #openClient: OpenEspHomeClient | undefined;
  readonly #outcomes = new Map<string, { offered: OfferedKey | undefined; reason: StatusErrorReason }>();
  readonly #push: (event: StatusEvent) => void;
  readonly #sessions = new Map<string, DeviceSession>();
  readonly #timers: TimerRegistry;
  #tokenCounter = 0;
  // The macs the sidebar last listed. Replaced wholesale by every warm.
  #warmed = new Set<string>();
  // The addresses the warmed configuration lists, canonical and in the user's own order, which is what settles which of two addresses reaching one device governs it.
  // Replaced wholesale by every warm, exactly as #warmed is.
  #warmedAddresses: readonly string[] = [];
  // Every probe still in flight, held only so disposal can cancel them. A probe removes its own entry as it settles, so this set is empty whenever none is running.
  readonly #probes = new Set<AbortController>();

  public constructor({ browserFactory, captureTimeoutSeconds, clock = systemClock, discoveryTimeoutSeconds = RATGDO_WEBUI_DISCOVERY_TIMEOUT, log, openClient,
    push }: StatusFeedOptions) {

    this.#browserFactory = browserFactory;
    this.#captureTimeoutSeconds = captureTimeoutSeconds;
    this.#clock = clock;
    this.#discoveryTimeoutSeconds = discoveryTimeoutSeconds;
    this.#log = log;
    this.#openClient = openClient;
    this.#push = push;

    // The not-found timers are unref'd as a matter of this owner's policy: the custom-UI child process must be free to exit when the settings modal closes, and a
    // pending per-mac budget is never a reason to hold it open.
    this.#timers = new TimerRegistry({ clock, unref: true });
  }

  /* Apply a warm set: the whole sidebar's device list and the configuration the page is editing. This is the pool's one policy chokepoint. The configuration replaces
   * the engine every key, log name, and listed address is read from, and the device list replaces `#warmed` wholesale (never merged), so a mac the sidebar dropped
   * simply leaves the set - its live session is deliberately NOT torn down, because a transient device-list read must never destroy a live connection. For each
   * device: a discovered device with no session starts a connect, unless outcome memory records an auth failure against a key that has not moved, in which case the
   * connect waits for a changed key; an undiscovered device with no session and no pending discovery timer arms its per-mac not-found timer; a device whose live
   * session's key has moved is torn down and reconnected against the new key, EXCEPT a healthy, connected, negotiated-plaintext session, which adopts the new key in
   * place with no teardown; a device whose key has not moved is left untouched. Timers for macs that left the warm set are cleared, since discovery and the not-found
   * sweep do not concern a departed mac.
   *
   * The key is the only thing a warm resolves that decides anything here. A log name is display truth: the prefix resolver reads it live from the engine on every log
   * call, so a warm that changes nothing but a name is applied by the engine's replacement and moves no connection, and neither does an edit to an option this pool
   * never reads.
   *
   * The listed addresses are applied first, and they are applied differently: a mac is something the sidebar already knows, while an address is a question the pool
   * has to ask the network. So each listed address is dialed once, identified, and remembered by what answered, and the device the pool already holds a session for
   * is only then reconciled against it. An address that has left the list is cancelled and forgotten.
   */
  public warm(request: StatusWarmRequest): void {

    // The macs the previous warm set knew, captured before the wholesale replace so we can clear the timers of the ones that leave.
    const departed = this.#warmed;

    this.#engine = new FeatureOptions(featureOptionCategories, featureOptions, request.options);
    this.#warmed = new Set(request.devices);

    for(const mac of departed) {

      if(!this.#warmed.has(mac)) {

        this.#timers.clear(mac);
      }
    }

    /* The listed addresses, read exactly as the platform reads them: the engine's list, canonicalized and de-duplicated in the user's order by the platform's own list
     * function. The pool then drops what nothing could dial - an entry whose canonical form is empty, and one naming a zone - since the platform refuses both before
     * dialing and the card refuses both before writing.
     */
    this.#applyAddresses(manualAddressList(this.#engine.valueList({ option: RATGDO_ADDRESS_OPTION })).filter((address) => (address.length > 0) &&
      !isZonedAddress(address)));

    // Re-ensure the discovery stream before this warm applies. startDiscovery is a no-op while one runs, so a healthy stream pays nothing; a browser whose
    // construction failed, or one that ended after losing its sockets, is replaced here at the warm cadence rather than leaving the pool blind for the child
    // process's life, and each failed attempt logs - the live signal an operator troubleshoots from. A discovery that lands after a pending not-found timer has
    // fired self-heals on arrival: #onDiscovery's connect trigger fires for the still-warmed mac and #connectDevice's synchronous prefix clears the stored outcome
    // before its first await, and view()'s stored-outcome retry covers a mac that re-enters the warm set later.
    this.startDiscovery();

    for(const mac of this.#warmed) {

      const session = this.#sessions.get(mac);

      if(!session) {

        /* No session yet. A discovered device connects now, unless outcome memory holds a verdict that re-dialing cannot change. Two of those exist, and they are
         * suppressed on different terms.
         *
         * An auth failure is suppressed only while the key it failed with has not moved: a forced warm - the restart recovery or the visibility belt - resends an
         * unchanged configuration at foreground cadence, and re-running a connect with the key that just failed is doomed churn that re-flashes the panel, while a
         * changed key is a genuine retry and falls through to the connect, whose synchronous prefix clears the stored outcome. An unsupported verdict is suppressed
         * regardless of the key, because a firmware version the client cannot speak does not become speakable when a key is edited; only a firmware or plugin update
         * changes it, and either one reopens the panel. Every other outcome keeps its unconditional retry here. An undiscovered device arms a not-found timer, but
         * only when none is already counting down for it - a re-warm that changes an unrelated device's key must not defer this device's verdict.
         */
        if(this.#devices.has(mac)) {

          const outcome = this.#outcomes.get(mac);
          const authFailedOnThisKey = (outcome !== undefined) && ((outcome.reason === "auth-invalid") || (outcome.reason === "auth-missing")) &&
            !this.#keyMoved(outcome.offered);

          if((outcome?.reason === "unsupported") || authFailedOnThisKey) {

            continue;
          }

          void this.#connectDevice(mac);
        } else if(!this.#timers.has(mac)) {

          this.#armDiscoveryTimer(mac);
        }

        continue;
      }

      // A live or in-flight session whose key has not moved is left untouched, which is the whole point of the pool. A session whose key has moved adopts the new key
      // in place - with no teardown - ONLY when it is healthy, connected, and negotiated plaintext: such a transport genuinely does not use the key, so adopting ends
      // the cosmetic Connecting flash an unencrypted device would otherwise show on a global key edit. Every other moved-key session - mid-connect (client still null),
      // disconnected (its client between sessions, whether or not a verdict has followed), or encrypted - tears down and reconnects against the new key. The branch
      // reads the client's live health for whether a session is up, because session.online follows the availability verdict and stays true through the window before
      // one, and reads session.encryptedTransport, recorded from each session's connect, never the live client.isEncrypted getter: that getter is connection-phase state
      // that reads false during any transient disconnect of the client's own auto-reconnect cycle, so a live read would misclassify a mid-blip encrypted device, adopt
      // the key in place, and permanently desync the still-old-keyed client. A disconnected plaintext session's reconnect re-captures the transport truth on arrival,
      // which also covers a device whose firmware later enables encryption: it drops on its reboot and rejoins through the reconnect path against the then-current key.
      if(this.#keyMoved(session.offered)) {

        if((session.client !== null) && isConnectionLive(session.client.health()) && !session.encryptedTransport) {

          session.offered = { key: this.#keyFor(session.offered?.mac), mac: session.offered?.mac };
        } else {

          this.#teardownSession(mac);
          void this.#connectDevice(mac);
        }
      }
    }
  }

  /* Switch the panel's view to one device. A live session re-pushes its snapshot from the client's cache through the retained row map, so a switch between two live
   * devices constructs and disposes nothing, while a session whose device is offline re-pushes its offline availability instead, because a
   * snapshot states the device online. A still-connecting session pushes "connecting". Otherwise the stored outcome decides: a transient failure (timeout or
   * unreachable), or a not-found for a device that has since been discovered, retries with a fresh connect, so a temporary outage clears the moment the user reselects
   * the device rather than requiring the panel to be reopened; a key failure, an unsupported firmware, and a misconfigured address each re-push their error, because
   * retrying is pointless until a person changes something and the warm owns that; a warmed-but-undiscovered mac with no outcome pushes "connecting" and lets its timer
   * classify it. An unwarmed mac pushes "connecting" rather than not-found - the ordered bridge makes this happen only in exotic timing, and the warm that follows
   * resolves it.
   *
   * A mac the pool has no session and no identity for gets one more chance before it falls through to the outcome branches: every listed address whose last dial may
   * yet succeed is re-dialed, because one of them may be this very device. That is the manual path's answer to the discovered path's retry - a device reached only by
   * address has no advertisement to re-arrive, so the user reselecting it is the trigger.
   */
  public view(mac: string): void {

    const session = this.#sessions.get(mac);

    if(session) {

      if(session.client) {

        if(!session.online) {

          this.#pushOffline(session);

          return;
        }

        this.#pushSnapshot(session, session.client.snapshot());

        return;
      }

      this.#pushForSession(session, { kind: "connecting", serialNumber: mac, session: session.token });

      return;
    }

    if(!this.#devices.has(mac)) {

      this.#redialAddresses();
    }

    const reason = this.#outcomes.get(mac)?.reason;

    if((reason === "timeout") || (reason === "unreachable") || ((reason === "not-found") && this.#devices.has(mac))) {

      void this.#connectDevice(mac);

      return;
    }

    if((reason === "auth-invalid") || (reason === "auth-missing") || (reason === "misconfigured") || (reason === "unsupported")) {

      this.#emit({ kind: "error", reason, serialNumber: mac, session: ++this.#tokenCounter });

      return;
    }

    this.#emit({ kind: "connecting", serialNumber: mac, session: ++this.#tokenCounter });
  }

  /* Project the known set into a plain mac-to-address object for the identity strip. Each device's stripped mac - the very key the pushes carry as serialNumber, so
   * the frontend joins on device.serialNumber with no translation - maps to the address the status connection is actually on: the one this device's session dialed,
   * and for a device the pool holds no session for, the one it would be dialed at. The two differ whenever a device advertises a higher-ranked address than the one
   * its live connection was opened at, and the panel's "IP Address" means where the connection is. A governed mac reports its listed address, because the identity
   * record already holds that address as the one to dial. A pure synchronous read of #devices and #sessions: it changes no session state and emits no wire event, so
   * the panel can pull it at any time without perturbing a connection. The result is frozen and freshly built per call, so a caller that mutates one read can corrupt
   * neither the pool's device memory nor a later read.
   */
  public addresses(): Readonly<Record<string, string>> {

    const projection: Record<string, string> = {};

    for(const [ mac, known ] of this.#devices) {

      projection[mac] = this.#sessions.get(mac)?.address ?? known.device.address;
    }

    return Object.freeze(projection);
  }

  /* Test one address on the user's behalf and say what is there, for the settings page's Add Device card. This is the one call in this module that exists to answer a
   * question rather than to keep a panel populated, and everything unusual about it follows from that.
   *
   * It touches NOTHING the pool owns. No session, no outcome memory, no not-found timer, and no address record that is currently dialing. A probe is a user's single
   * deliberate act, so it is allowed to open a second connection beside a pool dial of the very same address and the two never coordinate - the alternative, making the
   * probe wait on or reuse a pool dial, would make the card's answer depend on pool state the user cannot see. It always closes the connection it opened, on every
   * path, because the card only ever needed to know what answered.
   *
   * Two things can cut the connect short and the user is owed different words for each: this probe's own deadline, and the pool's lifetime ending because the settings
   * modal closed. openManualConnection classifies every abort of its shutdown signal as the same silent `shutdown` - it cannot know whose abort it was - so the two are
   * told apart afterward by reading the composed signal's own reason back against PROBE_DEADLINE's identity.
   *
   * The key it offers is the one the user typed, when there is one. Otherwise it is the key the warmed configuration stores at the MAC the device announces, else the
   * global key - the rule every other connection keys by - so a device whose key is already stored answers without the user retyping it.
   *
   * It never throws. The card is rendering whatever this resolves, and a rejection would leave the user looking at "Connecting to the device..." forever.
   *
   * @param request - The address to test, and the key the user typed, if any.
   *
   * @returns What answered, or the classified reason nothing usable did.
   */
  public async probe(request: { address: string; psk?: string }): Promise<StatusProbeResult> {

    const { address, psk } = request;
    const controller = new AbortController();
    const log = prefixedLog(this.#log, () => address);

    // Whether the connection core last asked for a key at a MAC, which for a connection dialed for no MAC is whether the device's handshake announced one.
    let announcesMac = false;

    const keyFor = (mac?: string): string | undefined => {

      announcesMac = (mac !== undefined);

      return psk ?? this.#keyFor(mac);
    };

    this.#probes.add(controller);

    // The deadline is armed on the injected clock rather than on a raw timer, so the suite drives it on TestClock; it is unref'd for the same reason the not-found
    // timers are, since a pending probe must never be what keeps the custom-UI child process alive.
    const deadline = this.#clock.schedule(() => controller.abort(PROBE_DEADLINE), RATGDO_WEBUI_PROBE_TIMEOUT * 1000, { unref: true });
    const signal = composeSignals(controller.signal, this.#lifetime.signal);

    /* The client this probe opened, held where the `finally` can reach it. The doc above promises it ALWAYS closes, and a dispose written inline after the connect
     * keeps that promise only for the paths that reach it: anything throwing between the connect and that line - the identity write, the transport read - would
     * leave a real connection open against a real device with nothing holding a reference to it. Disposing in the `finally` makes the promise structural.
     */
    let opened: Nullable<EspHomeClient> = null;

    try {

      const outcome = await openManualConnection({ host: address, keyFor, log, openClient: this.#openClient, shutdownSignal: signal,
        timeoutSeconds: this.#captureTimeoutSeconds });

      if(outcome.ok) {

        opened = outcome.client;
      }

      if(!outcome.ok) {

        /* Shutdown is the one reason that does not carry its own verdict, because it means somebody aborted rather than that something went wrong. Which somebody is
         * what the composed signal's reason says: this probe's deadline, or anything else - which at this point can only be the pool's own lifetime.
         */
        if(outcome.reason === "shutdown") {

          if(signal.reason === PROBE_DEADLINE) {

            log.debug("The device did not answer within the probe's %s second budget.", RATGDO_WEBUI_PROBE_TIMEOUT);

            return { kind: "error", reason: "timeout" };
          }

          return { kind: "error", reason: "unreachable" };
        }

        return { kind: "error", reason: statusErrorFor(outcome.reason) };
      }

      const identity = outcome.discovered;

      /* The device answered, so what the pool knows about it is now better than what it knew a moment ago - record the identity, which spares the next warm a dial of
       * an address it can already place. It is recorded ONLY when no pool dial of this address is in flight: that dial owns the record, and a probe quietly resolving
       * it underneath would let the dial's own resolution write a second time against a record it no longer recognizes.
       */
      if(this.#addresses.get(address)?.state !== "dialing") {

        this.#addresses.set(address, { mac: identity.strippedMac, state: "resolved" });
        this.#rememberDevice(identity, this.#devices.get(identity.strippedMac)?.manualAddress);
      }

      // The transport is read before the client goes, because that is the one fact about this connection the card shows that the identity record does not carry.
      const encrypted = outcome.client.isEncrypted;

      return { address, announcesMac, encrypted, firmwareVersion: identity.firmwareVersion, kind: "ok", mac: identity.strippedMac, model: identity.model,
        name: identity.friendlyName, variant: identity.variant };
    } catch(error) {

      // openManualConnection is total by its own contract, so reaching here means something below it came apart. The card is owed an answer either way.
      log.error("The connection test failed unexpectedly.", error);

      return { kind: "error", reason: "unreachable" };
    } finally {

      opened?.[Symbol.dispose]();
      deadline[Symbol.dispose]();
      this.#probes.delete(controller);
    }
  }

  /* Start mDNS discovery, retaining the stream. The server adapter calls this as the custom-UI process spawns, so discovery runs while the settings page is still in
   * front of the user and the first warm resolves discovered devices from a warm address map; warm() calls it again on every warm, so an attempt that failed is
   * retried at the warm cadence rather than leaving discovery dead for the child process's life. Failure is contained here - a browser that cannot be built must not
   * take down the process, whose other request handlers are unrelated to status - and every failed attempt logs, the live signal an operator troubleshoots from.
   * #ensureBrowser's early return makes the call a no-op while a stream runs, so the warm-cadence retries cost nothing on a healthy one.
   */
  public startDiscovery(): void {

    try {

      this.#ensureBrowser();
    } catch(error) {

      this.#log.error("The mDNS discovery browser could not be started.", error);
    }
  }

  /* Dispose the pool. Defense in depth: abort the pool's lifetime and clear the warm set FIRST, so even a discovery event already queued finds nothing to connect by
   * the time it drains; then abort every in-flight address dial, clear every not-found timer, tear down every session, and clear every map. Disposal ends the pool for
   * good: a later startDiscovery opens a browser on the aborted lifetime, whose stream ends at once. Safe to call more than once - a second abort of an aborted
   * controller does nothing, and the maps are already empty. The session walk reads the map's own iterator rather than a copy, which tolerates the deletion of the
   * entry it is standing on.
   *
   * The address dials are aborted and their map cleared ahead of the session teardown for the same reason the warm set is cleared first: a dial that resolves during
   * the teardown must find no record of itself and stand down, rather than installing a session into a pool that is going away.
   */
  public [Symbol.dispose](): void {

    this.#lifetime.abort(new HbpuAbortError("shutdown"));
    this.#discovery = null;
    this.#warmed.clear();
    this.#warmedAddresses = [];

    for(const record of this.#addresses.values()) {

      if(record.state === "dialing") {

        record.controller.abort();
      }
    }

    this.#addresses.clear();

    for(const probe of this.#probes) {

      probe.abort();
    }

    this.#probes.clear();
    this.#timers.clearAll();

    for(const mac of this.#sessions.keys()) {

      this.#teardownSession(mac);
    }

    this.#sessions.clear();
    this.#devices.clear();
    this.#outcomes.clear();
  }

  /* Open a connection for one known device and hold it as a live session. TOTAL by contract in two layers: the whole body sits in one try/catch so no synchronous or
   * awaited fault escapes, and every push routes through the contained `#emit` so a push sink that throws - the plugin-ui-utils bridge rejecting a pushEvent once the
   * modal has closed the channel - is swallowed rather than escaping. Totality matters because this method is dispatched fire-and-forget, so an escaped rejection would
   * terminate the custom-UI child process. The session records what the connection is offered - the key at this mac, read once - and the connection core keys this
   * connection for this same mac on its first contact and every reconnect, which is what lets the warm diff compare that record against the key at the same mac now.
   * The session is installed in `#sessions` BEFORE the first await, which is the double-connect guard against advertisement bursts and concurrent warms. Each terminal
   * branch records outcome memory and pushes its classified error (except shutdown, which stands down silently because the session was torn down mid-connect); a
   * successful open whose session was superseded while connecting disposes its client silently.
   *
   * A governed mac is not connected here at all: it is handed to the address dial, because the listed address is where its connection belongs and the identity has to
   * be re-derived on every dial - an address is a place, and what answers there can change. That delegation is what makes a swapped device at a listed address serve
   * under the mac that answers rather than the mac that used to.
   */
  async #connectDevice(mac: string): Promise<void> {

    const known = this.#devices.get(mac);

    // Every caller connects only a device the pool knows, so a missing entry means the mac left the known set between the decision and here; there is nothing to open.
    if(!known) {

      return;
    }

    if(known.manualAddress !== undefined) {

      await this.#dialAddress(known.manualAddress, mac);

      return;
    }

    const device = known.device;

    /* The feed logs this connection's lifecycle under the name the user knows the device by: the Device.LogName option they set for it, then the mDNS-advertised
     * friendly name, then the dialed address for a device advertising no usable name. The option is read from the warmed configuration through the same engine call
     * the platform's own lines resolve it with - so one device reads the same in the settings page's log as it does in Homebridge's.
     *
     * The resolver is a closure rather than a captured string because it is read on every log call, so a warm that changes only the name is carried by the next line
     * this connection writes and moves nothing else. The empty-string guard is deliberate, and it is why each fallback is a logical or rather than a nullish coalesce:
     * an empty name is as unusable an identity as no name at all, and nullish coalescing would let that empty string through as the prefix.
     */
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const log = prefixedLog(this.#log, () => this.#engine.value("Device.LogName", mac) || device.friendlyName || device.address);
    const session: DeviceSession = { address: device.address, client: null, controller: new AbortController(), encryptedTransport: false, mac,
      offered: { key: this.#keyFor(mac), mac }, online: false, rowMap: new Map(), stack: new DisposableStack(), token: ++this.#tokenCounter };

    try {

      // A connect is starting: retire any stale verdict and pending timer for this mac, then install the session synchronously so a concurrent advertisement or warm
      // sees a live session and does not start a second connect. This runs inside the try so the whole body - including the connecting push - stays total.
      this.#retirePendingVerdict(mac);
      this.#sessions.set(mac, session);
      this.#pushForSession(session, { kind: "connecting", serialNumber: mac, session: session.token });

      const outcome = await openConnection({ expected: ratgdoInitialStateEntityIds(device.variant), host: device.address, keyFor: this.#keyFor, log, mac,
        openClient: this.#openClient, shutdownSignal: session.controller.signal, timeoutSeconds: this.#captureTimeoutSeconds });

      if(!outcome.ok) {

        const reason = statusErrorFor(outcome.reason);

        // Shutdown classifies as nothing to surface: the session was torn down mid-connect, so it stands down silently rather than painting an error on a panel that
        // is going away.
        if(reason !== null) {

          this.#recordFailure(session, reason);
        }

        return;
      }

      // The connection is open. If a key-diff teardown or dispose superseded this session while connecting, dispose the client and stand down without a push.
      if(this.#sessions.get(mac) !== session) {

        outcome.client[Symbol.dispose]();

        return;
      }

      this.#adoptConnection({ client: outcome.client, initialState: outcome.initialState, session, variant: device.variant });
    } catch(error) {

      log.error("The live-status connection failed unexpectedly.", error);
      this.#recordFailure(session, "unreachable");
    }
  }

  /* Take an opened connection into an installed session: the row model, the listeners, the transport capture, and the first snapshot. Both dials reach this - the
   * discovered device's connect and the manual address's - so everything that makes a connection a session happens once, in one order, however the connection was
   * obtained. Synchronous by design: it runs after its caller's await, and nothing in it may yield, or a teardown could interleave between the listeners going on and
   * the session being marked live.
   *
   * @param options.client       - The connected client this session takes ownership of.
   * @param options.initialState - The state cache the connect captured, which becomes the session's first snapshot.
   * @param options.session      - The session record, already installed in #sessions by the caller.
   * @param options.variant      - The device variant whose status entities make up the row universe.
   */
  #adoptConnection({ client, initialState, session, variant }: { client: EspHomeClient; initialState: ReadonlyMap<EntityId, TelemetryEvent>; session: DeviceSession;
    variant: RatgdoVariant; }): void {

    // The client belongs to the session's stack before anything else here can throw, so tearing the session down always releases it, whichever later step comes apart.
    session.stack.use(client);

    // Compute the panel's row model BEFORE registering any listener, so the telemetry filter closure never observes an uninitialized set. The universe is the variant's
    // status entities mapped to row ids; narrowing it to the device's advertised entities yields the present rows. The map is retained on the session so view() can
    // rebuild a snapshot from it long after this connect.
    const universe = statusRowIndex(variant);
    const present = new Set<EntityId>(presentEntityIds(client, ratgdoStatusEntityIds(variant)));

    for(const [ id, rowId ] of universe) {

      if(present.has(id)) {

        session.rowMap.set(id, rowId);
      }
    }

    /* Register the session's listeners onto its stack. The client is already on it, so each listener goes on after the client and teardown releases the listeners
     * before the client's disconnect, and an intentional reconnect never pushes a spurious "Disconnected" availability event. The telemetry listener translates each
     * event and pushes a row only for a present panel entity; the lifecycle listener drives the availability row through the translation the platform applies too,
     * so the row follows the client's reachability verdicts rather than its session boundaries. After a reconnect cycle the device re-bursts full state through the
     * retained telemetry listener, so rows self-heal without a fresh snapshot.
     */
    session.stack.use(

      client.on("telemetry", (data: TelemetryEvent): void => {

        const event = translateTelemetry(data);

        // translateTelemetry mints the same canonical "type-objectId" id form that idFor produces, so the row map (keyed by branded EntityId) can look it up directly.
        const rowId = session.rowMap.get(event.id as EntityId);

        if(rowId === undefined) {

          return;
        }

        this.#pushForSession(session, { kind: "row", row: { id: rowId, value: mapRowValue(rowId, event) }, serialNumber: session.mac, session: session.token });
      }));

    session.stack.use(

      client.on("lifecycle", (lifecycle: LifecycleEvent): void => {

        /* Every later session is put to the identity rule this session's first contact passed, so a device that takes the address while the client is reconnecting
         * is refused as a first open would refuse it. The session is torn down with its device's verdict recorded and pushed as the classified identity failure, and
         * the warm protocol dials the device again as it dials any device it could not reach.
         */
        if(lifecycle.kind === "connect") {

          if(identityRefusal({ client, expected: session.mac }) !== null) {

            this.#recordFailure(session, statusErrorFor("identity-mismatch"));

            return;
          }

          // Each session negotiates its own transport, so the session's record of it is re-read here, where the session says what it negotiated, rather than read off
          // the client between sessions, when its getter reads false.
          session.encryptedTransport = lifecycle.encrypted;
        }

        const statement = translateLifecycle(lifecycle);

        switch(statement) {

          case "offline":

            session.online = false;
            this.#pushOffline(session);

            return;

          case "online":

            session.online = true;
            this.#pushForSession(session, { encrypted: session.encryptedTransport, kind: "availability", online: true, serialNumber: session.mac,
              session: session.token });

            return;

          case null:

            return;

          default: {

            // Compile-time exhaustiveness: a new availability statement fails to type-check here until it is handled.
            statement satisfies never;

            return;
          }
        }
      }));

    // Capture the negotiated transport here at connect resolution, and mark the session online. The initial connect fired inside the connect call before this
    // listener was registered, so the transport and the availability are set explicitly here and the lifecycle listener maintains them thereafter. warm()'s key
    // diff, the snapshot and the online availability push read encryptedTransport, never the live isEncrypted getter, for the disconnect-window reason spelled out
    // at the key diff's branch.
    session.client = client;
    session.encryptedTransport = client.isEncrypted;
    session.online = true;

    // Push the snapshot from the captured initial-state cache. Reading it AFTER registration means an event landing in that window produces at worst a duplicate row
    // push, never a loss; a present panel entity with no cache entry is omitted from the snapshot.
    this.#pushSnapshot(session, initialState);
  }

  /* Installing a session for a mac retires whatever the pool was about to say about that mac: the stored verdict a later view would re-surface, and the not-found
   * timer counting down toward one. Both dials call this at the same point - after the identity is known and before the session goes in - so a verdict that the
   * connection about to be installed disproves can never outlive it. One home for the rule, because the two call sites would otherwise drift.
   *
   * @param mac - The device whose pending verdict is being retired.
   */
  #retirePendingVerdict(mac: string): void {

    this.#outcomes.delete(mac);
    this.#timers.clear(mac);
  }

  /* Whether the key a connection was offered is no longer the key the lookup answers at the MAC it was chosen for. This is the one key comparison in the pool: the warm
   * diff, the auth-failure gate for a device with no session, and the address retry gate all ask it, so a connection keyed for the global key is compared against the
   * global key wherever it is compared, and never against a key stored later at its device's MAC.
   *
   * @param offered - What the connection was offered, or undefined when it failed before any key was chosen, which compares as no key chosen for no MAC.
   *
   * @returns true when a connection opened now would be offered a different key.
   */
  #keyMoved(offered: OfferedKey | undefined): boolean {

    return offered?.key !== this.#keyFor(offered?.mac);
  }

  /* The one writer of `#devices`. Every route a device identity arrives by - an mDNS advertisement, a manual address the pool dialed and identified - lands here, and
   * so does every change of governance, so the rules about what an identity record holds are stated once.
   *
   * The rule that needs one home is the address. A governed mac's record carries its LISTED address as the address to dial, whatever a later advertisement picks,
   * because the user naming an address is the user saying which one to use; the rest of the identity still refreshes from the advertisement, so a firmware upgrade or
   * a rename reaches the panel for a governed device exactly as it does for any other. An ungoverned record carries the identity untouched. A mac losing its
   * governance keeps the fields it last had and is corrected by its next advertisement, since nothing else knows where it is.
   *
   * ONE ADDRESS GOVERNS AT MOST ONE DEVICE, and this is where that is enforced, because this is the only place governance is written. Whenever a mac takes an
   * address, every OTHER mac still claiming that address gives it up. The sweep is release only, and it needs nothing else: a mac cannot still be connected AT an
   * address that a dial has just resolved to somebody else, because such a session could only have come from a dial of that address, and while it stands no second
   * dial of that address can begin.
   *
   * The rule is enforced here rather than at the dial that prompted it because governance is written from more than one state. A dial resolving from an address the
   * pool had never placed, or had last seen fail, writes a claim without any previous claim in hand to compare against - so a release keyed to "what the record said
   * before" is silent in exactly the case where a second claim is created. Sweeping the claims themselves is the only form of the rule that cannot be one-sided.
   *
   * @param identity      - The identity just derived, from either source.
   * @param manualAddress - The listed address governing this device after this write, or undefined for a device no listed address governs.
   */
  #rememberDevice(identity: DiscoveredRatgdo, manualAddress: string | undefined): void {

    const mac = identity.strippedMac;

    this.#devices.set(mac, { device: (manualAddress === undefined) ? identity : { ...identity, address: manualAddress }, manualAddress });

    if(manualAddress === undefined) {

      return;
    }

    // Every OTHER claim on this address goes, through the one method that clears them, so the rule lives in that method rather than being restated here in prose.
    this.#releaseAddress(manualAddress, mac);
  }

  /* Apply the warm set's address list: forget the addresses that left, then dial the ones that need dialing.
   *
   * A departure is the only destructive half. Its in-flight dial is aborted, its record dropped, and every mac it governed released - a device the user has stopped
   * naming by address goes back to being an ordinary discovered device, which its next advertisement corrects the address of. The release happens for every state
   * the departing dial could have ended in, because a device governed by an address the user no longer lists would otherwise keep being dialed there, ignore its
   * own advertisements from anywhere else, and never be retried. Its live session is left alone, exactly as a mac dropping out of the sidebar leaves its session
   * alone: a list edit is not a reason to tear down a working connection.
   *
   * @param listed - The addresses the warmed configuration lists, each canonical and dialable, in the user's order.
   */
  #applyAddresses(listed: readonly string[]): void {

    const kept = new Set(listed);

    for(const [ address, record ] of this.#addresses) {

      if(kept.has(address)) {

        continue;
      }

      if(record.state === "dialing") {

        record.controller.abort();
      }

      /* Every claim on the departing address goes, whatever state its dial ended in. The release is keyed to the address rather than to the record's mac for two
       * reasons: a record that failed or was aborted names no mac to release, and a resolved record names the device that ANSWERED there, which is not always the
       * device the address governs - two listed addresses can reach one opener, and the yielding one holds a resolved record naming that same mac. Passing the
       * address to each release is what keeps this from stripping the governance the address the user kept still holds.
       */
      this.#releaseAddress(address);
      this.#addresses.delete(address);
    }

    this.#warmedAddresses = listed;

    for(const address of listed) {

      if(this.#shouldDial(address)) {

        void this.#dialAddress(address);
      }
    }
  }

  /* Whether a listed address is worth dialing now.
   *
   * An address with no record has never been dialed. A dial in flight needs no second one - the record IS the guard. A resolved address is answered, and the device
   * it named is served through its mac from here on. A failed address repeats only for a reason a later attempt could get past without anyone acting, plus the pool's
   * key rule: a reachability failure may succeed on the next try, while a refused key repeats only once the key it was refused with has moved, because re-sending the
   * very key that just failed is churn that re-flashes the panel for nothing.
   *
   * @param address - The listed address.
   *
   * @returns true when this warm should dial it.
   */
  #shouldDial(address: string): boolean {

    const record = this.#addresses.get(address);

    if(record === undefined) {

      return true;
    }

    if(record.state !== "failed") {

      return false;
    }

    if((record.reason === "encryption-invalid") || (record.reason === "encryption-missing")) {

      return this.#keyMoved(record.offered);
    }

    return isRetryableFailure(record.reason);
  }

  /* Re-dial every listed address whose last outcome may yet change. This is the manual path's retry trigger, reached when the panel is asked to view a mac the pool
   * knows nothing about: a device reached only by address has no advertisement whose re-arrival could retry it, so the user selecting it is what asks again.
   */
  #redialAddresses(): void {

    for(const address of this.#warmedAddresses) {

      if(this.#shouldDial(address)) {

        void this.#dialAddress(address);
      }
    }
  }

  /* Drop the governance ONE ADDRESS gave a mac. The identity keeps every field it last had, because they are still the truth about that device - only where to dial
   * it becomes unknown, and its next advertisement answers that.
   *
   * The address is required, and it is what makes this safe to call from anywhere. A mac can be reached by more than one listed address, and only one of them
   * governs it: the others yielded, and a yielding address's record names that same mac, because the record is written when the dial resolves and the governance is
   * decided after. So a caller acting on one address - the user removing it from the list, or a new device taking it - must not be able to strip a claim some OTHER
   * address still holds. Releasing only when this address is the governing one makes that impossible by construction rather than by each caller remembering to check.
   *
   * @param mac     - The device whose governance is being released.
   * @param address - The address the release is made on behalf of. A no-op unless it is the address currently governing that device.
   */
  #releaseGovernance(mac: string, address: string): void {

    const known = this.#devices.get(mac);

    if(known?.manualAddress !== address) {

      return;
    }

    this.#rememberDevice(known.device, undefined);
  }

  /* Release EVERY claim on one address, optionally sparing the mac that is taking it. Two callers need this and they need it for opposite reasons: the writer, when
   * a mac takes an address and every other claimant must give it up, and the departure, when the user stops listing an address and nobody may go on being governed
   * by it.
   *
   * The candidates come from `#devices`, never from the address's own record. The record in `#addresses` is a derived view of one dial: a failed or aborted one
   * names no mac at all, and a resolved one names whichever device answered there, which is not necessarily the device the address governs. `#devices` is where
   * governance actually lives, so it is the only store that can be asked who is governed by an address in every state that address can be in.
   *
   * The walk does not decide who the claimant is. It offers every mac but the spared one to `#releaseGovernance`, which is the single place that knows whether a
   * mac holds this address and is a no-op for one that does not. Testing the claim here as well would be the same rule written twice, and the copy that ran first
   * would make the other unreachable.
   *
   * Mutating `#devices` while walking its own iterator is safe here, and not because the written key differs from the one being visited - it is the same key. No key
   * is ADDED during the walk, which is the thing a Map iterator cannot tolerate: a release that applies writes the value at a key the map already holds, which
   * leaves the iteration order untouched, and a release that does not apply writes nothing at all. `#releaseGovernance` re-enters `#rememberDevice` with no
   * address, which writes that one existing key and returns before reaching any walk of its own, so this walk is never nested.
   *
   * @param address - The address whose claims are released.
   * @param except  - The mac taking the address, whose claim is the one being established rather than released.
   */
  #releaseAddress(address: string, except?: string): void {

    for(const mac of this.#devices.keys()) {

      if(mac === except) {

        continue;
      }

      this.#releaseGovernance(mac, address);
    }
  }

  /* Dial one listed address, identify whatever answers, and make that connection the answering device's session.
   *
   * This is the manual path's whole connect, and it is deliberately unlike the discovered one. A mac is an identity the pool already has; an address is a place, and
   * what is at that place is the question the dial asks. So the identity comes back from the device-info record rather than from an advertisement, and it comes back
   * fresh on every dial - which is what serves a swapped opener under its own mac instead of under the mac that used to answer there.
   *
   * TOTAL by contract, like `#connectDevice`: the body sits in one try/catch so no fault escapes this fire-and-forget call. The `dialing` record is installed
   * synchronously before the first await and IS the guard against a second concurrent dial of one address, so a re-warm landing mid-dial adds nothing. Every exit
   * after the install releases that guard by writing the address's outcome over it - `resolved` once the device is identified, `failed` from a classified failure
   * or as the catch's first statement - except the exit that finds the record no longer its own after the open. That exit writes nothing: a departure or the
   * pool's disposal has deleted the record, or a later dial has installed its own, and either way the address is not this dial's to write.
   *
   * What becomes of the opened connection depends on the sidebar. A mac the sidebar lists takes the connection as its session, replacing a session it holds at some
   * other address and keeping the one it already holds at this one. A mac the sidebar does not list has its identity remembered and its connection closed at once:
   * the panel has nowhere to render it, and an idle connection would hold one of the device's few API slots for the life of the settings session.
   *
   * @param address - The listed address to dial, canonical.
   * @param onBehalfOf - The mac this dial is answering a connect request for, when a governed device's own connect delegated here. A failure then reaches the panel
   *                     as that device's failure; a dial nobody asked for on a mac's behalf fails quietly under the address.
   */
  async #dialAddress(address: string, onBehalfOf?: string): Promise<void> {

    const previous = this.#addresses.get(address);

    /* ONE dial per address at a time, and the guard lives HERE rather than at each caller, so that every route in meets it: the warm pass walking the listed
     * addresses, a governed device's own connect delegating to its address, and a view of a mac the pool cannot place. A second caller finding a dial already in
     * flight YIELDS - it does not start a rival dial and it does not wait on one - because the dial already running is dialing the same address by the same key rule
     * and will install the same session; a caller that started a second one would race it for the address record and for the mac's session slot.
     */
    if(previous?.state === "dialing") {

      return;
    }

    const controller = new AbortController();
    const log = prefixedLog(this.#log, () => address);

    /* What this dial offered, recorded by the lookup itself as the connection core calls it - the key, and the MAC the core chose it for - so the failure record and
     * the session hold exactly what the device was offered rather than a second reading of the configuration. It stays undefined while no key has been chosen: a
     * dial that failed before the handshake, or a device that answered in plaintext.
     */
    let offered: OfferedKey | undefined;

    const keyFor = (mac?: string): string | undefined => {

      offered = { key: this.#keyFor(mac), mac };

      return offered.key;
    };

    // The session this dial installs, held where the catch can reach it, and null until the dial installs one.
    let session: Nullable<DeviceSession> = null;

    this.#addresses.set(address, { controller, state: "dialing" });

    try {

      /* The dial is bounded by its own controller AND by the pool's lifetime, composed into one signal. Composing is what lets a departure cancel this one address
       * without touching any other dial, while disposal still ends every one of them.
       */
      const outcome = await openManualConnection({ host: address, keyFor, log, openClient: this.#openClient,
        shutdownSignal: composeSignals(controller.signal, this.#lifetime.signal), timeoutSeconds: this.#captureTimeoutSeconds });

      /* Is this dial still the one that owns the address? A departure aborts an in-flight dial and DELETES its record, so a dial whose record has gone - or has been
       * replaced by someone else's - must write nothing at all and dispose whatever it opened.
       *
       * Getting this wrong is not a cosmetic leak. A departure aborts, so the outcome arriving here would be a `shutdown` failure, and writing it back would leave a
       * `failed` record carrying a reason no retry gate ever retries: the address would be undialable for the life of this process, even after the user re-added it.
       */
      const holder = this.#addresses.get(address);

      if((holder?.state !== "dialing") || (holder.controller !== controller)) {

        if(outcome.ok) {

          outcome.client[Symbol.dispose]();
        }

        return;
      }

      if(!outcome.ok) {

        this.#addresses.set(address, { offered, reason: outcome.reason, state: "failed" });
        this.#reportAddressFailure(address, outcome.reason, onBehalfOf, offered);

        return;
      }

      const identity = outcome.discovered;
      const mac = identity.strippedMac;

      this.#addresses.set(address, { mac, state: "resolved" });

      /* Which address governs this device, decided exactly as the platform decides it: by the user's own list order, never by which dial happened to answer first.
       * Two listed addresses can reach one opener, and the races between them go differently on every run, so order is the only answer that is stable.
       */
      const governing = governingAddress(this.#devices.get(mac)?.manualAddress, address, this.#warmedAddresses);

      /* Whoever else was claiming this address gives it up here, inside the write. There is deliberately no separate "what did the record say before" comparison: a
       * dial that began from an address the pool had never placed, or had last seen fail, has no previous claim in hand, which is precisely the case such a
       * comparison cannot see. The writer sweeps the claims themselves, so every route into it is covered by the same rule.
       */
      this.#rememberDevice(identity, governing);

      // The identity is written, so a verdict the pool was about to record for this mac - or a not-found timer counting toward one - is retired before the session
      // that disproves it goes in. Ordering matters: a verdict retired after the install could be one this very connection just elicited.
      this.#retirePendingVerdict(mac);

      const existing = this.#sessions.get(mac);

      /* Three reasons this connection is closed rather than kept, and only the third is about this dial at all. The sidebar does not list the device, so there is
       * nowhere to render it. Or this address lost the governance, which makes it the yielding one of two that reach a single opener - and a yielding address is not
       * a standby: it holds no connection and dials nothing further, exactly as the runtime's own loop yields. Or the device is already connected at this very
       * address, in which case the session it holds is the one to keep and this dial merely re-confirmed who is there.
       */
      if(!this.#warmed.has(mac) || (governing !== address) || (existing?.address === address)) {

        outcome.client[Symbol.dispose]();

        return;
      }

      if(existing) {

        this.#teardownSession(mac);
      }

      // A device that answered in plaintext chose no key, so its record is the key at its own MAC, exactly as a discovered session's is.
      session = { address, client: null, controller, encryptedTransport: false, mac, offered: offered ?? { key: this.#keyFor(mac), mac },
        online: false, rowMap: new Map(), stack: new DisposableStack(), token: ++this.#tokenCounter };

      this.#sessions.set(mac, session);
      this.#adoptConnection({ client: outcome.client, initialState: outcome.initialState, session, variant: identity.variant });
    } catch(error) {

      /* The address's record is the in-flight guard, and writing the failure over it is what releases the guard. That is why the write comes first: nothing that
       * follows in the catch can leave the address recorded as still dialing.
       */
      this.#addresses.set(address, { offered, reason: "unknown", state: "failed" });

      log.error("The live-status connection failed unexpectedly.", error);

      /* A session whose installation threw still holds the device's slot, and left there it makes the next warm's redial read the device as already connected at
       * this address, which closes the fresh connection and serves nothing. So the session this dial installed is torn down, releasing the client its stack holds,
       * before the failure is reported, and only while it is still the one installed, because a session that has taken its place is not this failure's to remove.
       */
      if((session !== null) && (this.#sessions.get(session.mac) === session)) {

        this.#teardownSession(session.mac);
      }

      this.#reportAddressFailure(address, "unknown", onBehalfOf, offered);
    }
  }

  /* Surface a failed address dial. A dial the pool started on its own - walking the list at warm time - has no device to attribute the failure to, because the
   * whole point of the dial was to find out which device is there; it says so at debug under the address and nothing reaches the panel. A dial a governed device's
   * own connect delegated here DOES have one, and it is recorded and pushed exactly as a discovered device's failed connect is, so the panel never sits on
   * "Connecting" for a device whose listed address cannot be reached.
   *
   * @param address - The address that failed.
   * @param reason  - The classified reason it failed.
   * @param mac     - The device this dial was answering for, when one asked.
   * @param offered - What the failed dial was offered, or undefined when it failed before any key was chosen.
   */
  #reportAddressFailure(address: string, reason: ManualConnectionFailureReason, mac: string | undefined, offered: OfferedKey | undefined): void {

    const classified = statusErrorFor(reason);

    if((mac === undefined) || (classified === null)) {

      this.#log.debug("The device at %s could not be reached: %s.", address, reason);

      return;
    }

    /* The device may have been connected by something else while this dial was failing - another listed address that reaches the same opener, or a discovery pass -
     * and that connection is not this failure's to speak for. A failure whose address is no longer where the device is says nothing about the device, so it says so
     * under the address and installs nothing.
     */
    if(!this.#failureApplies(mac, address)) {

      this.#log.debug("The device at %s could not be reached: %s.", address, reason);

      return;
    }

    /* The failure belongs to a device the panel is showing, so it takes the same route a discovered device's failure takes: the verdict stored against the mac for a
     * later view to re-surface, the classified error pushed, and the session slot released. A session record is minted purely to carry the push's token.
     *
     * The slot is torn down before the mint rather than overwritten. The guard above admits two states, and one of them is a mac holding its session AT this very
     * address - so minting over it would drop a live session's record on the floor with its client still open. A teardown is what releases that client, and it is a
     * no-op on the ordinary path where the slot is already empty, so the method is sound on its own terms rather than only by what its one caller happens to do.
     */
    this.#teardownSession(mac);

    const session: DeviceSession = { address, client: null, controller: new AbortController(), encryptedTransport: false, mac, offered, online: false,
      rowMap: new Map(), stack: new DisposableStack(), token: ++this.#tokenCounter };

    this.#sessions.set(mac, session);
    this.#recordFailure(session, classified);
  }

  /* Tear down one device's session. The order is deliberate: abort the controller so every in-flight step unwinds on its identity check, then dispose the session's
   * stack, which releases in reverse of the order things went onto it - every listener first, then the client. Disposing a live client synchronously emits its
   * disconnect through the event bus, and the already-detached listeners mean that emission reaches no handler, so an intentional reconnect never pushes a spurious
   * "Disconnected" availability event. The session is removed last. Safe when absent.
   */
  #teardownSession(mac: string): void {

    const session = this.#sessions.get(mac);

    if(!session) {

      return;
    }

    session.controller.abort();
    session.stack.dispose();
    this.#sessions.delete(mac);
  }

  /* Open the discovery stream when one is not already running, and listen to it. startDiscovery is the sole caller, reached both as the custom-UI process spawns and
   * on every warm, so a spawn-time attempt that succeeded has the pool listening before the first warm arrives while one that failed is retried by the next warm; the
   * early return makes that warm-cadence retry a no-op while a stream runs. The construction is synchronous, so a factory or option fault propagates to
   * startDiscovery's containment, and the field is assigned only once it has returned.
   *
   * The stream ends rather than throws when the browser loses its last network socket, so the loop's own end is where the feed sees that fault and says so. A
   * browser that ends on its own leaves the pool with none, and the next warm's startDiscovery builds another - the warm cadence is the retry. `onError` is for a
   * throw out of the loop body, which would be a defect here, never the browser's end. The field is nulled in the `finally` the moment the loop ends, before the
   * disposal that follows awaits the sockets, so a warm arriving during that window opens a new stream rather than meeting a dead one; the pool's own abort at
   * disposal nulls the field first, which makes the `finally` a no-op on that path.
   */
  #ensureBrowser(): void {

    if(this.#discovery) {

      return;
    }

    const discovery = discoverServices<DiscoveredRatgdo>({ ...(this.#browserFactory === undefined) ? {} : { browserFactory: this.#browserFactory },
      classify: parseRatgdoService, clock: this.#clock, log: this.#log, serviceType: RATGDO_MDNS_SERVICE_TYPE, signal: this.#lifetime.signal });

    this.#discovery = discovery;

    void superviseLoop({ loop: async (): Promise<void> => {

      await using stream = discovery;

      try {

        for await (const event of stream) {

          this.#onDiscovery(event);
        }

        if(!this.#lifetime.signal.aborted) {

          this.#log.warn("The mDNS discovery browser stopped because it lost its network sockets; it restarts on the next warm.", discovery.signal.reason);
        }
      } finally {

        if(this.#discovery === discovery) {

          this.#discovery = null;
        }
      }
    }, onError: (error: unknown): void => this.#log.error("The mDNS discovery browser failed.", error), signal: this.#lifetime.signal });
  }

  /* Take in one thing the network said about a device, keyed by stripped MAC so a later advertisement refreshes a device's address.
   *
   * A warmed device with no session connects: the synchronous session install in #connectDevice is the double-connect guard, so a burst of advertisements for one mac
   * opens exactly one connection, and that same synchronous prefix clears the mac's not-found timer - the only timer an advertisement can meet, because a timer is
   * armed only for a warmed mac that holds no session. A warmed device that has stopped advertising the address its live or in-flight session dialed is torn down and
   * re-dialed at the address the fresh advertisement picks, the same shape warm() uses for a changed key, so the panel follows the device exactly as the platform
   * does. A re-advertisement that still lists the session's own address is a no-op even when the pick has moved to another of the device's addresses, and a mac
   * outside the warm set keeps whatever session it holds, which is the warm-set departure rule.
   *
   * A GOVERNED mac takes only the first half of that. Its identity refreshes like any other device's, through the one writer, which keeps the listed address as the
   * address to dial; but the address-change branch is skipped entirely, because its session lives at the address the user named and an advertisement listing some
   * other address is not the device moving - it is the device saying where else it answers, which the user has already overruled.
   *
   * @param event - The transition the discovery derived.
   */
  #onDiscovery(event: MdnsDiscoveryEvent<DiscoveredRatgdo>): void {

    switch(event.kind) {

      case "found":
      case "updated": {

        const mac = event.device.strippedMac;
        const governing = this.#devices.get(mac)?.manualAddress;

        this.#rememberDevice(event.device, governing);

        if(!this.#warmed.has(mac)) {

          return;
        }

        const session = this.#sessions.get(mac);

        if(!session) {

          void this.#connectDevice(mac);

          return;
        }

        if((governing === undefined) && !isAdvertisedAt(event.device.addresses, session.address)) {

          this.#teardownSession(mac);
          void this.#connectDevice(mac);
        }

        return;
      }

      case "lost": {

        // The discovery entry stands, so the address projection and any later connect keep the last address the device advertised, and a live session is left alone:
        // whether a connected device is still there is the ESPHome connection's to report, not an absent advertisement's.
        return;
      }

      default: {

        // Compile-time exhaustiveness: a new MdnsDiscoveryEvent kind fails to type-check here until it is handled.
        event satisfies never;

        return;
      }
    }
  }

  /* Arm a per-mac not-found timer for an undiscovered warmed device. Per-mac rather than one shared timer, because a shared timer re-armed on every warm would let an
   * unrelated device's key edit defer this device's not-found verdict indefinitely. The registry clears any timer already armed under the key, so a caller can arm
   * unconditionally without leaking a prior one, and it removes the entry before the callback runs, so the verdict reads `has(mac)` as false for its own timer.
   */
  #armDiscoveryTimer(mac: string): void {

    this.#timers.setTimeout(mac, () => this.#onDiscoveryTimeout(mac), this.#discoveryTimeoutSeconds * 1000);
  }

  /* Classify a warmed device not-found once its discovery budget elapses. The timer is cleared the instant the device is discovered, so a fired timer means the mac is
   * still undiscovered; the discovery-based predicate is a defensive re-check of that. The verdict is written to outcome memory - so a later view re-surfaces it - and
   * pushed as a sessionless error under a fresh monotonic token.
   */
  #onDiscoveryTimeout(mac: string): void {

    if(this.#devices.has(mac)) {

      return;
    }

    // Store the not-found verdict with no offered record: the retry gate pairs the record with the auth reasons alone - an unsupported verdict suppresses without
    // reading it, and not-found is not suppressed at all - so the record is inert here, and nothing was ever offered to a device that was never found.
    this.#outcomes.set(mac, { offered: undefined, reason: "not-found" });
    this.#emit({ kind: "error", reason: "not-found", serialNumber: mac, session: ++this.#tokenCounter });
  }

  /* Whether a connection failure still has anything to say about a device, asked by both failure paths in one place so the two cannot answer it differently.
   *
   * A failure is only ever about the connection that produced it. By the time it is handled the device may have been connected by something else entirely - another
   * listed address that reaches the same opener, or a discovery pass - and that connection is not this failure's to speak for.
   *
   * What the two paths ask differs on the EMPTY SLOT, and that is why the answer is not one expression. A session's own failure applies only while that very session
   * is still installed: an empty slot means the session is gone, whether a successor replaced it or disposal cleared the pool, and a failure for a session nothing
   * holds has no outcome memory worth writing and no panel to push to. An address dial made on a device's behalf carries no session of its own, and the empty slot is
   * its ORDINARY case - the dial was delegated by a connect that found the slot empty, so an empty slot is precisely the state its failure describes. It stops
   * applying only once the mac holds a session at some other address.
   *
   * @param mac     - The device the failure would be recorded against.
   * @param against - The session the failure came from, or the address it came from when the failure has no session of its own.
   *
   * @returns true when the failure still describes what this device is doing.
   */
  #failureApplies(mac: string, against: DeviceSession | string): boolean {

    const session = this.#sessions.get(mac);

    if(typeof against === "string") {

      return (session === undefined) || (session.address === against);
    }

    return session === against;
  }

  /* Record a terminal connection failure for the current session's device and surface it. Only the session still installed for the mac owns the mac's outcome memory and
   * session slot, so a session the map no longer holds writes nothing: either a successor owns the device now, or the pool was disposed out from under this connect and
   * there is nothing left to write to. On the current session: write the classified reason AND what the connection was offered - so a later warm can tell a doomed
   * resend of that same key from a genuine retry with a changed one - to outcome memory, push the error, and tear the session down so the device reads as
   * failed-with-no-session until a re-warm or a view retries it.
   *
   * A failed session releases everything it holds. It leaves the pool through `#teardownSession` rather than a bare delete, so its controller is aborted and its stack
   * disposed - every listener that registered, then the client - and a session that came apart part way through its installation never leaves the map with its
   * connection still open.
   */
  #recordFailure(session: DeviceSession, reason: StatusErrorReason): void {

    if(!this.#failureApplies(session.mac, session)) {

      return;
    }

    this.#outcomes.set(session.mac, { offered: session.offered, reason });
    this.#emit({ kind: "error", reason, serialNumber: session.mac, session: session.token });
    this.#teardownSession(session.mac);
  }

  /* Build the snapshot rows from a state cache through a session's row map and push them. Shared by the connect path (reading the captured initial-state cache) and by
   * view() (reading the live client cache), so both render the exact same row set the session advertised. A present panel entity with no cache entry is omitted, and
   * every value renders only through translateTelemetry. The rows are listed in the panel's one display order rather than the row map's, so a snapshot's rows sit
   * where the page's skeleton placed them.
   */
  #pushSnapshot(session: DeviceSession, cache: ReadonlyMap<EntityId, TelemetryEvent>): void {

    const values = new Map<StatusRowId, string>();

    for(const [ id, rowId ] of session.rowMap) {

      const cached = cache.get(id);

      if(cached === undefined) {

        continue;
      }

      values.set(rowId, mapRowValue(rowId, translateTelemetry(cached)));
    }

    // Each row is its shared template plus the value the device reports, so the motion row carries the same latch the page's skeleton does and the steady-state rows
    // carry none.
    const rows = STATUS_ROW_ORDER.flatMap((rowId): StatusRow[] => {

      const value = values.get(rowId);

      return (value === undefined) ? [] : [{ ...statusRowTemplate(rowId), value }];
    });

    /* Read the transport's encryption state from the session's own record so the snapshot mirrors the connect log's encrypted-connection lock. The record, not the
     * client's live getter: view() re-pushes a snapshot for a session that is still online through the patience window before a verdict, when the client sits between
     * sessions and its getter reads false, and the panel would drop an encrypted device's lock on a reselect.
     */
    this.#pushForSession(session, { encrypted: session.encryptedTransport, kind: "snapshot", online: true, rows, serialNumber: session.mac, session: session.token });
  }

  // Push a session's offline availability. It carries encrypted false because no transport exists while the device cannot be reached.
  #pushOffline(session: DeviceSession): void {

    this.#pushForSession(session, { encrypted: false, kind: "availability", online: false, serialNumber: session.mac, session: session.token });
  }

  /* Push an event only while its session is still the one installed for its mac. A superseded or torn-down session's late continuation must not reach the panel, so the
   * sink is guarded here once rather than at every call site. The delivery itself is contained in `#emit`.
   */
  #pushForSession(session: DeviceSession, event: StatusEvent): void {

    if(this.#sessions.get(session.mac) !== session) {

      return;
    }

    this.#emit(event);
  }

  /* Deliver one event to the bridge sink, contained. Every push - session-guarded or sessionless - routes through here so a sink that throws is logged and swallowed
   * rather than escaping. The bridge's pushEvent can reject once the modal has closed the channel, and this method is reached from fire-and-forget connects whose escaped
   * rejection would terminate the custom-UI child process, so the containment is the outer half of the pool's totality: `#connectDevice`'s try/catch guards the body, and
   * this guards the delivery of every classified error the body's own catch pushes.
   */
  #emit(event: StatusEvent): void {

    try {

      this.#push(event);
    } catch(error) {

      this.#log.error("A live-status update could not be delivered to the settings panel.", error);
    }
  }
}
