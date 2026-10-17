/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-status.ts: The live device-status connection pool for the Config UI X settings panel.
 *
 * This module runs exclusively inside the transient custom-UI child process that Config UI X forks for the plugin's settings modal - never inside Homebridge. At panel
 * open the frontend hands the pool the warm set: every device the sidebar knows plus that device's effective encryption key. The pool connects to every discovered warm
 * device immediately and holds each connection for the whole settings session, so clicking between devices is an instant view switch rather than a teardown and
 * reconnect. It opens each connection by reusing the platform's own connection.ts / discovery.ts / entities.ts / protocol modules end to end, translates telemetry into
 * status rows, and pushes those rows to the iframe over the plugin-ui-utils bridge. The status wire contract - the StatusEvent union, the StatusRow shape, and the
 * classified StatusErrorReason - lives in homebridge-plugin-utils and is imported here; this module is that contract's ratgdo adapter, owning the ESPHome StatusFeed, the
 * per-device session lifecycle, the row vocabulary, and the warm extension. It consumes openConnection, parseRatgdoService, ratgdoStatusEntityIds, presentEntityIds,
 * idFor, and translateTelemetry, and never touches raw wire semantics.
 *
 * A warm whose effective key for a device differs from the key that device's session last reconciled reconnects every such session except a healthy, connected,
 * negotiated-plaintext one, which adopts the new key in place - a transport that never used the key has nothing to reconnect for, and the reconnect would only flash the
 * panel. Mid-connect, offline, and encrypted sessions reconnect instead; an auth-failed device reconnects only on a changed key, never on a resend of the key that
 * failed; disposal tears down everything. Key resolution is the frontend's FeatureOptions engine output, diffed here per device, so encryption-key
 * inheritance lives nowhere in this module. A session is never torn down on the word of a transient device-list read - a mac merely absent from a re-warm keeps its live
 * connection. The pool holds per-mac outcome memory because
 * connects happen while no device is selected and their pushes are unrenderable, so a later view of a device that failed while unselected must re-surface the classified
 * failure rather than a permanent "Connecting...".
 *
 * The warm set and its route are ratgdo's extension to the shared protocol: the warm route declared in homebridge-ui/public/status-routes.mjs, where both halves of the
 * settings surface can read it, and narrowStatusWarmRequest here carry every known device plus its effective key to the pool, the input the key diff reads, while the
 * shared contract carries the pushed status back. Everything the panel renders - rows, updates, availability, and
 * errors - crosses the bridge as ESPHome-free, variant-free, entity-id-free data, so the row vocabulary and the label choices stay ratgdo's while the ESPHome details
 * never reach the wire.
 */
import type { Clock, HomebridgePluginLogging, MdnsBrowserFactory, MdnsDiscovery, MdnsDiscoveryEvent, Nullable, StatusErrorReason, StatusEvent,
  StatusRow } from "homebridge-plugin-utils";
import type { EntityId, EspHomeClient, LifecycleEvent, TelemetryEvent } from "esphome-client";
import { HbpuAbortError, TimerRegistry, discoverServices, prefixedLog, superviseLoop, systemClock } from "homebridge-plugin-utils";
import { RATGDO_ENTITIES, idFor, presentEntityIds, ratgdoInitialStateEntityIds, ratgdoStatusEntityIds } from "./entities.ts";
import { RATGDO_MDNS_SERVICE_TYPE, RATGDO_MOTION_DURATION, RATGDO_WEBUI_DISCOVERY_TIMEOUT } from "./settings.ts";
import { isAdvertisedAt, parseRatgdoService } from "./discovery.ts";
import type { DiscoveredRatgdo } from "./discovery.ts";
import type { EspHomeEvent } from "./types.ts";
import type { OpenEspHomeClient } from "./connection.ts";
import { RatgdoVariant } from "./types.ts";
import { openConnection } from "./connection.ts";
import { translateTelemetry } from "./protocol/telemetry.ts";

// The panel's row identities, a closed union used internally to type the label and sizer records exhaustively. The wire carries a row id as a plain string; this closed
// union is ratgdo's own, so a new row must extend it here and gains its label and sizer entries at compile time.
type StatusRowId = "door" | "light" | "lock" | "motion" | "obstruction";

