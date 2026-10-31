/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Self-test for the shared test harness in testing.helpers.ts.
 *
 * The harness is the foundation every other unit test builds on - the platform / ESPHome / MQTT doubles over the shared Homebridge test double, the telemetry
 * factories, and the buildRatgdoAccessory workhorse. A bug here would cascade into misleading pass/fail signals across the whole suite, so this file locks in the
 * harness's own contract: the guarantees the production accessory and its tests depend on (on/emit/dispose drive and detach; the telemetry factories key the snapshot
 * the way the device reads it; makeTestPlatform wires the kit's API and a REAL FeatureOptions engine; buildRatgdoAccessory constructs on Homebridge's own
 * PlatformAccessory, bridged before construction). It exercises the harness directly rather than through a production accessory.
 */
import { ConnectionError, CoverOperation, EncryptionKeyMissingError, EncryptionRequiredError, LockState, NegotiationFailedError, entityId,
  isConnectionLive } from "esphome-client";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import { Service, TestEspHomeClient, asEspHomeClient, buildRatgdoAccessory, makeBinarySensorEvent, makeCoverEvent, makeFakeOpenClient, makeKonnectedInitialState,
  makeLightEvent, makeLockEvent, makeRatgdoInitialState, makeRatgdoService, makeScriptedOpenClient, makeSwitchEvent, makeTelemetry, makeTestDevice, makeTestPlatform,
  openThroughHello, resolverOf } from "./testing.helpers.ts";
import { TestHomebridgeApi, TestMqttClient, logCount, loggedAt, settle } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import type { LifecycleEvent } from "esphome-client";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";
import { txtEntries } from "homebridge-plugin-utils";

/* The telemetry-event fields these tests assert on. The factories return a TelemetryEvent (a schema-derived union with all-optional value fields); we view one as this
 * narrow declared-property shape at the test boundary so the assertions read fields by dot access without tripping noPropertyAccessFromIndexSignature, and without an
 * `any` cast - the same construction-boundary viewing esphome-client's own tests use when synthesizing wire events.
 */
interface EventFields {

  currentOperation?: number;
  entity?: string;
  key?: number;
  position?: number;
  state?: unknown;
  type?: string;
}

const eventFields = (value: unknown): EventFields => value as EventFields;

