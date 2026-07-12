/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * connection.ts: Establish an ESPHome client connection and capture the device's initial state, with the client factory as an injectable port.
 *
 * The platform's discovery path needs a connected client whose LatestStateCache already holds initial state for every required entity before it constructs the
 * accessory. That sequence - open the client, wait for the state burst, and classify every failure mode - lives here as free functions rather than platform methods,
 * so the dependency on esphome-client's `openEspHomeClient` factory is an explicit, injectable parameter (defaulting to the real factory) instead of a hard module edge.
 * A unit test passes a fake factory and drives every branch (fast / slow / timeout / shutdown, plus the error taxonomy) without a live device or fake timers.
 *
 * Feature-option resolution stays at the platform: the caller resolves the device's encryption key and passes the concrete `psk` in, so this module's only external
 * dependency is the client-factory port. That keeps the seam single-purpose and the functions trivially testable.
 */
import { EncryptionKeyInvalidError, EncryptionKeyMissingError, EncryptionRequiredError, PermanentError, entityId, openEspHomeClient } from "esphome-client";
import type { EntityId, EspHomeClient, TelemetryEvent } from "esphome-client";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { RATGDO_INITIAL_STATE_TIMEOUT } from "./settings.ts";
import util from "node:util";

/* The injectable ESPHome client-factory port. Aliased to the real factory's type so the seam stays bound to esphome-client's signature: if `openEspHomeClient`'s shape
 * changes, this alias and every default-arg site that resolves to it move with it. Production never passes it (the default real factory runs); a unit test passes a
 * fake that resolves a synthetic client or rejects with a typed error.
 */
export type OpenEspHomeClient = typeof openEspHomeClient;

/* The result of a successful `openConnection`: the live, connected client plus the initial-state snapshot `captureInitialState` waited for. `null` is the failure
 * signal for every branch (shutdown, encryption, permanent, timeout, generic), so the caller branches on truthiness rather than catching.
 */
export interface ConnectionResult {

  client: EspHomeClient;
  initialState: ReadonlyMap<EntityId, TelemetryEvent>;
}

/* Options for `captureInitialState`. The caller supplies the connected client, the wait-list of entities that must appear in the cache before construction proceeds,
 * the platform-wide shutdown signal (independent cancellation), and an optional per-call state-capture budget. `timeoutSeconds` is injectable so the timeout branch is
 * testable in milliseconds without a Clock port or fake timers; it defaults to the production `RATGDO_INITIAL_STATE_TIMEOUT`.
 *
 * @property client         - The connected ESPHome client whose LatestStateCache we observe.
 * @property expected       - The caller's declaration of which entities matter for initial state; intersected with the device's advertised entity list.
 * @property shutdownSignal - The platform-wide shutdown signal; an abort surfaces its reason (the "shutdown" string) to the caller.
 * @property timeoutSeconds - Per-call state-capture budget, in seconds. Defaults to `RATGDO_INITIAL_STATE_TIMEOUT`.
 */
export interface CaptureInitialStateOptions {

  client: EspHomeClient;
  expected: readonly EntityId[];
  shutdownSignal: AbortSignal;
  timeoutSeconds?: number;
}

/* Options for `openConnection`. The factory port (`openClient`) defaults to the real `openEspHomeClient`; the caller passes a resolved `psk` (already looked up from
 * feature options) so this module never touches the feature-option engine. `timeoutSeconds` threads straight through to `captureInitialState`.
 *
 * @property expected       - The initial-state wait-list, forwarded to `captureInitialState`.
 * @property host           - The device's hostname or IP address.
 * @property log            - The static-prefix logging adapter the client uses for connect-internal messages.
 * @property openClient     - The injectable client-factory port. Defaults to the real `openEspHomeClient`.
 * @property psk            - The resolved base64 pre-shared key for Noise encryption, or null/undefined for an unencrypted device.
 * @property shutdownSignal - The platform-wide shutdown signal, forwarded to `captureInitialState`.
 * @property timeoutSeconds - Per-call state-capture budget, in seconds. Defaults to `RATGDO_INITIAL_STATE_TIMEOUT`.
 */
export interface OpenConnectionOptions {

  expected: readonly EntityId[];
  host: string;
  log: HomebridgePluginLogging;
  openClient?: OpenEspHomeClient;
  psk?: Nullable<string>;
  shutdownSignal: AbortSignal;
  timeoutSeconds?: number;
}

/* Establish the ESPHome client connection AND wait for the LatestStateCache to populate with initial state for every stateful entity. The dual await is wrapped
 * in one try/catch so error logging and cleanup are consistent regardless of which phase failed: any failure tears down the partially-constructed client and
 * returns null, signalling the caller to skip this discovery attempt (the next mDNS refresh will retry). The platformAccessory (if any) stays registered with
 * Homebridge - acquireService() is safe to call more than once and reuses existing service objects on the retry's RatgdoAccessory construction.
 *
 * The factory's `logger` field accepts the EspHomeLogging shape; the caller passes a static-prefix adapter built from device.name so client-internal messages (connect
 * retries, heartbeat, encryption fallback) carry device context. The adapter is permanent for the client's lifetime, so a HomeKit rename later does not retitle
 * client-internal logs - the accessory's dynamic-name logger is used for everything else.
 *
 * The catch's error-narrowing strategy mirrors the abort-source taxonomy that captureInitialState produces. Shutdown is checked first because it is not a failure -
 * the platform is going away and any in-flight discovery should tear down silently. TimeoutError DOMException is the dedicated state-capture-budget-exhausted case
 * (AbortSignal.timeout always uses that name; AbortError would be the wrong token to test). Encryption and PermanentError each get a dedicated branch so the user
 * sees a focused diagnostic instead of a wrapped stack trace. Everything else falls through to the generic else with the unfiltered util.inspect output.
 */
