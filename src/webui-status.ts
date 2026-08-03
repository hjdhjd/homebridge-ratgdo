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
 * The warm set and its route are ratgdo's extension to the shared protocol: STATUS_WARM_ROUTE and narrowStatusWarmRequest carry every known device plus its effective key
 * to the pool, the input the key diff reads, while the shared contract carries the pushed status back. Everything the panel renders - rows, updates, availability, and
 * errors - crosses the bridge as ESPHome-free, variant-free, entity-id-free data, so the row vocabulary and the label choices stay ratgdo's while the ESPHome details
 * never reach the wire.
 */
import type { EntityId, EspHomeClient, LifecycleEvent, TelemetryEvent } from "esphome-client";
import type { HomebridgePluginLogging, Nullable, StatusErrorReason, StatusEvent, StatusRow } from "homebridge-plugin-utils";
import { RATGDO_AUTODISCOVERY_TYPES, RATGDO_AUTODISCOVERY_WARMUP_OFFSETS, RATGDO_MOTION_DURATION, RATGDO_WEBUI_DISCOVERY_TIMEOUT,
  RATGDO_WEBUI_MDNS_REQUERY_INTERVAL } from "./settings.ts";
import { RATGDO_ENTITIES, idFor, presentEntityIds, ratgdoInitialStateEntityIds, ratgdoStatusEntityIds } from "./entities.ts";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { Bonjour } from "bonjour-service";
import type { DiscoveredRatgdo } from "./discovery.ts";
import type { EspHomeEvent } from "./types.ts";
import type { OpenEspHomeClient } from "./connection.ts";
import { RatgdoVariant } from "./types.ts";
import type { Service } from "bonjour-service";
import { openConnection } from "./connection.ts";
import { parseRatgdoService } from "./discovery.ts";
import { prefixedLog } from "homebridge-plugin-utils";
import { translateTelemetry } from "./protocol/telemetry.ts";

// The onRequest route the warm extension registers - ratgdo's addition to the shared status protocol. It carries the whole warm set (every known device plus its
// effective encryption key) so the pool connects ahead of selection. server.js and ui.mjs both address the bridge through this constant (ui.mjs mirrors the literal in
// its own module, because browser code cannot import from dist/), so this module is its one owner. The push-event name and the view route are the shared
// homebridge-plugin-utils contract, imported by both adapters from the package root.
export const STATUS_WARM_ROUTE = "/statusWarm";

// The onRequest route the address projection registers - a ratgdo addition to the shared status protocol, beside the warm route. It carries no request body and answers
// with the feed's live discovery map: each discovered device's mac to the address the status connection dials, the same truth the identity strip renders. server.js and
// ui.mjs both address the bridge through this constant, and ui.mjs mirrors the literal in its own module because browser code cannot import from dist/. The address is
// ratgdo-owned identity data, so it rides this ratgdo route rather than the shared homebridge-plugin-utils push wire.
export const STATUS_ADDRESSES_ROUTE = "/statusAddresses";

// The panel's row identities, a closed union used internally to type the label and sizer records exhaustively. The wire carries a row id as a plain string; this closed
// union is ratgdo's own, so a new row must extend it here and gains its label and sizer entries at compile time.
type StatusRowId = "door" | "light" | "lock" | "motion" | "obstruction";

// The injectable mDNS discovery port: given a per-service callback, start browsing and return a stop function. The default implementation wraps bonjour-service; a unit
// test injects a fake that drives advertisements synchronously and counts its stop calls.
export type RatgdoServiceBrowser = (onService: (service: Service) => void) => () => void;