describe("TestEspHomeClient", () => {

  test("command records the resolved id and payload", () => {

    const client = new TestEspHomeClient();

    client.command("cover-door", { position: 1 });

    assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 1 } }], "command records the dispatched id and payload for assertion");
  });

  test("the configurable reads return their seeded values", () => {

    const snapshot = makeRatgdoInitialState();
    const client = new TestEspHomeClient({ capabilities: { encryption: { active: true } }, deviceInfo: { projectVersion: "9.9.9" },
      entities: [{ objectId: "door", type: "cover" }], snapshot });

    assert.equal(client.capabilities().encryption.active, true, "capabilities reflects the seeded value");
    assert.equal(client.deviceInfo()?.projectVersion, "9.9.9", "deviceInfo reflects the seeded value");
    assert.deepEqual(client.entitiesByDevice(), [{ objectId: "door", type: "cover" }], "entitiesByDevice reflects the seeded list");

    // The client copies the seed into a mutable cache (so deliverState can mutate it without touching the caller's map), so snapshot() reflects the seed's CONTENTS
    // rather than returning the same reference.
    assert.deepEqual(client.snapshot(), snapshot, "snapshot reflects the seeded map's contents");
    assert.notEqual(client.snapshot(), snapshot, "the cache is a copy of the seed, not the seed itself, so a delivered state never mutates the caller's map");
  });

  test("deviceInfo returns null when no record is seeded", () => {

    const client = new TestEspHomeClient();

    assert.equal(client.deviceInfo(), null, "deviceInfo reflects the absence of a seeded record");
  });

  test("disconnect and subscribeToLogs record their calls", () => {

    const client = new TestEspHomeClient();

    client.subscribeToLogs(5);
    client.disconnect();

    assert.equal(client.disconnected, true, "disconnect records the manual teardown");
    assert.deepEqual(client.logSubscriptions, [5], "subscribeToLogs records the requested level");
  });

  test("on registers a handler that emit drives, and the Disposable detaches it", () => {

    const client = new TestEspHomeClient();
    const seen = [];
    const subscription = client.on("telemetry", (event) => {

      seen.push(event);
    });

    client.emit("telemetry", makeCoverEvent("door", 1));
    subscription[Symbol.dispose]();
    client.emit("telemetry", makeCoverEvent("door", 0));

    assert.equal(seen.length, 1, "the handler fires for events emitted while subscribed but not after disposal");
  });

  test("emit drives every handler registered for the event", () => {

    const client = new TestEspHomeClient();
    let count = 0;

    client.on("lifecycle", () => {

      count++;
    });
    client.on("lifecycle", () => {

      count++;
    });

    client.emit("lifecycle", { encrypted: false, kind: "connect" });

    assert.equal(count, 2, "all handlers registered for an event are driven");
  });

  test("deliverState commits the event to the cache BEFORE notifying telemetry listeners (cache-then-notify)", () => {

    const client = new TestEspHomeClient();
    const observedInCache: boolean[] = [];

    client.on("telemetry", () => {

      observedInCache.push(client.snapshot().has(entityId("cover", "door")));
    });
    client.deliverState(makeCoverEvent("door", 1));

    assert.equal(observedInCache[0], true, "the entity is present in the snapshot when the handler fires - the guarantee captureInitialState's slow path depends on");
    assert.ok(client.snapshot().has(entityId("cover", "door")), "deliverState keys the event into the snapshot by entityId(type, objectId)");
  });

  test("the seed snapshot is copied, so deliverState does not mutate the caller's map", () => {

    const seed = new Map();
    const client = new TestEspHomeClient({ snapshot: seed });

    client.deliverState(makeCoverEvent("door", 1));

    assert.equal(seed.size, 0, "the client copies the seed snapshot, so mutating its cache leaves the caller's passed-in map untouched");
    assert.equal(client.snapshot().size, 1, "the client's own cache reflects the delivered state");
  });

  test("[Symbol.dispose] counts the disposal openConnection performs on a failed open", () => {

    const client = new TestEspHomeClient();

    assert.equal(client.disposeCount, 0, "a fresh client is not disposed");
    client[Symbol.dispose]();
    assert.equal(client.disposeCount, 1, "[Symbol.dispose] counts the teardown openConnection's catch performs via client?.[Symbol.dispose]()");
    client[Symbol.dispose]();
    assert.equal(client.disposeCount, 2, "a counter tells a second disposal apart from the first, where a boolean would read the same either way");
  });

  test("[Symbol.dispose] emits a disconnect synchronously to a listener still registered", () => {

    const client = new TestEspHomeClient();
    const seen: LifecycleEvent[] = [];
    const subscription = client.on("lifecycle", (event: LifecycleEvent) => {

      seen.push(event);
    });

    client[Symbol.dispose]();

    assert.deepEqual(seen, [{ cause: undefined, kind: "disconnect" }],
      "disposal emits the disconnect member through the handler map, so a teardown-ordering test observes it without awaiting a turn");

    // A listener released before the client goes down hears nothing, which is the other half of the ordering guarantee the feed's teardown test rests on.
    subscription[Symbol.dispose]();
    client[Symbol.dispose]();

    assert.equal(seen.length, 1, "a listener released before the disposal hears no disconnect");
  });

  test("health reads a live session by default, follows the lifecycle connect and disconnect emit drives, and answers the live field a test sets", () => {

    const client = new TestEspHomeClient({ isEncrypted: true });

    assert.equal(isConnectionLive(client.health()), true, "a client the open factory returned holds a live session");
    assert.equal(client.health().encrypted, true, "the live record carries the seeded encryption state");

    client.emit("lifecycle", { kind: "disconnect" });

    assert.equal(isConnectionLive(client.health()), false, "a disconnect leaves the client between sessions");

    client.emit("lifecycle", { cause: new ConnectionError("The reconnect attempt failed.", "CONNECT_FAILED"), kind: "lost" });

    assert.equal(isConnectionLive(client.health()), false, "a lost verdict is no session boundary, so the client stays between sessions");

    client.emit("lifecycle", { encrypted: true, kind: "connect" });

    assert.equal(isConnectionLive(client.health()), true, "a connect begins a live session again");

    client.live = false;

    assert.equal(isConnectionLive(client.health()), false, "a test models a client between sessions that has announced nothing by setting the field");
    assert.equal(client.health().encrypted, false, "the down record is the library's disconnected baseline, never on an encrypted wire");

    client.live = true;
    client[Symbol.dispose]();

    assert.equal(isConnectionLive(client.health()), false, "disposal's disconnect goes through emit, so it ends the session too");
  });

  test("isEncrypted reads false by default and reflects the seeded value", () => {

    assert.equal(new TestEspHomeClient().isEncrypted, false, "an unseeded client mirrors a plaintext session");
    assert.equal(new TestEspHomeClient({ isEncrypted: true }).isEncrypted, true, "the seeded encryption state is what the getter reports");
  });

  test("onListen fires synchronously inside on(), receiving the event name and the client", () => {

    const calls: [ string, boolean ][] = [];
    const client: TestEspHomeClient = new TestEspHomeClient({ onListen: (event, listened) => calls.push([ event, listened === client ]) });

    client.on("telemetry", () => { /* The handler is beside the point here...the hook's timing is the subject. */ });

    assert.equal(calls.length, 1, "the hook runs inside on() rather than on a later turn, which is the window a real client can emit into");
    assert.deepEqual(calls, [[ "telemetry", true ]], "the hook receives the event name it was registered for and the client that registered it");
  });

  test("throwOnListen makes on() throw and registers nothing", () => {

    const client = new TestEspHomeClient({ throwOnListen: true });

    assert.throws(() => client.on("lifecycle", () => { /* Never registered: the throw precedes registration. */ }), /listener registration failed/u);

    // Nothing was recorded, so a later emit reaches no handler - the state a consumer's totality catch has to cope with.
    client.emit("lifecycle", { encrypted: false, kind: "connect" });

    assert.deepEqual(client.listenerDisposals, [], "a registration that threw leaves no listener to release");
  });

  test("listenerDisposals records each listener's event name when its Disposable runs", () => {

    const client = new TestEspHomeClient();
    const lifecycle = client.on("lifecycle", () => { /* Registered only so its Disposable can be run below. */ });
    const telemetry = client.on("telemetry", () => { /* Likewise. */ });

    assert.deepEqual(client.listenerDisposals, [], "registration alone records no disposal");

    telemetry[Symbol.dispose]();
    lifecycle[Symbol.dispose]();

    assert.deepEqual(client.listenerDisposals, [ "telemetry", "lifecycle" ], "each Disposable records its own event name, in the order the releases ran");
  });
});

