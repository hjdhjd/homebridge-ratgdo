/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-status.test.ts: Unit tests for the webUI status connection pool - the persistent per-device session lifecycle, the warm-set key diff and reconnect, the view
 * switch, the per-mac not-found sweep, outcome memory, the domain-to-row translation, the classified error surface, the teardown ordering, and the request-boundary
 * narrowing. The ESPHome client, the client factory, and the mDNS browser are all injected as fakes, so every branch of the pool runs deterministically without a live
 * device, a real connection, or fake timers; the discovery budget is injected in fractional seconds so the not-found sweep resolves in milliseconds of real time. The
 * fakes follow the testing.helpers conventions - counters, not booleans, wherever a no-op-versus-double-call distinction matters.
 */
import { AuthenticationError, CoverOperation, LockState, entityId } from "esphome-client";
import type { EntityId, TelemetryEvent } from "esphome-client";
import { StatusFeed, narrowStatusWarmRequest } from "./webui-status.ts";
import { describe, test } from "node:test";
import { makeBinarySensorEvent, makeCapturingLog, makeCoverEvent, makeLightEvent, makeLockEvent, makeMdnsService, makeSwitchEvent,
  makeTelemetry } from "./testing.helpers.ts";
import type { OpenEspHomeClient } from "./connection.ts";
import { RATGDO_MOTION_DURATION } from "./settings.ts";
import type { RecordedOpenOptions } from "./testing.helpers.ts";
import type { Service } from "bonjour-service";
import type { StatusEvent } from "homebridge-plugin-utils";
import assert from "node:assert/strict";

/* This file constructs raw mDNS TXT payloads whose keys are the snake_case ESPHome wire names (esphome_version, project_name, ...), so camelcase is disabled for the
 * fixture factory below, matching the discovery-test convention.
 */
/* eslint-disable camelcase */

// Three devices' stripped macs and addresses. The mac is the stripped, colon-free form the whole pipeline keys on; the address is what parseRatgdoService advertises.
const MAC = "AABBCCDDEEFF";
const MAC_TWO = "112233445566";
const MAC_THREE = "778899AABBCC";
const ADDR = "192.0.2.10";
const ADDR_TWO = "192.0.2.11";
const ADDR_THREE = "192.0.2.12";

// The status-entity set a healthy Disco-class ratgdo advertises: cover, light, lock, the momentary motion sensor, and the obstruction sensor.
const ADVERTISED = [

  { objectId: "door", type: "cover" },
  { objectId: "light", type: "light" },
  { objectId: "lock_remotes", type: "lock" },
  { objectId: "motion", type: "binary_sensor" },
  { objectId: "obstruction", type: "binary_sensor" }
];

// Build a mDNS service double that parseRatgdoService classifies as a ratgdo device with the given stripped mac and address. The overrides record replaces individual
// TXT fields on the well-formed base - passing friendly_name as undefined or an empty string models a device that advertises no usable name - so the TXT vocabulary
// stays in this one fixture rather than being restated as record literals inside the tests that need a variant.
const makeService = (mac = MAC, address = ADDR, overrides: Record<string, string | undefined> = {}): Service => {

  return makeMdnsService({ esphome_version: "2.0.0", friendly_name: "Test Ratgdo", mac, project_name: "ratgdo.esp32", project_version: "1.0.0", ...overrides },
    [address]);
};

// Key a list of telemetry events into a latest-state cache the same way the ESPHome client does, so a fake client's snapshot mirrors the wire cache.
const buildCache = (events: TelemetryEvent[]): Map<EntityId, TelemetryEvent> => {

  const cache = new Map<EntityId, TelemetryEvent>();

  for(const event of events) {

    cache.set(entityId(event.type, event.entity), event);
  }

  return cache;
};

// A resting snapshot for the advertised set: a closed door carrying NO position field (the protobuf zero-omission case), light off, remotes unlocked, motion idle, and no
// obstruction. Every value renders only through translateTelemetry.
const restingCache = (): Map<EntityId, TelemetryEvent> => buildCache([

  makeTelemetry("cover", "door", {}),
  makeLightEvent("light", false),
  makeLockEvent("lock_remotes", LockState.UNLOCKED),
  makeBinarySensorEvent("motion", false),
  makeBinarySensorEvent("obstruction", false)
]);

// The Konnected variant advertises different object ids and no motion sensor, so its status set is cover / light / lock / obstruction under Konnected wire names.
const KONNECTED_ADVERTISED = [

  { objectId: "garage_door", type: "cover" },
  { objectId: "garage_light", type: "light" },
  { objectId: "lock", type: "lock" },
  { objectId: "obstruction", type: "binary_sensor" }
];

// A resting Konnected snapshot: door closed, light off, lock unlocked, obstruction clear.
const konnectedCache = (): Map<EntityId, TelemetryEvent> => buildCache([

  makeCoverEvent("garage_door", 0),
  makeLightEvent("garage_light", false),
  makeLockEvent("lock", LockState.UNLOCKED),
  makeBinarySensorEvent("obstruction", false)
]);

// Build a mDNS service double that parseRatgdoService classifies as a Konnected device with the given stripped mac and address.
const makeKonnectedService = (mac = MAC, address = ADDR): Service => {

  return makeMdnsService({ esphome_version: "2.0.0", friendly_name: "Test Konnected", mac, project_name: "konnected.garage-door-gdov2-s", project_version: "1.0.0" },
    [address]);
};

// Flush the microtask queue plus a timer tick, so a warm's deferred connect continuations settle before the assertions run.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

// Wait a fixed span of real time, for the not-found-sweep timing tests where the deadline order across timers is the discriminating input.
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A resolvable/rejectable promise handle: the connect fakes hold one open to prove two connects overlap, or to land a resolution after a supersede.
const deferred = <T>(): { promise: Promise<T>; reject: (reason: unknown) => void; resolve: (value: T) => void } => {

  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res, rej) => {

    reject = rej;
    resolve = res;
  });

  return { promise, reject, resolve };
};

/* A fake ESPHome client covering the surface the pool and openConnection reach: snapshot / entitiesByDevice (configurable), on (registers a handler and returns a
 * counting Disposable), emit (drives a registered handler), and Symbol.dispose (records the disposal AND emits a disconnect, mirroring the real client so the teardown-
 * ordering test can prove listeners are detached before the client). listenerDisposals records each Disposable disposal by event name, so a test asserts every listener
 * was released exactly once. An optional onListen hook lets a test drive a synchronous emit at the moment a listener registers.
 */
class FakeClient {

  public disposeCount = 0;
  public readonly listenerDisposals: string[] = [];
  readonly #cache: ReadonlyMap<EntityId, TelemetryEvent>;
  readonly #entities: { objectId: string; type: string }[];
  readonly #handlers = new Map<string, ((event: unknown) => void)[]>();
  readonly #isEncrypted: boolean;
  readonly #onListen: ((event: string, client: FakeClient) => void) | undefined;
  readonly #throwOnListen: boolean;

  public constructor(options: { cache?: ReadonlyMap<EntityId, TelemetryEvent>; entities?: { objectId: string; type: string }[]; isEncrypted?: boolean;
    onListen?: (event: string, client: FakeClient) => void; throwOnListen?: boolean; } = {}) {

    this.#cache = options.cache ?? new Map();
    this.#entities = options.entities ?? ADVERTISED;
    this.#isEncrypted = options.isEncrypted ?? false;
    this.#onListen = options.onListen;
    this.#throwOnListen = options.throwOnListen ?? false;
  }

  public snapshot(): ReadonlyMap<EntityId, TelemetryEvent> {

    return this.#cache;
  }

  public entitiesByDevice(): { objectId: string; type: string }[] {

    return this.#entities;
  }

  // Mirror the real client's isEncrypted getter so the snapshot's encryption state can be driven from a fixture.
  public get isEncrypted(): boolean {

    return this.#isEncrypted;
  }

  public on(event: string, handler: (event: never) => void): Disposable {

    // Model a client whose listener registration fails, so the connect body's totality catch can be exercised.
    if(this.#throwOnListen) {

      throw new Error("listener registration failed");
    }

    const list = this.#handlers.get(event) ?? [];

    list.push(handler as (event: unknown) => void);
    this.#handlers.set(event, list);
    this.#onListen?.(event, this);

    return { [Symbol.dispose]: (): void => {

      this.listenerDisposals.push(event);
      this.#handlers.set(event, (this.#handlers.get(event) ?? []).filter((entry) => entry !== handler));
    } };
  }