/* Construction options for StatusFeed. `browse` and `openClient` default to the real implementations (the default-arg port pattern connection.ts establishes), and
 * `discoveryTimeoutSeconds` defaults to RATGDO_WEBUI_DISCOVERY_TIMEOUT; a unit test overrides all three. `push` is the raw bridge sink - StatusFeed guards every push on
 * session identity internally, so `push` itself is unconditional.
 *
 * @property browse                  - The mDNS discovery port. Defaults to the real bonjour-service browser.
 * @property discoveryTimeoutSeconds - Seconds a warmed mac waits for mDNS discovery before it is classified not-found. Defaults to RATGDO_WEBUI_DISCOVERY_TIMEOUT.
 * @property log                     - The logging adapter client-internal and feed-internal messages route through.
 * @property openClient              - The ESPHome client-factory port, threaded straight into openConnection. Defaults to the real factory there.
 * @property push                    - The bridge sink that delivers a status event to the iframe.
 */
export interface StatusFeedOptions {

  browse?: RatgdoServiceBrowser;
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
 * `#pushForSession(session, event)` lands only while `this.#sessions.get(session.mac) === session`. `client` is null until the connection opens; `controller` cancels
 * every in-flight step; `encryptedTransport` records the negotiated transport captured once at connect resolution - true when the client negotiated encryption - and
 * backs the key diff in place of the live isEncrypted getter, which reads false during the client's own reconnect windows; `listeners` holds the retained
 * telemetry/lifecycle Disposables; `online` tracks connect and disconnect through the lifecycle listener; `rowMap` is the entity-id-to-row-id map computed at connect
 * resolution and retained because view() rebuilds a snapshot from it long after the connect; `psk` records the key the diff last reconciled - the key the connection was
 * opened with, or the key a healthy plaintext session adopted in place; `token` is the session's monotonic identity.
 */
interface DeviceSession {

  client: Nullable<EspHomeClient>;
  controller: AbortController;
  encryptedTransport: boolean;
  listeners: Disposable[];
  mac: string;
  online: boolean;
  psk: string | undefined;
  rowMap: Map<EntityId, StatusRowId>;
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
      const _exhaust: never = rowId;