export async function openConnection({ expected, host, log, openClient = openEspHomeClient, psk, shutdownSignal, timeoutSeconds = RATGDO_INITIAL_STATE_TIMEOUT }:
OpenConnectionOptions): Promise<Nullable<ConnectionResult>> {

  /* Client is a plain, manually-disposed variable rather than a `using` declaration. A `using` binding runs its disposal on any scope exit, including the
   * success-path `return { client, initialState }` below, which would tear down the freshly-connected client before the caller ever receives it. Manual
   * disposal keeps teardown confined to the failure paths - the catch branches below - where cleanup is actually the intent.
   */
  let client: EspHomeClient | undefined;

  try {

    client = await openClient({

      clientId: "homebridge-ratgdo",
      host: host,
      logger: log,
      psk: psk
    });

    const initialState = await captureInitialState({ client, expected, shutdownSignal, timeoutSeconds });

    return { client, initialState };
  } catch(error) {

    // Shutdown is not a failure - the platform is tearing down and this in-flight discovery is no longer interesting. Silent cleanup so the log is not filled
    // with spurious "Failed to establish connection" lines on every device that happened to be mid-handshake when the user stopped Homebridge.
    if(shutdownSignal.aborted) {

      client?.[Symbol.dispose]();

      return null;
    }

    if(isEncryptionError(error)) {

      log.error("Encryption configuration error - check the device's API encryption key: %s", error.message);
    } else if(error instanceof PermanentError) {

      log.error("Permanent connection error: %s", util.inspect(error, { depth: null }));
    } else if((error instanceof DOMException) && (error.name === "TimeoutError")) {

      log.error("Initial-state capture timed out after %s seconds. The device opened the connection but failed to push entity state.", timeoutSeconds);
    } else {

      log.error("Failed to establish connection: %s", util.inspect(error, { depth: null }));
    }

    client?.[Symbol.dispose]();

    return null;
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
 * teardown when the helper returns, composes the caller's shutdown signal with this call's own state-capture timeout, and resolves the moment the last required
 * entity lands - no polling.
 *
 * Signal ownership is intentionally split: the caller supplies the platform-wide shutdown signal (independent cancellation - the plugin is going away), and this
 * function composes its own per-call state-capture timeout. Owning the timeout here matches the function's name and contract - the budget covers state capture,
 * not the preceding `openEspHomeClient()` handshake - and a future caller does not need to know what the budget is.
 */
export async function captureInitialState({ client, expected, shutdownSignal, timeoutSeconds = RATGDO_INITIAL_STATE_TIMEOUT }: CaptureInitialStateOptions):
Promise<ReadonlyMap<EntityId, TelemetryEvent>> {

  const cache = client.snapshot();

  // Intersect the caller's "what we care about" list with the device's "what's actually here" list. Set membership for the exposed ids gives O(1) per-entry filter
  // and the resulting `required` list is what every completeness check below operates on.
  const exposed = new Set(client.entitiesByDevice(0).map((entity) => entityId(entity.type, entity.objectId)));
  const required = expected.filter((id) => exposed.has(id));

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
   * wires up after construction. The abort path threads `signal.reason` through `reject()`, so a timeout or shutdown abort surfaces the appropriate reason to the
   * caller's catch handler - shutdown surfaces the platform's "shutdown" string, timeout surfaces a TimeoutError DOMException.
   */

  // Compose shutdown and state-capture timeout into one cancellation source. AbortSignal.any propagates whichever source aborts first as the composed signal's
  // reason, which is what lets openConnection's catch distinguish which source aborted and emit the right user-facing message for each. The composed signal is
  // local to this call - it does not leak past return because we hold the only reference.
  const signal = AbortSignal.any([ shutdownSignal, AbortSignal.timeout(timeoutSeconds * 1000) ]);

  // Synchronous gate against an already-aborted shutdown signal (the timeout we just created cannot have fired in the same tick). `AbortSignal#addEventListener`
  // does not fire the handler when the signal is already aborted, so skipping this check would let a shutdown that landed while we were awaiting
  // `openEspHomeClient()` slip past the listener and hang `await promise` forever.
  signal.throwIfAborted();

  const { promise, resolve, reject } = Promise.withResolvers<undefined>();

  using _sub = client.on("telemetry", () => {

    if(required.every((id) => cache.has(id))) {

      resolve(undefined);
    }
  });

  const abortListener = (): void => reject(signal.reason);

  signal.addEventListener("abort", abortListener, { once: true });

  try {

    await promise;
  } finally {

    signal.removeEventListener("abort", abortListener);
  }

  return cache;
}

/* Type predicate for the "configuration mistake" subset of the typed-error hierarchy. esphome-client exposes EncryptionKeyMissingError, EncryptionKeyInvalidError, and
 * EncryptionRequiredError as PermanentError subclasses; this helper enumerates them once so the catch handler in openConnection and the lifecycle disconnect
 * handler in platform.ts share one decision about what counts as an encryption-config error. If esphome-client adds a fourth encryption-related PermanentError subclass,
 * both call sites pick up the new branch by extending this predicate.
 */
export function isEncryptionError(error: unknown): error is EncryptionKeyMissingError | EncryptionKeyInvalidError | EncryptionRequiredError {

  return (error instanceof EncryptionKeyMissingError) || (error instanceof EncryptionKeyInvalidError) || (error instanceof EncryptionRequiredError);
}