  public emit(event: string, data: unknown): void {

    for(const handler of [...(this.#handlers.get(event) ?? [])]) {

      handler(data);
    }
  }

  public [Symbol.dispose](): void {

    this.disposeCount++;

    // Mirror the real client: disconnecting synchronously emits a disconnect through the event bus to any lifecycle listener still registered.
    this.emit("lifecycle", { cause: undefined, kind: "disconnect" });
  }
}

// A recording mDNS browser port: it captures the onService callback and re-emits any queued advertisement the moment the browser starts (so a device is pre-discovered by
// startDiscovery), exposes advertise() for a mid-flight injection, and counts starts and stops.
class FakeBrowse {

  public startCount = 0;
  public stopCount = 0;
  #onService: ((service: Service) => void) | null = null;
  readonly #queued: Service[] = [];

  public readonly port = (onService: (service: Service) => void): (() => void) => {

    this.startCount++;
    this.#onService = onService;

    for(const service of this.#queued) {

      onService(service);
    }

    return (): void => {

      this.stopCount++;
    };
  };

  public queue(service: Service): void {

    this.#queued.push(service);
  }

  public advertise(service: Service): void {

    this.#onService?.(service);
  }
}

// Build a fake client factory driven by a per-call handler, recording the options each invocation received so a test can assert what openConnection forwarded.
const makeOpenClient = (handler: (options: RecordedOpenOptions, index: number) => Promise<unknown>): OpenEspHomeClient & { calls: RecordedOpenOptions[] } => {

  const calls: RecordedOpenOptions[] = [];
  const open = (options: RecordedOpenOptions): Promise<unknown> => {

    const index = calls.length;

    calls.push(options);

    return handler(options, index);
  };

  return Object.assign(open, { calls }) as unknown as OpenEspHomeClient & { calls: RecordedOpenOptions[] };
};

// Count the factory calls that targeted one device address, so a per-device connect / reconnect assertion is exact.
const callsForHost = (openClient: { calls: RecordedOpenOptions[] }, host: string): RecordedOpenOptions[] => openClient.calls.filter((call) => call.host === host);

// Assemble a pool plus its recording seams. push captures every bridge event unless a test overrides it (the containment test injects a throwing sink); the browser and
// client factory are the injected fakes; the discovery budget defaults short, so the not-found sweep resolves in milliseconds. entries captures the feed's own log lines.
const makeFeed = (options: { browse?: FakeBrowse["port"]; discoveryTimeoutSeconds?: number; openClient?: OpenEspHomeClient;
  push?: (event: StatusEvent) => void; } = {}) => {

  const pushes: StatusEvent[] = [];
  const browse = new FakeBrowse();
  const { entries, log } = makeCapturingLog();
  const feed = new StatusFeed({

    browse: options.browse ?? browse.port,
    discoveryTimeoutSeconds: options.discoveryTimeoutSeconds ?? 0.02,
    log,
    openClient: options.openClient,
    push: options.push ?? ((event) => pushes.push(event))
  });

  return { browse, entries, feed, pushes };
};

describe("StatusFeed pool connect", () => {

  test("connects every discovered warmed device concurrently, and a view switch between two live devices constructs and disposes nothing", async () => {

    const clientA = new FakeClient({ cache: restingCache() });
    const clientB = new FakeClient({ cache: restingCache() });
    const deferredA = deferred<FakeClient>();
    const deferredB = deferred<FakeClient>();
    const openClient = makeOpenClient((options) => (options.host === ADDR_TWO) ? deferredB.promise : deferredA.promise);
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService(MAC));
    browse.queue(makeService(MAC_TWO, ADDR_TWO));
    feed.startDiscovery();
    feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    // Both connects are in flight - both factory calls made - before either resolves. A serialized pool would have made only the first call and awaited it.
    assert.equal(openClient.calls.length, 2, "both discovered devices start connecting concurrently, before either connection resolves");

    deferredA.resolve(clientA);
    deferredB.resolve(clientB);

    await flush();

    assert.equal(pushes.filter((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)).length, 1, "the first device completes through its snapshot");
    assert.equal(pushes.filter((event) => (event.kind === "snapshot") && (event.serialNumber === MAC_TWO)).length, 1, "the second device completes through its snapshot");

    const callsAfterConnect = openClient.calls.length;
    const disposalsAfterConnect = clientA.disposeCount + clientB.disposeCount;
    const snapshotsBefore = pushes.filter((event) => event.kind === "snapshot").length;

    feed.view(MAC);
    feed.view(MAC_TWO);

    assert.equal(openClient.calls.length, callsAfterConnect, "switching between two live devices makes no new factory call");
    assert.equal(clientA.disposeCount + clientB.disposeCount, disposalsAfterConnect, "switching between two live devices disposes no client");
    assert.equal(pushes.filter((event) => event.kind === "snapshot").length, snapshotsBefore + 2, "each view re-pushes a snapshot from the live cache");
  });

  test("streams a snapshot with online, the motion row's latch, and rows translated from the cache", async () => {

    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache() })) });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    const snapshot = pushes.find((event) => event.kind === "snapshot");

    assert.ok(snapshot?.kind === "snapshot", "the connect completes through a snapshot push");
    assert.equal(snapshot.online, true, "the snapshot carries online true - the initial-reachability bridge");
    assert.equal(snapshot.encrypted, false, "an unencrypted session's snapshot carries encrypted false");
    assert.equal("motionLatchSeconds" in snapshot, false, "the snapshot event carries no motionLatchSeconds field - the latch travels on the motion row itself");

    const motionRow = snapshot.rows.find((row) => row.id === "motion");

    assert.deepEqual(motionRow?.latch, { seconds: RATGDO_MOTION_DURATION, value: "Detected" },
      "the motion row carries the momentary-value latch keyed to the motion-latch duration from the single source of truth");
    assert.deepEqual(snapshot.rows, [

      { id: "door", label: "Door", sizer: "Stopped (100%)", value: "Closed" },
      { id: "lock", label: "Remotes", sizer: "Unlocked", value: "Unlocked" },
      { id: "motion", label: "Motion", latch: { seconds: RATGDO_MOTION_DURATION, value: "Detected" }, sizer: "Detected", value: "" },
      { id: "light", label: "Light", sizer: "Off", value: "Off" },
      { id: "obstruction", label: "Obstruction", sizer: "Obstructed", value: "Clear" }
    ], "every row value renders through translateTelemetry, including a closed door with no position field reading Closed and the motion row's momentary latch");
  });

  test("threads the warmed psk through the client factory verbatim", async () => {

    const openClient = makeOpenClient(async () => new FakeClient({ cache: restingCache() }));
    const { browse, feed } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC, psk: "test-psk" }] });

    await flush();

    assert.equal(openClient.calls[0]?.host, ADDR, "openConnection forwards the discovered device address to the factory");
    assert.equal(openClient.calls[0]?.psk, "test-psk", "the warmed psk threads through the connect and openConnection to the factory unchanged");
  });

  test("threads the client's encryption state into the snapshot", async () => {

    const client = new FakeClient({ cache: restingCache(), isEncrypted: true });
    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => client) });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    const snapshot = pushes.find((event) => event.kind === "snapshot");

    assert.ok(snapshot?.kind === "snapshot", "the connect completes through a snapshot push");
    assert.equal(snapshot.encrypted, true, "the snapshot carries encrypted true, threaded from the client's isEncrypted getter");
  });
});

