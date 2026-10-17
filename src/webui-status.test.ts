/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-status.test.ts: Unit tests for the webUI status connection pool - the persistent per-device session lifecycle, the warm-set key diff and reconnect, the
 * address re-dial, the view switch, the per-mac not-found sweep, outcome memory, the domain-to-row translation, the classified error surface, the teardown ordering,
 * and the request-boundary narrowing. The ESPHome client, the client factory, the mDNS browser, and the clock are all injected as doubles, so every branch of the pool
 * runs deterministically without a live device, a real connection, or real time; the discovery budget is injected in fractional seconds and the injected clock is what
 * drives it. The doubles follow the testing.helpers conventions - counters, not booleans, wherever a no-op-versus-double-call distinction matters.
 */
import { AuthenticationError, CoverOperation, LockState, entityId } from "esphome-client";
import type { DeviceInfo, EntityId, TelemetryEvent } from "esphome-client";
import { HbpuAbortError, dnsNameKey } from "homebridge-plugin-utils";
import type { MdnsBrowserLike, MdnsBrowserOptions, MdnsService, Nullable, StatusEvent } from "homebridge-plugin-utils";
import type { OpenClientHandler, RecordedOpenOptions, TestEspHomeClientOptions } from "./testing.helpers.ts";
import { RATGDO_MOTION_DURATION, RATGDO_WEBUI_PROBE_TIMEOUT } from "./settings.ts";
import { StatusFeed, narrowStatusProbeRequest, narrowStatusWarmRequest } from "./webui-status.ts";
import { TestClock, TestMdnsBrowserFactory, capturingLog, expectAt, formatLogEntry, settle } from "homebridge-plugin-utils/testing";
import { TestEspHomeClient, makeBinarySensorEvent, makeCoverEvent, makeFakeOpenClient, makeLightEvent, makeLockEvent, makeRatgdoService, makeSwitchEvent,
  makeTelemetry } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import type { OpenEspHomeClient } from "./connection.ts";
import type { RatgdoTxtKey } from "./discovery.ts";
import { RatgdoVariant } from "./types.ts";
import type { TestMdnsBrowser } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { canonicalManualAddress } from "./manual.ts";

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

// The IPv6 literals the multi-address cases need. A unique-local address outranks a global one in the pick, so a device advertising both is dialed at the unique-local
// one - which is what lets a test move the pick while leaving the address a live session holds in the advertisement.
const ADDR_V6_GLOBAL = "2001:db8::1";
const ADDR_V6_ULA = "fd00::1";

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
const makeService = (mac = MAC, address = ADDR, overrides: Partial<Record<RatgdoTxtKey, Nullable<string>>> = {}): MdnsService => {

  return makeRatgdoService({ esphome_version: "2.0.0", friendly_name: "Test Ratgdo", mac, project_name: "ratgdo.esp32", project_version: "1.0.0", ...overrides },
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
const makeKonnectedService = (mac = MAC, address = ADDR): MdnsService => {

  return makeRatgdoService({ esphome_version: "2.0.0", friendly_name: "Test Konnected", mac, project_name: "konnected.garage-door-gdov2-s", project_version: "1.0.0" },
    [address]);
};


/* A browser factory whose first `failNext` builds throw, for the discovery-start failure paths. It extends the library's own double so any build past the failures
 * answers a real browser a test can drive, and `attempts` counts every build asked for - the recorded createCalls hold only the ones that succeeded.
 */
class FlakeyBrowserFactory extends TestMdnsBrowserFactory {

  public attempts = 0;
  #failNext: number;

  public constructor(failNext: number) {

    super();
    this.#failNext = failNext;
  }

  public override create(options: MdnsBrowserOptions): MdnsBrowserLike {

    this.attempts++;

    if(this.#failNext > 0) {

      this.#failNext--;

      throw new Error("The mDNS socket could not be opened.");
    }

    return super.create(options);
  }
}

// Deliver a service the way a browser derives it: an instance the double already holds is an update, and one it does not is a find.
const announce = (browser: TestMdnsBrowser, service: MdnsService): void => {

  if(browser.services.has(dnsNameKey(service.name))) {

    browser.updated(service);

    return;
  }

  browser.found(service);
};

// Count the factory calls that targeted one device address, so a per-device connect / reconnect assertion is exact.
const callsForHost = (openClient: { calls: RecordedOpenOptions[] }, host: string): RecordedOpenOptions[] => openClient.calls.filter((call) => call.host === host);

/* This suite's ESPHome client double: the shared harness class seeded with the entity set a healthy Disco-class ratgdo advertises. Which entities a device advertises
 * is this file's fixture policy rather than part of the double's contract, so the default lives here once and the shared class keeps its empty default for every other
 * suite that constructs it directly. A case that advertises something else - the Konnected variant, or an extra switch - passes its own `entities` and overrides it.
 */
const makeClient = (options: TestEspHomeClientOptions = {}): TestEspHomeClient => new TestEspHomeClient({ entities: ADVERTISED, ...options });

// The colon-delimited MAC a device-info record carries, from the stripped form the rest of this file keys on. The wire spells it one way and the pool keys on the
// other, and this is the one place that translation is written.
const colonMac = (mac: string): string => (mac.match(/../g) ?? []).join(":");

/* The one factory the address-dial sections build their clients through: a client that answers a device-info record naming the given device, so an address dial
 * identifies it exactly as a real opener's handshake would. Overrides reach the record itself, which is how a test describes a device that names no project, no
 * MAC, or no firmware - each one of them a refusal the dial has to classify.
 */
const makeAnsweringClient = (options: { deviceInfo?: Partial<DeviceInfo> | null; isEncrypted?: boolean; mac?: string;
  variant?: "konnected" | "ratgdo"; } = {}): TestEspHomeClient => {

  const konnected = ((options.variant ?? "ratgdo") === "konnected");
  const record: Nullable<DeviceInfo> = (options.deviceInfo === null) ? null : {

    esphomeVersion: "2.0.0",
    friendlyName: konnected ? "Test Konnected" : "Test Ratgdo",
    macAddress: colonMac(options.mac ?? MAC),
    projectName: konnected ? "konnected.garage-door-gdov2-s" : "ratgdo.esp32",
    projectVersion: "1.0.0",
    ...options.deviceInfo
  };

  return makeClient({ deviceInfo: record, entities: konnected ? KONNECTED_ADVERTISED : ADVERTISED, isEncrypted: options.isEncrypted ?? false,
    snapshot: konnected ? konnectedCache() : restingCache() });
};

/* Assemble a pool plus its recording boundaries. push captures every bridge event unless a test overrides it (the containment test injects a throwing sink); the
 * browser factory, the clock, and the client factory are the injected doubles; the discovery budget defaults short and the clock drives it. entries captures the
 * feed's own log lines.
 *
 * `browser()` answers the most recently created browser rather than the first, so a test that lets one fail and be replaced reads the live one.
 */
const makeFeed = (options: { browserFactory?: TestMdnsBrowserFactory; discoveryTimeoutSeconds?: number; openClient?: OpenEspHomeClient;
  push?: (event: StatusEvent) => void; } = {}) => {

  const pushes: StatusEvent[] = [];
  const clock = new TestClock();
  const factory = options.browserFactory ?? new TestMdnsBrowserFactory();
  const log = capturingLog();
  const feed = new StatusFeed({

    browserFactory: factory,
    clock,
    discoveryTimeoutSeconds: options.discoveryTimeoutSeconds ?? 0.02,
    log,
    openClient: options.openClient,
    push: options.push ?? ((event) => pushes.push(event))
  });
  const browser = (): TestMdnsBrowser => expectAt(factory.createCalls, factory.createCalls.length - 1, "the feed's current browser").browser;

  return { browser, clock, entries: log.entries, factory, feed, pushes };
};

describe("StatusFeed pool connect", () => {

  test("connects every discovered warmed device concurrently, and a view switch between two live devices constructs and disposes nothing", async () => {

    const clientA = makeClient({ snapshot: restingCache() });
    const clientB = makeClient({ snapshot: restingCache() });
    const pendingA = Promise.withResolvers<TestEspHomeClient>();
    const pendingB = Promise.withResolvers<TestEspHomeClient>();
    const openClient = makeFakeOpenClient((options) => (options.host === ADDR_TWO) ? pendingB.promise : pendingA.promise);
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService(MAC));
    browser().found(makeService(MAC_TWO, ADDR_TWO));

    await settle();

    feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    // Both connects are in flight - both factory calls made - before either resolves. A serialized pool would have made only the first call and awaited it.
    assert.equal(openClient.calls.length, 2, "both discovered devices start connecting concurrently, before either connection resolves");

    pendingA.resolve(clientA);
    pendingB.resolve(clientB);

    await settle();

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

    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() })) });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    const snapshot = pushes.find((event) => event.kind === "snapshot");

    assert.ok(snapshot?.kind === "snapshot", "the connect completes through a snapshot push");
    assert.equal(snapshot.online, true, "the snapshot carries online true - the initial-reachability bridge");
    assert.equal(snapshot.encrypted, false, "an unencrypted session's snapshot carries encrypted false");
    assert.equal("motionLatchSeconds" in snapshot, false, "the snapshot event carries no motionLatchSeconds field - the latch travels on the motion row itself");

    const motionRow = snapshot.rows.find((row) => row.id === "motion");

    assert.ok(motionRow && (motionRow.kind !== "choices"), "the motion row is present and is a text row - ratgdo composes text rows only");
    assert.deepEqual(motionRow.latch, { seconds: RATGDO_MOTION_DURATION, value: "Detected" },
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

    const openClient = makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() }));
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "test-psk" }] });

    await settle();

    assert.equal(openClient.calls[0]?.host, ADDR, "openConnection forwards the discovered device address to the factory");
    assert.equal(openClient.calls[0]?.psk, "test-psk", "the warmed psk threads through the connect and openConnection to the factory unchanged");
  });

  test("threads the client's encryption state into the snapshot", async () => {

    const client = makeClient({ isEncrypted: true, snapshot: restingCache() });
    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => client) });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

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
    const clientA1 = makeClient({ isEncrypted: true, snapshot: restingCache() });
    const clientA2 = makeClient({ isEncrypted: true, snapshot: restingCache() });
    const clientB = makeClient({ snapshot: restingCache() });
    let aCall = 0;
    const openClient = makeFakeOpenClient((options) => {

      if(options.host === ADDR_TWO) {

        return Promise.resolve(clientB);
      }

      aCall++;

      return Promise.resolve((aCall === 1) ? clientA1 : clientA2);
    });
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService(MAC));
    browser().found(makeService(MAC_TWO, ADDR_TWO));

    await settle();

    feed.warm({ devices: [ { mac: MAC, psk: "global-1" }, { mac: MAC_TWO, psk: "override" } ] });

    await settle();

    const snapshotsBefore = pushes.filter((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)).length;

    feed.warm({ devices: [ { mac: MAC, psk: "global-2" }, { mac: MAC_TWO, psk: "override" } ] });

    await settle();

    assert.equal(clientA1.disposeCount, 1, "the inheriting device's old client is disposed on the key change");
    assert.equal(callsForHost(openClient, ADDR).length, 2, "the inheriting device makes a second factory call");
    assert.equal(callsForHost(openClient, ADDR)[1]?.psk, "global-2", "the reconnect carries the new key verbatim");
    assert.ok(pushes.filter((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)).length > snapshotsBefore,
      "the inheriting device pushes a fresh snapshot");
    assert.equal(clientB.disposeCount, 0, "the override device's client is not disposed");
    assert.equal(callsForHost(openClient, ADDR_TWO).length, 1, "the override device makes no second factory call");
  });

  test("leaves a session untouched when a re-warm carries the same key", async () => {

    const client = makeClient({ snapshot: restingCache() });
    const openClient = makeFakeOpenClient(async () => client);
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "same" }] });

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "same" }] });

    await settle();

    assert.equal(openClient.calls.length, 1, "a matching key makes no second factory call");
    assert.equal(client.disposeCount, 0, "a matching key leaves the live client undisposed");
  });

  test("adopts a changed key in place for a healthy plaintext session, and the adopted key holds across a later disconnect", async () => {

    // A healthy, connected, negotiated-plaintext session genuinely does not use the key, so a changed key adopts in place with no teardown and no reconnect - this is
    // what ends the cosmetic Connecting flash an unencrypted device would otherwise show on a global key edit. A follow-up re-warm then proves the adopted key was
    // actually stored: take the session offline and re-warm the SAME adopted key. A build that skipped the psk write would re-diff its stale stored key and reconnect
    // through the offline path, so a flat factory count across both re-warms proves the adoption both happened and persisted.
    const client = makeClient({ snapshot: restingCache() });
    const openClient = makeFakeOpenClient(async () => client);
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "k1" }] });

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "k2" }] });

    await settle();

    assert.equal(openClient.calls.length, 1, "a healthy plaintext session adopts the changed key in place - no reconnect, no second factory call");
    assert.equal(client.disposeCount, 0, "the adopting session keeps its live client undisposed");

    // The adoption proof: take the session offline, then re-warm the SAME key it adopted. The stored key now matches, so even the offline path no-ops; a build that
    // never wrote the adopted key would re-diff a stale "k1" here and reconnect.
    client.emit("lifecycle", { cause: undefined, kind: "disconnect" });
    feed.warm({ devices: [{ mac: MAC, psk: "k2" }] });

    await settle();

    assert.equal(openClient.calls.length, 1, "the adopted key was stored, so a re-warm carrying it makes no factory call even after the session went offline");
    assert.equal(client.disposeCount, 0, "no teardown follows the matching-key re-warm on the offline session");
  });

  test("reconnects an offline plaintext session on a changed key rather than adopting in place", async () => {

    // In-place adoption is for a HEALTHY session only. A plaintext session that has gone offline does not qualify: it reconnects on a changed key exactly as an encrypted
    // or mid-connect session does - the conservative fallback that re-captures the transport truth on arrival, covering a device that later enables encryption. Take the
    // session offline with a disconnect, then re-warm a changed key and assert the reconnect.
    const client1 = makeClient({ snapshot: restingCache() });
    const client2 = makeClient({ snapshot: restingCache() });
    let call = 0;
    const openClient = makeFakeOpenClient(async () => {

      call++;

      return (call === 1) ? client1 : client2;
    });
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "k1" }] });

    await settle();

    client1.emit("lifecycle", { cause: undefined, kind: "disconnect" });
    feed.warm({ devices: [{ mac: MAC, psk: "k2" }] });

    await settle();

    assert.equal(openClient.calls.length, 2, "an offline plaintext session reconnects on the changed key - no in-place adoption for an unhealthy session");
    assert.equal(client1.disposeCount, 1, "the offline session's old client is torn down on the reconnect");
    assert.equal(callsForHost(openClient, ADDR)[1]?.psk, "k2", "the reconnect carries the changed key");
  });

  test("converts a key-failed device to a live session on the next warm", async () => {

    const client = makeClient({ snapshot: restingCache() });
    let call = 0;
    const openClient = makeFakeOpenClient(async () => {

      call++;

      if(call === 1) {

        throw new (await import("esphome-client")).EncryptionKeyInvalidError("bad key");
      }

      return client;
    });
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "wrong" }] });

    await settle();

    assert.ok(pushes.some((event) => (event.kind === "error") && (event.reason === "auth-invalid")), "the wrong key fails auth-invalid");

    feed.warm({ devices: [{ mac: MAC, psk: "right" }] });

    await settle();

    assert.equal(openClient.calls.length, 2, "the key fix starts a fresh connect - the stored outcome was cleared");
    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "the key fix converts the failed device to a live session");
  });

  test("gates an unsupported retry on nothing: neither an unchanged nor a changed key re-dials a version the client cannot speak", async () => {

    /* A firmware version the client cannot negotiate is not a configuration mistake, so unlike an auth failure it is suppressed regardless of the key: editing a key
     * cannot make an out-of-range API version speakable. Both directions on one failed device: re-warm the same key, then re-warm a changed one, and neither starts a
     * second connect.
     */
    const openClient = makeFakeOpenClient(async () => {

      throw new (await import("esphome-client")).NegotiationFailedError("api major out of range", "API_MAJOR_OUT_OF_RANGE");
    });
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "first" }] });

    await settle();

    assert.ok(pushes.some((event) => (event.kind === "error") && (event.reason === "unsupported")), "the connect fails unsupported and records the verdict");
    assert.equal(openClient.calls.length, 1, "the first warm started exactly one connect");

    feed.warm({ devices: [{ mac: MAC, psk: "first" }] });

    await settle();

    assert.equal(openClient.calls.length, 1, "a re-warm carrying the same key starts no new connect");

    feed.warm({ devices: [{ mac: MAC, psk: "second" }] });

    await settle();

    assert.equal(openClient.calls.length, 1, "a re-warm carrying a changed key starts no new connect either - the verdict does not turn on the key");

    // Reselecting the device re-emits its classified verdict rather than a connecting state the panel would never resolve.
    const before = pushes.length;

    feed.view(MAC);

    await settle();

    const emitted = pushes.slice(before);

    assert.ok(emitted.some((event) => (event.kind === "error") && (event.reason === "unsupported")),
      "a view of the unsupported device re-surfaces its verdict");
    assert.ok(!emitted.some((event) => (event.kind === "connecting")), "the view pushes no connecting state for a device that will never connect");
  });

  test("gates an auth-failed retry on a changed key: the same failed key does not retry, a changed key does", async () => {

    // Outcome memory records the key an auth failure happened with, so a forced warm resending the very same key does not re-flash the doomed connect, while a genuinely
    // changed key clears the memory and retries. Both directions on one failed device: re-warm the same failed key (no new factory call), then re-warm a changed key (a
    // fresh connect that succeeds). The forced-resend cadence a restart or visibility return produces is exactly the same-key re-warm this gate blocks.
    const client = makeClient({ snapshot: restingCache() });
    let call = 0;
    const openClient = makeFakeOpenClient(async () => {

      call++;

      if(call === 1) {

        throw new (await import("esphome-client")).EncryptionKeyInvalidError("bad key");
      }

      return client;
    });
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "wrong" }] });

    await settle();

    assert.ok(pushes.some((event) => (event.kind === "error") && (event.reason === "auth-invalid")), "the first connect fails auth-invalid and records the failed key");

    // Re-warm the SAME failed key: the stored auth failure blocks the doomed retry.
    feed.warm({ devices: [{ mac: MAC, psk: "wrong" }] });

    await settle();

    assert.equal(openClient.calls.length, 1, "a re-warm carrying the same failed key starts no new connect - the auth-retry memory blocks the doomed resend");

    // Re-warm a CHANGED key: the memory clears and the device retries.
    feed.warm({ devices: [{ mac: MAC, psk: "right" }] });

    await settle();

    assert.equal(openClient.calls.length, 2, "a changed key clears the auth-retry memory and starts a fresh connect");
    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "the changed-key retry converts the failed device to a live session");
  });

  test("clears outcome memory when a connect starts, so a view after a key-fix reconnect shows the snapshot not the stale error", async () => {

    // Outcome memory is cleared when a connect starts, never lingering behind a live session. A device fails auth-invalid, then a key fix reconnects it; a view of the
    // now-live device must re-surface the live snapshot and never the stale key error - the encoded check for the outcome-drifts-from-session-state pre-mortem risk.
    const client = makeClient({ snapshot: restingCache() });
    let call = 0;
    const openClient = makeFakeOpenClient(async () => {

      call++;

      if(call === 1) {

        throw new (await import("esphome-client")).EncryptionKeyInvalidError("bad key");
      }

      return client;
    });
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "wrong" }] });

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "right" }] });

    await settle();

    const before = pushes.length;

    feed.view(MAC);

    const emitted = pushes.slice(before);

    assert.ok(emitted.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "view after the key-fix reconnect pushes a fresh snapshot");
    assert.ok(!emitted.some((event) => event.kind === "error"), "view never re-surfaces the stale key error - the outcome was cleared when the reconnect started");
  });

  test("pushes no availability event during an intentional key-diff reconnect", async () => {

    // Encrypted fakes, so the changed key reconnects rather than adopting in place - this test is about the teardown ordering that reconnect performs.
    const client1 = makeClient({ isEncrypted: true, snapshot: restingCache() });
    const client2 = makeClient({ isEncrypted: true, snapshot: restingCache() });
    let call = 0;
    const openClient = makeFakeOpenClient(async () => {

      call++;

      return (call === 1) ? client1 : client2;
    });
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "k1" }] });

    await settle();

    const availabilityBefore = pushes.filter((event) => event.kind === "availability").length;

    feed.warm({ devices: [{ mac: MAC, psk: "k2" }] });

    await settle();

    assert.deepEqual([...client1.listenerDisposals].sort(), [ "lifecycle", "telemetry" ], "the reconnect disposes both of the old session's listeners");
    assert.equal(client1.disposeCount, 1, "the reconnect disposes the old client");
    assert.equal(pushes.filter((event) => event.kind === "availability").length, availabilityBefore,
      "detaching the listeners before the client means the old client's disconnect emission pushes no availability event");
  });
});