/* Construction options for StatusFeed. `browserFactory`, `clock`, and `openClient` default to the real implementations (the default-arg port pattern connection.ts
 * establishes), and `discoveryTimeoutSeconds` defaults to RATGDO_WEBUI_DISCOVERY_TIMEOUT; a unit test overrides all four. `push` is the raw bridge sink - StatusFeed
 * guards every push on session identity internally, so `push` itself is unconditional.
 *
 * @property browserFactory          - The library's browser boundary. A test injects TestMdnsBrowserFactory; absent, the library builds its own browser.
 * @property clock                   - The time source the not-found timers and the browser arm on. Defaults to systemClock; a test injects TestClock.
 * @property discoveryTimeoutSeconds - Seconds a warmed mac waits for mDNS discovery before it is classified not-found. Defaults to RATGDO_WEBUI_DISCOVERY_TIMEOUT.
 * @property log                     - The logging adapter client-internal and feed-internal messages route through.
 * @property openClient              - The ESPHome client-factory port, threaded straight into openConnection. Defaults to the real factory there.
 * @property push                    - The bridge sink that delivers a status event to the iframe.
 */
export interface StatusFeedOptions {

  browserFactory?: MdnsBrowserFactory;
  clock?: Clock;
  discoveryTimeoutSeconds?: number;
  log: HomebridgePluginLogging;
  openClient?: OpenEspHomeClient;
  push: (event: StatusEvent) => void;
}

/* One warm-set entry on the wire: a device's stripped mac and its effective encryption key, absent when the device has none. This is the single named shape the warm
 * narrowing produces and the warm method consumes, so neither re-declares it inline.
 */
export interface WarmDeviceEntry {

  mac: string;
  psk?: string;
}

/* The per-device session record, keyed in `#sessions` by stripped mac. The record carries its own mac so the identity-guarded sink is self-describing: a push through
 * `#pushForSession(session, event)` lands only while `this.#sessions.get(session.mac) === session`. `address` is the address this session's connect dialed, which is
 * what lets the discovery path tell a device that has moved from one whose advertised set merely shifted underneath it - `#devices` holds the advertised truth and the
 * session holds the dialed one, and the address projection reads the dialed one because that is where the panel's connection is; `client` is null until the connection
 * opens; `controller` cancels every in-flight step; `encryptedTransport` records the negotiated transport captured once at connect resolution - true when the client
 * negotiated encryption - and backs the key diff in place of the live isEncrypted getter, which reads false during the client's own reconnect windows; `online`
 * tracks connect and disconnect through the lifecycle listener; `rowMap` is the entity-id-to-row-id map computed at connect resolution and retained because view()
 * rebuilds a snapshot from it long after the connect; `psk` records the key the diff last reconciled - the key the connection was opened with, or the key a healthy
 * plaintext session adopted in place; `stack` holds the client and then each retained listener, so teardown releases the listeners before the client's disconnect;
 * `token` is the session's monotonic identity.
 */
interface DeviceSession {

  address: string;
  client: Nullable<EspHomeClient>;
  controller: AbortController;
  encryptedTransport: boolean;
  mac: string;
  online: boolean;
  psk: string | undefined;
  rowMap: Map<EntityId, StatusRowId>;
  stack: DisposableStack;
  token: number;
}

// The human-readable label for each row identity. The "Remotes" label reflects that the lock entity controls the opener's remote lockout rather than a physical deadbolt.
const STATUS_ROW_LABELS: Record<StatusRowId, string> = {

  door: "Door",
  light: "Light",
  lock: "Remotes",
  motion: "Motion",
  obstruction: "Obstruction"
};