describe("asEspHomeClient and makeFakeOpenClient", () => {

  test("asEspHomeClient is an identity cast - it changes the static type, not the object", () => {

    const client = new TestEspHomeClient();

    assert.equal(asEspHomeClient(client), client, "the boundary cast returns the same instance, viewed as the production EspHomeClient type");
  });

  test("makeFakeOpenClient resolves the supplied client, modeling a successful open", async () => {

    const client = new TestEspHomeClient();
    const open = makeFakeOpenClient(client);

    assert.equal(await open({ host: "192.0.2.10" }), client, "a TestEspHomeClient result resolves through the factory, mirroring openEspHomeClient's success path");
  });

  test("makeFakeOpenClient rejects with the supplied error, modeling a failed open", async () => {

    const failure = new Error("connection refused");
    const open = makeFakeOpenClient(failure);

    await assert.rejects(() => open({ host: "192.0.2.10" }), (error) => error === failure);
  });

  test("makeFakeOpenClient records the options each invocation received", async () => {

    const open = makeFakeOpenClient(new TestEspHomeClient());
    const resolver = (): string => "k";

    await open({ host: "192.0.2.10", psk: resolver });

    assert.equal(open.calls.length, 1, "every invocation is recorded");
    assert.equal(open.calls[0]?.host, "192.0.2.10", "the recorded options carry the host openConnection forwards");
    assert.equal(open.calls[0].psk, resolver, "the recorded options carry the key resolver, so a test can read what the connection core handed the client");
  });

  test("resolverOf answers the resolver a recorded invocation carried, and refuses one that carried none", async () => {

    const open = makeFakeOpenClient(new TestEspHomeClient());
    const resolver = (): string => "k";

    await open({ host: "192.0.2.10", psk: resolver });
    await open({ host: "192.0.2.11", psk: null });

    assert.equal(resolverOf(open.calls[0]), resolver, "the resolver the invocation carried is the one answered");

    // An invocation opened with no resolver fails at the read, rather than at a later call of null, and so does an invocation that never happened.
    assert.throws(() => resolverOf(open.calls[1]), /carried no key resolver/);
    assert.throws(() => resolverOf(undefined), /carried no key resolver/);
  });

  test("openThroughHello settles the way the client settles on what the resolver did with the hello", async (t) => {

    const client = new TestEspHomeClient();
    const hello = { macAddress: "AA:BB:CC:DD:EE:FF" };
    const heard: unknown[] = [];

    const keyed = makeFakeOpenClient(openThroughHello({ client, hello }));

    assert.equal(await keyed({ host: "192.0.2.10", psk: (announced) => {

      heard.push(announced);

      return "k";
    } }), client, "a resolver answering a key resolves the client");
    assert.deepEqual(heard, [hello], "and the resolver was handed the hello the device announced");

    const refusal = new NegotiationFailedError("refused", "API_MAJOR_OUT_OF_RANGE");

    await assert.rejects(() => makeFakeOpenClient(openThroughHello({ client, hello }))({ host: "192.0.2.10", psk: () => {

      throw refusal;
    } }), (error) => error === refusal);

    const fault = new Error("the resolver came apart");

    await assert.rejects(() => makeFakeOpenClient(openThroughHello({ client, hello }))({ host: "192.0.2.10", psk: () => {

      throw fault;
    } }), (error: unknown) => {

      assert.ok(error instanceof ConnectionError, "any other exception rejects as a connection failure, as the library wraps one");
      assert.equal(error.code, "CONNECT_FAILED", "under the connect-failed code");
      assert.equal(error.cause, fault, "carrying the exception as its cause");

      return true;
    });

    for(const answer of [ null, "" ]) {

      // A subtest per answer names the answer in a failure report, and the sequential await keeps each rejection attributable to the answer that caused it.
      // eslint-disable-next-line no-await-in-loop
      await t.test("a resolver answering " + JSON.stringify(answer) + " fails as a missing key", async () => {

        await assert.rejects(() => makeFakeOpenClient(openThroughHello({ client, hello }))({ host: "192.0.2.10", psk: () => answer }), EncryptionKeyMissingError);
      });
    }

    // An invocation carrying no resolver fails the way an encrypted device answers a plaintext client.
    await assert.rejects(() => makeFakeOpenClient(openThroughHello({ client, hello }))({ host: "192.0.2.10", psk: null }), EncryptionRequiredError);
  });

  test("makeFakeOpenClient answers each call through a handler, passing that call's options and its zero-based index", async () => {

    const first = new TestEspHomeClient();
    const second = new TestEspHomeClient();
    const seen: [ string, number ][] = [];
    const open = makeFakeOpenClient(async (options, index) => {

      seen.push([ options.host, index ]);

      return (index === 0) ? first : second;
    });

    assert.equal(await open({ host: "192.0.2.10" }), first, "the handler's answer for the first call is what the factory resolves");
    assert.equal(await open({ host: "192.0.2.11" }), second, "a handler answers a later call differently, which is the whole of what the fixed forms cannot do");
    assert.deepEqual(seen, [ [ "192.0.2.10", 0 ], [ "192.0.2.11", 1 ] ], "the handler receives each call's own options and its zero-based index");
    assert.deepEqual(open.calls.map((call) => call.host), [ "192.0.2.10", "192.0.2.11" ],
      "every call is recorded once, on the single recording path the fixed and handler forms share");
  });
});