describe("StatusFeed view", () => {

  test("re-surfaces a stored auth-missing outcome rather than connecting", async () => {

    const openClient = makeFakeOpenClient(async () => {

      throw new (await import("esphome-client")).EncryptionRequiredError("key required");
    });
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    const before = pushes.length;

    feed.view(MAC);

    const emitted = pushes.slice(before);

    assert.equal(emitted.length, 1, "view emits exactly one push for the stored failure");
    assert.ok((emitted[0]?.kind === "error") && (emitted[0].reason === "auth-missing"), "view re-pushes the stored auth-missing error");
    assert.ok(!emitted.some((event) => event.kind === "connecting"), "view never re-pushes connecting for a stored key failure");
  });

  test("retries a stored unreachable outcome with a fresh connect on view", async () => {

    const client = makeClient({ snapshot: restingCache() });
    let call = 0;
    const openClient = makeFakeOpenClient(async () => {

      call++;

      if(call === 1) {

        throw new Error("connection refused");
      }

      return client;
    });
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    assert.equal(openClient.calls.length, 1, "the first connect failed unreachable");

    feed.view(MAC);

    await settle();

    assert.equal(openClient.calls.length, 2, "a stored unreachable outcome retries on view");
    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "the retry completes through a snapshot");
  });

  test("pushes connecting for a still-connecting session", async () => {

    const pendingClient = Promise.withResolvers<TestEspHomeClient>();
    const openClient = makeFakeOpenClient(() => pendingClient.promise);
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    const before = pushes.length;

    feed.view(MAC);

    const emitted = pushes.slice(before);

    assert.equal(emitted.length, 1, "view emits one push for a session still connecting");
    assert.equal(emitted[0]?.kind, "connecting", "a session with no client yet pushes connecting");

    pendingClient.resolve(makeClient({ snapshot: restingCache() }));

    await settle();
  });

  test("pushes connecting for a warmed-but-undiscovered mac and for an unwarmed mac", async () => {

    const { feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 5, openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() })) });

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

  test("projects each discovered device's mac to its address and omits an undiscovered warmed mac", async () => {

    // Discovery, not the warm set, is what populates the projection: MAC and MAC_TWO are advertised (discovered) but never warmed, while MAC_THREE is warmed but never
    // advertised. The projection must carry the two discovered addresses and omit the warmed-but-undiscovered mac. The discovery budget is generous so MAC_THREE's
    // not-found timer never fires during the read.
    const { browser, feed } = makeFeed({ discoveryTimeoutSeconds: 5 });

    feed.startDiscovery();
    browser().found(makeService(MAC));
    browser().found(makeService(MAC_TWO, ADDR_TWO));

    await settle();

    feed.warm({ devices: [{ mac: MAC_THREE }] });

    assert.deepEqual(feed.addresses(), { [MAC]: ADDR, [MAC_TWO]: ADDR_TWO },
      "the projection carries exactly the two discovered devices' addresses and omits the undiscovered warmed mac");
  });

  test("returns read-only truth - a fresh frozen projection per call that a caller cannot corrupt", async () => {

    // The projection is truth the panel reads, never a handle it can corrupt. Each call returns a fresh, frozen object, so a caller that mutates one read reaches neither
    // the pool's discovery memory nor a later read.
    const { browser, feed } = makeFeed({ discoveryTimeoutSeconds: 5 });

    feed.startDiscovery();
    browser().found(makeService(MAC));

    await settle();

    const first = feed.addresses();

    assert.deepEqual(first, { [MAC]: ADDR }, "the projection carries the discovered address");
    assert.ok(Object.isFrozen(first), "the returned projection is frozen against mutation");
    assert.notStrictEqual(feed.addresses(), first, "each call returns a fresh object rather than a shared reference");
    assert.throws(() => { (first as Record<string, string>)[MAC] = "10.0.0.1"; }, "mutating the frozen projection throws rather than corrupting it");
    assert.deepEqual(feed.addresses(), { [MAC]: ADDR }, "a later read is unchanged by an attempt to mutate an earlier one");
  });

  test("keeps a discovered device in the projection after it leaves the warm set - discovery memory is the source, not the warm set", async () => {

    // The feed has no per-device discovery removal: #devices is populated on advertisement and cleared only at dispose, so a mac dropped from the warm set stays in the
    // projection. This asserts the actual departure behavior rather than inventing a removal the feed does not perform.
    const client = makeClient({ snapshot: restingCache() });
    const { browser, feed } = makeFeed({ discoveryTimeoutSeconds: 5, openClient: makeFakeOpenClient(async () => client) });

    feed.startDiscovery();
    browser().found(makeService(MAC));

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

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
    const client = makeClient({ entities, snapshot: cache });
    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => client) });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    const snapshot = pushes.find((event) => event.kind === "snapshot");

    assert.ok(snapshot?.kind === "snapshot", "the connect completes through a snapshot push");
    assert.deepEqual(snapshot.rows.map((row) => row.id), [ "door", "lock", "light", "obstruction" ],
      "the seeded motion event produces no snapshot row, because motion is not in the advertised intersection");

    const rowsBefore = pushes.filter((event) => event.kind === "row").length;

    client.emit("telemetry", makeBinarySensorEvent("motion", true));

    assert.equal(pushes.filter((event) => event.kind === "row").length, rowsBefore, "a motion telemetry event for an unadvertised entity produces no row push");
  });

  test("builds the Konnected row set from the Konnected wire ids, with no motion row", async () => {

    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => makeClient({ entities: KONNECTED_ADVERTISED,
      snapshot: konnectedCache() })) });

    feed.startDiscovery();
    browser().found(makeKonnectedService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

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
    const onListen = (event: string, client: TestEspHomeClient): void => {

      if(event === "telemetry") {

        client.emit("telemetry", panelEvent);
        client.emit("telemetry", strayEvent);
      }
    };
    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => makeClient({ onListen, snapshot: restingCache() })) });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    const rows = pushes.filter((event) => event.kind === "row");

    assert.equal(rows.length, 1, "exactly the panel event produces a row push - the stray sensor event is filtered out");
    assert.deepEqual(rows[0]?.kind === "row" ? rows[0].row : null, { id: "door", value: "Opening" }, "the panel event pushes the translated door row");
  });

  test("filters telemetry to panel rows, dropping unregistered types and registered-but-not-panel entities", async () => {

    const client = makeClient({ entities: [ ...ADVERTISED, { objectId: "laser", type: "switch" } ], snapshot: restingCache() });
    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => client) });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

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
    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => makeClient({ snapshot: cache })) });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    const snapshot = pushes.find((event) => event.kind === "snapshot");

    assert.ok(snapshot?.kind === "snapshot", "the connect completes through a snapshot push");
    assert.deepEqual(snapshot.rows.map((row) => row.id), [ "door", "lock", "light", "obstruction" ],
      "the advertised-but-uncached motion entity is omitted from the snapshot rather than rendered with a phantom value");
  });
});

describe("StatusFeed row value mapping", () => {

  // Drive one telemetry event through a live session and return the value of the row push it produced.
  const rowValueFor = async (event: TelemetryEvent, rowId: string): Promise<string | undefined> => {

    const client = makeClient({ snapshot: restingCache() });
    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => client) });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

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
    // vocabulary can produce, asserted here so a value-set change that widens a row must update this expectation in step with the module's frozen record.
    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() })) });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    const snapshot = pushes.find((event) => event.kind === "snapshot");

    assert.ok(snapshot?.kind === "snapshot", "the connect completes through a snapshot push");

    const sizers = Object.fromEntries(snapshot.rows.map((row) => {

      assert.ok(row.kind !== "choices", "every snapshot row is a text row - ratgdo composes text rows only");

      return [ row.id, row.sizer ];
    }));

    assert.deepEqual(sizers, { door: "Stopped (100%)", light: "Off", lock: "Unlocked", motion: "Detected", obstruction: "Obstructed" },
      "every snapshot row carries its column's widest-possible value as the sizer, covering every row id");
  });
});