describe("StatusFeed key diff", () => {

  test("reconnects the inheriting device on a global-key change while the override device keeps its client", async () => {

    // Device A inherits the global key; device B carries a device-scoped override. The frontend resolves both keys and warms them; the pool diffs its output per device.
    // Device A is encrypted, so a differing key reconnects it rather than adopting the key in place - the transport this reconnect contract was always about. A
    // global-key change re-warms A with a new key while B's override is unchanged, so A reconnects and B is left untouched - the inheritance contract, both directions.
    const clientA1 = new FakeClient({ cache: restingCache(), isEncrypted: true });
    const clientA2 = new FakeClient({ cache: restingCache(), isEncrypted: true });
    const clientB = new FakeClient({ cache: restingCache() });
    let aCall = 0;
    const openClient = makeOpenClient((options) => {

      if(options.host === ADDR_TWO) {

        return Promise.resolve(clientB);
      }

      aCall++;

      return Promise.resolve((aCall === 1) ? clientA1 : clientA2);
    });
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService(MAC));
    browse.queue(makeService(MAC_TWO, ADDR_TWO));
    feed.startDiscovery();
    feed.warm({ devices: [ { mac: MAC, psk: "global-1" }, { mac: MAC_TWO, psk: "override" } ] });

    await flush();

    const snapshotsBefore = pushes.filter((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)).length;

    feed.warm({ devices: [ { mac: MAC, psk: "global-2" }, { mac: MAC_TWO, psk: "override" } ] });

    await flush();

    assert.equal(clientA1.disposeCount, 1, "the inheriting device's old client is disposed on the key change");
    assert.equal(callsForHost(openClient, ADDR).length, 2, "the inheriting device makes a second factory call");
    assert.equal(callsForHost(openClient, ADDR)[1]?.psk, "global-2", "the reconnect carries the new key verbatim");
    assert.ok(pushes.filter((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)).length > snapshotsBefore,
      "the inheriting device pushes a fresh snapshot");
    assert.equal(clientB.disposeCount, 0, "the override device's client is not disposed");
    assert.equal(callsForHost(openClient, ADDR_TWO).length, 1, "the override device makes no second factory call");
  });

  test("leaves a session untouched when a re-warm carries the same key", async () => {

    const client = new FakeClient({ cache: restingCache() });
    const openClient = makeOpenClient(async () => client);
    const { browse, feed } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC, psk: "same" }] });

    await flush();

    feed.warm({ devices: [{ mac: MAC, psk: "same" }] });

    await flush();

    assert.equal(openClient.calls.length, 1, "a matching key makes no second factory call");
    assert.equal(client.disposeCount, 0, "a matching key leaves the live client undisposed");
  });

  test("adopts a changed key in place for a healthy plaintext session, and the adopted key holds across a later disconnect", async () => {

    // A healthy, connected, negotiated-plaintext session genuinely does not use the key, so a changed key adopts in place with no teardown and no reconnect - this is
    // what ends the cosmetic Connecting flash an unencrypted device would otherwise show on a global key edit. A follow-up re-warm then proves the adopted key was
    // actually stored: take the session offline and re-warm the SAME adopted key. A build that skipped the psk write would re-diff its stale stored key and reconnect
    // through the offline path, so a flat factory count across both re-warms proves the adoption both happened and persisted.
    const client = new FakeClient({ cache: restingCache() });
    const openClient = makeOpenClient(async () => client);
    const { browse, feed } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC, psk: "k1" }] });

    await flush();

    feed.warm({ devices: [{ mac: MAC, psk: "k2" }] });

    await flush();

    assert.equal(openClient.calls.length, 1, "a healthy plaintext session adopts the changed key in place - no reconnect, no second factory call");
    assert.equal(client.disposeCount, 0, "the adopting session keeps its live client undisposed");

    // The adoption proof: take the session offline, then re-warm the SAME key it adopted. The stored key now matches, so even the offline path no-ops; a build that
    // never wrote the adopted key would re-diff a stale "k1" here and reconnect.
    client.emit("lifecycle", { cause: undefined, kind: "disconnect" });
    feed.warm({ devices: [{ mac: MAC, psk: "k2" }] });

    await flush();

    assert.equal(openClient.calls.length, 1, "the adopted key was stored, so a re-warm carrying it makes no factory call even after the session went offline");
    assert.equal(client.disposeCount, 0, "no teardown follows the matching-key re-warm on the offline session");
  });

  test("reconnects an offline plaintext session on a changed key rather than adopting in place", async () => {

    // In-place adoption is for a HEALTHY session only. A plaintext session that has gone offline does not qualify: it reconnects on a changed key exactly as an encrypted
    // or mid-connect session does - the conservative fallback that re-captures the transport truth on arrival, covering a device that later enables encryption. Take the
    // session offline with a disconnect, then re-warm a changed key and assert the reconnect.
    const client1 = new FakeClient({ cache: restingCache() });
    const client2 = new FakeClient({ cache: restingCache() });
    let call = 0;
    const openClient = makeOpenClient(async () => {

      call++;

      return (call === 1) ? client1 : client2;
    });
    const { browse, feed } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC, psk: "k1" }] });

    await flush();

    client1.emit("lifecycle", { cause: undefined, kind: "disconnect" });
    feed.warm({ devices: [{ mac: MAC, psk: "k2" }] });

    await flush();

    assert.equal(openClient.calls.length, 2, "an offline plaintext session reconnects on the changed key - no in-place adoption for an unhealthy session");
    assert.equal(client1.disposeCount, 1, "the offline session's old client is torn down on the reconnect");
    assert.equal(callsForHost(openClient, ADDR)[1]?.psk, "k2", "the reconnect carries the changed key");
  });

  test("converts a key-failed device to a live session on the next warm", async () => {

    const client = new FakeClient({ cache: restingCache() });
    let call = 0;
    const openClient = makeOpenClient(async () => {

      call++;

      if(call === 1) {

        throw new (await import("esphome-client")).EncryptionKeyInvalidError("bad key");
      }

      return client;
    });
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC, psk: "wrong" }] });

    await flush();

    assert.ok(pushes.some((event) => (event.kind === "error") && (event.reason === "auth-invalid")), "the wrong key fails auth-invalid");

    feed.warm({ devices: [{ mac: MAC, psk: "right" }] });

    await flush();

    assert.equal(openClient.calls.length, 2, "the key fix starts a fresh connect - the stored outcome was cleared");
    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "the key fix converts the failed device to a live session");
  });

  test("gates an auth-failed retry on a changed key: the same failed key does not retry, a changed key does", async () => {

    // Outcome memory records the key an auth failure happened with, so a forced warm resending the very same key does not re-flash the doomed connect, while a genuinely
    // changed key clears the memory and retries. Both directions on one failed device: re-warm the same failed key (no new factory call), then re-warm a changed key (a
    // fresh connect that succeeds). The forced-resend cadence a restart or visibility return produces is exactly the same-key re-warm this gate blocks.
    const client = new FakeClient({ cache: restingCache() });
    let call = 0;
    const openClient = makeOpenClient(async () => {

      call++;

      if(call === 1) {

        throw new (await import("esphome-client")).EncryptionKeyInvalidError("bad key");
      }

      return client;
    });
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC, psk: "wrong" }] });

    await flush();

    assert.ok(pushes.some((event) => (event.kind === "error") && (event.reason === "auth-invalid")), "the first connect fails auth-invalid and records the failed key");

    // Re-warm the SAME failed key: the stored auth failure blocks the doomed retry.
    feed.warm({ devices: [{ mac: MAC, psk: "wrong" }] });

    await flush();

    assert.equal(openClient.calls.length, 1, "a re-warm carrying the same failed key starts no new connect - the auth-retry memory blocks the doomed resend");

    // Re-warm a CHANGED key: the memory clears and the device retries.
    feed.warm({ devices: [{ mac: MAC, psk: "right" }] });

    await flush();

    assert.equal(openClient.calls.length, 2, "a changed key clears the auth-retry memory and starts a fresh connect");
    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "the changed-key retry converts the failed device to a live session");
  });

  test("clears outcome memory when a connect starts, so a view after a key-fix reconnect shows the snapshot not the stale error", async () => {

    // Outcome memory is cleared when a connect starts, never lingering behind a live session. A device fails auth-invalid, then a key fix reconnects it; a view of the
    // now-live device must re-surface the live snapshot and never the stale key error - the encoded check for the outcome-drifts-from-session-state pre-mortem risk.
    const client = new FakeClient({ cache: restingCache() });
    let call = 0;
    const openClient = makeOpenClient(async () => {

      call++;

      if(call === 1) {

        throw new (await import("esphome-client")).EncryptionKeyInvalidError("bad key");
      }

      return client;
    });
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC, psk: "wrong" }] });

    await flush();

    feed.warm({ devices: [{ mac: MAC, psk: "right" }] });

    await flush();

    const before = pushes.length;

    feed.view(MAC);

    const emitted = pushes.slice(before);

    assert.ok(emitted.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "view after the key-fix reconnect pushes a fresh snapshot");
    assert.ok(!emitted.some((event) => event.kind === "error"), "view never re-surfaces the stale key error - the outcome was cleared when the reconnect started");
  });

  test("pushes no availability event during an intentional key-diff reconnect", async () => {

    // Encrypted fakes, so the changed key reconnects rather than adopting in place - this test is about the teardown ordering that reconnect performs.
    const client1 = new FakeClient({ cache: restingCache(), isEncrypted: true });
    const client2 = new FakeClient({ cache: restingCache(), isEncrypted: true });
    let call = 0;
    const openClient = makeOpenClient(async () => {

      call++;

      return (call === 1) ? client1 : client2;
    });
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC, psk: "k1" }] });

    await flush();

    const availabilityBefore = pushes.filter((event) => event.kind === "availability").length;

    feed.warm({ devices: [{ mac: MAC, psk: "k2" }] });

    await flush();

    assert.deepEqual([...client1.listenerDisposals].sort(), [ "lifecycle", "telemetry" ], "the reconnect disposes both of the old session's listeners");
    assert.equal(client1.disposeCount, 1, "the reconnect disposes the old client");
    assert.equal(pushes.filter((event) => event.kind === "availability").length, availabilityBefore,
      "detaching the listeners before the client means the old client's disconnect emission pushes no availability event");
  });
});