/* The status entity universe for a variant: every status entity id mapped to its panel row id, derived from the RATGDO_ENTITIES registry so entity literals never leave
 * that module. The switch is exhaustive over RatgdoVariant, so adding a variant fails compilation here. Motion is a ratgdo-only momentary sensor - Konnected firmware
 * advertises none - so it appears in the ratgdo row set only. Insertion order fixes the panel's display order: Door, Remotes, Motion, Light, Obstruction.
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

/* Map a translated telemetry event to its display value for a given row. The switch is exhaustive over StatusRowId. The door reads current_operation first so a moving
 * door shows its transition, then falls back to position: a raw 0-1 cover position of >= 1 is Open, absent or <= 0 is Closed (protobuf omits a zero-valued position, so a
 * closed door legitimately arrives with none), and anything strictly between is a partial stop. The remaining rows are straight state translations.
 */
function mapRowValue(rowId: StatusRowId, event: EspHomeEvent): string {

  switch(rowId) {

    case "door": {

      if(event.current_operation === "OPENING") {

        return "Opening";
      }

      if(event.current_operation === "CLOSING") {

        return "Closing";
      }

      const position = event.position;

      if((position === undefined) || (position <= 0)) {

        return "Closed";
      }

      if(position >= 1) {

        return "Open";
      }

      return "Stopped (" + String(Math.round(position * 100)) + "%)";
    }

    case "light": {

      return (event.state === "ON") ? "On" : "Off";
    }

    case "lock": {

      switch(event.state) {

        case "LOCKED":

          return "Locked";

        case "UNLOCKED":

          return "Unlocked";

        default:

          return "Unknown";
      }
    }

    case "motion": {

      return (event.state === "ON") ? "Detected" : "";
    }

    case "obstruction": {

      return (event.state === "ON") ? "Obstructed" : "Clear";
    }

    default: {

      // Compile-time exhaustiveness: a new StatusRowId fails to type-check here until it is handled.
      rowId satisfies never;

      return "";
    }
  }
}

/* The widest display value each row's vocabulary can produce, one entry per row id. This lives beside mapRowValue because the two share one vocabulary: a change to a
 * row's value set - a new lock state, a wider door label - must update the widest member here in the same edit. The frontend renders each as an invisible width
 * reservation so a column is born at its maximum-ever width and never truncates a value or shifts. The door's "Stopped (100%)" is its widest because the three-digit
 * percentage is the longest partial-position label; "Off", "Unlocked", "Detected", and "Obstructed" are each the longest member of their row's closed value set. Typing
 * the map as a Record over StatusRowId makes it fail to compile until every row id is covered.
 */
const STATUS_ROW_SIZERS: Record<StatusRowId, string> = {

  door: "Stopped (100%)",
  light: "Off",
  lock: "Unlocked",
  motion: "Detected",
  obstruction: "Obstructed"
};

/* Narrow the untrusted warm-request body at the bridge boundary. The body must be an object carrying a `devices` array or the whole request is null. Each entry is
 * narrowed individually - a non-empty string mac is required, a psk is carried only when it is a non-empty string - and a malformed entry is dropped without invalidating
 * the request, because one bad device must not blank the whole panel. An empty devices array is valid: it is how the frontend says "the sidebar knows nothing". This
 * lives in the tested module rather than the untestable server adapter.
 */
export function narrowStatusWarmRequest(body: unknown): Nullable<{ devices: WarmDeviceEntry[] }> {

  if((typeof body !== "object") || (body === null)) {

    return null;
  }

  const record = body as { devices?: unknown };

  if(!Array.isArray(record.devices)) {

    return null;
  }

  const devices: WarmDeviceEntry[] = [];

  for(const raw of record.devices) {

    if((typeof raw !== "object") || (raw === null)) {

      continue;
    }

    const entry = raw as { mac?: unknown; psk?: unknown };

    if((typeof entry.mac !== "string") || (entry.mac.length === 0)) {

      continue;
    }

    const psk = ((typeof entry.psk === "string") && (entry.psk.length > 0)) ? entry.psk : undefined;

    devices.push({ mac: entry.mac, psk });
  }

  return { devices };
}