describe("StatusFeed availability", () => {

  test("pushes an availability event for each lifecycle transition, in order, with the boolean values", async () => {

    const client = makeClient({ snapshot: restingCache() });
    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => client) });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

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
  const failureReasonFor = async (handler: OpenClientHandler): Promise<string | undefined> => {

    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(handler) });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

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

  test("maps an unsupported API version to the unsupported error", async () => {

    assert.equal(await failureReasonFor(async () => {

      throw new (await import("esphome-client")).NegotiationFailedError("api major out of range", "API_MAJOR_OUT_OF_RANGE");
    }), "unsupported", "a device announcing an API version the client cannot speak surfaces as unsupported");
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
    const pendingFirst = Promise.withResolvers<TestEspHomeClient>();
    const openClient = makeFakeOpenClient((_options, index) => (index === 0) ? pendingFirst.promise : Promise.resolve(makeClient({ snapshot: restingCache() })));
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "k1" }] });

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "k2" }] });
    pendingFirst.reject(new Error("connect abandoned"));

    await settle();

    assert.equal(pushes.some((event) => (event.kind === "error") && (event.serialNumber === MAC)), false, "a shutdown-classified outcome pushes no error");
  });

  test("surfaces an unreachable error rather than rejecting when the connect body throws unexpectedly", async () => {

    // The connect body is total: a client whose listener registration throws mid-connect is caught, logged, and surfaced as unreachable rather than escaping as a
    // rejection that would terminate the custom-UI child process.
    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache(), throwOnListen: true })) });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

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
      const { browser, entries, feed } = makeFeed({ openClient: makeFakeOpenClient(async () => {

        throw new Error("connect refused");
      }), push: throwingPush });

      feed.startDiscovery();
      browser().found(makeService());

      await settle();

      feed.warm({ devices: [{ mac: MAC }] });

      assert.doesNotThrow(() => feed.view(MAC_TWO), "a sessionless view push is contained when the sink throws");

      await settle();
      await settle();

      assert.deepEqual(rejections, [], "no push throw escapes as an unhandled rejection across the warm-connect-fail cycle");
      assert.ok(entries.some((entry) => (entry.level === "error") && formatLogEntry(entry).includes("could not be delivered")),
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
    const openClient = makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() }));
    const { browser, entries, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

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

      assert.ok(entries.some((entry) => (entry.level === level) && (formatLogEntry(entry) === ("Test Ratgdo: " + message))),
        "the " + level + " level arrives at the feed's log under the device's advertised name");
    }
  });

  test("falls back to the dialed address for a device advertising no usable name", async () => {

    // An absent friendly_name and an advertised-but-empty one are equally unusable as an identity, so each falls through to the address the connection dials. Both arms
    // run the same assertion against a freshly built feed, so the check lives in one local helper rather than being written out twice.
    const assertAddressIsTheIdentity = async (overrides: Record<string, string | undefined>): Promise<void> => {

      const openClient = makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() }));
      const { browser, entries, feed } = makeFeed({ openClient });

      feed.startDiscovery();
      browser().found(makeService(MAC, ADDR, overrides));

      await settle();

      feed.warm({ devices: [{ mac: MAC }] });

      await settle();

      const call = openClient.calls[0];

      assert.ok(call, "the unnamed device still connects");

      call.logger.info("A line.");

      assert.ok(entries.some((entry) => (entry.level === "info") && (formatLogEntry(entry) === (ADDR + ": A line."))),
        "the dialed address stands in as the device's identity");
    };

    await assertAddressIsTheIdentity({ friendly_name: undefined });
    await assertAddressIsTheIdentity({ friendly_name: "" });
  });

  test("keeps the feed-level delivery error free of any device identity", async () => {

    /* The #emit containment sits below every per-device session and has no device in scope, so its message opens with exactly the feed-level string. The match is
     * anchored at the head of the rendered line rather than floating anywhere within it, so a device prefix leaking down into feed-scope messages fails here instead
     * of passing unnoticed...the caught error renders after the sentence, which is why the head is what the assertion reads.
     */
    const throwingPush = (): void => {

      throw new Error("the settings panel channel is closed");
    };
    const { browser, entries, feed } = makeFeed({ openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() })), push: throwingPush });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    assert.ok(entries.some((entry) => (entry.level === "error") &&
      formatLogEntry(entry).startsWith("A live-status update could not be delivered to the settings panel.")), "the feed-level delivery error carries no device prefix");
  });

  test("gives each of two concurrent connects its own device identity", async () => {

    // The adapter is minted per connect inside the connect body, so two connects in flight together cannot share one adapter or overwrite one another's identity.
    const openClient = makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() }));
    const { browser, entries, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService(MAC, ADDR, { friendly_name: "Garage Door North" }));
    browser().found(makeService(MAC_TWO, ADDR_TWO, { friendly_name: "Garage Door South" }));

    await settle();

    feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    await settle();

    const north = callsForHost(openClient, ADDR)[0];
    const south = callsForHost(openClient, ADDR_TWO)[0];

    assert.ok(north, "the first device recorded its own factory call");
    assert.ok(south, "the second device recorded its own factory call");

    north.logger.info("A north line.");
    south.logger.info("A south line.");

    assert.ok(entries.some((entry) => (entry.level === "info") && (formatLogEntry(entry) === "Garage Door North: A north line.")),
      "the first device's adapter carries only its own name");
    assert.ok(entries.some((entry) => (entry.level === "info") && (formatLogEntry(entry) === "Garage Door South: A south line.")),
      "the second device's adapter carries only its own name");
  });

  test("attributes an unexpected connect-body failure to its device", async () => {

    // The connect body's totality catch runs with the device still in scope, so its line opens with the same identity every other line of this connection does. A
    // client whose listener registration throws lands in exactly that catch, and the caught error renders after the sentence, so the head is what the assertion reads.
    const { browser, entries, feed } = makeFeed({ openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache(), throwOnListen: true })) });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    assert.ok(entries.some((entry) => (entry.level === "error") &&
      formatLogEntry(entry).startsWith("Test Ratgdo: The live-status connection failed unexpectedly.")), "the connect body's catch logs under the device's identity");
  });

  test("speaks under the warmed log name ahead of the advertised name, and re-reads it on every line", async () => {

    /* The resolver is a closure the adapter calls per line rather than a string captured at connect, so one recorded logger is driven across two warms here: the same
     * adapter answers the log name while one is warmed and the advertised name once it is not. Asserting it on ONE adapter is what tells a live resolver from an
     * implementation that merely happened to compute the right prefix at connect time.
     */
    const openClient = makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() }));
    const { browser, entries, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ logName: "North Door", mac: MAC }] });

    await settle();

    const call = openClient.calls[0];

    assert.ok(call, "the device connects, recording the logger openConnection forwarded to the client factory");

    call.logger.info("A line.");

    assert.ok(entries.some((entry) => (entry.level === "info") && (formatLogEntry(entry) === "North Door: A line.")),
      "the user's own name for the device outranks the name the device advertises");

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    call.logger.info("A later line.");

    assert.ok(entries.some((entry) => (entry.level === "info") && (formatLogEntry(entry) === "Test Ratgdo: A later line.")),
      "clearing the name falls the very same adapter back to the advertised one, which only a resolver read per line can do");
  });

  test("falls back through the advertised name to the dialed address for a device with neither a warmed name nor an advertised one", async () => {

    // The full precedence needs a device advertising no usable name and carrying no log name, which is the one input that reaches the last fallback.
    const openClient = makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() }));
    const { browser, entries, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService(MAC, ADDR, { friendly_name: undefined }));

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    const call = openClient.calls[0];

    assert.ok(call, "the unnamed device still connects");

    call.logger.info("A line.");

    assert.ok(entries.some((entry) => (entry.level === "info") && (formatLogEntry(entry) === (ADDR + ": A line."))),
      "with no name from either source the dialed address stands in as the identity");
  });

  test("moves no connection for a warm that changes nothing but the log name", async () => {

    // A log name is display truth alone. The key diff is what decides a teardown, so a warm carrying a new name against an unchanged key must leave the live session
    // exactly where it is: the factory call count proves no second connect, and the client's dispose record proves the first was never torn down.
    const client = makeClient({ snapshot: restingCache() });
    const openClient = makeFakeOpenClient(async () => client);
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ logName: "North Door", mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "the first warm opens exactly one connection");

    feed.warm({ devices: [{ logName: "South Door", mac: MAC }] });
    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "neither a renamed device nor a cleared name opens a second connection");
    assert.equal(client.disposeCount, 0, "the live session is never torn down over a name");
  });
});

describe("StatusFeed discovery", () => {

  test("connects a device discovered after its warm entry and clears its pending not-found timer", async () => {

    // The budget is short (30ms) and the clock is driven PAST it, so a dropped timer clear surfaces: an uncleared timer would fire not-found at 30ms, well inside the
    // 50ms the clock moves. The advertisement lands before the deadline, so discovery clears the timer and connects, and the later advance proves the timer is gone.
    const { browser, clock, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 0.03,
      openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() })) });

    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });
    announce(browser(), makeService());

    await settle();

    clock.advance(50);

    await settle();

    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "a device discovered after its warm entry connects on arrival");
    assert.ok(!pushes.some((event) => (event.kind === "error") && (event.reason === "not-found")), "no not-found fires past the deadline - discovery cleared the timer");
  });

  test("fires the per-mac not-found timer for a still-undiscovered mac, undeferred by an unrelated device's re-warm", async () => {

    // MAC stays undiscovered; MAC_TWO is discovered and encrypted, so its key change on every re-warm forces a reconnect (a plaintext session would adopt the key in
    // place) - the unrelated activity. A per-mac timer keeps MAC's original deadline (50ms from its arming warm); a shared timer re-armed on every warm would push MAC's
    // deadline out past the assertion window. The last re-warm lands at 45ms, so the read at 72ms is past the true 50ms deadline but well short of any re-armed 95ms
    // one.
    const openClient = makeFakeOpenClient(async () => makeClient({ isEncrypted: true, snapshot: restingCache() }));
    const { browser, clock, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 0.05, openClient });

    // Re-warm the set with a fresh key for the discovered device, driving its reconnect while MAC stays warmed and undiscovered.
    const rewarm = (key: string): void => feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO, psk: key } ] });

    feed.startDiscovery();
    browser().found(makeService(MAC_TWO, ADDR_TWO));

    await settle();

    feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO, psk: "k0" } ] });

    await settle();

    clock.advance(15);

    await settle();

    rewarm("k1");
    clock.advance(15);

    await settle();

    rewarm("k2");
    clock.advance(15);

    await settle();

    rewarm("k3");
    clock.advance(27);

    await settle();

    const notFound = pushes.filter((event) => (event.kind === "error") && (event.serialNumber === MAC) && (event.reason === "not-found"));

    assert.equal(notFound.length, 1, "MAC's not-found timer fires exactly once at its original deadline, undeferred by MAC_TWO's re-warms");
    assert.ok(!pushes.some((event) => (event.kind === "error") && (event.serialNumber === MAC_TWO) && (event.reason === "not-found")),
      "the discovered device never times out");
  });

  test("keeps a live session when its mac is absent from a re-warm and stops discovery-driven reconnects for it", async () => {

    const clientA = makeClient({ snapshot: restingCache() });
    const clientB = makeClient({ snapshot: restingCache() });
    const openClient = makeFakeOpenClient((options) => Promise.resolve((options.host === ADDR_TWO) ? clientB : clientA));
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService(MAC));
    browser().found(makeService(MAC_TWO, ADDR_TWO));

    await settle();

    feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    await settle();

    const aCallsBefore = callsForHost(openClient, ADDR).length;

    // Re-warm without MAC. Its session must survive - a transient device-list read must not destroy a live connection - and MAC must leave the warm set.
    feed.warm({ devices: [{ mac: MAC_TWO }] });

    await settle();

    assert.equal(clientA.disposeCount, 0, "a mac absent from a re-warm keeps its live session undisposed");

    // Re-advertise MAC: it left the warm set, so discovery drives no reconnect for it.
    announce(browser(), makeService(MAC));

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, aCallsBefore, "MAC leaving the warm set stops discovery-driven reconnects for it");
  });

  test("does not reconnect a re-advertised mac that has left the warm set and holds no session", async () => {

    // Isolate the #warmKeys gate. The device's connect fails, so its session is gone; then the device is dropped from the warm set. On re-advertisement, with no session
    // to block it, the session guard admits a reconnect - only #warmKeys.has() being false gates it out - so a flat factory count proves warm-set membership is the gate.
    const openClient = makeFakeOpenClient(async () => {

      throw new Error("connect refused");
    });
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService(MAC));

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    assert.equal(openClient.calls.length, 1, "the first connect attempt failed and left no session");

    // Drop MAC from the warm set entirely, then re-advertise it: no session exists, so only its absence from #warmKeys can gate the reconnect out.
    feed.warm({ devices: [] });
    announce(browser(), makeService(MAC));

    await settle();

    assert.equal(openClient.calls.length, 1, "a re-advertised mac absent from the warm set with no session makes no new factory call");
  });

  test("ignores an advertised service that is not a ratgdo device", async () => {

    const { browser, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 1, openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() })) });

    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    // A foreign ESPHome project the discovery parser rejects; it must record no device and start no connect.
    announce(browser(), makeRatgdoService({ esphome_version: "2.0.0", friendly_name: "Other", mac: MAC, project_name: "esphome.generic", project_version: "1.0.0" },
      [ADDR]));

    await settle();

    assert.ok(!pushes.some((event) => event.kind === "snapshot"), "an unclassifiable service records no device and starts no connect");
  });
});