      void _exhaust;

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

/* The default mDNS discovery port. A single mDNS query can lose its packet or be answered slowly, so the browser opens with a warmup burst before settling into a
 * steady-state re-query. The burst reuses RATGDO_AUTODISCOVERY_WARMUP_OFFSETS, the RFC 6762 §5.2 doubling-interval cadence the platform's own discovery schedule fires,
 * so this browser and the platform share one source of mDNS timing truth rather than a second set of numbers. Offset zero is the query bonjour-service issues at find()
 * time, so only the non-zero offsets schedule follow-ups; the steady-state RATGDO_WEBUI_MDNS_REQUERY_INTERVAL then carries the long tail while the modal is open. Every
 * timer is unref'd so none keeps the child process alive on its own, and the returned stop function clears the warmup timers alongside the interval, stops each browser,
 * and destroys the Bonjour instance.
 */
const defaultBrowse: RatgdoServiceBrowser = (onService) => {

  const bonjour = new Bonjour();
  const browsers = RATGDO_AUTODISCOVERY_TYPES.map((type) => bonjour.find({ type }, onService));

  // Re-issue every browser's mDNS query. Shared by the warmup burst and the steady-state interval, so the two cadences drive one query action.
  const requery = (): void => {

    for(const browser of browsers) {

      browser.update();
    }
  };

  // The warmup burst: one follow-up query at each non-zero warmup offset, catching a device whose responder missed the initial find() query. Offset zero is that initial
  // query itself, so it schedules no follow-up here. Each timer is unref'd and retained so the stop function can clear it.
  const warmupTimers = RATGDO_AUTODISCOVERY_WARMUP_OFFSETS.filter((offset) => offset > 0).map((offset) => {

    const timer = setTimeout(requery, offset * 1000);

    timer.unref();

    return timer;
  });

  const interval = setInterval(requery, RATGDO_WEBUI_MDNS_REQUERY_INTERVAL * 1000);

  interval.unref();

  return (): void => {

    clearInterval(interval);

    for(const timer of warmupTimers) {

      clearTimeout(timer);
    }

    for(const browser of browsers) {

      browser.stop();
    }

    bonjour.destroy();
  };
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
 * happens on a differing effective key - which reconnects every session except a healthy, connected, negotiated-plaintext one, that instead adopts the key in place - and
 * on disposal; an auth-failed device reconnects only when the key changes. Every push routes through the per-mac identity guard, so a superseded session's late
 * continuation reaches no panel. The pool is disposable; disposal stops the browser, clears the warm set and every timer, and tears down every session.
 */
export class StatusFeed {

  readonly #browse: RatgdoServiceBrowser;
  readonly #devices = new Map<string, DiscoveredRatgdo>();
  readonly #discoveryTimeoutSeconds: number;
  readonly #discoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #log: HomebridgePluginLogging;
  readonly #openClient: OpenEspHomeClient | undefined;
  readonly #outcomes = new Map<string, { psk: string | undefined; reason: StatusErrorReason }>();
  readonly #push: (event: StatusEvent) => void;
  readonly #sessions = new Map<string, DeviceSession>();
  #stopBrowser: Nullable<() => void> = null;
  #tokenCounter = 0;
  #warmKeys = new Map<string, string | undefined>();

  public constructor({ browse = defaultBrowse, discoveryTimeoutSeconds = RATGDO_WEBUI_DISCOVERY_TIMEOUT, log, openClient, push }: StatusFeedOptions) {

    this.#browse = browse;
    this.#discoveryTimeoutSeconds = discoveryTimeoutSeconds;
    this.#log = log;
    this.#openClient = openClient;
    this.#push = push;
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

        this.#clearDiscoveryTimer(mac);
      }
    }

    // Re-ensure the discovery browser before this warm applies. startDiscovery is a no-op while the browser runs, so a healthy browser pays nothing; a browser whose
    // construction-time start failed is retried here at the warm cadence rather than staying dead for the child process's life, and each failed retry logs - the live
    // signal an operator troubleshoots from. The start sits after the wholesale #warmKeys replacement, so a browse port that delivers callbacks synchronously from the
    // start evaluates them against the set this warm is applying - #onService's connect decision reads #warmKeys live - never against the outgoing set. A discovery
    // that lands after a pending not-found timer has fired self-heals on arrival: #onService's connect trigger fires for the still-warmed mac and #connectDevice's
    // synchronous prefix clears the stored outcome before its first await, and view()'s stored-outcome retry covers a mac that re-enters the warm set later.
    this.startDiscovery();

    for(const entry of request.devices) {

      const session = this.#sessions.get(entry.mac);

      if(!session) {

        // No session yet. A discovered device connects now, unless outcome memory records an auth failure against this very key: an auth-failed device is retried only
        // when the incoming key differs from the one it failed with, because a forced warm - the restart recovery or the visibility belt - resends unchanged keys at
        // foreground cadence, and re-running a connect with the key that just failed is doomed churn that re-flashes the panel. A changed key falls through to the
        // connect, whose synchronous prefix clears the stored outcome; every non-auth outcome keeps its unconditional retry here. An undiscovered device arms a not-found
        // timer, but only when none is already counting down for it - a re-warm that changes an unrelated device's key must not defer this device's verdict.
        if(this.#devices.has(entry.mac)) {

          const outcome = this.#outcomes.get(entry.mac);

          if((outcome !== undefined) && ((outcome.reason === "auth-invalid") || (outcome.reason === "auth-missing")) && (outcome.psk === entry.psk)) {

            continue;
          }

          void this.#connectDevice(entry.mac);
        } else if(!this.#discoveryTimers.has(entry.mac)) {

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

    if((reason === "auth-invalid") || (reason === "auth-missing")) {

      this.#emit({ kind: "error", reason, serialNumber: mac, session: ++this.#tokenCounter });

      return;
    }

    this.#emit({ kind: "connecting", serialNumber: mac, session: ++this.#tokenCounter });
  }

  /* Project the discovered set into a plain mac-to-address object for the identity strip. Each discovered device's stripped mac - the very key the pushes carry as
   * serialNumber, so the frontend joins on device.serialNumber with no translation - maps to that device's live advertised address, the address the status connection
   * actually dials. A pure synchronous read of #devices: it changes no session state and emits no wire event, so the panel can pull it at any time without perturbing a
   * connection. The result is frozen and freshly built per call, so a caller that mutates one read can corrupt neither the pool's discovery memory nor a later read.
   */
  public addresses(): Readonly<Record<string, string>> {

    const projection: Record<string, string> = {};

    for(const [ mac, device ] of this.#devices) {

      projection[mac] = device.address;
    }

    return Object.freeze(projection);
  }

  /* Start mDNS discovery, retaining the browser. The server adapter calls this as the custom-UI process spawns, so discovery runs while the settings page is still in
   * front of the user and the first warm resolves discovered devices from a warm address map; warm() calls it again on every warm, so a spawn-time start that failed is
   * retried at the warm cadence rather than leaving discovery dead for the child process's life. Failure is contained here - a browser that cannot start must not take
   * down the process, whose other request handlers are unrelated to status - and every failed retry logs, the live signal an operator troubleshoots from.
   * #ensureBrowser's early return makes the call a no-op once the browser runs, so the warm-cadence retries cost nothing on a healthy browser.
   */
  public startDiscovery(): void {

    try {

      this.#ensureBrowser();
    } catch(error) {

      this.#log.error("The mDNS discovery browser could not be started.", error);
    }
  }

  /* Dispose the pool. Defense in depth: stop the browser and clear the warm set FIRST, so even a discovery callback already queued finds nothing to connect; then clear
   * every not-found timer, tear down every session over a snapshot of the keys, and clear every map. Safe to call more than once - the browser stop function is nulled
   * after it runs, and clearing already-empty maps is harmless.
   */
  public [Symbol.dispose](): void {

    this.#stopBrowser?.();
    this.#stopBrowser = null;
    this.#warmKeys.clear();

    for(const timer of this.#discoveryTimers.values()) {

      clearTimeout(timer);
    }

    this.#discoveryTimers.clear();

    for(const mac of [...this.#sessions.keys()]) {

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
    const session: DeviceSession = { client: null, controller: new AbortController(), encryptedTransport: false, listeners: [], mac, online: false, psk,
      rowMap: new Map(), token: ++this.#tokenCounter };

    try {

      // A connect is starting: clear any stale outcome memory and any pending not-found timer, then install the session synchronously so a concurrent advertisement or
      // warm sees a live session and does not start a second connect. This runs inside the try so the whole body - including the connecting push - stays total.
      this.#outcomes.delete(mac);
      this.#clearDiscoveryTimer(mac);
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

          case "permanent":
          case "unknown":

            this.#recordFailure(session, "unreachable");

            return;

          default: {

            // Compile-time exhaustiveness: a new ConnectionFailureReason fails to type-check here until it is handled.
            const _exhaust: never = outcome.reason;

            void _exhaust;

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

      // Register the session's listeners, retaining each Disposable so teardown detaches them. The telemetry listener translates each event and pushes a row only for a
      // present panel entity; the lifecycle listener - the canonical typed connect/disconnect channel - drives the availability row. After a reconnect cycle the device
      // re-bursts full state through the retained telemetry listener, so rows self-heal without a fresh snapshot.
      session.listeners.push(

        client.on("telemetry", (data: TelemetryEvent): void => {

          const event = translateTelemetry(data);

          // translateTelemetry mints the same canonical "type-objectId" id form that idFor produces, so the row map (keyed by branded EntityId) can look it up directly.
          const rowId = session.rowMap.get(event.id as EntityId);

          if(rowId === undefined) {

            return;
          }

          this.#pushForSession(session, { kind: "row", row: { id: rowId, value: mapRowValue(rowId, event) }, serialNumber: session.mac, session: session.token });
        }),
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
              const _exhaust: never = lifecycle;

              void _exhaust;

              return;
            }
          }
        })
      );

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

  /* Tear down one device's session. Ordering is pinned: abort the controller so every in-flight step unwinds on its identity check, dispose the retained listeners BEFORE
   * disposing the client - disposing a live client synchronously emits its disconnect through the event bus, and detaching the listeners first means that emission
   * reaches no handler, so an intentional key-diff reconnect never pushes a spurious "Disconnected" availability event - then remove the session. Safe when absent.
   */
  #teardownSession(mac: string): void {

    const session = this.#sessions.get(mac);

    if(!session) {

      return;
    }

    session.controller.abort();

    for(const listener of session.listeners) {

      listener[Symbol.dispose]();
    }

    session.client?.[Symbol.dispose]();
    this.#sessions.delete(mac);
  }

  // Start the mDNS browser when it is not already running, retaining its stop function. startDiscovery is the sole caller, reached both as the custom-UI process spawns
  // and on every warm, so a spawn-time start that succeeded has the browser browsing before the first warm arrives while a spawn-time start that failed is retried by
  // the next warm; the early return makes that warm-cadence retry a no-op once the browser runs. A synchronous throw from the browse port propagates to startDiscovery's
  // containment.
  #ensureBrowser(): void {

    if(this.#stopBrowser) {

      return;
    }

    this.#stopBrowser = this.#browse((service) => this.#onService(service));
  }

  /* Classify one advertised service and record it, keyed by stripped MAC so a later advertisement refreshes a device's address. Discovering a mac clears its pending
   * not-found timer. When the device is warmed and has no session, start its connect: the synchronous session install in #connectDevice is the double-connect guard, so a
   * burst of advertisements for the same mac opens exactly one connection.
   */
  #onService(service: Service): void {

    const discovered = parseRatgdoService(service);

    if(!discovered) {

      return;
    }

    this.#devices.set(discovered.strippedMac, discovered);
    this.#clearDiscoveryTimer(discovered.strippedMac);

    if(this.#warmKeys.has(discovered.strippedMac) && !this.#sessions.has(discovered.strippedMac)) {

      void this.#connectDevice(discovered.strippedMac);
    }
  }

  /* Arm a per-mac not-found timer for an undiscovered warmed device. Per-mac rather than one shared timer, because a shared timer re-armed on every warm would let an
   * unrelated device's key edit defer this device's not-found verdict indefinitely. Clear-before-arm so a caller can arm unconditionally without leaking a prior timer.
   * The timer is unref'd so it never keeps the child process alive on its own.
   */
  #armDiscoveryTimer(mac: string): void {

    this.#clearDiscoveryTimer(mac);

    const timer = setTimeout(() => {

      this.#discoveryTimers.delete(mac);
      this.#onDiscoveryTimeout(mac);
    }, this.#discoveryTimeoutSeconds * 1000);

    timer.unref();
    this.#discoveryTimers.set(mac, timer);
  }

  // Clear and forget a mac's pending not-found timer, if one is counting down. Called on discovery, on a mac leaving the warm set, when a connect starts, and at dispose.
  #clearDiscoveryTimer(mac: string): void {

    const timer = this.#discoveryTimers.get(mac);

    if(timer !== undefined) {

      clearTimeout(timer);
      this.#discoveryTimers.delete(mac);
    }
  }

  /* Classify a warmed device not-found once its discovery budget elapses. The timer is cleared the instant the device is discovered, so a fired timer means the mac is
   * still undiscovered; the discovery-based predicate is a defensive re-check of that. The verdict is written to outcome memory - so a later view re-surfaces it - and
   * pushed as a sessionless error under a fresh monotonic token.
   */
  #onDiscoveryTimeout(mac: string): void {

    if(this.#devices.has(mac)) {

      return;
    }

    // Store the not-found verdict with an undefined key: the retry gate consults the stored key only for the auth reasons, so it is inert for not-found, and this write
    // site has no session in scope to read a key from.
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