/* The status connection pool. It holds one live or in-flight session per warmed, discovered device and switches the panel's view between them without teardown. Teardown
 * happens on a differing effective key - which reconnects every session except a healthy, connected, negotiated-plaintext one, that instead adopts the key in place - on
 * an advertisement that moves a warmed device to a different address, which re-dials the session at the new one so the panel follows the device exactly as the platform
 * does, and on disposal; an auth-failed device reconnects only when the key changes. Every push routes through the per-mac identity guard, so a superseded session's late
 * continuation reaches no panel. The pool is disposable; disposal ends the discovery stream, clears the warm set and every timer, and tears down every session.
 */
export class StatusFeed implements Disposable {

  readonly #browserFactory: MdnsBrowserFactory | undefined;
  readonly #clock: Clock;
  readonly #devices = new Map<string, DiscoveredRatgdo>();
  // The live discovery while one runs, and null between them: a null field is what makes the next warm's startDiscovery open a new one.
  #discovery: Nullable<MdnsDiscovery<DiscoveredRatgdo>> = null;
  readonly #discoveryTimeoutSeconds: number;
  // The pool's own lifetime, and the signal every discovery it opens is bound to. Aborted exactly once, at disposal.
  readonly #lifetime = new AbortController();
  readonly #log: HomebridgePluginLogging;
  readonly #openClient: OpenEspHomeClient | undefined;
  readonly #outcomes = new Map<string, { psk: string | undefined; reason: StatusErrorReason }>();
  readonly #push: (event: StatusEvent) => void;
  readonly #sessions = new Map<string, DeviceSession>();
  readonly #timers: TimerRegistry;
  #tokenCounter = 0;
  #warmKeys = new Map<string, string | undefined>();

  public constructor({ browserFactory, clock = systemClock, discoveryTimeoutSeconds = RATGDO_WEBUI_DISCOVERY_TIMEOUT, log, openClient, push }: StatusFeedOptions) {

    this.#browserFactory = browserFactory;
    this.#clock = clock;
    this.#discoveryTimeoutSeconds = discoveryTimeoutSeconds;
    this.#log = log;
    this.#openClient = openClient;
    this.#push = push;

    // The not-found timers are unref'd as a matter of this owner's policy: the custom-UI child process must be free to exit when the settings modal closes, and a
    // pending per-mac budget is never a reason to hold it open.
    this.#timers = new TimerRegistry({ clock, unref: true });
  }