describe("StatusFeed advertisement", () => {

  test("never double-connects on repeated re-advertisements of a live mac", async () => {

    const openClient = makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() }));
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    assert.equal(openClient.calls.length, 1, "the initial advertisement connects the device once");
    assert.equal(pushes.filter((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)).length, 1, "the first connect completes through one snapshot");

    announce(browser(), makeService());
    announce(browser(), makeService());
    announce(browser(), makeService());

    await settle();

    assert.equal(openClient.calls.length, 1,
      "repeated re-advertisements of a live mac make no further factory call - the synchronous session install is the double-connect guard");
    assert.equal(pushes.filter((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)).length, 1, "and push no further snapshot");
  });
});

describe("StatusFeed isolation", () => {

  test("leaves sibling connects unaffected when one device's connect fails", async () => {

    const clientA = makeClient({ snapshot: restingCache() });
    const clientC = makeClient({ snapshot: restingCache() });
    const openClient = makeFakeOpenClient(async (options) => {

      if(options.host === ADDR_TWO) {

        throw new Error("device two refused");
      }

      return (options.host === ADDR) ? clientA : clientC;
    });
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService(MAC));
    browser().found(makeService(MAC_TWO, ADDR_TWO));
    browser().found(makeService(MAC_THREE, ADDR_THREE));

    await settle();

    feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO }, { mac: MAC_THREE } ] });

    await settle();

    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "the first sibling completes despite the middle device's failure");
    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC_THREE)),
      "the last sibling completes despite the middle device's failure");
    assert.ok(pushes.some((event) => (event.kind === "error") && (event.serialNumber === MAC_TWO) && (event.reason === "unreachable")),
      "the failing device surfaces its error");
  });
});

describe("StatusFeed supersede", () => {

  test("disposes a superseded connection without pushing, while the successor completes its snapshot", async () => {

    const first = makeClient({ snapshot: restingCache() });
    const second = makeClient({ snapshot: restingCache() });
    const pendingFirst = Promise.withResolvers<TestEspHomeClient>();
    const openClient = makeFakeOpenClient((_options, index) => (index === 0) ? pendingFirst.promise : Promise.resolve(second));
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService());

    await settle();


    // Start the first connect against one key; its client resolution defers. Supersede it with a re-warm carrying a different key, which tears the first session down and
    // starts the successor. Only then does the first connect resolve - after the supersede has installed the successor session.
    feed.warm({ devices: [{ mac: MAC, psk: "k1" }] });

    await settle();

    feed.warm({ devices: [{ mac: MAC, psk: "k2" }] });
    pendingFirst.resolve(first);

    await settle();

    assert.equal(first.disposeCount, 1, "the superseded first client is disposed exactly once");
    assert.equal(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC) && (event.session === 1)), false,
      "the superseded first session never pushes its snapshot");
    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "the successor session completes through its own snapshot");
  });
});

describe("StatusFeed dispose", () => {

  test("tears down every session and timer, is safe on repeat, and connects nothing afterward", async () => {

    const clientA = makeClient({ snapshot: restingCache() });
    const clientB = makeClient({ snapshot: restingCache() });
    const openClient = makeFakeOpenClient((options) => Promise.resolve((options.host === ADDR_TWO) ? clientB : clientA));
    const { browser, clock, factory, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 0.03, openClient });

    feed.startDiscovery();
    browser().found(makeService(MAC));
    browser().found(makeService(MAC_TWO, ADDR_TWO));

    await settle();

    // MAC and MAC_TWO are discovered and connect; MAC_THREE is warmed while undiscovered, so it arms a not-found timer that dispose must clear.
    feed.warm({ devices: [ { mac: MAC }, { mac: MAC_TWO }, { mac: MAC_THREE } ] });

    await settle();

    /* The pool's defense in depth, exercised at its tightest: a third device's advertisement is delivered and dispose runs in the same synchronous turn, before the
     * queue has drained, so the event is staged when the pool goes away. The cleared warm set is what makes that queued event connect nothing when it does drain.
     */
    browser().found(makeService(MAC_THREE, ADDR_THREE));
    feed[Symbol.dispose]();

    assert.equal(clientA.disposeCount, 1, "dispose tears down the first session's client");
    assert.equal(clientB.disposeCount, 1, "dispose tears down the second session's client");
    assert.equal(browser().aborted, true, "dispose ends the discovery stream");

    const settledCount = pushes.length;

    feed[Symbol.dispose]();

    assert.equal(clientA.disposeCount, 1, "a repeat dispose tears the first session's client down no second time");
    assert.equal(clientB.disposeCount, 1, "a repeat dispose tears the second session's client down no second time");
    assert.equal(factory.createCalls.length, 1, "a repeat dispose builds no second browser");

    // The staged advertisement drains after the abort, and the warmed-but-undiscovered mac's budget elapses. Neither may reach the panel.
    await settle();

    clock.advance(50);

    await settle();

    assert.equal(callsForHost(openClient, ADDR_THREE).length, 0, "an advertisement staged when dispose ran opens no connection");
    assert.equal(pushes.length, settledCount, "nothing is pushed after dispose - the cleared warm set and the cleared not-found timer both hold");
  });
});

describe("StatusFeed discovery lifecycle", () => {

  test("builds the browser ahead of the first warm and never builds it twice", async () => {

    const { browser, factory, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() })) });

    feed.startDiscovery();

    assert.equal(factory.createCalls.length, 1, "startDiscovery builds the browser");

    browser().found(makeService());
    feed.startDiscovery();

    assert.equal(factory.createCalls.length, 1, "a second startDiscovery reuses the running stream rather than building another browser");

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    assert.equal(factory.createCalls.length, 1, "the warm resolves the discovered device from the warm map without building a second browser");
    assert.ok(pushes.some((event) => event.kind === "snapshot"), "the warm connects through to its snapshot");
  });

  test("contains a discovery-start failure instead of taking down the process", () => {

    const { feed } = makeFeed({ browserFactory: new FlakeyBrowserFactory(1) });

    assert.doesNotThrow(() => feed.startDiscovery(), "a browser that cannot be built is contained, never thrown to the adapter");
  });

  test("retries a failed construction-time browser build on the next warm, then connects a warmed device on advertisement", async () => {

    // The factory throws on its first build - the construction-time one - and succeeds on the second. startDiscovery contains the first failure, so the pool is
    // browserless after construction; the next warm calls startDiscovery again through its contained path, bringing a live browser up. An advertisement then connects
    // the warmed device, proving discovery recovered through warm() rather than construction. attempts counts every build asked for, so it tells the recovery apart:
    // one after construction, two after the warm. The discovery budget is generous so the warmed mac's not-found timer never pre-empts the advertisement's connect.
    const factory = new FlakeyBrowserFactory(1);
    const { browser, feed, pushes } = makeFeed({ browserFactory: factory, discoveryTimeoutSeconds: 5,
      openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() })) });

    feed.startDiscovery();

    assert.equal(factory.attempts, 1, "the construction-time build is attempted once and its failure is contained");

    feed.warm({ devices: [{ mac: MAC }] });

    assert.equal(factory.attempts, 2, "warm() retries the build through its own contained path, bringing the attempt count to two");

    announce(browser(), makeService(MAC));

    await settle();

    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)),
      "an advertisement after the warm-path retry connects the warmed device - discovery recovered through warm(), not construction");
  });

  test("does not rebuild a live browser across repeated warms", () => {

    // A warm re-ensures the stream through startDiscovery, but a stream already running must not be replaced: ensureBrowser's early return makes the call a no-op
    // while one runs. The build count stays one across three warms that add and drop devices, proving the warm-cadence retry costs nothing on a healthy stream.
    const { factory, feed } = makeFeed({ openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() })) });

    feed.startDiscovery();

    assert.equal(factory.createCalls.length, 1, "construction builds the browser once");

    feed.warm({ devices: [{ mac: MAC }] });
    feed.warm({ devices: [{ mac: MAC }] });
    feed.warm({ devices: [{ mac: MAC_TWO }] });

    assert.equal(factory.createCalls.length, 1, "repeated warms reuse the running stream rather than building another browser");
  });

  test("builds a replacement browser on the next warm after the running one lost its sockets", async () => {

    // A browser that loses its last network socket aborts itself: the stream ends rather than throwing, so the feed's loop is where that fault becomes visible. The
    // loop nulls its field on the way out, and the next warm is what builds the replacement - the warm cadence IS the retry.
    const { browser, entries, factory, feed } = makeFeed({ discoveryTimeoutSeconds: 5,
      openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() })) });

    feed.startDiscovery();

    assert.equal(factory.createCalls.length, 1, "startDiscovery builds the first browser");

    browser().abort(new HbpuAbortError("failed"));

    await settle();

    assert.ok(entries.some((entry) => (entry.level === "warn") && formatLogEntry(entry).includes("lost its network sockets")),
      "the loop's own end is where the socket loss is reported");

    feed.warm({ devices: [{ mac: MAC }] });

    assert.equal(factory.createCalls.length, 2, "the next warm builds a replacement browser rather than leaving the pool blind");
  });

  test("fires a warmed mac's not-found verdict exactly as its budget elapses and not a millisecond before", async () => {

    // The budget is the whole contract of the per-mac sweep, and the injected clock is what makes the boundary exact: one millisecond short of it there is no
    // verdict, and the millisecond that reaches it produces exactly one.
    const { clock, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 0.05 });

    feed.startDiscovery();
    feed.warm({ devices: [{ mac: MAC }] });

    clock.advance(49);

    await settle();

    assert.equal(pushes.filter((event) => (event.kind === "error") && (event.reason === "not-found")).length, 0,
      "one millisecond short of the budget the verdict has not fired");

    clock.advance(1);

    await settle();

    const notFound = pushes.filter((event) => (event.kind === "error") && (event.reason === "not-found"));
    const verdict = notFound[0];

    assert.equal(notFound.length, 1, "the verdict fires exactly once as the budget elapses");
    assert.ok((verdict?.kind === "error") && (verdict.serialNumber === MAC), "the verdict names the warmed mac that was never advertised");
  });
});