describe("StatusFeed view", () => {

  test("re-surfaces a stored auth-missing outcome rather than connecting", async () => {

    const openClient = makeOpenClient(async () => {

      throw new (await import("esphome-client")).EncryptionRequiredError("key required");
    });
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    const before = pushes.length;

    feed.view(MAC);

    const emitted = pushes.slice(before);

    assert.equal(emitted.length, 1, "view emits exactly one push for the stored failure");
    assert.ok((emitted[0]?.kind === "error") && (emitted[0].reason === "auth-missing"), "view re-pushes the stored auth-missing error");
    assert.ok(!emitted.some((event) => event.kind === "connecting"), "view never re-pushes connecting for a stored key failure");
  });

  test("retries a stored unreachable outcome with a fresh connect on view", async () => {

    const client = new FakeClient({ cache: restingCache() });
    let call = 0;
    const openClient = makeOpenClient(async () => {

      call++;

      if(call === 1) {

        throw new Error("connection refused");
      }

      return client;
    });
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    assert.equal(openClient.calls.length, 1, "the first connect failed unreachable");

    feed.view(MAC);

    await flush();

    assert.equal(openClient.calls.length, 2, "a stored unreachable outcome retries on view");
    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "the retry completes through a snapshot");
  });

  test("pushes connecting for a still-connecting session", async () => {

    const deferredClient = deferred<FakeClient>();
    const openClient = makeOpenClient(() => deferredClient.promise);
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    const before = pushes.length;

    feed.view(MAC);

    const emitted = pushes.slice(before);

    assert.equal(emitted.length, 1, "view emits one push for a session still connecting");
    assert.equal(emitted[0]?.kind, "connecting", "a session with no client yet pushes connecting");

    deferredClient.resolve(new FakeClient({ cache: restingCache() }));

    await flush();
  });

  test("pushes connecting for a warmed-but-undiscovered mac and for an unwarmed mac", async () => {

    const { feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 5, openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache() })) });

    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    // MAC is warmed but never advertised, so it has a pending timer and no outcome; view pushes connecting and lets the timer classify it.
    const beforeWarmed = pushes.length;

    feed.view(MAC);

    assert.equal(pushes.slice(beforeWarmed).length, 1, "view emits one push for a warmed-but-undiscovered mac");
    assert.equal(pushes.slice(beforeWarmed)[0]?.kind, "connecting", "a warmed-but-undiscovered mac with no outcome pushes connecting");

    // MAC_TWO is not in the warm set at all; view still pushes connecting rather than not-found - the ordered bridge means the warm that follows resolves it.
    const beforeUnwarmed = pushes.length;

    feed.view(MAC_TWO);

    assert.equal(pushes.slice(beforeUnwarmed).length, 1, "view emits one push for an unwarmed mac");
    assert.equal(pushes.slice(beforeUnwarmed)[0]?.kind, "connecting", "an unwarmed mac pushes connecting rather than not-found");
  });
});

describe("StatusFeed addresses", () => {

  test("projects each discovered device's mac to its address and omits an undiscovered warmed mac", () => {

    // Discovery, not the warm set, is what populates the projection: MAC and MAC_TWO are advertised (discovered) but never warmed, while MAC_THREE is warmed but never
    // advertised. The projection must carry the two discovered addresses and omit the warmed-but-undiscovered mac. The discovery budget is generous so MAC_THREE's
    // not-found timer never fires during the read.
    const { browse, feed } = makeFeed({ discoveryTimeoutSeconds: 5 });

    browse.queue(makeService(MAC));
    browse.queue(makeService(MAC_TWO, ADDR_TWO));
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC_THREE }] });

    assert.deepEqual(feed.addresses(), { [MAC]: ADDR, [MAC_TWO]: ADDR_TWO },
      "the projection carries exactly the two discovered devices' addresses and omits the undiscovered warmed mac");
  });

  test("returns read-only truth - a fresh frozen projection per call that a caller cannot corrupt", () => {

    // The projection is truth the panel reads, never a handle it can corrupt. Each call returns a fresh, frozen object, so a caller that mutates one read reaches neither
    // the pool's discovery memory nor a later read.
    const { browse, feed } = makeFeed({ discoveryTimeoutSeconds: 5 });

    browse.queue(makeService(MAC));
    feed.startDiscovery();

    const first = feed.addresses();

    assert.deepEqual(first, { [MAC]: ADDR }, "the projection carries the discovered address");
    assert.ok(Object.isFrozen(first), "the returned projection is frozen against mutation");
    assert.notStrictEqual(feed.addresses(), first, "each call returns a fresh object rather than a shared reference");
    assert.throws(() => { (first as Record<string, string>)[MAC] = "10.0.0.1"; }, "mutating the frozen projection throws rather than corrupting it");
    assert.deepEqual(feed.addresses(), { [MAC]: ADDR }, "a later read is unchanged by an attempt to mutate an earlier one");
  });

  test("keeps a discovered device in the projection after it leaves the warm set - discovery memory is the source, not the warm set", async () => {

    // The feed has no per-device discovery removal: #devices is populated on advertisement and cleared only at dispose, so a mac dropped from the warm set stays in the
    // projection. This pins the actual departure behavior rather than inventing a removal the feed does not perform.
    const client = new FakeClient({ cache: restingCache() });
    const { browse, feed } = makeFeed({ discoveryTimeoutSeconds: 5, openClient: makeOpenClient(async () => client) });

    browse.queue(makeService(MAC));
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    assert.deepEqual(feed.addresses(), { [MAC]: ADDR }, "the discovered warmed device is in the projection");

    // Drop MAC from the warm set entirely; discovery memory is untouched, so the address remains.
    feed.warm({ devices: [] });

    assert.deepEqual(feed.addresses(), { [MAC]: ADDR }, "the address survives the warm departure - only dispose clears discovery memory");
  });
});

