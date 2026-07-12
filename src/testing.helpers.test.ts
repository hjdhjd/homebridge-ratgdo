/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Self-test for the shared test harness in testing.helpers.ts.
 *
 * The harness is the foundation every other unit test builds on - the hand-built HAP double, the platform / ESPHome / MQTT doubles, the telemetry factories, and the
 * buildRatgdoAccessory workhorse. A bug here would cascade into misleading pass/fail signals across the whole suite, so this file pins the harness's own contract: the
 * guarantees the real homebridge-plugin-utils service helpers and the production accessory depend on (a marker service seeds its primary characteristic;
 * getCharacteristic returns a stable instance; triggerSet runs the handler then caches; on/emit/dispose drive and detach; the telemetry factories key the snapshot the
 * way the device reads it; makeTestPlatform wires a REAL FeatureOptions engine). It exercises the harness directly rather than through a production accessory.
 */
import { Characteristic, Service, TestEspHomeClient, TestMqttClient, TestService, asEspHomeClient, buildRatgdoAccessory, loggedAt, makeBinarySensorEvent,
  makeCapturingLog, makeCoverEvent, makeFakeOpenClient, makeKonnectedInitialState, makeLightEvent, makeLockEvent, makeMdnsService, makeRatgdoInitialState,
  makeSwitchEvent, makeTelemetry, makeTestAccessory, makeTestDevice, makeTestPlatform } from "./testing.helpers.ts";
import { CoverOperation, LockState, entityId } from "esphome-client";
import { describe, test } from "node:test";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";