describe("StatusFeed address change", () => {

  test("re-dials a warmed live session when its device is advertised at a new address", async () => {

    // The session records the address its connect dialed, so an advertisement carrying a different one is a device that moved. The pool follows it exactly as the
    // platform does: tear the session down and re-dial at the new address, which is the same shape warm() uses for a changed key.
    const first = makeClient({ snapshot: restingCache() });
    const second = makeClient({ snapshot: restingCache() });
    let call = 0;
    const openClient = makeFakeOpenClient(async () => {

      call++;

      return (call === 1) ? first : second;
    });
    const { browser, feed } = makeFeed({ discoveryTimeoutSeconds: 5, openClient });

    feed.startDiscovery();
    browser().found(makeService(MAC));

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "the device connects once at the address it first advertised");

    announce(browser(), makeService(MAC, ADDR_TWO));

    await settle();

    assert.equal(first.disposeCount, 1, "the session that dialed the old address is torn down");
    assert.equal(openClient.calls.length, 2, "exactly one further connection is opened");
    assert.equal(callsForHost(openClient, ADDR_TWO).length, 1, "the re-dial targets the newly advertised address");
  });

  test("re-dials a live session at the new pick when the address it is connected on leaves the advertisement", async () => {

    /* The device advertises three addresses and is dialed at the unique-local one, then advertises a set without it. The session's own address is gone from the
     * advertisement, which is what a device that moved looks like, and the pool tears the session down and re-dials at what the remaining set picks.
     */
    const first = makeClient({ snapshot: restingCache() });
    const second = makeClient({ snapshot: restingCache() });
    let call = 0;
    const openClient = makeFakeOpenClient(async () => {

      call++;

      return (call === 1) ? first : second;
    });
    const { browser, feed } = makeFeed({ discoveryTimeoutSeconds: 5, openClient });

    feed.startDiscovery();
    browser().found(makeRatgdoService({ esphome_version: "2.0.0", friendly_name: "Test Ratgdo", mac: MAC, project_name: "ratgdo.esp32", project_version: "1.0.0" },
      [ ADDR, ADDR_V6_GLOBAL, ADDR_V6_ULA ]));

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR_V6_ULA).length, 1, "the device connects at the unique-local address its first advertisement picked");

    announce(browser(), makeRatgdoService({ esphome_version: "2.0.0", friendly_name: "Test Ratgdo", mac: MAC, project_name: "ratgdo.esp32", project_version: "1.0.0" },
      [ ADDR, ADDR_V6_GLOBAL ]));

    await settle();

    assert.equal(first.disposeCount, 1, "the session on the address that left the advertisement is torn down");
    assert.equal(openClient.calls.length, 2, "exactly one further connection is opened");
    assert.equal(callsForHost(openClient, ADDR_V6_GLOBAL).length, 1, "the re-dial targets what the remaining set picks");
  });

  test("leaves a live session alone when the device advertises a higher-ranked address than the one it is connected on", async () => {

    /* The case a comparison against the pick gets wrong. The device is dialed at its global IPv6 address because that is the best it advertised, then its unique-local
     * record returns and the pick moves to that. The session's own address is still advertised, so the device has not moved: the healthy connection stands, nothing is
     * re-dialed, and the panel sees no Connecting flash. The projection follows the session rather than the pick, because the panel's "IP Address" means where the
     * connection actually is.
     */
    const client = makeClient({ snapshot: restingCache() });
    const openClient = makeFakeOpenClient(async () => client);
    const { browser, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 5, openClient });

    feed.startDiscovery();
    browser().found(makeRatgdoService({ esphome_version: "2.0.0", friendly_name: "Test Ratgdo", mac: MAC, project_name: "ratgdo.esp32", project_version: "1.0.0" },
      [ ADDR, ADDR_V6_GLOBAL ]));

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR_V6_GLOBAL).length, 1, "the device connects at the routable IPv6 address its first advertisement picked");

    const connectingBefore = pushes.filter((event) => event.kind === "connecting").length;

    announce(browser(), makeRatgdoService({ esphome_version: "2.0.0", friendly_name: "Test Ratgdo", mac: MAC, project_name: "ratgdo.esp32", project_version: "1.0.0" },
      [ ADDR, ADDR_V6_GLOBAL, ADDR_V6_ULA ]));

    await settle();

    assert.equal(client.disposeCount, 0, "the connection stands, because the address it was opened at is still advertised");
    assert.equal(openClient.calls.length, 1, "no second connection is opened, even though the pick has moved to the unique-local address");
    assert.equal(callsForHost(openClient, ADDR_V6_ULA).length, 0, "and nothing dials the address the pick now favors");
    assert.equal(pushes.filter((event) => event.kind === "connecting").length, connectingBefore, "the panel sees no Connecting flash for a device that never moved");
    assert.deepEqual(feed.addresses(), { [MAC]: ADDR_V6_GLOBAL }, "the projection reports the address the live session is connected on, not the new pick");
  });

  test("leaves a live session alone when the advertised set is merely reordered", async () => {

    // The browser lists a host's addresses in the order they arrived in its cache, so a record that lapses and returns re-enters at the end. The ranked pick already
    // ignores that order and membership ignores it too, so a reorder of a stable set is an event at neither gate.
    const client = makeClient({ snapshot: restingCache() });
    const openClient = makeFakeOpenClient(async () => client);
    const { browser, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 5, openClient });

    feed.startDiscovery();
    browser().found(makeRatgdoService({ esphome_version: "2.0.0", friendly_name: "Test Ratgdo", mac: MAC, project_name: "ratgdo.esp32", project_version: "1.0.0" },
      [ ADDR_V6_ULA, ADDR_V6_GLOBAL ]));

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    const pushesBefore = pushes.length;

    announce(browser(), makeRatgdoService({ esphome_version: "2.0.0", friendly_name: "Test Ratgdo", mac: MAC, project_name: "ratgdo.esp32", project_version: "1.0.0" },
      [ ADDR_V6_GLOBAL, ADDR_V6_ULA ]));

    await settle();

    assert.equal(client.disposeCount, 0, "a reorder of the same set tears nothing down");
    assert.equal(openClient.calls.length, 1, "and opens no second connection");
    assert.equal(pushes.length, pushesBefore, "and pushes nothing, which follows from the session being untouched");
  });

  test("falls the address projection back to the advertised pick once the pool holds no session for a device", async () => {

    /* The projection must not keep reporting a torn-down session's address: the panel would name an address nothing is connected on. Here the held address leaves the
     * advertisement, so the session is torn down, and the re-dial at the new pick fails - which leaves the device discovered with no session at all. The read falls
     * back to what the advertisement picks, which is the address the next connect will dial.
     */
    const first = makeClient({ snapshot: restingCache() });
    let call = 0;
    const openClient = makeFakeOpenClient(async () => {

      call++;

      if(call === 1) {

        return first;
      }

      throw new Error("connect refused");
    });
    const { browser, feed } = makeFeed({ discoveryTimeoutSeconds: 5, openClient });

    feed.startDiscovery();
    browser().found(makeRatgdoService({ esphome_version: "2.0.0", friendly_name: "Test Ratgdo", mac: MAC, project_name: "ratgdo.esp32", project_version: "1.0.0" },
      [ ADDR, ADDR_V6_GLOBAL ]));

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    assert.deepEqual(feed.addresses(), { [MAC]: ADDR_V6_GLOBAL }, "a live session's own address is what the projection reports");

    announce(browser(), makeRatgdoService({ esphome_version: "2.0.0", friendly_name: "Test Ratgdo", mac: MAC, project_name: "ratgdo.esp32", project_version: "1.0.0" },
      [ ADDR, ADDR_V6_ULA ]));

    await settle();

    assert.equal(first.disposeCount, 1, "the session on the address that left the advertisement is torn down");
    assert.deepEqual(feed.addresses(), { [MAC]: ADDR_V6_ULA }, "and with no session left, the projection reports the address the advertisement picks");
  });

  test("leaves a live session alone when a mac outside the warm set moves", async () => {

    // The warm-set departure rule outranks the address change: a mac the sidebar no longer names keeps whatever session it holds, and discovery drives nothing for it.
    const client = makeClient({ snapshot: restingCache() });
    const openClient = makeFakeOpenClient(async () => client);
    const { browser, feed } = makeFeed({ discoveryTimeoutSeconds: 5, openClient });

    feed.startDiscovery();
    browser().found(makeService(MAC));

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    feed.warm({ devices: [] });
    announce(browser(), makeService(MAC, ADDR_TWO));

    await settle();

    assert.equal(client.disposeCount, 0, "a mac outside the warm set keeps its live session even when its address moves");
    assert.equal(openClient.calls.length, 1, "no re-dial is opened for a mac the warm set no longer names");
  });

  test("keeps the address projection and the live session when an advertisement is lost", async () => {

    // A lost advertisement changes nothing: the discovery entry stands so the projection and any later connect keep the last address, and whether a connected device
    // is still there is the ESPHome connection's to report. The client's dispose count staying zero is what tells a correct lost arm from one that tears the session
    // down; the absence of an availability push follows from the same fact.
    const client = makeClient({ snapshot: restingCache() });
    const { browser, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 5, openClient: makeFakeOpenClient(async () => client) });

    feed.startDiscovery();
    browser().found(makeService(MAC));

    await settle();

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    const pushesBefore = pushes.length;

    browser().lost(makeService(MAC).name);

    await settle();

    assert.equal(client.disposeCount, 0, "a lost advertisement leaves the live session untouched");
    assert.deepEqual(feed.addresses(), { [MAC]: ADDR }, "the address projection keeps the last address the device advertised");
    assert.equal(pushes.length, pushesBefore, "and nothing is pushed, which follows from the session being untouched");
  });
});

describe("narrowStatusWarmRequest", () => {

  test("accepts a well-formed request and carries each entry's psk", () => {

    const result = narrowStatusWarmRequest({ devices: [ { mac: MAC, psk: "secret" }, { mac: MAC_TWO } ] });

    assert.deepEqual(result, { addresses: [], devices: [ { logName: undefined, mac: MAC, psk: "secret" }, { logName: undefined, mac: MAC_TWO, psk: undefined } ] },
      "each entry is carried, a non-empty psk kept and an absent psk narrowed to undefined");
  });

  test("drops a malformed entry individually without invalidating the request", () => {

    const result = narrowStatusWarmRequest({ devices: [ { mac: MAC }, { psk: "x" }, { mac: "" }, "nope", null, { mac: MAC_TWO } ] });

    assert.deepEqual(result, { addresses: [], devices: [ { logName: undefined, mac: MAC, psk: undefined }, { logName: undefined, mac: MAC_TWO, psk: undefined } ] },
      "an entry with no mac, an empty-string mac, a non-object entry, and null are each dropped while the well-formed entries survive");
  });

  test("carries a non-empty log name and narrows every other spelling of one to undefined", () => {

    // The log name is narrowed by exactly the rule the psk is, so the rows that matter are the ones a wrong implementation would treat differently: a value kept, and
    // each of the three ways a field can say nothing - absent, null, and present-but-empty.
    assert.deepEqual(narrowStatusWarmRequest({ devices: [{ logName: "North Door", mac: MAC }] }),
      { addresses: [], devices: [{ logName: "North Door", mac: MAC, psk: undefined }] }, "a non-empty log name is carried through");

    for(const logName of [ undefined, null, "", 42 ]) {

      assert.deepEqual(narrowStatusWarmRequest({ devices: [{ logName, mac: MAC }] }), { addresses: [], devices: [{ logName: undefined, mac: MAC, psk: undefined }] },
        "a log name of " + JSON.stringify(logName) + " is the device offering no name, so it narrows to undefined");
    }
  });

  test("rejects a body that is not an object or carries no devices array", () => {

    assert.equal(narrowStatusWarmRequest(null), null, "a null body is rejected");
    assert.equal(narrowStatusWarmRequest("nope"), null, "a non-object body is rejected");
    assert.equal(narrowStatusWarmRequest({}), null, "a body with no devices array is rejected");
    assert.equal(narrowStatusWarmRequest({ devices: "nope" }), null, "a body whose devices field is not an array is rejected");
  });

  test("accepts an empty devices array", () => {

    assert.deepEqual(narrowStatusWarmRequest({ devices: [] }), { addresses: [], devices: [] }, "an empty devices array is a valid warm - the sidebar knows nothing");
  });

  test("narrows a null or empty entry psk to undefined", () => {

    assert.deepEqual(narrowStatusWarmRequest({ devices: [{ mac: MAC, psk: null }] }), { addresses: [], devices: [{ logName: undefined, mac: MAC, psk: undefined }] },
      "a null entry psk narrows to undefined");
    assert.deepEqual(narrowStatusWarmRequest({ devices: [{ mac: MAC, psk: "" }] }), { addresses: [], devices: [{ logName: undefined, mac: MAC, psk: undefined }] },
      "an empty-string entry psk narrows to undefined");
  });

  test("creates no session for an empty warm at the feed layer", async () => {

    const { feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => makeClient({ snapshot: restingCache() })) });

    feed.startDiscovery();
    feed.warm({ devices: [] });

    await settle();

    assert.equal(pushes.length, 0, "an empty warm dispatches to no connect and pushes nothing");
  });
});

describe("narrowStatusWarmRequest addresses", () => {

  test("reads an absent, empty, or unparseable address list as no addresses at all", () => {

    // An install that lists no address is the ordinary one, and every one of these spellings is it saying so. Refusing the whole request over a malformed list would
    // blank a panel whose devices are perfectly well formed.
    for(const addresses of [ undefined, [], "nope", null, 42 ]) {

      assert.deepEqual(narrowStatusWarmRequest({ addresses, devices: [] }), { addresses: [], devices: [] },
        "an addresses field of " + JSON.stringify(addresses) + " reads as no listed addresses");
    }
  });

  test("canonicalizes each address through the runtime's own rule, and drops what nothing could dial", () => {

    /* The feed keys every address record on this form, and the platform keys its loops on the same form, so the two must agree character for character - which is
     * why this calls the runtime's own function rather than restating the rule. The bracketed row is the one that matters: the bracketed and bare spellings of one
     * literal have to become ONE address here, or the feed holds two records for one device.
     */
    const result = narrowStatusWarmRequest({ addresses: [ { address: "[2001:DB8::5]" }, { address: "2001:db8::5" }, { address: "  Garage.Local  " },
      { address: "fe80::1%en0" }, { address: "[]" } ], devices: [] });

    assert.ok(result, "the request narrows");
    assert.deepEqual(result.addresses.map((entry) => entry.address), [ "2001:db8::5", "2001:db8::5", "garage.local" ],
      "the bracketed literal becomes the bare one, whitespace and case are settled, and the zoned and empty entries are dropped entirely");

    for(const address of [ "[2001:db8::5]", "2001:db8::5" ]) {

      assert.deepEqual(narrowStatusWarmRequest({ addresses: [{ address }], devices: [] })?.addresses,
        [{ address: canonicalManualAddress(address), psk: undefined }],
        "the feed and the runtime answer the same canonical form for " + JSON.stringify(address));
    }
  });

  test("carries each well-formed address lower-cased with its key, and drops a malformed entry individually", () => {

    const result = narrowStatusWarmRequest({ addresses: [ { address: "Garage.Local", psk: "secret" }, { address: ADDR }, { psk: "x" }, { address: "" }, "nope",
      null, { address: "FD00::1", psk: "" } ], devices: [] });

    assert.deepEqual(result, { addresses: [ { address: "garage.local", psk: "secret" }, { address: ADDR, psk: undefined },
      { address: "fd00::1", psk: undefined } ], devices: [] },
    "every address is lower-cased at this one boundary, the key follows the device rule, and an entry with no address is dropped without taking the request with it");
  });
});