describe("StatusFeed row model", () => {

  test("excludes rows for status entities the firmware does not advertise, even when the cache holds them", async () => {

    // The device does NOT advertise motion, but its cache is seeded WITH a motion event. Only a real intersection of the status universe with the advertised set excludes
    // the motion row; an implementation that skipped the intersection and read the whole variant universe would find the seeded motion event and render it, so this test
    // tells the two apart where a cache that merely lacks motion could not.
    const entities = [ { objectId: "door", type: "cover" }, { objectId: "light", type: "light" }, { objectId: "lock_remotes", type: "lock" },
      { objectId: "obstruction", type: "binary_sensor" } ];
    const cache = buildCache([ makeTelemetry("cover", "door", {}), makeLightEvent("light", false), makeLockEvent("lock_remotes", LockState.UNLOCKED),
      makeBinarySensorEvent("motion", true), makeBinarySensorEvent("obstruction", false) ]);
    const client = new FakeClient({ cache, entities });
    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => client) });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    const snapshot = pushes.find((event) => event.kind === "snapshot");

    assert.ok(snapshot?.kind === "snapshot", "the connect completes through a snapshot push");
    assert.deepEqual(snapshot.rows.map((row) => row.id), [ "door", "lock", "light", "obstruction" ],
      "the seeded motion event produces no snapshot row, because motion is not in the advertised intersection");

    const rowsBefore = pushes.filter((event) => event.kind === "row").length;

    client.emit("telemetry", makeBinarySensorEvent("motion", true));

    assert.equal(pushes.filter((event) => event.kind === "row").length, rowsBefore, "a motion telemetry event for an unadvertised entity produces no row push");
  });

  test("builds the Konnected row set from the Konnected wire ids, with no motion row", async () => {

    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => new FakeClient({ cache: konnectedCache(), entities: KONNECTED_ADVERTISED })) });

    browse.queue(makeKonnectedService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    const snapshot = pushes.find((event) => event.kind === "snapshot");

    assert.ok(snapshot?.kind === "snapshot", "the Konnected connect completes through a snapshot push");
    assert.deepEqual(snapshot.rows, [

      { id: "door", label: "Door", sizer: "Stopped (100%)", value: "Closed" },
      { id: "lock", label: "Remotes", sizer: "Unlocked", value: "Unlocked" },
      { id: "light", label: "Light", sizer: "Off", value: "Off" },
      { id: "obstruction", label: "Obstruction", sizer: "Obstructed", value: "Clear" }
    ], "the Konnected variant resolves its own object ids and carries door / lock / light / obstruction rows with no motion row");
  });

  test("registers listeners after the row model, so an event landing at registration is filtered and pushed as a row", async () => {

    const panelEvent = makeCoverEvent("door", 1, CoverOperation.IS_OPENING);
    const strayEvent = makeTelemetry("sensor", "uptime", { state: 1 });

    // Emit a panel event and a non-panel event the instant the telemetry listener registers. The row map is computed before registration, so the panel event pushes a row
    // while the non-panel event is filtered out - a read-then-register regression would drop the panel event, and an uninitialized filter would admit the stray one.
    const onListen = (event: string, client: FakeClient): void => {

      if(event === "telemetry") {

        client.emit("telemetry", panelEvent);
        client.emit("telemetry", strayEvent);
      }
    };
    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache(), onListen })) });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    const rows = pushes.filter((event) => event.kind === "row");

    assert.equal(rows.length, 1, "exactly the panel event produces a row push - the stray sensor event is filtered out");
    assert.deepEqual(rows[0]?.kind === "row" ? rows[0].row : null, { id: "door", value: "Opening" }, "the panel event pushes the translated door row");
  });

  test("filters telemetry to panel rows, dropping unregistered types and registered-but-not-panel entities", async () => {

    const client = new FakeClient({ cache: restingCache(), entities: [ ...ADVERTISED, { objectId: "laser", type: "switch" } ] });
    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => client) });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    const before = pushes.filter((event) => event.kind === "row").length;

    // A switch entity in the registry that is not a status row (laser), plus an entity type absent from the registry (sensor). A filter that wrongly admits full registry
    // membership would push the laser row.
    client.emit("telemetry", makeSwitchEvent("laser", true));
    client.emit("telemetry", makeTelemetry("sensor", "uptime", { state: 1 }));

    const after = pushes.filter((event) => event.kind === "row").length;

    assert.equal(after, before, "neither a registered-but-not-panel entity nor an unregistered type produces a row push");
  });

  test("omits a snapshot row for an advertised entity absent from the cache", async () => {

    // The device advertises motion (so it is in the row map), but its captured cache carries no motion event - a momentary sensor that has not fired. The snapshot omits
    // the motion row rather than rendering a phantom value; a later motion telemetry event would still push a row, because the entity is a real advertised member.
    const cache = buildCache([ makeTelemetry("cover", "door", {}), makeLightEvent("light", false), makeLockEvent("lock_remotes", LockState.UNLOCKED),
      makeBinarySensorEvent("obstruction", false) ]);
    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => new FakeClient({ cache })) });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    const snapshot = pushes.find((event) => event.kind === "snapshot");

    assert.ok(snapshot?.kind === "snapshot", "the connect completes through a snapshot push");
    assert.deepEqual(snapshot.rows.map((row) => row.id), [ "door", "lock", "light", "obstruction" ],
      "the advertised-but-uncached motion entity is omitted from the snapshot rather than rendered with a phantom value");
  });
});

describe("StatusFeed row value mapping", () => {

  // Drive one telemetry event through a live session and return the value of the row push it produced.
  const rowValueFor = async (event: TelemetryEvent, rowId: string): Promise<string | undefined> => {

    const client = new FakeClient({ cache: restingCache() });
    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => client) });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    client.emit("telemetry", event);

    const rowPush = [...pushes].reverse().find((push) => (push.kind === "row") && (push.row.id === rowId));

    return (rowPush?.kind === "row") ? rowPush.row.value : undefined;
  };

  test("maps the door through its operation and position cases", async () => {

    assert.equal(await rowValueFor(makeCoverEvent("door", 0.5, CoverOperation.IS_OPENING), "door"), "Opening", "an opening cover reads Opening");
    assert.equal(await rowValueFor(makeCoverEvent("door", 0.5, CoverOperation.IS_CLOSING), "door"), "Closing", "a closing cover reads Closing");
    assert.equal(await rowValueFor(makeCoverEvent("door", 1, CoverOperation.IDLE), "door"), "Open", "a fully-open idle cover reads Open");
    assert.equal(await rowValueFor(makeCoverEvent("door", 0, CoverOperation.IDLE), "door"), "Closed", "a fully-closed idle cover reads Closed");
    assert.equal(await rowValueFor(makeCoverEvent("door", 0.43, CoverOperation.IDLE), "door"), "Stopped (43%)", "a partially-open idle cover reads its percentage");
  });

  test("maps the remaining rows through their state cases", async () => {

    assert.equal(await rowValueFor(makeLightEvent("light", true), "light"), "On", "a lit light reads On");
    assert.equal(await rowValueFor(makeLightEvent("light", false), "light"), "Off", "an unlit light reads Off");
    assert.equal(await rowValueFor(makeLockEvent("lock_remotes", LockState.LOCKED), "lock"), "Locked", "a locked remote set reads Locked");
    assert.equal(await rowValueFor(makeLockEvent("lock_remotes", LockState.UNLOCKED), "lock"), "Unlocked", "an unlocked remote set reads Unlocked");
    assert.equal(await rowValueFor(makeLockEvent("lock_remotes", LockState.JAMMED), "lock"), "Unknown", "a non-binary lock state reads Unknown");
    assert.equal(await rowValueFor(makeBinarySensorEvent("motion", true), "motion"), "Detected", "an asserted motion sensor reads Detected");
    assert.equal(await rowValueFor(makeBinarySensorEvent("motion", false), "motion"), "", "an idle motion sensor reads empty");
    assert.equal(await rowValueFor(makeBinarySensorEvent("obstruction", true), "obstruction"), "Obstructed", "an asserted obstruction reads Obstructed");
    assert.equal(await rowValueFor(makeBinarySensorEvent("obstruction", false), "obstruction"), "Clear", "a clear obstruction reads Clear");
  });
});

describe("StatusFeed snapshot sizers", () => {

  test("carries each row's widest-possible value as its sizer, one per row id", async () => {

    // The ratgdo variant carries every StatusRowId, so one snapshot proves the whole sizer record's values. Each expected string is the widest display value that row's
    // vocabulary can produce, pinned here so a value-set change that widens a row must update this expectation in step with the module's frozen record.
    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache() })) });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    const snapshot = pushes.find((event) => event.kind === "snapshot");

    assert.ok(snapshot?.kind === "snapshot", "the connect completes through a snapshot push");

    const sizers = Object.fromEntries(snapshot.rows.map((row) => [ row.id, row.sizer ]));

    assert.deepEqual(sizers, { door: "Stopped (100%)", light: "Off", lock: "Unlocked", motion: "Detected", obstruction: "Obstructed" },
      "every snapshot row carries its column's widest-possible value as the sizer, covering every row id");
  });
});

describe("StatusFeed availability", () => {

  test("pushes an availability event for each lifecycle transition, in order, with the boolean values", async () => {

    const client = new FakeClient({ cache: restingCache() });
    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => client) });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    client.emit("lifecycle", { cause: undefined, kind: "disconnect" });
    client.emit("lifecycle", { encrypted: true, kind: "connect" });

    const availability = pushes.filter((event) => event.kind === "availability");

    assert.deepEqual(availability.map((event) => (event.kind === "availability") ? event.online : null), [ false, true ],
      "a disconnect then a reconnect push availability online false then true, values and order both");
    assert.deepEqual(availability.map((event) => (event.kind === "availability") ? event.encrypted : null), [ false, true ],
      "the disconnect carries encrypted false and the reconnect threads lifecycle.encrypted true");
  });
});