  /* Apply a warm set: the whole sidebar's device list plus each device's effective encryption key. This is the pool's one policy chokepoint. The warm set replaces
   * `#warmKeys` wholesale (never merged), so a mac the sidebar dropped simply leaves the set - its live session is deliberately NOT torn down, because a transient
   * device-list read must never destroy a live connection. For each entry: a discovered device with no session starts a connect, unless outcome memory records an auth
   * failure against this very key, in which case the connect waits for a changed key; an undiscovered device with no session and no pending discovery timer arms its
   * per-mac not-found timer; a device whose live session's key differs is torn down and reconnected against the new key, EXCEPT a healthy, connected,
   * negotiated-plaintext session, which adopts the new key in place with no teardown; a device whose key matches is left untouched. Timers for macs that left the warm
   * set are cleared, since discovery and the not-found sweep do not concern a departed mac.
   */
  public warm(request: { devices: WarmDeviceEntry[] }): void {

    // The macs the previous warm set knew, captured before the wholesale replace so we can clear the timers of the ones that leave.
    const departed = new Set(this.#warmKeys.keys());

    this.#warmKeys = new Map(request.devices.map((entry) => [ entry.mac, entry.psk ]));

    for(const mac of departed) {

      if(!this.#warmKeys.has(mac)) {

        this.#timers.clear(mac);
      }
    }

    // Re-ensure the discovery stream before this warm applies. startDiscovery is a no-op while one runs, so a healthy stream pays nothing; a browser whose
    // construction failed, or one that ended after losing its sockets, is replaced here at the warm cadence rather than leaving the pool blind for the child
    // process's life, and each failed attempt logs - the live signal an operator troubleshoots from. A discovery that lands after a pending not-found timer has
    // fired self-heals on arrival: #onDiscovery's connect trigger fires for the still-warmed mac and #connectDevice's synchronous prefix clears the stored outcome
    // before its first await, and view()'s stored-outcome retry covers a mac that re-enters the warm set later.
    this.startDiscovery();

    for(const entry of request.devices) {

      const session = this.#sessions.get(entry.mac);

      if(!session) {

        /* No session yet. A discovered device connects now, unless outcome memory holds a verdict that re-dialing cannot change. Two of those exist, and they are
         * suppressed on different terms.
         *
         * An auth failure is suppressed only against the very key it failed with: a forced warm - the restart recovery or the visibility belt - resends unchanged keys
         * at foreground cadence, and re-running a connect with the key that just failed is doomed churn that re-flashes the panel, while a changed key is a genuine
         * retry and falls through to the connect, whose synchronous prefix clears the stored outcome. An unsupported verdict is suppressed regardless of the key,
         * because a firmware version the client cannot speak does not become speakable when a key is edited; only a firmware or plugin update changes it, and either
         * one reopens the panel. Every other outcome keeps its unconditional retry here. An undiscovered device arms a not-found timer, but only when none is already
         * counting down for it - a re-warm that changes an unrelated device's key must not defer this device's verdict.
         */
        if(this.#devices.has(entry.mac)) {

          const outcome = this.#outcomes.get(entry.mac);
          const authFailedOnThisKey = (outcome !== undefined) && ((outcome.reason === "auth-invalid") || (outcome.reason === "auth-missing")) &&
            (outcome.psk === entry.psk);

          if((outcome?.reason === "unsupported") || authFailedOnThisKey) {

            continue;
          }

          void this.#connectDevice(entry.mac);
        } else if(!this.#timers.has(entry.mac)) {

          this.#armDiscoveryTimer(entry.mac);
        }

        continue;
      }

      // A live or in-flight session whose key matches is left untouched, which is the whole point of the pool. A session whose key differs adopts the new key in place -
      // with no teardown - ONLY when it is healthy, connected, and negotiated plaintext: such a transport genuinely does not use the key, so adopting ends the cosmetic
      // Connecting flash an unencrypted device would otherwise show on a global key edit. Every other differing-key session - mid-connect (client still null), offline
      // (dropped since its last connect), or encrypted - tears down and reconnects against the new key. The branch reads session.encryptedTransport and
      // session.online, both captured at well-defined moments, never the live client.isEncrypted getter: that getter is connection-phase state that reads false
      // during any transient disconnect of the client's own auto-reconnect cycle, so a live read would misclassify a mid-blip encrypted device, adopt the key in place,
      // and permanently desync the still-old-keyed client. An offline plaintext session's reconnect re-captures the transport truth on arrival, which also covers a
      // device whose firmware later enables encryption: it drops offline on its reboot and rejoins through the reconnect path against the then-current key.
      if(session.psk !== entry.psk) {

        if((session.client !== null) && session.online && !session.encryptedTransport) {

          session.psk = entry.psk;
        } else {

          this.#teardownSession(entry.mac);
          void this.#connectDevice(entry.mac);
        }
      }
    }
  }

  /* Switch the panel's view to one device. A live session re-pushes its snapshot from the client's cache through the retained row map, so a switch between two live
   * devices constructs and disposes nothing. A still-connecting session pushes "connecting". Otherwise the stored outcome decides: a transient failure (timeout or
   * unreachable), or a not-found for a device that has since been discovered, retries with a fresh connect, so a temporary outage clears the moment the user reselects
   * the device rather than requiring the panel to be reopened; a key failure re-pushes its error, because retrying is pointless until the key changes and the warm diff
   * owns that; a warmed-but-undiscovered mac with no outcome
   * pushes "connecting" and lets its timer classify it. An unwarmed mac pushes "connecting" rather than not-found - the ordered bridge makes this happen only in exotic
   * timing, and the warm that follows resolves it.
   */
  public view(mac: string): void {

    const session = this.#sessions.get(mac);

    if(session) {

      if(session.client) {

        this.#pushSnapshot(session, session.client.snapshot());

        return;
      }

      this.#pushForSession(session, { kind: "connecting", serialNumber: mac, session: session.token });

      return;
    }

    const reason = this.#outcomes.get(mac)?.reason;

    if((reason === "timeout") || (reason === "unreachable") || ((reason === "not-found") && this.#devices.has(mac))) {

      void this.#connectDevice(mac);

      return;
    }

    if((reason === "auth-invalid") || (reason === "auth-missing") || (reason === "unsupported")) {

      this.#emit({ kind: "error", reason, serialNumber: mac, session: ++this.#tokenCounter });

      return;
    }

    this.#emit({ kind: "connecting", serialNumber: mac, session: ++this.#tokenCounter });
  }

  /* Project the discovered set into a plain mac-to-address object for the identity strip. Each discovered device's stripped mac - the very key the pushes carry as
   * serialNumber, so the frontend joins on device.serialNumber with no translation - maps to the address the status connection is actually on: the one this device's
   * session dialed, and for a device the pool holds no session for, the one its advertisement would be dialed at. The two differ whenever a device advertises a
   * higher-ranked address than the one its live connection was opened at, and the panel's "IP Address" means where the connection is. A pure synchronous read of
   * #devices and #sessions: it changes no session state and emits no wire event, so the panel can pull it at any time without perturbing a connection. The result is
   * frozen and freshly built per call, so a caller that mutates one read can corrupt neither the pool's discovery memory nor a later read.
   */
  public addresses(): Readonly<Record<string, string>> {

    const projection: Record<string, string> = {};

    for(const [ mac, device ] of this.#devices) {

      projection[mac] = this.#sessions.get(mac)?.address ?? device.address;
    }

    return Object.freeze(projection);
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
   * the time it drains; then clear every not-found timer, tear down every session, and clear every map. Disposal ends the pool for good: a later startDiscovery opens
   * a browser on the aborted lifetime, whose stream ends at once. Safe to call more than once - a second abort of an aborted controller does nothing, and the maps are
   * already empty. The session walk reads the map's own iterator rather than a copy, which tolerates the deletion of the entry it is standing on.
   */
  public [Symbol.dispose](): void {

    this.#lifetime.abort(new HbpuAbortError("shutdown"));
    this.#discovery = null;
    this.#warmKeys.clear();
    this.#timers.clearAll();

    for(const mac of this.#sessions.keys()) {

      this.#teardownSession(mac);
    }

    this.#sessions.clear();
    this.#devices.clear();
    this.#outcomes.clear();
  }

  /* Open a connection for one discovered device and hold it as a live session. TOTAL by contract in two layers: the whole body sits in one try/catch so no synchronous or
   * awaited fault escapes, and every push routes through the contained `#emit` so a push sink that throws - the plugin-ui-utils bridge rejecting a pushEvent once the
   * modal has closed the channel - is swallowed rather than escaping. Totality matters because this method is dispatched fire-and-forget, so an escaped rejection would
   * terminate the custom-UI child process. The key is read ONCE from `#warmKeys` into a single local that backs BOTH the session record and the openConnection argument,
   * because the warm diff's correctness rests on those two never diverging. The session is installed in `#sessions` BEFORE the first await, which is the double-connect
   * guard against advertisement bursts and concurrent warms. Each terminal branch records outcome memory and pushes its classified error (except shutdown, which stands
   * down silently because the session was torn down mid-connect); a successful open whose session was superseded while connecting disposes its client silently.
   */
  async #connectDevice(mac: string): Promise<void> {

    const device = this.#devices.get(mac);

    // Every caller connects only a discovered device, so a missing entry means the mac left discovery between the decision and here; there is nothing to open.
    if(!device) {

      return;
    }

    // The feed logs this connection's lifecycle under the device's own identity - the mDNS-advertised name, or the dialed address for a device advertising no usable
    // name - so a connection failure in a multi-device install is attributable from the log line alone. HomeKit-side logging resolves the user's Device.LogName option
    // at the platform instead (platform.ts, resolveLogName); the feed speaks mDNS identity because that is the truth it discovers and dials. The empty-string guard is
    // deliberate, and it is why the fallback defaults with a logical or rather than a nullish coalesce: a device advertising an empty name is as unusable an identity as
    // one advertising none, and nullish coalescing would let that empty string through as the prefix.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const log = prefixedLog(this.#log, () => device.friendlyName || device.address);

    // The key backs both the session record and the openConnection argument from this one read, so a later warm-set replacement cannot make the two disagree for this
    // connect.
    const psk = this.#warmKeys.get(mac);
    const session: DeviceSession = { address: device.address, client: null, controller: new AbortController(), encryptedTransport: false, mac, online: false, psk,
      rowMap: new Map(), stack: new DisposableStack(), token: ++this.#tokenCounter };

    try {

      // A connect is starting: clear any stale outcome memory and any pending not-found timer, then install the session synchronously so a concurrent advertisement or
      // warm sees a live session and does not start a second connect. This runs inside the try so the whole body - including the connecting push - stays total.
      this.#outcomes.delete(mac);
      this.#timers.clear(mac);
      this.#sessions.set(mac, session);
      this.#pushForSession(session, { kind: "connecting", serialNumber: mac, session: session.token });

      const outcome = await openConnection({ expected: ratgdoInitialStateEntityIds(device.variant), host: device.address, log, openClient: this.#openClient,
        psk, shutdownSignal: session.controller.signal });

      if(!outcome.ok) {

        switch(outcome.reason) {

          case "shutdown":

            return;

          case "encryption-invalid":

            this.#recordFailure(session, "auth-invalid");

            return;

          case "encryption-missing":

            this.#recordFailure(session, "auth-missing");

            return;

          case "timeout":

            this.#recordFailure(session, "timeout");

            return;

          case "unsupported":

            this.#recordFailure(session, "unsupported");

            return;

          case "permanent":
          case "unknown":

            this.#recordFailure(session, "unreachable");

            return;

          default: {

            // Compile-time exhaustiveness: a new ConnectionFailureReason fails to type-check here until it is handled.
            outcome.reason satisfies never;

            return;
          }
        }
      }

      // The connection is open. If a key-diff teardown or dispose superseded this session while connecting, dispose the client and stand down without a push.
      if(this.#sessions.get(mac) !== session) {

        outcome.client[Symbol.dispose]();

        return;
      }

      const { client, initialState } = outcome;

      // Compute the panel's row model BEFORE registering any listener, so the telemetry filter closure never observes an uninitialized set. The universe is the variant's
      // status entities mapped to row ids; narrowing it to the device's advertised entities yields the present rows in a stable display order. The map is retained on the
      // session so view() can rebuild a snapshot from it long after this connect.
      const universe = statusRowIndex(device.variant);
      const present = new Set<EntityId>(presentEntityIds(client, ratgdoStatusEntityIds(device.variant)));

      for(const [ id, rowId ] of universe) {

        if(present.has(id)) {

          session.rowMap.set(id, rowId);
        }
      }

      /* Register the session's listeners onto its stack. The client goes on FIRST and each listener after it, so teardown releases the listeners before the client's
       * disconnect and an intentional reconnect never pushes a spurious "Disconnected" availability event. The telemetry listener translates each event and pushes a
       * row only for a present panel entity; the lifecycle listener - the canonical typed connect/disconnect channel - drives the availability row. After a reconnect
       * cycle the device re-bursts full state through the retained telemetry listener, so rows self-heal without a fresh snapshot.
       */
      session.stack.use(client);
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

          switch(lifecycle.kind) {

            case "connect":

              session.online = true;
              this.#pushForSession(session, { encrypted: lifecycle.encrypted, kind: "availability", online: true, serialNumber: session.mac, session: session.token });

              return;

            case "disconnect":

              session.online = false;
              this.#pushForSession(session, { encrypted: false, kind: "availability", online: false, serialNumber: session.mac, session: session.token });

              return;

            default: {

              // Compile-time exhaustiveness: a new LifecycleEvent kind fails to type-check here until it is handled.
              lifecycle satisfies never;

              return;
            }
          }
        }));

      // Capture the negotiated transport ONCE, here at connect resolution, and mark the session connected. The initial connect fired inside openConnection before this
      // listener was registered, so online is set explicitly here and maintained by the lifecycle listener thereafter. warm()'s key diff reads these two session-tracked
      // fields, never the live isEncrypted getter, for the disconnect-window reason spelled out at that branch.
      session.client = client;
      session.encryptedTransport = client.isEncrypted;
      session.online = true;

      // Push the snapshot from the captured initial-state cache. Reading it AFTER registration means an event landing in that window produces at worst a duplicate row
      // push, never a loss; a present panel entity with no cache entry is omitted from the snapshot.
      this.#pushSnapshot(session, initialState);
    } catch(error) {

      log.error("The live-status connection failed unexpectedly.", error);
      this.#recordFailure(session, "unreachable");
    }
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
   * @param event - The transition the discovery derived.
   */
  #onDiscovery(event: MdnsDiscoveryEvent<DiscoveredRatgdo>): void {

    switch(event.kind) {

      case "found":
      case "updated": {

        const mac = event.device.strippedMac;

        this.#devices.set(mac, event.device);

        if(!this.#warmKeys.has(mac)) {

          return;
        }

        const session = this.#sessions.get(mac);

        if(!session) {

          void this.#connectDevice(mac);

          return;
        }

        if(!isAdvertisedAt(event.device, session.address)) {

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

    // Store the not-found verdict with an undefined key: the retry gate pairs the stored key with the auth reasons alone - an unsupported verdict suppresses without
    // reading it, and not-found is not suppressed at all - so the key is inert here, and this write site has no session in scope to read one from.
    this.#outcomes.set(mac, { psk: undefined, reason: "not-found" });
    this.#emit({ kind: "error", reason: "not-found", serialNumber: mac, session: ++this.#tokenCounter });
  }

  /* Record a terminal connection failure for the current session's device and surface it. Only the session still installed for the mac owns the mac's outcome memory and
   * session slot, so a superseded session that somehow reaches here writes nothing - its successor owns the device now. On the current session: write the classified
   * reason AND the key it failed with - so a later warm can tell a doomed resend of that same key from a genuine retry with a changed one - to outcome memory, push the
   * error, and remove the session so the device reads as failed-with-no-session until a re-warm or a view retries it.
   */
  #recordFailure(session: DeviceSession, reason: StatusErrorReason): void {

    if(this.#sessions.get(session.mac) !== session) {

      return;
    }

    this.#outcomes.set(session.mac, { psk: session.psk, reason });
    this.#emit({ kind: "error", reason, serialNumber: session.mac, session: session.token });
    this.#sessions.delete(session.mac);
  }

  /* Build the snapshot rows from a state cache through a session's row map and push them. Shared by the connect path (reading the captured initial-state cache) and by
   * view() (reading the live client cache), so both render the exact same row set the session advertised. A present panel entity with no cache entry is omitted, and
   * every value renders only through translateTelemetry.
   */
  #pushSnapshot(session: DeviceSession, cache: ReadonlyMap<EntityId, TelemetryEvent>): void {

    const rows: StatusRow[] = [];

    for(const [ id, rowId ] of session.rowMap) {

      const cached = cache.get(id);

      if(cached === undefined) {

        continue;
      }

      const row: StatusRow = { id: rowId, label: STATUS_ROW_LABELS[rowId], sizer: STATUS_ROW_SIZERS[rowId], value: mapRowValue(rowId, translateTelemetry(cached)) };

      // Motion is the one momentary row, so its snapshot value carries the latch that clears a detected state back to the placeholder after the configured duration; the
      // steady-state rows carry none. The latch travels on the authoritative snapshot row, so the panel's clear-back runs on the server's duration rather than the
      // skeleton's fallback.
      if(rowId === "motion") {

        row.latch = { seconds: RATGDO_MOTION_DURATION, value: "Detected" };
      }

      rows.push(row);
    }

    // Read the transport's encryption state from the session's own client so the snapshot mirrors the connect log's encrypted-connection lock. Both callers assign
    // session.client before this runs (the connect path just opened it, view() guards on it), so the live getter is the source; a null client defaults to false.
    const encrypted = session.client?.isEncrypted ?? false;

    this.#pushForSession(session, { encrypted, kind: "snapshot", online: true, rows, serialNumber: session.mac, session: session.token });
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