/* The telemetry-event fields these tests assert on. The factories return a TelemetryEvent (a schema-derived union with all-optional value fields); we view one as this
 * narrow declared-property shape at the test seam so the assertions read fields by dot access without tripping noPropertyAccessFromIndexSignature, and without an `any`
 * cast - the same construction-seam viewing esphome-client's own tests use when synthesizing wire events.
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

describe("TestCharacteristic", () => {

  test("updateValue stores the written value and value returns it", () => {

    const char = new TestService(Service.Switch, "s", undefined).getCharacteristic(Characteristic.On);

    char.updateValue(true);

    assert.equal(char.value, true, "the cached value reflects the last updateValue write");
  });

  test("triggerGet returns the bound getter's result over the cached value", async () => {

    const char = new TestService(Service.Switch, "s", undefined).getCharacteristic(Characteristic.On);

    char.updateValue(false);
    char.onGet(() => true);

    assert.equal(await char.triggerGet(), true, "the bound onGet handler wins over the cached value");
  });

  test("triggerGet falls back to the cached value when no getter is bound", async () => {

    const char = new TestService(Service.Switch, "s", undefined).getCharacteristic(Characteristic.On);

    char.updateValue(true);

    assert.equal(await char.triggerGet(), true, "with no onGet bound, triggerGet reads the cache (HAP read-from-cache semantics)");
  });

  test("triggerSet runs the bound setter and then caches the value", async () => {

    const char = new TestService(Service.Switch, "s", undefined).getCharacteristic(Characteristic.On);
    let observed;

    char.onSet((value) => {

      observed = value;
    });

    await char.triggerSet(true);

    assert.equal(observed, true, "the onSet handler runs with the supplied value");
    assert.equal(char.value, true, "the value is cached after the setter resolves (HAP set-then-cache semantics)");
  });

  test("setCharacteristic fires the bound onSet handler", () => {

    const service = new TestService(Service.Switch, "s", undefined);
    let observed;

    service.getCharacteristic(Characteristic.On).onSet((value) => {

      observed = value;
    });

    service.setCharacteristic(Characteristic.On, true);

    // setCharacteristic routes through triggerSet, whose handler body runs synchronously before the first await, so the side effect is observable without a tick.
    assert.equal(observed, true, "setCharacteristic drives the onSet handler (the path production MQTT set handlers use)");
  });
});

describe("TestService", () => {

  test("getCharacteristic lazily creates and returns a stable instance across calls", () => {

    const service = new TestService(Service.Switch, "s", undefined);
    const first = service.getCharacteristic(Characteristic.On);
    const second = service.getCharacteristic(Characteristic.On);

    assert.equal(first, second, "repeated getCharacteristic returns the same instance so a bound onGet/onSet persists");
  });

  test("characteristics exposes the seed characteristic first in insertion order", () => {

    const service = new Service.GarageDoorOpener("door");

    assert.equal(service.characteristics[0]?.type, Characteristic.CurrentDoorState,
      "the marker's seed characteristic is first - what the real acquireService destructures to recover the Characteristic constructor");
  });

  test("testCharacteristic is a pure predicate that never creates", () => {

    const service = new TestService(Service.Switch, "s", undefined);
    const before = service.characteristics.length;

    assert.equal(service.testCharacteristic(Characteristic.MotionDetected), false, "an unmaterialized characteristic reports absent");
    assert.equal(service.characteristics.length, before, "testCharacteristic does not lazily create the characteristic it probes");
  });

  test("addOptionalCharacteristic materializes the characteristic", () => {

    const service = new TestService(Service.Switch, "s", undefined);

    service.addOptionalCharacteristic(Characteristic.StatusActive);

    assert.equal(service.testCharacteristic(Characteristic.StatusActive), true, "addOptionalCharacteristic materializes the characteristic for a later bind");
  });

  test("removeCharacteristic deletes the materialized characteristic", () => {

    const service = new TestService(Service.Switch, "s", undefined);

    service.getCharacteristic(Characteristic.On);
    service.removeCharacteristic(service.getCharacteristic(Characteristic.On));

    assert.equal(service.testCharacteristic(Characteristic.On), false, "removeCharacteristic deletes the instance (the path validService takes on a failed service)");
  });

  test("UUID mirrors the marker's static and falls back to a non-empty sentinel for an unidentified kind", () => {

    assert.equal(new Service.Switch("s").UUID, "Switch", "a namespace marker exposes its static UUID");

    // A stand-in marker without a UUID static. It carries a field so it is not an extraneous (empty) class; the point is the absent static UUID that forces the fallback.
    class UnknownKind {

      public readonly hapKind = "unknown" as const;
    }

    assert.equal(new TestService(UnknownKind, "x", undefined).UUID, "unidentified-service-kind",
      "a hand-rolled type with no UUID static resolves to the never-empty sentinel");
  });

  test("setPrimaryService records the primary flag", () => {

    const service = new Service.GarageDoorOpener("door");

    service.setPrimaryService(true);

    assert.equal(service.isPrimary, true, "setPrimaryService records HAP's primary designation");
  });
});

describe("TestAccessory and makeTestAccessory", () => {

  test("a fresh accessory carries an AccessoryInformation service", () => {

    const accessory = makeTestAccessory();

    assert.ok(accessory.getService(Service.AccessoryInformation), "every accessory is born with an AccessoryInformation service");
  });

  test("makeTestAccessory applies stable default identity", () => {

    const accessory = makeTestAccessory();

    assert.equal(accessory.displayName, "Test Ratgdo", "the default display name is stable");
    assert.equal(accessory.UUID, "00000000-0000-0000-0000-000000000000", "the default UUID is a stable all-zero value");
  });

  test("addService appends a service instance and returns it", () => {

    const accessory = makeTestAccessory();
    const service = new Service.GarageDoorOpener("door");
    const returned = accessory.addService(service);

    assert.equal(returned, service, "addService returns the same instance it was handed");
    assert.equal(accessory.getService(Service.GarageDoorOpener), service, "the added service is findable by type");
  });

  test("the legacy addService(type, name, subtype) form creates a characteristic-empty service", () => {

    const accessory = makeTestAccessory();
    const service = accessory.addService(Service.Switch, "extra", "sub");

    assert.equal(service.characteristics.length, 0, "the legacy form produces a plain service with no seeded characteristic");
    assert.equal(service.subtype, "sub", "the subtype is carried through");
  });

  test("getService and getServiceById disambiguate by subtype", () => {

    const accessory = makeTestAccessory();
    const bare = accessory.addService(new Service.Switch("bare"));
    const subtyped = accessory.addService(new TestService(Service.Switch, "tagged", "tag"));

    assert.equal(accessory.getService(Service.Switch), bare, "getService returns the no-subtype service of the type");
    assert.equal(accessory.getServiceById(Service.Switch, "tag"), subtyped, "getServiceById returns the service matching both type and subtype");
  });

  test("removeService removes the instance", () => {

    const accessory = makeTestAccessory();
    const service = accessory.addService(new Service.GarageDoorOpener("door"));

    accessory.removeService(service);

    assert.equal(accessory.getService(Service.GarageDoorOpener), undefined, "the removed service is no longer findable");
  });
});

describe("HAP marker namespaces", () => {

  test("each service marker seeds its primary characteristic", () => {

    assert.equal(new Service.GarageDoorOpener("x").characteristics[0]?.type, Characteristic.CurrentDoorState, "GarageDoorOpener seeds CurrentDoorState");
    assert.equal(new Service.Battery("x").characteristics[0]?.type, Characteristic.ChargingState, "Battery seeds ChargingState");
    assert.equal(new Service.Lightbulb("x").characteristics[0]?.type, Characteristic.On, "Lightbulb seeds On");
    assert.equal(new Service.MotionSensor("x").characteristics[0]?.type, Characteristic.MotionDetected, "MotionSensor seeds MotionDetected");
    assert.equal(new Service.OccupancySensor("x").characteristics[0]?.type, Characteristic.OccupancyDetected, "OccupancySensor seeds OccupancyDetected");
    assert.equal(new Service.ContactSensor("x").characteristics[0]?.type, Characteristic.ContactSensorState, "ContactSensor seeds ContactSensorState");
    assert.equal(new Service.AccessoryInformation("x").characteristics[0]?.type, Characteristic.Name, "AccessoryInformation seeds Name");
  });

  test("characteristic statics mirror the real HAP integer constants production compares against", () => {

    assert.equal(Characteristic.CurrentDoorState.OPEN, 0, "CurrentDoorState.OPEN is 0");
    assert.equal(Characteristic.CurrentDoorState.CLOSED, 1, "CurrentDoorState.CLOSED is 1");
    assert.equal(Characteristic.CurrentDoorState.STOPPED, 4, "CurrentDoorState.STOPPED is 4");
    assert.equal(Characteristic.TargetDoorState.OPEN, 0, "TargetDoorState.OPEN is 0");
    assert.equal(Characteristic.LockCurrentState.SECURED, 1, "LockCurrentState.SECURED is 1");
    assert.equal(Characteristic.LockCurrentState.UNSECURED, 0, "LockCurrentState.UNSECURED is 0");
    assert.equal(Characteristic.ChargingState.CHARGING, 1, "ChargingState.CHARGING is 1");
    assert.equal(Characteristic.ChargingState.NOT_CHARGING, 0, "ChargingState.NOT_CHARGING is 0");
  });
});

describe("makeCapturingLog and loggedAt", () => {

  test("each level records an entry and loggedAt matches by level and substring", () => {

    const { entries, log } = makeCapturingLog();

    log.info("Hello world.");
    log.warn("A warning.");

    assert.equal(entries.length, 2, "each log call records one entry");
    assert.equal(loggedAt(entries, "info", "Hello"), true, "loggedAt finds an info entry by substring");
    assert.equal(loggedAt(entries, "warn", "warning"), true, "loggedAt finds a warn entry by substring");
  });

  test("loggedAt is negative for the wrong level or a missing substring", () => {

    const { entries, log } = makeCapturingLog();

    log.error("Disk failure.");

    assert.equal(loggedAt(entries, "info", "Disk failure."), false, "the level must match");
    assert.equal(loggedAt(entries, "error", "not present"), false, "the substring must be present");
  });
});

describe("TestMqttClient", () => {

  test("subscribeGet records a getter that invokeGet resolves by topic suffix", () => {

    const mqtt = new TestMqttClient();

    mqtt.subscribeGet("AABB/garagedoor", "Garage Door", () => "open");

    assert.equal(mqtt.invokeGet("garagedoor"), "open", "invokeGet matches the recorded getter by topic suffix and returns its value");
    assert.equal(mqtt.invokeGet("missing"), undefined, "invokeGet returns undefined for an unregistered suffix");
  });

  test("invokeSet drives the recorded setter and publish records the payload", async () => {

    const mqtt = new TestMqttClient();
    let received;

    mqtt.subscribeSet("AABB/garagedoor", "Garage Door", (value) => {

      received = value;
    });

    await mqtt.invokeSet("garagedoor", "open 50");
    await mqtt.publish("AABB/motion", "true");

    assert.equal(received, "open 50", "invokeSet drives the recorded setter with the supplied value");
    assert.deepEqual(mqtt.publishes, [{ payload: "true", topic: "AABB/motion" }], "publish records the topic and payload");
  });

  test("invokeSet for an unregistered suffix is a no-op rather than a throw", async () => {

    const mqtt = new TestMqttClient();

    await assert.doesNotReject(() => mqtt.invokeSet("absent", "x"), "invoking an unregistered set topic must not throw");
  });
});

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

  test("[Symbol.dispose] records the disposal openConnection performs on a failed open", () => {

    const client = new TestEspHomeClient();

    assert.equal(client.disposed, false, "a fresh client is not disposed");
    client[Symbol.dispose]();
    assert.equal(client.disposed, true, "[Symbol.dispose] records the teardown openConnection's catch performs via client?.[Symbol.dispose]()");
  });
});

describe("asEspHomeClient and makeFakeOpenClient", () => {

  test("asEspHomeClient is an identity cast - it changes the static type, not the object", () => {

    const client = new TestEspHomeClient();

    assert.equal(asEspHomeClient(client), client, "the seam cast returns the same instance, viewed as the production EspHomeClient type");
  });

  test("makeFakeOpenClient resolves the supplied client, modeling a successful open", async () => {

    const client = new TestEspHomeClient();
    const open = makeFakeOpenClient(client);

    assert.equal(await open({ host: "192.0.2.10" }), client, "a TestEspHomeClient result resolves through the factory, mirroring openEspHomeClient's success path");
  });

  test("makeFakeOpenClient rejects with the supplied error, modeling a failed open", async () => {

    const failure = new Error("connection refused");
    const open = makeFakeOpenClient(failure);

    await assert.rejects(() => open({ host: "192.0.2.10" }), (error) => error === failure, "an Error result rejects through the factory, mirroring a failed open");
  });

  test("makeFakeOpenClient records the options each invocation received", async () => {

    const open = makeFakeOpenClient(new TestEspHomeClient());

    await open({ host: "192.0.2.10", psk: "k" });

    assert.equal(open.calls.length, 1, "every invocation is recorded");
    assert.equal(open.calls[0]?.host, "192.0.2.10", "the recorded options carry the host openConnection forwards");
    assert.equal(open.calls[0]?.psk, "k", "the recorded options carry the psk, so a test can assert the resolved key threads through the seam unchanged");
  });
});

describe("telemetry factories and initial-state builders", () => {

  test("makeTelemetry produces the wire-faithful base shape", () => {

    const event = eventFields(makeTelemetry("light", "light", { state: true }));

    assert.equal(event.type, "light", "the type tag is carried");
    assert.equal(event.entity, "light", "the object id rides on the entity field");
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

describe("makeMdnsService", () => {

  test("carries the raw txt record and defaults the address list", () => {

    const service = makeMdnsService({ mac: "AABBCCDDEEFF" });

    assert.deepEqual(service.addresses, ["192.0.2.10"], "the address list defaults to a single TEST-NET-1 address");
    assert.deepEqual(service.txt, { mac: "AABBCCDDEEFF" }, "the raw txt record is carried through verbatim for parseRatgdoService to narrow");
  });

  test("carries an explicit empty address list for the no-address guard", () => {

    assert.deepEqual(makeMdnsService({}, []).addresses, [], "an explicit empty address list models a service with no advertised address");
  });
});

describe("makeTestPlatform", () => {

  test("wires a REAL FeatureOptions engine that honors userOptions", () => {

    assert.equal(makeTestPlatform().platform.featureOptions.test("Light", "AABBCCDDEEFF"), true, "Light defaults enabled through the real engine");
    assert.equal(makeTestPlatform({ userOptions: ["Disable.Light"] }).platform.featureOptions.test("Light", "AABBCCDDEEFF"), false,
      "a Disable.Light userOption threads through the real engine to disable the feature");
  });

  test("the capturing log routes platform.log and platform.debug into the entries buffer", () => {

    const { entries, platform } = makeTestPlatform();

    platform.log.info("info line");
    platform.debug("debug line");

    assert.equal(loggedAt(entries, "info", "info line"), true, "platform.log routes into the shared entries buffer");
    assert.equal(loggedAt(entries, "debug", "debug line"), true, "platform.debug routes into the shared entries buffer");
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
});