describe("StatusFeed connection failures", () => {

  // Drive a connect whose client factory fails in the given way and return the classified error reason it pushed, if any.
  const failureReasonFor = async (handler: (options: RecordedOpenOptions) => Promise<unknown>): Promise<string | undefined> => {

    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(handler) });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    const error = pushes.find((event) => event.kind === "error");

    return (error?.kind === "error") ? error.reason : undefined;
  };

  test("maps a missing-key encryption failure to the auth-missing error", async () => {

    assert.equal(await failureReasonFor(async () => {

      throw new (await import("esphome-client")).EncryptionRequiredError("key required");
    }), "auth-missing", "a device that requires but lacks its API key surfaces as auth-missing");
  });

  test("maps a mismatched-key encryption failure to the auth-invalid error", async () => {

    assert.equal(await failureReasonFor(async () => {

      throw new (await import("esphome-client")).EncryptionKeyInvalidError("bad key");
    }), "auth-invalid", "a configured key that does not match the device surfaces as auth-invalid");
  });

  test("maps a state-capture timeout to the timeout error", async () => {

    // openConnection classifies a TimeoutError DOMException as a state-capture timeout, so a factory raising one drives the timeout branch without a real wait.
    assert.equal(await failureReasonFor(async () => {

      throw new DOMException("timed out", "TimeoutError");
    }), "timeout", "a state-capture timeout surfaces as the timeout reason");
  });

  test("maps a permanent error to the unreachable error", async () => {

    assert.equal(await failureReasonFor(async () => {

      throw new AuthenticationError("auth failed");
    }), "unreachable", "a permanent connection error surfaces as unreachable");
  });

  test("maps an unclassified error to the unreachable error", async () => {

    assert.equal(await failureReasonFor(async () => {

      throw new Error("connection refused");
    }), "unreachable", "an unclassified failure surfaces as unreachable");
  });

  test("pushes nothing when a connect is abandoned by a key-diff teardown mid-connect", async () => {

    // The first connect defers. A re-warm with a changed key supersedes it - tearing its session down and aborting its signal - then the deferred connect fails. With the
    // session's signal aborted, openConnection classifies the outcome as a shutdown, which the pool stands down on silently rather than surfacing an error.
    const deferredFirst = deferred<FakeClient>();
    const openClient = makeOpenClient((options, index) => (index === 0) ? deferredFirst.promise : Promise.resolve(new FakeClient({ cache: restingCache() })));
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC, psk: "k1" }] });

    await flush();

    feed.warm({ devices: [{ mac: MAC, psk: "k2" }] });
    deferredFirst.reject(new Error("connect abandoned"));

    await flush();

    assert.equal(pushes.some((event) => (event.kind === "error") && (event.serialNumber === MAC)), false, "a shutdown-classified outcome pushes no error");
  });

  test("surfaces an unreachable error rather than rejecting when the connect body throws unexpectedly", async () => {

    // The connect body is total: a client whose listener registration throws mid-connect is caught, logged, and surfaced as unreachable rather than escaping as a
    // rejection that would terminate the custom-UI child process.
    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache(), throwOnListen: true })) });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    assert.ok(pushes.some((event) => (event.kind === "error") && (event.reason === "unreachable")), "an unexpected throw in the connect body surfaces as unreachable");
  });

  test("contains a push sink that always throws across a full warm-connect-fail cycle", async () => {

    // The push sink itself throws on every delivery - the bridge's pushEvent after the modal has closed the channel. The connecting push, then the terminal error push in
    // the connect's own catch, then a sessionless view push all hit the throwing sink; none may escape as a synchronous throw or an unhandled rejection from the
    // fire-and-forget connect, and the containment is logged instead.
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {

      rejections.push(reason);
    };

    process.on("unhandledRejection", onUnhandled);

    try {

      const throwingPush = (): void => {

        throw new Error("the settings panel channel is closed");
      };
      const { browse, entries, feed } = makeFeed({ openClient: makeOpenClient(async () => {

        throw new Error("connect refused");
      }), push: throwingPush });

      browse.queue(makeService());
      feed.startDiscovery();
      feed.warm({ devices: [{ mac: MAC }] });

      assert.doesNotThrow(() => feed.view(MAC_TWO), "a sessionless view push is contained when the sink throws");

      await flush();
      await flush();

      assert.deepEqual(rejections, [], "no push throw escapes as an unhandled rejection across the warm-connect-fail cycle");
      assert.ok(entries.some((entry) => (entry.level === "error") && String(entry.parameters[0]).includes("could not be delivered")),
        "the contained push failure is logged rather than swallowed silently");
    } finally {

      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("StatusFeed connection logging", () => {

  test("prefixes every level of the connection's logger with the device's advertised name", async () => {

    // openConnection forwards this adapter to the client factory as its logger, so the client's own lines - connect retries, heartbeat, the encryption diagnostic that
    // sent us looking for this identity in the first place - reach the feed's log carrying the device they belong to.
    const openClient = makeOpenClient(async () => new FakeClient({ cache: restingCache() }));
    const { browse, entries, feed } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    const call = openClient.calls[0];

    assert.ok(call, "the device connects, recording the logger openConnection forwarded to the client factory");

    const levels = [

      { level: "debug", message: "A debug line." },
      { level: "error", message: "An error line." },
      { level: "info", message: "An info line." },
      { level: "warn", message: "A warning line." }
    ] as const;

    for(const { level, message } of levels) {

      call.logger[level](message);
    }

    for(const { level, message } of levels) {

      assert.ok(entries.some((entry) => (entry.level === level) && (entry.parameters[0] === ("Test Ratgdo: " + message))),
        "the " + level + " level arrives at the feed's log under the device's advertised name");
    }
  });

  test("falls back to the dialed address for a device advertising no usable name", async () => {

    // An absent friendly_name and an advertised-but-empty one are equally unusable as an identity, so each falls through to the address the connection dials. Both arms
    // run the same assertion against a freshly built feed, so the check lives in one local helper rather than being written out twice.
    const assertAddressIsTheIdentity = async (overrides: Record<string, string | undefined>): Promise<void> => {

      const openClient = makeOpenClient(async () => new FakeClient({ cache: restingCache() }));
      const { browse, entries, feed } = makeFeed({ openClient });

      browse.queue(makeService(MAC, ADDR, overrides));
      feed.startDiscovery();
      feed.warm({ devices: [{ mac: MAC }] });

      await flush();

      const call = openClient.calls[0];

      assert.ok(call, "the unnamed device still connects");

      call.logger.info("A line.");

      assert.ok(entries.some((entry) => (entry.level === "info") && (entry.parameters[0] === (ADDR + ": A line."))),
        "the dialed address stands in as the device's identity");
    };

    await assertAddressIsTheIdentity({ friendly_name: undefined });
    await assertAddressIsTheIdentity({ friendly_name: "" });
  });

  test("keeps the feed-level delivery error free of any device identity", async () => {

    // The #emit containment sits below every per-device session and has no device in scope, so its message stays exactly the feed-level string. The equality is exact
    // rather than a substring match, so a device prefix leaking down into feed-scope messages fails here instead of passing unnoticed.
    const throwingPush = (): void => {

      throw new Error("the settings panel channel is closed");
    };
    const { browse, entries, feed } = makeFeed({ openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache() })), push: throwingPush });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    assert.ok(entries.some((entry) => (entry.level === "error") && (entry.parameters[0] === "A live-status update could not be delivered to the settings panel.")),
      "the feed-level delivery error carries no device prefix");
  });

  test("gives each of two concurrent connects its own device identity", async () => {

    // The adapter is minted per connect inside the connect body, so two connects in flight together cannot share one adapter or overwrite one another's identity.
    const openClient = makeOpenClient(async () => new FakeClient({ cache: restingCache() }));
    const { browse, entries, feed } = makeFeed({ openClient });

    browse.queue(makeService(MAC, ADDR, { friendly_name: "Garage Door North" }));
    browse.queue(makeService(MAC_TWO, ADDR_TWO, { friendly_name: "Garage Door South" }));
    feed.startDiscovery();
    feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    await flush();

    const north = callsForHost(openClient, ADDR)[0];
    const south = callsForHost(openClient, ADDR_TWO)[0];

    assert.ok(north, "the first device recorded its own factory call");
    assert.ok(south, "the second device recorded its own factory call");

    north.logger.info("A north line.");
    south.logger.info("A south line.");

    assert.ok(entries.some((entry) => (entry.level === "info") && (entry.parameters[0] === "Garage Door North: A north line.")),
      "the first device's adapter carries only its own name");
    assert.ok(entries.some((entry) => (entry.level === "info") && (entry.parameters[0] === "Garage Door South: A south line.")),
      "the second device's adapter carries only its own name");
  });

  test("attributes an unexpected connect-body failure to its device", async () => {

    // The connect body's totality catch runs with the device still in scope, so its line carries the same identity every other line of this connection does. A client
    // whose listener registration throws lands in exactly that catch.
    const { browse, entries, feed } = makeFeed({ openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache(), throwOnListen: true })) });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    assert.ok(entries.some((entry) => (entry.level === "error") && (entry.parameters[0] === "Test Ratgdo: The live-status connection failed unexpectedly.")),
      "the connect body's catch logs under the device's identity");
  });
});