describe("makeScriptedOpenClient", () => {

  // What a dial has come to after one macrotask turn: its client or its rejection once it has settled, and "pending" while it has not.
  const outcome = async (dial: Promise<unknown>): Promise<unknown> => Promise.race([ dial.then((client) => client, (error: unknown) => error),
    settle().then(() => "pending") ]);

  test("answers a host from its script and parks a dial past it until the dial's signal aborts, rejecting at once under a signal already aborted", async () => {

    const client = new TestEspHomeClient();
    const open = makeScriptedOpenClient({ "192.0.2.10": [client] });
    const reason = new Error("The dial was abandoned.");
    const parked = new AbortController();

    assert.equal(await open({ host: "192.0.2.10", signal: new AbortController().signal }), client, "a host's first dial is answered from its script");

    const waiting = open({ host: "192.0.2.10", signal: parked.signal });

    assert.equal(await outcome(waiting), "pending", "a dial past its host's script parks");

    parked.abort(reason);

    assert.equal(await outcome(waiting), reason, "and rejects with its signal's reason once that signal aborts");
    assert.equal(await outcome(open({ host: "192.0.2.11", signal: AbortSignal.abort(reason) })), reason,
      "a dial under a signal that has already aborted rejects at once, rather than parking for an abort event that never comes");
  });
});