describe("StatusFeed address dial", () => {

  test("serves a warmed mac that never advertised, as that mac's session at the listed address", async () => {

    /* The whole point of a listed address: nothing on the network announced this device, so the pool learns what it is by dialing the address and reading the
     * device-info record back. The snapshot push is what proves the connection became a real session rather than an identification that was thrown away.
     */
    const openClient = makeFakeOpenClient(async () => makeAnsweringClient());
    const { feed, pushes } = makeFeed({ openClient });

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "the listed address is dialed exactly once");
    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)),
      "the device that answered is served under its own mac, with the snapshot the dial captured");
    assert.deepEqual(feed.addresses(), { [MAC]: ADDR }, "the identity strip reports the listed address, which is where the connection is");
  });

  test("dials the bare literal for a bracketed listed address", async () => {

    /* The dial-host proof on the feed side, and the one that shows the fix end to end: the address arrives bracketed on the wire, and what reaches the ESPHome
     * client factory as `host` is the bare literal. The bracketed form is not an IP literal to Node's own parser, so a dial carrying it would be resolved as a
     * hostname and fail for good - this row is the difference between a connection and a lookup that never succeeds.
     */
    const openClient = makeFakeOpenClient(async () => makeAnsweringClient());
    const { feed } = makeFeed({ openClient });

    // Driven through the narrowing rather than straight into warm(), because the narrowing IS this module's canonicalization point: warm() trusts the shape the
    // bridge boundary handed it, exactly as it trusts every other field it was given.
    const request = narrowStatusWarmRequest({ addresses: [{ address: "[2001:DB8::5]" }], devices: [{ mac: MAC }] });

    assert.ok(request, "the request narrows");

    feed.warm(request);

    await settle();

    assert.deepEqual(openClient.calls.map((call) => call.host), ["2001:db8::5"], "one dial, and its host is the bare literal rather than the bracketed spelling");
    assert.deepEqual(feed.addresses(), { [MAC]: "2001:db8::5" }, "and the identity strip reports that same canonical address");
  });

  test("never dials an address naming a zone", async () => {

    // The page refuses a zoned address before it can be sent, so one arriving here is a payload to ignore rather than a user to tell - it is dropped at the
    // narrowing, and the observation is that nothing was dialed at all.
    const openClient = makeFakeOpenClient(async () => makeAnsweringClient());
    const { feed } = makeFeed({ openClient });
    const request = narrowStatusWarmRequest({ addresses: [{ address: "fe80::1%en0" }], devices: [{ mac: MAC }] });

    assert.ok(request, "the request narrows rather than being refused wholesale");

    feed.warm(request);

    await settle();

    assert.equal(openClient.calls.length, 0, "a zoned address reaches no dial");
  });

  test("identifies an address whose device the sidebar does not list, and closes that connection at once", async () => {

    // A listed address may name a device nobody has added to HomeKit yet. Identifying it is worth one connection; HOLDING it is not, because an opener has very few
    // API slots and the panel has nowhere to render a device it does not list.
    const client = makeAnsweringClient({ mac: MAC_THREE });
    const openClient = makeFakeOpenClient(async () => client);
    const { feed, pushes } = makeFeed({ openClient });

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(client.disposeCount, 1, "the connection is closed the moment the device is identified");
    assert.ok(!pushes.some((event) => (event.kind !== "hello") && (event.serialNumber === MAC_THREE)), "a device the sidebar does not list pushes nothing to the panel");
    assert.deepEqual(feed.addresses(), { [MAC_THREE]: ADDR }, "the identity is remembered even though the connection was not");

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "a resolved address is not dialed again by a later warm");
  });

  test("retires the not-found timer of a mac an address dial resolves before the budget fires", async () => {

    /* The distinguishing observation is the SCHEDULED TIMER COUNT, not the push stream. An implementation that installs the session but skips the shared retirement
     * leaves the timer armed, and #onDiscoveryTimeout's own device guard then swallows the verdict - so the pushes look identical while a timer leaks. Reading
     * clock.pending across the dial is what tells those two apart.
     */
    const openClient = makeFakeOpenClient(async () => makeAnsweringClient());
    const { clock, feed, pushes } = makeFeed({ discoveryTimeoutSeconds: 0.05, openClient });

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    const armed = clock.pending;

    assert.equal(armed, 1, "a warmed mac nothing has advertised arms exactly one not-found timer");

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(clock.pending, armed - 1, "resolving the address retires that mac's pending timer rather than leaving it counting down");

    clock.advance(100);

    await settle();

    assert.ok(!pushes.some((event) => (event.kind === "error") && (event.reason === "not-found")),
      "no not-found verdict outlives the connection that disproved it");
  });

  test("opens exactly one connection per address however many warms arrive while a dial is in flight", async () => {

    // The dialing record is installed before the first await, so it is what a re-warm meets. Three warms land here before the dial resolves, and each of the last
    // two would open its own connection against an implementation whose guard is the resolved record alone.
    const pending = Promise.withResolvers<TestEspHomeClient>();
    const openClient = makeFakeOpenClient(() => pending.promise);
    const { feed } = makeFeed({ openClient });

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });
    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "one address in flight is one connection, whatever the warm cadence");

    pending.resolve(makeAnsweringClient());

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "and the dial that resolves does not add another");
  });

  test("opens one connection when a governed device's own connect races the warm pass's dial, in either order", async () => {

    /* Two routes reach one address: the warm pass walking the listed addresses, and a governed device's connect delegating to the address that governs it. The guard
     * that makes them one dial lives at the dial's own entry rather than at either caller, so it does not matter which arrives first - and both orders are driven
     * here because a guard at one caller only would pass one of them.
     */
    const assertOneDial = async (delegateFirst: boolean): Promise<void> => {

      const pending = Promise.withResolvers<TestEspHomeClient>();
      const openClient = makeFakeOpenClient((_options, index) => (index === 0) ? pending.promise : Promise.resolve(makeAnsweringClient()));
      const { feed } = makeFeed({ openClient });

      // The device is governed first, so #connectDevice has an address to delegate to.
      feed.startDiscovery();
      feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

      await settle();

      pending.resolve(makeAnsweringClient());

      await settle();

      assert.equal(callsForHost(openClient, ADDR).length, 1, "the device is governed and connected at its listed address");

      // Now hold a redial open and drive both routes into it while it is in flight.
      const second = Promise.withResolvers<TestEspHomeClient>();
      const held = makeFakeOpenClient(() => second.promise);
      const rig = makeFeed({ openClient: held });

      rig.feed.startDiscovery();
      rig.feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

      await settle();

      // A second warm and a discovery event both ask again while the first dial is still open.
      if(delegateFirst) {

        rig.browser().found(makeService(MAC, ADDR_TWO));
        rig.feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });
      } else {

        rig.feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });
        rig.browser().found(makeService(MAC, ADDR_TWO));
      }

      await settle();

      assert.equal(callsForHost(held, ADDR).length, 1,
        "one dial is in flight for that address and the other caller yields to it (delegate-first: " + String(delegateFirst) + ")");

      second.resolve(makeAnsweringClient());

      await settle();

      assert.equal(callsForHost(held, ADDR).length, 1, "and the dial that resolves installs one session without a rival having been opened");
      assert.equal(rig.feed.addresses()[MAC], ADDR, "the device ends on its listed address");
    };

    await assertOneDial(false);
    await assertOneDial(true);
  });

  test("opens one connection when a discovery event reaches a governed device whose redial is still in flight", async () => {

    /* The row that actually reaches the one-dial-per-address guard, which needs a state the simpler races never build: the mac must ALREADY be governed when the
     * second caller arrives, or #onDiscovery remembers it ungoverned and #connectDevice takes the ordinary discovered path to some other address instead of
     * delegating to this one - and then the two callers never meet at the same address at all.
     *
     * So the device is warmed and RESOLVED first, which is what makes it governed. Only then is a redial forced and held open, and a discovery event for that same
     * mac fired into the window. Both routes now want the same address, and the guard at the dial's own entry is the only thing between them and two connections.
     */
    const first = makeAnsweringClient({ isEncrypted: true });
    const held = Promise.withResolvers<TestEspHomeClient>();
    const openClient = makeFakeOpenClient((_options, index) => (index === 0) ? Promise.resolve(first) : held.promise);
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR, "the device is governed by the address before the race starts, which is what makes the delegation possible");

    // A key edit at the governing address forces a redial, and that redial is held unresolved.
    feed.warm({ addresses: [{ address: ADDR, psk: "fresh-key" }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 2, "the redial is in flight");

    // The second caller: a discovery event for the very same mac, which finds it governed and delegates to the address already being dialed.
    announce(browser(), makeService(MAC, ADDR_TWO));

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 2, "the discovery event yields to the dial already in flight rather than opening a second connection");
    assert.equal(callsForHost(openClient, ADDR_TWO).length, 0, "and it does not dial the announced address either, because the device is governed");

    held.resolve(makeAnsweringClient({ isEncrypted: true }));

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 2, "the dial that resolves adds none");
    assert.equal(feed.addresses()[MAC], ADDR, "and the device holds exactly one session, at its listed address");
  });

  test("dials an address again after the user removes it and re-adds it", async () => {

    /* A departure aborts the in-flight dial and drops its record. The aborted connect then classifies as shutdown - and shutdown is a reason no retry gate ever
     * retries, so a dial that wrote that verdict back would leave the address undialable for the life of this process. The distinguishing observation is the dial
     * count after the re-add: an implementation that writes its outcome without re-checking ownership never reaches two.
     */
    const pending = Promise.withResolvers<TestEspHomeClient>();
    const openClient = makeFakeOpenClient((_options, index) => (index === 0) ? pending.promise : Promise.resolve(makeAnsweringClient()));
    const { feed, pushes } = makeFeed({ openClient });

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "the first dial is in flight");

    feed.warm({ addresses: [], devices: [{ mac: MAC }] });

    await settle();

    // The aborted dial settles AFTER the departure, which is the window this row is about.
    pending.resolve(makeAnsweringClient());

    await settle();

    assert.equal(pushes.filter((event) => (event.kind !== "hello") && (event.serialNumber === MAC)).length, 0,
      "the aborted dial installs no session and pushes nothing for a device nobody listed");

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 2, "re-adding the address dials it again rather than finding a dead record in its place");
    assert.equal(feed.addresses()[MAC], ADDR, "and the device is served at it");
  });

  test("leaves an address dialable again when its own open step throws rather than failing", async () => {

    // A throw out of the factory is not an outcome openManualConnection classifies - it is the dial itself coming apart. The finally is what has to release the
    // in-flight guard, and the observation that proves it is the NEXT warm dialing at all.
    const openClient = makeFakeOpenClient(async (_options, index) => {

      if(index === 0) {

        throw new Error("the socket could not be opened");
      }

      return makeAnsweringClient();
    });
    const { feed, pushes } = makeFeed({ openClient });

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "the first dial ran and came apart");

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 2, "the address is dialable again rather than stuck in flight for the panel's life");
    assert.ok(pushes.some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)), "and the retry serves the device");
  });
});