describe("StatusFeed discovery", () => {

  test("connects a device discovered after its warm entry and clears its pending not-found timer", async () => {

    // The budget is short (30ms) and the assertion waits PAST it, so a dropped timer clear surfaces: an uncleared timer would fire not-found at 30ms, well within the
    // 50ms wait. The advertisement arrives synchronously - before the deadline - so discovery clears the timer and connects, and the later wait proves the timer is gone.
    const { browse, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 0.03, openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache() })) });

    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });
    browse.advertise(makeService());

    await delay(50);

    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "a device discovered after its warm entry connects on arrival");
    assert.ok(!pushes.some((event) => (event.kind === "error") && (event.reason === "not-found")), "no not-found fires past the deadline - discovery cleared the timer");
  });

  test("fires the per-mac not-found timer for a still-undiscovered mac, undeferred by an unrelated device's re-warm", async () => {

    // MAC stays undiscovered; MAC_TWO is discovered and encrypted, so its key change on every re-warm forces a reconnect (a plaintext session would adopt the key in
    // place) - the unrelated activity. A per-mac timer keeps MAC's original deadline (50ms from its arming warm); a shared timer re-armed on every warm would push MAC's
    // deadline out past the assertion window. The last re-warm lands near 45ms, so the assertion at ~72ms is past the true 50ms deadline but well short of any re-armed
    // 95ms one.
    const openClient = makeOpenClient(async () => new FakeClient({ cache: restingCache(), isEncrypted: true }));
    const { browse, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 0.05, openClient });

    // Re-warm the set with a fresh key for the discovered device, driving its reconnect while MAC stays warmed and undiscovered.
    const rewarm = (key: string): void => feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO, psk: key } ] });

    browse.queue(makeService(MAC_TWO, ADDR_TWO));
    feed.startDiscovery();
    feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO, psk: "k0" } ] });

    await flush();
    await delay(15);
    rewarm("k1");
    await delay(15);
    rewarm("k2");
    await delay(15);
    rewarm("k3");
    await delay(27);

    const notFound = pushes.filter((event) => (event.kind === "error") && (event.serialNumber === MAC) && (event.reason === "not-found"));

    assert.equal(notFound.length, 1, "MAC's not-found timer fires exactly once at its original deadline, undeferred by MAC_TWO's re-warms");
    assert.ok(!pushes.some((event) => (event.kind === "error") && (event.serialNumber === MAC_TWO) && (event.reason === "not-found")),
      "the discovered device never times out");
  });

  test("keeps a live session when its mac is absent from a re-warm and stops discovery-driven reconnects for it", async () => {

    const clientA = new FakeClient({ cache: restingCache() });
    const clientB = new FakeClient({ cache: restingCache() });
    const openClient = makeOpenClient((options) => Promise.resolve((options.host === ADDR_TWO) ? clientB : clientA));
    const { browse, feed } = makeFeed({ openClient });

    browse.queue(makeService(MAC));
    browse.queue(makeService(MAC_TWO, ADDR_TWO));
    feed.startDiscovery();
    feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    await flush();

    const aCallsBefore = callsForHost(openClient, ADDR).length;

    // Re-warm without MAC. Its session must survive - a transient device-list read must not destroy a live connection - and MAC must leave the warm set.
    feed.warm({ devices: [{ mac: MAC_TWO }] });

    await flush();

    assert.equal(clientA.disposeCount, 0, "a mac absent from a re-warm keeps its live session undisposed");

    // Re-advertise MAC: it left the warm set, so discovery drives no reconnect for it.
    browse.advertise(makeService(MAC));

    await flush();

    assert.equal(callsForHost(openClient, ADDR).length, aCallsBefore, "MAC leaving the warm set stops discovery-driven reconnects for it");
  });

  test("does not reconnect a re-advertised mac that has left the warm set and holds no session", async () => {

    // Isolate the #warmKeys gate. The device's connect fails, so its session is gone; then the device is dropped from the warm set. On re-advertisement, with no session
    // to block it, the session guard admits a reconnect - only #warmKeys.has() being false gates it out - so a flat factory count proves warm-set membership is the gate.
    const openClient = makeOpenClient(async () => {

      throw new Error("connect refused");
    });
    const { browse, feed } = makeFeed({ openClient });

    browse.queue(makeService(MAC));
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    assert.equal(openClient.calls.length, 1, "the first connect attempt failed and left no session");

    // Drop MAC from the warm set entirely, then re-advertise it: no session exists, so only its absence from #warmKeys can gate the reconnect out.
    feed.warm({ devices: [] });
    browse.advertise(makeService(MAC));

    await flush();

    assert.equal(openClient.calls.length, 1, "a re-advertised mac absent from the warm set with no session makes no new factory call");
  });

  test("ignores an advertised service that is not a ratgdo device", async () => {

    const { browse, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 1, openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache() })) });

    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    // A foreign ESPHome project the discovery parser rejects; it must record no device and start no connect.
    browse.advertise(makeMdnsService({ esphome_version: "2.0.0", friendly_name: "Other", mac: MAC, project_name: "esphome.generic", project_version: "1.0.0" }, [ADDR]));

    await flush();

    assert.ok(!pushes.some((event) => event.kind === "snapshot"), "an unclassifiable service records no device and starts no connect");
  });
});

describe("StatusFeed advertisement", () => {

  test("never double-connects on repeated re-advertisements of a live mac", async () => {

    const openClient = makeOpenClient(async () => new FakeClient({ cache: restingCache() }));
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    assert.equal(openClient.calls.length, 1, "the initial advertisement connects the device once");
    assert.equal(pushes.filter((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)).length, 1, "the first connect completes through one snapshot");

    browse.advertise(makeService());
    browse.advertise(makeService());
    browse.advertise(makeService());

    await flush();

    assert.equal(openClient.calls.length, 1,
      "repeated re-advertisements of a live mac make no further factory call - the synchronous session install is the double-connect guard");
    assert.equal(pushes.filter((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)).length, 1, "and push no further snapshot");
  });
});

describe("StatusFeed isolation", () => {

  test("leaves sibling connects unaffected when one device's connect fails", async () => {

    const clientA = new FakeClient({ cache: restingCache() });
    const clientC = new FakeClient({ cache: restingCache() });
    const openClient = makeOpenClient(async (options) => {

      if(options.host === ADDR_TWO) {

        throw new Error("device two refused");
      }

      return (options.host === ADDR) ? clientA : clientC;
    });
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService(MAC));
    browse.queue(makeService(MAC_TWO, ADDR_TWO));
    browse.queue(makeService(MAC_THREE, ADDR_THREE));
    feed.startDiscovery();
    feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO }, { mac: MAC_THREE } ] });

    await flush();

    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "the first sibling completes despite the middle device's failure");
    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC_THREE)),
      "the last sibling completes despite the middle device's failure");
    assert.ok(pushes.some((event) => (event.kind === "error") && (event.serialNumber === MAC_TWO) && (event.reason === "unreachable")),
      "the failing device surfaces its error");
  });
});

describe("StatusFeed supersede", () => {

  test("disposes a superseded connection without pushing, while the successor completes its snapshot", async () => {

    const first = new FakeClient({ cache: restingCache() });
    const second = new FakeClient({ cache: restingCache() });
    const deferredFirst = deferred<FakeClient>();
    const openClient = makeOpenClient((options, index) => (index === 0) ? deferredFirst.promise : Promise.resolve(second));
    const { browse, feed, pushes } = makeFeed({ openClient });

    browse.queue(makeService());
    feed.startDiscovery();

    // Start the first connect against one key; its client resolution defers. Supersede it with a re-warm carrying a different key, which tears the first session down and
    // starts the successor. Only then does the first connect resolve - after the supersede has installed the successor session.
    feed.warm({ devices: [{ mac: MAC, psk: "k1" }] });

    await flush();

    feed.warm({ devices: [{ mac: MAC, psk: "k2" }] });
    deferredFirst.resolve(first);

    await flush();

    assert.equal(first.disposeCount, 1, "the superseded first client is disposed exactly once");
    assert.equal(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC) && (event.session === 1)), false,
      "the superseded first session never pushes its snapshot");
    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "the successor session completes through its own snapshot");
  });
});

describe("StatusFeed dispose", () => {

  test("tears down every session and timer, is safe on repeat, and connects nothing afterward", async () => {

    const clientA = new FakeClient({ cache: restingCache() });
    const clientB = new FakeClient({ cache: restingCache() });
    const openClient = makeOpenClient((options) => Promise.resolve((options.host === ADDR_TWO) ? clientB : clientA));
    const { browse, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 0.03, openClient });

    browse.queue(makeService(MAC));
    browse.queue(makeService(MAC_TWO, ADDR_TWO));
    feed.startDiscovery();

    // MAC and MAC_TWO are discovered and connect; MAC_THREE is warmed while undiscovered, so it arms a not-found timer that dispose must clear.
    feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO }, { mac: MAC_THREE } ] });

    await flush();

    feed[Symbol.dispose]();

    assert.equal(clientA.disposeCount, 1, "dispose tears down the first session's client");
    assert.equal(clientB.disposeCount, 1, "dispose tears down the second session's client");
    assert.equal(browse.stopCount, 1, "dispose stops the browser");

    const settledCount = pushes.length;

    feed[Symbol.dispose]();

    assert.equal(browse.stopCount, 1, "a repeat dispose stops the browser no second time");

    // A post-dispose advertisement connects nothing, and the cleared not-found timer never fires.
    browse.advertise(makeService(MAC));

    await delay(50);

    assert.equal(pushes.length, settledCount, "a post-dispose advertisement connects nothing and the cleared timer fires no not-found");
  });
});