describe("telemetry factories and initial-state builders", () => {

  test("makeTelemetry produces the wire-faithful base shape", () => {

    const event = eventFields(makeTelemetry("light", "light", { state: true }));

    assert.equal(event.type, "light", "the type tag is carried");
    assert.equal(event.entity, "light", "the object id lives on the entity field");
    assert.equal(event.key, 0, "the wire key defaults to 0");
    assert.equal(event.state, true, "extra fields are spread onto the event");
  });

  test("the typed factories carry their tag and value fields", () => {

    assert.equal(eventFields(makeCoverEvent("door", 0.5, CoverOperation.IS_OPENING)).currentOperation, CoverOperation.IS_OPENING, "makeCoverEvent carries the operation");
    assert.equal(eventFields(makeCoverEvent("door", 0.5)).position, 0.5, "makeCoverEvent carries the float position");
    assert.equal(eventFields(makeLockEvent("lock", LockState.LOCKED)).state, LockState.LOCKED, "makeLockEvent carries the LockState");
    assert.equal(eventFields(makeLightEvent("light", true)).state, true, "makeLightEvent carries the boolean state");
    assert.equal(eventFields(makeSwitchEvent("laser", false)).state, false, "makeSwitchEvent carries the boolean state");
    assert.equal(eventFields(makeBinarySensorEvent("obstruction", true)).state, true, "makeBinarySensorEvent carries the boolean state");
  });

  test("makeRatgdoInitialState keys every entry by entityId(type, objectId)", () => {

    const state = makeRatgdoInitialState();

    assert.equal(state.size, 7, "the Ratgdo resting snapshot covers the seven stateful entities");
    assert.ok(state.has(entityId("cover", "door")), "the cover entry is keyed by its branded entity id");
    assert.ok(state.has(entityId("lock", "lock_remotes")), "the lock entry is keyed by its branded entity id");
  });

  test("makeRatgdoInitialState overrides replace the default entry for the same id", () => {

    const state = makeRatgdoInitialState([makeCoverEvent("door", 1)]);

    assert.equal(state.size, 7, "an override for an existing id replaces rather than adds");
    assert.equal(eventFields(state.get(entityId("cover", "door"))).position, 1, "the overriding event wins for its id");
  });

  test("makeKonnectedInitialState keys the Konnected object ids", () => {

    const state = makeKonnectedInitialState();

    assert.equal(state.size, 5, "the Konnected resting snapshot covers its five stateful entities");
    assert.ok(state.has(entityId("cover", "garage_door")), "the Konnected cover uses the garage_door object id");
    assert.ok(state.has(entityId("switch", "str_output")), "the Konnected strobe uses the str_output object id");
  });
});