describe("StatusFeed address governance", () => {

  test("keeps a governed session at its listed address when discovery announces another", async () => {

    /* The user naming an address is the user overruling the pick. An advertisement listing some other address for a governed mac is the device saying where else it
     * answers, which is worth remembering and not worth reconnecting for - so the connection count is the assertion that matters.
     */
    const openClient = makeFakeOpenClient(async () => makeAnsweringClient());
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "the governed device connects at its listed address");

    browser().found(makeService(MAC, ADDR_TWO));

    await settle();

    assert.equal(callsForHost(openClient, ADDR_TWO).length, 0, "the announced address is never dialed for a governed device");
    assert.equal(callsForHost(openClient, ADDR).length, 1, "and the session at the listed address is not torn down and reopened");
    assert.deepEqual(feed.addresses(), { [MAC]: ADDR }, "the strip keeps reporting the listed address, which is where the connection is");
  });

  test("leaves exactly one live session, at the listed address, when an address dial and a discovery connect race for one device", async () => {

    /* The two routes to one device can be in flight together, and which resolves first is the network's to decide. Whichever way the race goes the outcome has to be
     * the same: one session, at the address the user named, and every client that lost disposed. Both orders are driven here, and the clients are counted rather
     * than inspected - a stranded connection shows up as a client nobody disposed.
     */
    const assertOneSessionAtTheListedAddress = async (resolveDiscoveryFirst: boolean): Promise<void> => {

      const clients = new Map<string, TestEspHomeClient>();
      const pending = new Map<string, PromiseWithResolvers<TestEspHomeClient>>();
      const openClient = makeFakeOpenClient((options) => {

        const deferred = Promise.withResolvers<TestEspHomeClient>();

        pending.set(options.host, deferred);

        return deferred.promise;
      });
      const { browser, feed } = makeFeed({ openClient });

      feed.startDiscovery();
      browser().found(makeService(MAC, ADDR_TWO));
      feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

      await settle();

      assert.equal(pending.size, 2, "both routes are in flight at once, which is the race this row is about");

      for(const host of resolveDiscoveryFirst ? [ ADDR_TWO, ADDR ] : [ ADDR, ADDR_TWO ]) {

        const client = (host === ADDR) ? makeAnsweringClient() : makeClient({ snapshot: restingCache() });

        clients.set(host, client);
        pending.get(host)?.resolve(client);

        // eslint-disable-next-line no-await-in-loop
        await settle();
      }

      assert.deepEqual(feed.addresses(), { [MAC]: ADDR },
        "the device ends up on the address the user listed (discovery-first: " + String(resolveDiscoveryFirst) + ")");
      assert.equal(clients.get(ADDR_TWO)?.disposeCount, 1, "the connection the discovery route opened is disposed rather than stranded");
      assert.equal(clients.get(ADDR)?.disposeCount, 0, "and the one at the listed address is the live session, so nothing disposed it");
    };

    await assertOneSessionAtTheListedAddress(false);
    await assertOneSessionAtTheListedAddress(true);
  });

  test("settles two addresses reaching one device by list order, in either arrival order", async () => {

    /* Two loops racing over a network resolve in whichever order the network gives, so arrival order would hand the device a different address on every open. The
     * list's own order is the only stable answer, and both arrival orders are driven here against the same list to prove the outcome does not depend on the race.
     */
    const assertFirstListedGoverns = async (resolveSecondFirst: boolean): Promise<void> => {

      const first = Promise.withResolvers<TestEspHomeClient>();
      const second = Promise.withResolvers<TestEspHomeClient>();
      const openClient = makeFakeOpenClient((options) => (options.host === ADDR) ? first.promise : second.promise);
      const { feed } = makeFeed({ openClient });

      feed.warm({ addresses: [ { address: ADDR }, { address: ADDR_TWO } ], devices: [{ mac: MAC }] });

      await settle();

      const [ earlier, later ] = resolveSecondFirst ? [ second, first ] : [ first, second ];

      // Each dial is settled on its own, in the order this arm describes, so the pool sees two resolutions at two separate moments rather than one batch.
      earlier.resolve(makeAnsweringClient());

      await settle();

      later.resolve(makeAnsweringClient());

      await settle();

      assert.deepEqual(feed.addresses(), { [MAC]: ADDR },
        "the address the user listed first governs, whichever dial answered first (second-resolved-first: " + String(resolveSecondFirst) + ")");
    };

    await assertFirstListedGoverns(false);
    await assertFirstListedGoverns(true);
  });

  test("redials an encrypted governed session at its listed address when that address's key changes", async () => {

    /* A governed device's key lives at its address, so an edit there is what moves its connection. The device is encrypted here deliberately: the pool's key diff
     * lets a healthy PLAINTEXT session adopt a new key in place, because such a transport never used it, and that rule is untouched by governance - so a plaintext
     * device would prove nothing about the address the redial dials. The second dial's recorded psk is the observation, because a redial carrying the old key would
     * look identical by count alone.
     */
    const openClient = makeFakeOpenClient(async () => makeAnsweringClient({ isEncrypted: true }));
    const { feed } = makeFeed({ openClient });

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    feed.warm({ addresses: [{ address: ADDR, psk: "fresh-key" }], devices: [{ mac: MAC }] });

    await settle();

    const calls = callsForHost(openClient, ADDR);

    assert.equal(calls.length, 2, "a key edit at the governing address redials the governed session");
    assert.equal(calls[1]?.psk, "fresh-key", "the redial carries the key stored at the address, not the one stored at the mac");
  });

  test("serves a different device that now answers at a listed address under the mac that answered", async () => {

    // An address is a place, and the opener at that place can be swapped. Re-deriving the identity on every dial is what makes the panel follow the hardware rather
    // than the address book. The devices are encrypted so the key edit below actually redials rather than being adopted in place.
    const openClient = makeFakeOpenClient(async (_options, index) => makeAnsweringClient({ isEncrypted: true, mac: (index === 0) ? MAC : MAC_TWO }));
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    feed.warm({ addresses: [{ address: ADDR }], devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    await settle();

    assert.deepEqual(feed.addresses(), { [MAC]: ADDR }, "the first device answers there and takes the address");

    feed.warm({ addresses: [{ address: ADDR, psk: "fresh-key" }], devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    await settle();

    assert.equal(feed.addresses()[MAC_TWO], ADDR, "the device that answers there now is served under its own mac");

    /* The displaced device keeps the fields it last had, because they are still true about it - only WHERE it is has become unknown, and the one thing that can
     * answer that is an advertisement. So the proof that its governance was dropped is that an announcement now moves it, which for a governed device it could not.
     */
    browser().found(makeService(MAC, ADDR_THREE));

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR_THREE, "the device that used to be there is ungoverned again, so its own announcement places it");
  });

  test("pushes the classified error for a governed device whose listed address cannot be reached", async () => {

    /* A governed device's failure has to reach the panel under its own mac, or the row sits on Connecting forever - the address dial is the only thing that could
     * ever have connected it. The following view is what proves the verdict was stored and not merely pushed once.
     */
    const openClient = makeFakeOpenClient(async (_options, index) => {

      if(index === 0) {

        return makeAnsweringClient({ isEncrypted: true });
      }

      throw new (await import("esphome-client")).EncryptionKeyInvalidError("the key was refused");
    });
    const { feed, pushes } = makeFeed({ openClient });

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    const before = pushes.length;

    feed.warm({ addresses: [{ address: ADDR, psk: "wrong-key" }], devices: [{ mac: MAC }] });

    await settle();

    assert.ok(pushes.slice(before).some((event) => (event.kind === "error") && (event.serialNumber === MAC)),
      "the governed device's failure is pushed under its own mac rather than swallowed under the address");

    const afterPush = pushes.length;

    feed.view(MAC);

    assert.ok(pushes.slice(afterPush).some((event) => (event.kind === "error") && (event.serialNumber === MAC)),
      "the verdict is stored too, so reselecting the device re-surfaces it rather than showing Connecting");
  });

  test("governs one address with exactly one mac, releasing any other that still claims it", async () => {

    /* An address governs AT MOST ONE device, and this drives the sequence that can create a second claim. Governance is written whenever a dial resolves; a release
     * keyed to what the address record said BEFORE the dial is silent exactly when the record was absent or failed, which is how two macs come to carry one
     * governing address. The writer sweeps the claims instead, so every route into it is covered.
     *
     * The steps, each a state the pool can actually be in:
     *   1. the address resolves to the first opener, which takes it and a session at it;
     *   2. a key edit redials while that device is unreachable, so the record goes to FAILED;
     *   3. a second opener answers there, and the next warm retries the failed record and resolves to IT.
     *
     * The window this row exists for is the END OF STEP 3, and it is read by what governance DOES rather than by any address projection: the released device is
     * placed by its own announcement, and the holder ignores one. Reading the projection instead would assert nothing, because a released mac keeps its last-known
     * address until something corrects it - so the projection looks identical whether the claim was released or not.
     */
    const first = makeAnsweringClient({ isEncrypted: true });
    const second = makeAnsweringClient({ isEncrypted: true, mac: MAC_TWO });
    const openClient = makeFakeOpenClient(async (options, index) => {

      // The second dial is the key-edit redial of the listed address, and it fails: that device is off the network at that moment.
      if((options.host === ADDR) && (index === 1)) {

        throw new Error("the device did not answer");
      }

      if(options.host !== ADDR) {

        return makeAnsweringClient({ isEncrypted: true });
      }

      // The first dial of the address is the first opener's and the step-3 retry is the second opener's. Any dial after those gets a connection of its own, so the
      // holder's client cannot be handed out a second time and its disposal count answers only for the session the row is watching.
      return (index === 0) ? first : ((index === 2) ? second : makeAnsweringClient({ isEncrypted: true, mac: MAC_TWO }));
    });
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    feed.warm({ addresses: [{ address: ADDR }], devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR, "step 1: the first opener takes the address");

    feed.warm({ addresses: [{ address: ADDR, psk: "second-key" }], devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    await settle();

    // Step 3: the second opener is what answers there now, and the next warm retries the FAILED record and resolves to it - the write with no previous claim in hand.
    announce(browser(), makeService(MAC_TWO, ADDR));
    feed.warm({ addresses: [{ address: ADDR, psk: "second-key" }], devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    await settle();

    assert.equal(feed.addresses()[MAC_TWO], ADDR, "step 3: the second opener now holds the address");

    /* THE WINDOW. Both macs would claim the address without the sweep, and the only way to see a claim is to act on it: an announcement moves an ungoverned device
     * and is ignored by a governed one. The first opener must move - the sweep released it - and the second must not, because it is the holder.
     */
    announce(browser(), makeService(MAC, ADDR_THREE));

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR_THREE,
      "the first opener gave up its claim when the second took the address, so its own announcement places it");

    announce(browser(), makeService(MAC_TWO, ADDR_TWO));

    await settle();

    assert.equal(feed.addresses()[MAC_TWO], ADDR, "while the device that holds the address ignores an announcement naming anywhere else, which only a governed one does");
    assert.equal(second.disposeCount, 0, "and the holder's session at the address is untouched throughout");
  });

  test("keeps a still-listed address governing when the address that yielded to it is removed", async () => {

    /* Two listed addresses reaching one opener: the earlier-listed one governs and the later one yields. BOTH have a resolved record naming that mac, because a
     * record is written when a dial resolves and the governance is decided after it - so a release that acted on "the record names this mac" would strip, on the
     * departure of the yielding address, the governance the address the user KEPT is holding. Releasing only on behalf of the address that actually governs is what
     * makes the two tellable apart.
     *
     * Read, as everywhere else, by what governance does: the device must still ignore an announcement naming somewhere else.
     */
    const openClient = makeFakeOpenClient(async () => makeAnsweringClient());
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    feed.warm({ addresses: [ { address: ADDR }, { address: ADDR_TWO } ], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR, "the earlier-listed address governs, and the later one has yielded to it");

    // The user removes the address that yielded. The one that governs is untouched.
    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    announce(browser(), makeService(MAC, ADDR_THREE));

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR,
      "the device still ignores an announcement naming elsewhere, so the governance the kept address holds survived the other one's removal");
  });

  test("releases a removed address's device even when the address never resolved on its last dial", async () => {

    /* Governance lives in the device record; the address record is a derived view of one dial. A departure that hunted for its claimant IN that record would find
     * nobody to release whenever the last dial of the address ended anywhere but `resolved` - which is a state the user reaches by an ordinary route.
     *
     * The route, built exactly: the device is governed by A and connected there, then a key edit at A tears its session down and delegates its connect back to A;
     * that dial fails, so A's record is `failed` and names no mac. The user then removes A. The device would go on claiming an address the user no longer lists -
     * dialed with no key, deaf to its own advertisements from anywhere else, and never retried, because the retry gate refuses an unlisted address.
     *
     * Read by what governance does: once the claim is gone the device is an ordinary discovered one, so its own announcement places it.
     */
    let answer = true;
    const openClient = makeFakeOpenClient(async () => {

      if(!answer) {

        throw new Error("the device did not answer");
      }

      return makeAnsweringClient({ isEncrypted: true });
    });
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR, "the device is governed by the listed address");

    // The key edit tears the session down and redials, and that dial fails - so the address record ends as FAILED, carrying no mac at all.
    answer = false;
    feed.warm({ addresses: [{ address: ADDR, psk: "fresh-key" }], devices: [{ mac: MAC }] });

    await settle();

    // The user removes the address.
    feed.warm({ addresses: [], devices: [{ mac: MAC }] });

    await settle();

    announce(browser(), makeService(MAC, ADDR_THREE));

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR_THREE,
      "the removed address released the device it governed, so the device's own advertisement places it again");
  });

  test("leaves a live session alone when a delegated dial of another address fails", async () => {

    /* A failure is only ever about the connection that produced it, and this drives the one interleaving where that matters. Two listed addresses reach one opener.
     * While the governing address is failing, the other one resolves and becomes the device's session - so by the time the failure is handled the device is
     * connected, and the failure describes a connection nobody is using. It must not close that session, must not replace it, and must not tell the panel the
     * device is unreachable while it plainly is not.
     *
     * The interleaving, built exactly: the device is governed by A and connected there; then a warm lists B AHEAD of A and edits A's key. The address pass dials B
     * (no record yet) while the device's own connect, whose session the key edit just tore down, delegates to A - so both are in flight at once. B answers and takes
     * the device by list order, installing its session. A then fails, and its failure arrives at a device that is already connected somewhere else.
     */
    const governed = makeAnsweringClient({ isEncrypted: true });
    const bClient = makeAnsweringClient({ isEncrypted: true });
    const failing = Promise.withResolvers<TestEspHomeClient>();
    let dialsOfA = 0;
    const openClient = makeFakeOpenClient((options) => {

      if(options.host === ADDR_TWO) {

        return Promise.resolve(bClient);
      }

      // The first dial of A is what governs the device. Every later one is the failing dial this row is about.
      return (dialsOfA++ === 0) ? Promise.resolve(governed) : failing.promise;
    });
    const { feed, pushes } = makeFeed({ openClient });

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR, "the device is governed by A and connected there");
    assert.equal(governed.disposeCount, 0, "on a live session");

    const before = pushes.length;

    // B is listed AHEAD of A, and A's key is edited - which tears the device's session down and delegates its connect to A while the address pass dials B.
    feed.warm({ addresses: [ { address: ADDR_TWO }, { address: ADDR, psk: "fresh-key" } ], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR_TWO, "B answered and took the device by list order, installing its own session");
    assert.equal(bClient.disposeCount, 0, "which is live");

    // Only now does A's dial fail, arriving at a device that is connected at B.
    failing.reject(new Error("the device did not answer"));

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR_TWO, "the device is still at B");
    assert.equal(bClient.disposeCount, 0, "its session at B was not closed by a failure belonging to a connection nobody is using");
    assert.ok(!pushes.slice(before).some((event) => (event.kind === "error") && (event.serialNumber === MAC)),
      "and the panel is told nothing about a device that is plainly connected");
  });

  test("leaves no connection open when a different opener answers at a listed address", async () => {

    /* The disposal accounting across a displacement. The device that used to answer here loses its governance, and every client the
     * two dials opened is accounted for: the one that lost is closed and the one serving the device is not.
     *
     * The displaced device does NOT also need a session torn down here, and the implementation deliberately does not try. A displaced mac's session at the address
     * could only have come from a dial of that address resolving to it, and such a dial leaves the address recorded as resolved to that mac; while that stands, no
     * second dial of the address can begin - the warm pass refuses to redial a resolved address, and the only unguarded route in is a connect delegating on behalf
     * of the mac that holds the address, which runs only for a mac holding no session at all. So a displaced device is never still connected at the address at the
     * moment the dial that displaces it resolves.
     */
    const displaced = makeAnsweringClient({ isEncrypted: true });
    const arrival = makeAnsweringClient({ isEncrypted: true, mac: MAC_TWO });
    const openClient = makeFakeOpenClient(async (_options, index) => (index === 0) ? displaced : arrival);
    const { browser, feed } = makeFeed({ openClient });

    feed.startDiscovery();
    feed.warm({ addresses: [{ address: ADDR }], devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR, "the first device holds the address");

    // A key edit at the address redials it, and a different opener answers this time.
    feed.warm({ addresses: [{ address: ADDR, psk: "fresh-key" }], devices: [ { mac: MAC }, { mac: MAC_TWO } ] });

    await settle();

    assert.equal(feed.addresses()[MAC_TWO], ADDR, "the device that answers there now holds the address");
    assert.equal(displaced.disposeCount, 1, "the displaced device's connection is closed exactly once, not left open against hardware that is not it");
    assert.equal(arrival.disposeCount, 0, "and the connection serving the device that answered is the live one");

    // The displaced device is ungoverned again, which its own announcement then proves by placing it.
    browser().found(makeService(MAC, ADDR_THREE));

    await settle();

    assert.equal(feed.addresses()[MAC], ADDR_THREE, "the displaced device is ungoverned, so its own advertisement places it");
  });

  test("aborts a departed address's dial in flight and releases the device it governed", async () => {

    const pending = Promise.withResolvers<TestEspHomeClient>();
    const openClient = makeFakeOpenClient(() => pending.promise);
    const { feed } = makeFeed({ openClient });

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    const dial = callsForHost(openClient, ADDR)[0];

    assert.ok(dial, "the dial is in flight");
    assert.equal(dial.signal.aborted, false, "and has not been cancelled yet");

    feed.warm({ addresses: [], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(dial.signal.aborted, true, "an address the user removed has its dial cancelled rather than left running");
  });

  test("writes nothing and pushes nothing when a connect comes apart after the feed has been disposed", async () => {

    /* Disposal is the end of the pool: it clears every session and every stored verdict, and a connect still unwinding when it happens has nobody left to tell.
     * Reaching that state takes a precise interleaving. A fault arriving on the connect's own await says nothing at all, because disposal aborts that session's
     * controller and openConnection classifies any fault under an aborted signal as a silent shutdown - so the only way into the failure recorder with an emptied
     * slot is a fault raised AFTER a successful open, past the check that stands the connect down when its session has been replaced. The hook is the entity list,
     * which one connect reads TWICE: once inside the connect itself, to capture initial state, and once inside the adopt that follows that check, to build the
     * row model.
     *
     * So this client disposes the feed on that second read. The adopt's very next act is to put the client onto the session's disposable stack, which disposal has
     * just closed, so it faults there and the failure recorder is reached with the session slot emptied by disposal rather than superseded by a successor. A
     * recorder that read "no session" as "this failure still applies" would write a verdict into the cleared memory and push an error at a panel that is gone.
     */
    const { browser, feed, pushes } = makeFeed({ openClient: makeFakeOpenClient(async () => client) });
    const client = makeClient({ snapshot: restingCache() });
    let reads = 0;

    Object.defineProperty(client, "entitiesByDevice", { value: () => {

      if(++reads === 2) {

        feed[Symbol.dispose]();
      }

      return ADVERTISED;
    } });

    feed.startDiscovery();
    browser().found(makeService(MAC));

    await settle();

    const after = pushes.length;

    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    assert.equal(reads, 2, "the connect got past its ownership check and into the adopt, which is the window this row is about");
    assert.ok(!pushes.slice(after).some((event) => (event.kind === "error")),
      "a connect that comes apart after disposal pushes nothing, because the panel it would push to is gone with the pool");

    feed.view(MAC);

    assert.ok(!pushes.slice(after).some((event) => (event.kind === "error")),
      "and it stored no verdict, so a later view surfaces none rather than an error from a pool that no longer exists");
  });

  test("aborts every in-flight address dial on disposal", async () => {

    const openClient = makeFakeOpenClient(() => Promise.withResolvers<TestEspHomeClient>().promise);
    const { feed } = makeFeed({ openClient });

    feed.warm({ addresses: [ { address: ADDR }, { address: ADDR_TWO } ], devices: [{ mac: MAC }] });

    await settle();

    const dials = [ callsForHost(openClient, ADDR)[0], callsForHost(openClient, ADDR_TWO)[0] ];

    assert.ok(dials.every((call) => call && !call.signal.aborted), "both dials are in flight");

    feed[Symbol.dispose]();

    assert.ok(dials.every((call) => call?.signal.aborted), "disposal ends every address dial, not only the sessions");
  });
});

describe("StatusFeed address outcomes", () => {

  test("repeats a refused key only once the key has changed", async () => {

    const openClient = makeFakeOpenClient(async (_options, index) => {

      if(index < 2) {

        throw new (await import("esphome-client")).EncryptionKeyInvalidError("the key was refused");
      }

      return makeAnsweringClient();
    });
    const { feed } = makeFeed({ openClient });

    feed.warm({ addresses: [{ address: ADDR, psk: "wrong" }], devices: [] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "the first dial runs");

    feed.warm({ addresses: [{ address: ADDR, psk: "wrong" }], devices: [] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "re-sending the very key the device just refused is churn, so it is suppressed");

    feed.warm({ addresses: [{ address: ADDR, psk: "right" }], devices: [] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 2, "a changed key is a genuine retry and dials again");
  });

  test("never repeats an address that answered with something this plugin cannot use", async () => {

    // Neither verdict changes without someone acting on the device or the configuration, so retrying either one at warm cadence would dial a device forever for
    // nothing. The two arms run the same assertion, because the rule is one rule.
    const assertNoRepeat = async (client: TestEspHomeClient | Error): Promise<void> => {

      const openClient = makeFakeOpenClient(async () => {

        if(client instanceof Error) {

          throw client;
        }

        return client;
      });
      const { feed } = makeFeed({ openClient });

      feed.warm({ addresses: [{ address: ADDR }], devices: [] });

      await settle();
      feed.warm({ addresses: [{ address: ADDR }], devices: [] });

      await settle();

      assert.equal(callsForHost(openClient, ADDR).length, 1, "the address is dialed once and not again");
    };

    // A device that answers and names nothing is not an opener we support, and an API version the client cannot speak needs a firmware or plugin update.
    await assertNoRepeat(makeClient({ deviceInfo: null, snapshot: restingCache() }));
    await assertNoRepeat(new (await import("esphome-client")).NegotiationFailedError("api major out of range", "API_MAJOR_OUT_OF_RANGE"));
  });

  test("repeats a timed-out address at the next warm and at a view of a mac it has never placed", async () => {

    /* A device reached only by address has no advertisement whose re-arrival could retry it, so the two triggers that exist are the next warm and the user
     * reselecting a device the pool cannot place. Both are driven here against one feed.
     */
    const openClient = makeFakeOpenClient(async () => {

      throw new Error("the device did not answer");
    });
    const { feed } = makeFeed({ openClient });

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 1, "the first dial runs");

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 2, "an unreachable address is worth trying again, so the next warm dials it");

    feed.view(MAC);

    await settle();

    assert.equal(callsForHost(openClient, ADDR).length, 3, "and selecting a device the pool cannot place asks every listed address again");
  });
});

describe("StatusFeed probe", () => {

  test("answers the identity of the device that responded, and closes the connection it opened", async () => {

    const client = makeAnsweringClient({ isEncrypted: true });
    const openClient = makeFakeOpenClient(async () => client);
    const { feed } = makeFeed({ openClient });

    const result = await feed.probe({ address: ADDR });

    assert.deepEqual(result, { address: ADDR, encrypted: true, firmwareVersion: "2.0.0", kind: "ok", mac: MAC, model: "1.0.0", name: "Test Ratgdo",
      variant: RatgdoVariant.RATGDO }, "the card is handed everything it renders about the device, read off the record the handshake produced");
    assert.equal(client.disposeCount, 1, "a probe always closes the connection it opened - the card only needed to know what answered");
  });

  test("closes its connection even when something throws after the connect succeeded", async () => {

    /* The doc promises this ALWAYS closes, and a dispose written inline after the connect keeps that promise only for the paths that reach it. The client here throws
     * from the transport read the probe makes between the connect and the dispose, which is exactly the window an inline dispose leaves open - and an open connection
     * against a real device that nothing holds a reference to is the worst shape this method could leave behind.
     */
    const client = makeAnsweringClient();

    Object.defineProperty(client, "isEncrypted", { get: () => {

      throw new Error("the transport read came apart");
    } });

    const { entries, feed } = makeFeed({ openClient: makeFakeOpenClient(async () => client) });
    const result = await feed.probe({ address: ADDR });

    assert.deepEqual(result, { kind: "error", reason: "unreachable" }, "the card is still answered rather than left waiting");
    assert.equal(client.disposeCount, 1, "and the connection the probe opened is closed exactly once, by the finally rather than by the line that threw");
    assert.ok(entries.some((entry) => (entry.level === "error") && formatLogEntry(entry).startsWith(ADDR + ": The connection test failed unexpectedly.")),
      "with the fault reported under the address");
  });

  test("classifies each failure the way the panel already classifies it, and still closes the connection", async () => {

    /* One row over the whole taxonomy, because the probe's whole contribution here is that it does NOT invent a second vocabulary. The unrecognized arm is the one
     * verdict only an address dial can reach, and it is the reason misconfigured exists on this wire at all.
     */
    const esphome = await import("esphome-client");
    const rows: { expected: string; open: () => Promise<TestEspHomeClient> }[] = [

      { expected: "auth-invalid", open: async () => {

        throw new esphome.EncryptionKeyInvalidError("the key does not match");
      } },
      { expected: "auth-missing", open: async () => {

        throw new esphome.EncryptionKeyMissingError("this device requires a key");
      } },
      { expected: "misconfigured", open: async () => makeClient({ deviceInfo: null, snapshot: restingCache() }) },
      { expected: "unreachable", open: async () => {

        throw new Error("connection refused");
      } },
      { expected: "unsupported", open: async () => {

        throw new esphome.NegotiationFailedError("api major out of range", "API_MAJOR_OUT_OF_RANGE");
      } }
    ];

    for(const row of rows) {

      const openClient = makeFakeOpenClient(row.open);
      const { feed } = makeFeed({ openClient });

      // eslint-disable-next-line no-await-in-loop
      const result = await feed.probe({ address: ADDR });

      assert.deepEqual(result, { kind: "error", reason: row.expected }, "the probe answers " + row.expected + " exactly as a pool connect would classify it");
    }
  });

  test("closes the connection of a device that answered as something this plugin cannot use", async () => {

    // The refusal arm is the one success-shaped failure - the handshake completed and a client exists - so it is the arm where a missing dispose would strand a real
    // connection against a real device.
    const client = makeClient({ deviceInfo: null, snapshot: restingCache() });
    const { feed } = makeFeed({ openClient: makeFakeOpenClient(async () => client) });

    await feed.probe({ address: ADDR });

    assert.equal(client.disposeCount, 1, "the connection to a device that is not an opener is closed rather than left open");
  });

  test("gives up on the injected clock's deadline, says so at debug, and closes the connection", async () => {

    /* The deadline is armed on the feed's own clock, so this drives it without waiting. The distinguishing observation is the REASON: an abort is classified
     * shutdown by the connect layer whoever caused it, so an implementation that did not read its own sentinel back would answer unreachable here.
     */
    const client = makeAnsweringClient();
    const openClient = makeFakeOpenClient((options) => new Promise<TestEspHomeClient>((_resolve, reject) => {

      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const { clock, entries, feed } = makeFeed({ openClient });
    const probe = feed.probe({ address: ADDR });

    await settle();

    clock.advance(RATGDO_WEBUI_PROBE_TIMEOUT * 1000);

    assert.deepEqual(await probe, { kind: "error", reason: "timeout" }, "the probe's own deadline is a timeout, not a generic unreachable");
    assert.ok(entries.some((entry) => (entry.level === "debug") && formatLogEntry(entry).startsWith(ADDR + ": The device did not answer within")),
      "the deadline says so under the address, at debug - it is a diagnostic rather than something the user must act on");
    assert.equal(client.disposeCount, 0, "no connection was ever opened, so there was none to close");
  });

  test("answers unreachable when the pool's own lifetime ends the probe, and disposal aborts it", async () => {

    // The other abort. The card is being torn down with the modal, so the wording matters less than that it resolves at all rather than hanging or throwing.
    const openClient = makeFakeOpenClient((options) => new Promise<TestEspHomeClient>((_resolve, reject) => {

      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const { feed } = makeFeed({ openClient });
    const probe = feed.probe({ address: ADDR });

    await settle();

    feed[Symbol.dispose]();

    assert.deepEqual(await probe, { kind: "error", reason: "unreachable" }, "the pool's lifetime ending resolves the probe rather than leaving the card waiting");
  });

  test("leaves a live session and its pushes completely alone", async () => {

    /* Risk 7's second half. The probe opens a SECOND connection to the very device the pool is already holding a session for, which is deliberate - a probe is one
     * short user act, and making it coordinate with the pool would make the card's answer depend on state the user cannot see. What it must not do is disturb
     * anything: the session's client is untouched, its token does not move, and no push is emitted on the probe's behalf.
     */
    const session = makeAnsweringClient();
    const probed = makeAnsweringClient();
    const openClient = makeFakeOpenClient(async (_options, index) => (index === 0) ? session : probed);
    const { browser, feed, pushes } = makeFeed({ openClient });

    feed.startDiscovery();
    browser().found(makeService(MAC));
    feed.warm({ devices: [{ mac: MAC }] });

    await settle();

    const before = pushes.length;
    const token = pushes.filter((event) => (event.kind !== "hello") && (event.serialNumber === MAC)).at(-1);

    assert.ok(token, "the device has a live session that has pushed");

    const result = await feed.probe({ address: ADDR });

    assert.equal(result.kind, "ok", "the probe answers on its own connection");
    assert.equal(pushes.length, before, "a probe pushes nothing - the panel is not told about a connection it does not own");
    assert.equal(session.disposeCount, 0, "the live session's client is untouched");
    assert.equal(probed.disposeCount, 1, "and the probe's own client is closed");

    // The session still works afterward, which is what proves the probe did not quietly supersede it.
    feed.view(MAC);

    assert.ok(pushes.slice(before).some((event) => (event.kind === "snapshot") && (event.serialNumber === MAC)),
      "the session still answers a view, so the probe neither replaced nor retired it");
  });

  test("never disturbs an address dial that is in flight", async () => {

    // The one piece of pool state a probe could plausibly corrupt: an address record another dial owns. A probe that resolved it underneath would leave that dial
    // writing against a record it no longer recognizes.
    const pending = Promise.withResolvers<TestEspHomeClient>();
    const openClient = makeFakeOpenClient((_options, index) => (index === 0) ? pending.promise : Promise.resolve(makeAnsweringClient()));
    const { feed } = makeFeed({ openClient });

    feed.warm({ addresses: [{ address: ADDR }], devices: [{ mac: MAC }] });

    await settle();

    const result = await feed.probe({ address: ADDR });

    assert.equal(result.kind, "ok", "the probe answers even while a pool dial of the same address is in flight");

    pending.resolve(makeAnsweringClient());

    await settle();

    assert.deepEqual(feed.addresses(), { [MAC]: ADDR }, "the pool dial still resolves its own address record and installs the session it was opening");
  });

  test("never throws, whatever comes apart underneath it", async () => {

    const openClient = makeFakeOpenClient(() => {

      throw new Error("the factory came apart");
    });
    const { entries, feed } = makeFeed({ openClient });

    assert.deepEqual(await feed.probe({ address: ADDR }), { kind: "error", reason: "unreachable" },
      "the card is rendering this answer, so a fault below resolves as a verdict rather than rejecting");
    assert.ok(entries.length >= 0, "and whatever was logged about it stays a diagnostic");
  });
});

describe("narrowStatusProbeRequest", () => {

  test("accepts one non-empty address, lower-cased exactly as a warm lower-cases one", () => {

    assert.deepEqual(narrowStatusProbeRequest({ address: "Garage.Local" }), { address: "garage.local", psk: undefined },
      "the address is canonicalized here, so a probe and a warm of the same address agree about what it is called");
    assert.deepEqual(narrowStatusProbeRequest({ address: ADDR, psk: "secret" }), { address: ADDR, psk: "secret" }, "a non-empty key is carried through");
  });

  test("narrows every spelling of an absent key to undefined", () => {

    for(const psk of [ undefined, null, "", 42 ]) {

      assert.deepEqual(narrowStatusProbeRequest({ address: ADDR, psk }), { address: ADDR, psk: undefined },
        "a key of " + JSON.stringify(psk) + " is the user having typed none");
    }
  });

  test("canonicalizes its address through the same rule the warm narrowing uses, and refuses a zone", () => {

    /* The probe and the warm have to agree about what one address is called, or a probe's resolved record is read by the next warm's dial under a different key. The
     * rows below are asserted against canonicalManualAddress itself rather than against written-out strings, which is what makes them fail if either side drifts.
     */
    for(const address of [ "[2001:DB8::5]", "  Garage.Local  ", "10.0.0.20" ]) {

      assert.deepEqual(narrowStatusProbeRequest({ address }), { address: canonicalManualAddress(address), psk: undefined },
        "the probe narrowing answers the canonical form for " + JSON.stringify(address));
      assert.deepEqual(narrowStatusProbeRequest({ address })?.address, narrowStatusWarmRequest({ addresses: [{ address }], devices: [] })?.addresses[0]?.address,
        "and it is the very form the warm narrowing answers for the same input");
    }

    for(const address of [ "fe80::1%en0", "[fe80::1%en0]" ]) {

      assert.equal(narrowStatusProbeRequest({ address }), null, JSON.stringify(address) + " names a zone, which nothing can dial, so the probe is refused outright");
    }

    assert.equal(narrowStatusProbeRequest({ address: "[]" }), null, "an address that canonicalizes to nothing is refused too");
  });

  test("rejects a body carrying no usable address", () => {

    for(const body of [ null, "nope", 42, {}, { address: "" }, { address: 42 }, { psk: "secret" } ]) {

      assert.equal(narrowStatusProbeRequest(body), null, "a body of " + JSON.stringify(body) + " names no address to test");
    }
  });
});