describe("StatusFeed discovery warmup", () => {

  test("starts the browser ahead of the first warm and never starts it twice", async () => {

    const { browse, feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache() })) });

    browse.queue(makeService());
    feed.startDiscovery();

    assert.equal(browse.startCount, 1, "startDiscovery starts the browser");

    feed.startDiscovery();

    assert.equal(browse.startCount, 1, "a second startDiscovery reuses the running browser rather than starting another");

    feed.warm({ devices: [{ mac: MAC }] });

    await flush();

    assert.equal(browse.startCount, 1, "the warm resolves the discovered device from the warm map without starting a second browser");
    assert.ok(pushes.some((event) => event.kind === "snapshot"), "the warm connects through to its snapshot");
  });

  test("contains a discovery-start failure instead of taking down the process", () => {

    const { feed } = makeFeed({ browse: () => {

      throw new Error("The mDNS socket could not be opened.");
    } });

    assert.doesNotThrow(() => feed.startDiscovery(), "a browser that cannot start is contained, never thrown to the adapter");
  });

  test("retries a failed construction-time browser start on the next warm, then connects a warmed device on advertisement", async () => {

    // The browse port throws on its first invocation - the construction-time start - and succeeds on the second. startDiscovery contains the first failure, so the
    // browser is dead after construction; the next warm calls startDiscovery again through its contained path, retrying the start and bringing the live browser up. An
    // advertisement then connects the warmed device, proving discovery recovered through warm() rather than construction. attempts counts every port invocation, so it
    // tells the recovery apart: one after construction, two after the warm. The discovery budget is generous so the warmed mac's not-found timer never pre-empts the
    // advertisement's synchronous connect.
    const browse = new FakeBrowse();
    let attempts = 0;
    const flakeyPort = (onService: (service: Service) => void): (() => void) => {

      attempts++;

      if(attempts === 1) {

        throw new Error("The mDNS socket could not be opened.");
      }

      return browse.port(onService);
    };
    const { feed, pushes } = makeFeed({ browse: flakeyPort, discoveryTimeoutSeconds: 5,
      openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache() })) });

    feed.startDiscovery();

    assert.equal(attempts, 1, "the construction-time start is attempted once and its failure is contained");

    feed.warm({ devices: [{ mac: MAC }] });

    assert.equal(attempts, 2, "warm() retries the browser start through its own contained path, bringing the attempt count to two");

    browse.advertise(makeService(MAC));

    await flush();

    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)),
      "an advertisement after the warm-path retry connects the warmed device - discovery recovered through warm(), not construction");
  });

  test("does not restart a live browser across repeated warms", async () => {

    // A warm re-ensures the browser through startDiscovery, but a browser already running must not be restarted: ensureBrowser's early return makes the call a no-op
    // while browsing. The start count stays one across three warms that add and drop devices, proving the warm-cadence retry costs nothing on a healthy browser.
    const { browse, feed } = makeFeed({ openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache() })) });

    feed.startDiscovery();

    assert.equal(browse.startCount, 1, "construction starts the browser once");

    feed.warm({ devices: [{ mac: MAC }] });
    feed.warm({ devices: [{ mac: MAC }] });
    feed.warm({ devices: [{ mac: MAC_TWO }] });

    assert.equal(browse.startCount, 1, "repeated warms reuse the running browser rather than starting another");
  });

  test("starts the browser inside warm only after the warm-set replacement, so a synchronous advertisement never connects a departing mac", async () => {

    // The startDiscovery call inside warm() sits after the wholesale #warmKeys replacement, so a browse port that delivers advertisements synchronously from the start
    // evaluates #onService's connect predicate against the set this warm is applying rather than the outgoing one. The port throws on its first two starts - construction
    // and the first warm - and succeeds on the third, replaying a queued advertisement for MAC synchronously at that successful start. The first warm carries MAC (the
    // browser stays dead, so MAC only arms a not-found timer); the second warm drops MAC and is the start that finally succeeds. Because the replacement runs before the
    // start, the synchronous advertisement sees the second warm's empty set and connects nothing; a start placed at the top of warm() would see the outgoing [ MAC ] set
    // and connect a departing mac - the policy this placement exists to prevent.
    const browse = new FakeBrowse();
    let attempts = 0;
    const flakeyPort = (onService: (service: Service) => void): (() => void) => {

      attempts++;

      if(attempts <= 2) {

        throw new Error("The mDNS socket could not be opened.");
      }

      return browse.port(onService);
    };
    const openClient = makeOpenClient(async () => new FakeClient({ cache: restingCache() }));
    const { feed, pushes } = makeFeed({ browse: flakeyPort, discoveryTimeoutSeconds: 5, openClient });

    // Queue MAC's advertisement so the third, successful start replays it synchronously from within the departing warm.
    browse.queue(makeService(MAC));

    feed.startDiscovery();

    assert.equal(attempts, 1, "the construction-time start is attempted once and contained");

    feed.warm({ devices: [{ mac: MAC }] });

    assert.equal(attempts, 2, "the first warm retries the start, which fails again and leaves the browser dead while MAC arms its not-found timer");

    feed.warm({ devices: [] });

    assert.equal(attempts, 3, "the departing warm retries the start once more, and this time it succeeds and replays the queued advertisement synchronously");

    await flush();

    assert.equal(callsForHost(openClient, ADDR).length, 0,
      "the synchronous advertisement evaluates against the departing warm's empty set, so the client factory is never invoked for the departed mac");
    assert.ok(!pushes.some((event) => ((event.kind === "connecting") || (event.kind === "snapshot")) && (event.serialNumber === MAC)),
      "no session is created for the departed mac - neither a connecting nor a snapshot push reaches it");
    assert.ok(!pushes.some((event) => (event.kind === "error") && (event.serialNumber === MAC) && (event.reason === "not-found")),
      "the departed mac's not-found timer was cleared by the warm-set sweep before the advertisement landed, so no not-found fires");
  });
});

describe("narrowStatusWarmRequest", () => {

  test("accepts a well-formed request and carries each entry's psk", () => {

    const result = narrowStatusWarmRequest({ devices: [ { mac: MAC, psk: "secret" }, { mac: MAC_TWO } ] });

    assert.deepEqual(result, { devices: [ { mac: MAC, psk: "secret" }, { mac: MAC_TWO, psk: undefined } ] },
      "each entry is carried, a non-empty psk kept and an absent psk narrowed to undefined");
  });

  test("drops a malformed entry individually without invalidating the request", () => {

    const result = narrowStatusWarmRequest({ devices: [ { mac: MAC }, { psk: "x" }, { mac: "" }, "nope", null, { mac: MAC_TWO } ] });

    assert.deepEqual(result, { devices: [ { mac: MAC, psk: undefined }, { mac: MAC_TWO, psk: undefined } ] },
      "an entry with no mac, an empty-string mac, a non-object entry, and null are each dropped while the well-formed entries survive");
  });

  test("rejects a body that is not an object or carries no devices array", () => {

    assert.equal(narrowStatusWarmRequest(null), null, "a null body is rejected");
    assert.equal(narrowStatusWarmRequest("nope"), null, "a non-object body is rejected");
    assert.equal(narrowStatusWarmRequest({}), null, "a body with no devices array is rejected");
    assert.equal(narrowStatusWarmRequest({ devices: "nope" }), null, "a body whose devices field is not an array is rejected");
  });

  test("accepts an empty devices array", () => {

    assert.deepEqual(narrowStatusWarmRequest({ devices: [] }), { devices: [] }, "an empty devices array is a valid warm - the sidebar knows nothing");
  });

  test("narrows a null or empty entry psk to undefined", () => {

    assert.deepEqual(narrowStatusWarmRequest({ devices: [{ mac: MAC, psk: null }] }), { devices: [{ mac: MAC, psk: undefined }] },
      "a null entry psk narrows to undefined");
    assert.deepEqual(narrowStatusWarmRequest({ devices: [{ mac: MAC, psk: "" }] }), { devices: [{ mac: MAC, psk: undefined }] },
      "an empty-string entry psk narrows to undefined");
  });

  test("creates no session for an empty warm at the feed layer", async () => {

    const { feed, pushes } = makeFeed({ openClient: makeOpenClient(async () => new FakeClient({ cache: restingCache() })) });

    feed.startDiscovery();
    feed.warm({ devices: [] });

    await flush();

    assert.equal(pushes.length, 0, "an empty warm dispatches to no connect and pushes nothing");
  });
});