describe("makeTestDevice", () => {

  test("applies sensible defaults", () => {

    const device = makeTestDevice();

    assert.equal(device.variant, RatgdoVariant.RATGDO, "the default variant is Ratgdo");
    assert.equal(device.mac, "AABBCCDDEEFF", "the default MAC is stable");
  });

  test("overrides merge over the defaults", () => {

    const device = makeTestDevice({ mac: "001122334455", variant: RatgdoVariant.KONNECTED });

    assert.equal(device.variant, RatgdoVariant.KONNECTED, "an override replaces the default variant");
    assert.equal(device.mac, "001122334455", "an override replaces the default MAC");
    assert.equal(device.name, "Test Ratgdo", "unspecified fields keep their defaults");
  });
});

describe("makeRatgdoService", () => {

  /* eslint-disable camelcase */
  test("composes one record string per advertised TXT field and defaults the address list", () => {

    const service = makeRatgdoService({ friendly_name: null, mac: "AABBCCDDEEFF", project_version: undefined, version: "2.0.0" });

    assert.deepEqual(service.addresses, ["192.0.2.10"], "the address list defaults to a single TEST-NET-1 address");
    assert.deepEqual(txtEntries(service.txt), new Map([ [ "friendly_name", null ], [ "mac", "AABBCCDDEEFF" ], [ "version", "2.0.0" ] ]),
      "a string field carries as key=value, a null field as the bare flag key, and an undefined field is omitted from the record entirely");
  });

  test("names the instance by the advertised MAC, falling back to a fixed label", () => {

    assert.equal(makeRatgdoService({ mac: "AABBCCDDEEFF" }).instance, "AABBCCDDEEFF",
      "the MAC names the instance, so two devices advertising two MACs cannot collide in the browser's snapshot");
    assert.equal(makeRatgdoService({ friendly_name: "Garage" }).instance, "ratgdo", "a device advertising no MAC falls back to the fixed label");
  });
  /* eslint-enable camelcase */
});

describe("makeTestPlatform", () => {

  test("wires a REAL FeatureOptions engine that honors userOptions", () => {

    assert.equal(makeTestPlatform().platform.featureOptions.test("Light", "AABBCCDDEEFF"), true, "Light defaults enabled through the real engine");
    assert.equal(makeTestPlatform({ userOptions: ["Disable.Light"] }).platform.featureOptions.test("Light", "AABBCCDDEEFF"), false,
      "a Disable.Light userOption threads through the real engine to disable the feature");
  });

  test("the capturing log routes what the double logs into the entries buffer", () => {

    const { entries, platform } = makeTestPlatform();

    platform.log.info("info line");

    assert.equal(loggedAt(entries, "info", "info line"), true, "platform.log routes into the shared entries buffer");
  });

  test("mqtt is null by default and a recording double when requested", () => {

    assert.equal(makeTestPlatform().platform.mqtt, null, "MQTT is absent by default");
    assert.ok(makeTestPlatform({ mqtt: true }).platform.mqtt instanceof TestMqttClient, "MQTT is a recording double when requested");
  });

  test("getEspHomeClient returns the fake client, or undefined when clientUnavailable", () => {

    assert.ok(makeTestPlatform().platform.getEspHomeClient("AABBCCDDEEFF") instanceof TestEspHomeClient, "getEspHomeClient returns the fake client by default");
    assert.equal(makeTestPlatform({ clientUnavailable: true }).platform.getEspHomeClient("AABBCCDDEEFF"), undefined,
      "clientUnavailable models the connect-failure window where no client is available");
  });

  test("resolveLogName mirrors production: a configured value resolves, an unset or empty value collapses to undefined", () => {

    assert.equal(makeTestPlatform({ userOptions: ["Enable.Device.LogName.MyDoor"] }).platform.resolveLogName("AABBCCDDEEFF"), "MyDoor",
      "a configured Device.LogName resolves to its value");
    assert.equal(makeTestPlatform().platform.resolveLogName("AABBCCDDEEFF"), undefined, "an unset Device.LogName resolves to undefined");
  });

  test("carries the kit's Homebridge API double, whose HAP namespace is the platform double's own", () => {

    const { platform } = makeTestPlatform();

    assert.ok(platform.api instanceof TestHomebridgeApi, "the platform double's API is the kit's Homebridge API double");
    assert.equal(platform.hap, platform.api.hap, "the platform double's HAP namespace is its API's, as production's platform reads it");
    assert.equal(platform.hap.Service.GarageDoorOpener, Service.GarageDoorOpener, "the API runs on the one runtime whose Service namespace the harness exports");
  });
});

describe("buildRatgdoAccessory", () => {

  test("constructs a real RatgdoAccessory against the doubles and returns the assertion handles", () => {

    const { accessory, client, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

    assert.equal(ratgdo.device.variant, RatgdoVariant.RATGDO, "the constructed accessory carries the device descriptor");
    assert.ok(accessory.getService(Service.GarageDoorOpener), "the real configure chain ran and wired the garage door service");
    assert.ok(client instanceof TestEspHomeClient, "the fake client handle is returned for command assertions");
    assert.ok(mqtt instanceof TestMqttClient, "the recording MQTT double is returned when requested");
  });

  test("defaults the initial-state snapshot to the device variant", () => {

    const { accessory } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED } });

    assert.ok(accessory.getService(Service.GarageDoorOpener), "a Konnected build uses the Konnected snapshot and constructs without throwing");
  });

  /* The accessory is Homebridge's own PlatformAccessory, made through the platform double's API, and it is on the bridge before the RatgdoAccessory sees it. The seed
   * runs first, on an accessory not yet bridged, which is the order a cached accessory's services reach Homebridge's restore in.
   */
  test("seeds, restores and bridges Homebridge's own PlatformAccessory before constructing on it", () => {

    const seeded: boolean[] = [];
    const { accessory, platform } = buildRatgdoAccessory({ seed: (cached) => {

      seeded.push(cached._associatedHAPAccessory.bridged);
    } });

    assert.deepEqual(seeded, [false], "the seed runs once, on the accessory before Homebridge's restore bridges it");
    assert.deepEqual(platform.api.accessories, [accessory], "the accessory is the one the platform double's API made");
    assert.equal(accessory.UUID, platform.hap.uuid.generate("AABBCCDDEEFF"), "the accessory's identity is the HAP UUID of the device MAC");
    assert.equal(accessory._associatedHAPAccessory.bridged, true, "the restore bridged the accessory before construction");
    assert.deepEqual(platform.api.calls, [], "a restore is Homebridge's own act, so the accessory reaches the bridge with no plugin call recorded");
    assert.deepEqual([ accessory._associatedPlatform, accessory._associatedPlugin ], [ PLATFORM_NAME, PLUGIN_NAME ],
      "the restore stamps the accessory with the plugin's own platform name and identifier, as Homebridge's restore of a cached accessory does");
  });

  /* The accessory's logger is a gate wrapped around a prefix wrapped around the platform's own gated logger, so a debug call crosses two gates on its way to the
   * sink. Asserting the COUNT rather than mere presence is what proves the two gates produce one line and not two, and asserting the level is what proves the
   * plugin's opt-in debug output lands where Homebridge actually prints it.
   */
  test("routes an accessory debug line into the buffer at warn under the debug opt-in, and drops it without one", () => {

    const debugOn = buildRatgdoAccessory({ config: { debug: true, options: undefined } });
    const before = debugOn.entries.length;

    debugOn.ratgdo.log.debug("a gated line");

    assert.equal(logCount(debugOn.entries.slice(before), "warn", "a gated line"), 1, "the gated debug channel emits the line exactly once, through warn");
    assert.equal(loggedAt(debugOn.entries, "debug", "a gated line"), false, "nothing is recorded at the debug level itself");

    const debugOff = buildRatgdoAccessory();

    debugOff.ratgdo.log.debug("a gated line");

    assert.equal(loggedAt(debugOff.entries, "warn", "a gated line"), false, "the gate drops the line with the debug opt-in off");
  });
});
