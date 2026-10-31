/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.mqtt.test.ts: MQTT concern net for RatgdoAccessory.configureMqtt - the subscribeGet / subscribeSet handlers the accessory registers on the platform's
 * MqttClient at configuration time.
 *
 * configureMqtt wires a fixed set of get topics (garagedoor, obstruction) plus its feature-gated get topics (dooropenoccupancy, light, lock, occupancy, motion) and a
 * single set topic (garagedoor). The recording MqttClient double retains every registered handler by topic, so these tests invoke a get handler and assert its returned
 * string, invoke a set handler and assert the resulting setDoorState -> client command dispatch (or the error log on an unrecognized verb), and confirm that every gated
 * subscription is present exactly when its feature option is enabled and absent otherwise. The per-device topic prefix ("<mac>/<suffix>") is asserted across the whole
 * registered surface in one sweep. The opener's availability statement and what its connect registration restates when a broker session begins are netted here too,
 * driven through the double's connection lever.
 */
import { MQTT_GET_SUFFIX, MQTT_SET_SUFFIX } from "homebridge-plugin-utils";
import { RATGDO_MOTION_DURATION, RATGDO_OCCUPANCY_DURATION } from "./settings.ts";
import type { TestMqttClient, TestMqttPublish } from "homebridge-plugin-utils/testing";
import { buildRatgdoAccessory, makeBinarySensorEvent, makeCoverEvent, makeKonnectedInitialState, makeLightEvent, makeLockEvent,
  makeRatgdoInitialState, makeSwitchEvent } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import { LockState } from "esphome-client";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";
import { loggedAt } from "homebridge-plugin-utils/testing";

// The default device MAC the harness stamps onto every accessory. configureMqtt prefixes every topic with "<mac>/", so this is the prefix every recorded subscription
// must carry.
const DEVICE_MAC = "AABBCCDDEEFF";

/* Drive the MQTT double through one broker session and answer every publish the session recorded, in order. The lever's false-to-true edge is a session restored:
 * the double records the plugin-level statement on the bare availability tail and then runs every connect registration the accessory holds.
 */
const restoreSession = (mqtt: TestMqttClient): TestMqttPublish[] => {

  const before = mqtt.published.length;

  mqtt.connected = false;
  mqtt.connected = true;

  return mqtt.published.slice(before);
};

// The state topics a session restated, read past the plugin-level and opener availability statements that open it and reduced to [tail, payload, retain] triples,
// sorted by tail because the order the accessory restates in is not part of the contract.
const restatedIn = (session: readonly TestMqttPublish[]): (boolean | string)[][] => session.slice(2)
  .map((entry) => [ entry.topic.slice((DEVICE_MAC + "/").length), entry.payload.toString(), entry.retain ]).sort();

describe("RatgdoAccessory MQTT configuration", () => {

  describe("the garage door get subscription", () => {

    test("returns the translated current door state for a resting closed door", async () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(await mqtt.invokeGet("garagedoor" + MQTT_GET_SUFFIX), "closed",
        "a resting (closed) cover snapshot is reported through the garagedoor getter as the string \"closed\"");
    });

    test("returns the translated current door state for an open door", async () => {

      const { mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(await mqtt.invokeGet("garagedoor" + MQTT_GET_SUFFIX), "open",
        "a fully-open cover snapshot is reported through the garagedoor getter as the string \"open\"");
    });
  });

  describe("the garage door set subscription", () => {

    test("opens a closed door by dispatching a full-open cover command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "open");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 1 } }],
        "an \"open\" verb on a closed door dispatches a position-1 cover command to the resolved cover entity");
    });

    test("closes an open door by dispatching a full-close cover command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "close");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 0 } }],
        "a \"close\" verb on an open door dispatches a position-0 cover command to the resolved cover entity");
    });

    test("parses a positional \"open 50\" command into a half-open set command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "open 50");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 0.5 } }],
        "an \"open 50\" command parses the position and dispatches a 0.5 fractional cover position");
    });

    test("accepts a zero position boundary in \"open 0\" as an explicit set command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "open 0");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 0 } }],
        "an \"open 0\" command treats 0 as a valid in-range position and dispatches a 0 fractional cover position");
    });

    test("ignores an out-of-range position in \"open 150\" and falls back to a plain full-open", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "open 150");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 1 } }],
        "a position above 100 is discarded, so \"open 150\" degrades to a plain open dispatching a position-1 cover command");
    });

    test("routes the door command to the Konnected variant's cover entity", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "open");

      assert.deepEqual(client.commands, [{ id: "cover-garage_door", payload: { position: 1 } }],
        "a Konnected device resolves the cover command to the garage_door entity id");
    });

    test("logs an error and dispatches nothing for an unrecognized verb", async () => {

      const { client, entries, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "frobnicate");

      assert.equal(loggedAt(entries, "error", "Invalid garage door MQTT command received"), true, "an unrecognized verb is rejected with an error log");
      assert.equal(client.commands.length, 0, "an unrecognized verb dispatches no cover command");
    });

    test("treats a bare \"stop\" verb as an unrecognized MQTT command", async () => {

      const { client, entries, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "stop");

      assert.equal(loggedAt(entries, "error", "Invalid garage door MQTT command received"),
        true, "the MQTT set handler recognizes only open and close, so a bare \"stop\" verb falls through to the error path");
      assert.equal(client.commands.length, 0, "a bare \"stop\" verb dispatches no cover command");
    });

    test("dispatches nothing when the ESPHome client is unavailable", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ clientUnavailable: true, mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "open");

      assert.equal(client.commands.length, 0, "with no ESPHome client resolved, the door command silently dispatches nothing");
    });
  });

  describe("the lock get subscription", () => {

    test("returns the stringified lock current state for a resting unlocked device", async () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(await mqtt.invokeGet("lock" + MQTT_GET_SUFFIX), "0", "a resting UNSECURED lock current state stringifies to \"0\"");
    });

    test("returns the stringified lock current state for a locked device", async () => {

      const { mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeLockEvent("lock_remotes", LockState.LOCKED)]), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(await mqtt.invokeGet("lock" + MQTT_GET_SUFFIX), "1", "a LOCKED snapshot maps to the SECURED current state and stringifies to \"1\"");
    });

    test("is absent when the lock option is disabled", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Opener.Lock"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.subscriptions.some((entry) => entry.topic.endsWith("lock" + MQTT_GET_SUFFIX)), false,
        "disabling the lock option leaves no lock subscription registered");
    });
  });

  describe("the obstruction get subscription", () => {

    test("returns the stringified obstruction state for a clear door", async () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(await mqtt.invokeGet("obstruction" + MQTT_GET_SUFFIX), "false", "a clear obstruction state stringifies to \"false\"");
    });

    test("returns the stringified obstruction state for an obstructed door", async () => {

      const { mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeBinarySensorEvent("obstruction", true)]), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(await mqtt.invokeGet("obstruction" + MQTT_GET_SUFFIX), "true", "an obstructed snapshot stringifies to \"true\"");
    });
  });

  describe("the door-open occupancy get subscription", () => {

    test("is present and reflects the door-open occupancy status when the feature is enabled", async () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Opener.OccupancySensor"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(await mqtt.invokeGet("dooropenoccupancy" + MQTT_GET_SUFFIX), "false",
        "with the opener occupancy sensor enabled, the dooropenoccupancy getter reports the resting (cleared) occupancy status as \"false\"");
    });

    test("is absent when the opener occupancy sensor feature is disabled by default", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.subscriptions.some((entry) => entry.topic.endsWith("dooropenoccupancy" + MQTT_GET_SUFFIX)), false,
        "the opener occupancy sensor is off by default, so no dooropenoccupancy subscription is registered");
    });
  });

  describe("the light get subscription", () => {

    test("is present and reflects the on light state when the Light feature is enabled by default", async () => {

      const { mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeLightEvent("light", true)]), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(await mqtt.invokeGet("light" + MQTT_GET_SUFFIX), "true",
        "with the Light feature enabled, an on light snapshot is reported through the light getter as \"true\"");
    });

    test("is absent when the Light feature is disabled", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Light"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.subscriptions.some((entry) => entry.topic.endsWith("light" + MQTT_GET_SUFFIX)), false,
        "disabling the Light feature leaves no light subscription registered");
    });
  });

  describe("the motion occupancy get subscription", () => {

    test("is present and reflects the motion occupancy status when the feature is enabled", async () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Motion.OccupancySensor"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(await mqtt.invokeGet("/occupancy" + MQTT_GET_SUFFIX), "false",
        "with the motion occupancy sensor enabled, the occupancy getter reports the resting (cleared) occupancy status as \"false\"");
    });

    test("is absent when the motion occupancy sensor feature is disabled by default", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.subscriptions.some((entry) => entry.topic.endsWith("/occupancy" + MQTT_GET_SUFFIX)), false,
        "the motion occupancy sensor is off by default, so no occupancy subscription is registered");
    });
  });

  describe("the motion get subscription", () => {

    test("is present and reflects the motion state when the Motion feature is enabled by default", async () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(await mqtt.invokeGet("motion" + MQTT_GET_SUFFIX), "false",
        "with the Motion feature enabled, the resting (untriggered) motion state is reported as \"false\"");
    });

    test("is absent when the Motion feature is disabled", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Motion"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.subscriptions.some((entry) => entry.topic.endsWith("motion" + MQTT_GET_SUFFIX)), false,
        "disabling the Motion feature leaves no motion subscription registered");
    });
  });

  describe("the registered subscription table", () => {

    test("registers each topic beside the label the client logs that topic under", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: [ "Enable.Motion.OccupancySensor", "Enable.Opener.OccupancySensor" ] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      /* Reduce every recorded registration to the pair that reaches a user: the tail the accessory subscribed on, and the label the client names it by in the
       * sentence it logs when a get or a set arrives. The recorded topic carries the child the client appends, so the tail is read between the device prefix and
       * that child, through the library's own constants rather than a second spelling of "/get" here. Both sides are sorted by tail, because the order
       * configureMqtt registers in is not part of the contract while the pairing is - a site reading the right topic beside another entry's label satisfies every
       * other assertion in this file and fails only here. A label the double recorded as absent survives the reduction as undefined rather than collapsing to a
       * string, so a missing label fails the comparison instead of passing as an empty one.
       */
      const tailOf = (topic: string, suffix: string): string => topic.slice((DEVICE_MAC + "/").length, -suffix.length);
      const byTail = (kind: "get" | "set", suffix: string): (string | undefined)[][] => mqtt.subscriptions.filter((entry) => entry.kind === kind)
        .map((entry) => [ tailOf(entry.topic, suffix), entry.type ]).sort();

      assert.deepEqual(byTail("get", MQTT_GET_SUFFIX), [ [ "dooropenoccupancy", "Door Open Indicator Occupancy" ], [ "garagedoor", "Garage Door" ],
        [ "light", "Light" ], [ "lock", "Lock" ], [ "motion", "Motion" ], [ "obstruction", "Obstruction" ], [ "occupancy", "Occupancy" ] ],
      "with every gated feature enabled, each get subscription carries its own tail and its own label");

      assert.deepEqual(byTail("set", MQTT_SET_SUFFIX), [[ "garagedoor", "Garage Door" ]], "the garage door is the one topic the accessory accepts a command on");
    });
  });

  describe("the motion subscriptions across the variants", () => {

    test("a Konnected device registers neither, since the hints its firmware cannot serve gate both", () => {

      const { mqtt } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(), mqtt: true,
        userOptions: ["Enable.Motion.OccupancySensor"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.subscriptions.some((entry) => entry.topic.endsWith("motion" + MQTT_GET_SUFFIX)), false,
        "a Konnected device registers no motion subscription, so a broker read of it answers nothing");
      assert.equal(mqtt.subscriptions.some((entry) => entry.topic.endsWith("/occupancy" + MQTT_GET_SUFFIX)), false,
        "a Konnected device registers no motion occupancy subscription even with the occupancy sensor enabled");
    });

    test("a Ratgdo device registers both under the same configuration", async () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Motion.OccupancySensor"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(await mqtt.invokeGet("motion" + MQTT_GET_SUFFIX), "false", "a Ratgdo device registers the motion subscription, which reports the resting state");
      assert.equal(await mqtt.invokeGet("/occupancy" + MQTT_GET_SUFFIX), "false",
        "a Ratgdo device registers the motion occupancy subscription, which reports the cleared state");
    });
  });

  describe("the availability topic", () => {

    /* The first event is the online the platform dispatches for a new connection, which lands on a status construction already started at online. It must still
     * produce a statement, since it is the one that connection makes, so this sequence fails for a publish gated on a change as well as for a missing one.
     */
    test("states each availability event once, retained, on the opener's availability topic", () => {

      const { mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "availability", state: "online" });

      assert.deepEqual(mqtt.publishedTo(DEVICE_MAC + "/availability"), [{ payload: "online", retain: true, topic: DEVICE_MAC + "/availability" }],
        "an online availability event records exactly one retained online statement, even on a status that already read online");

      ratgdo.updateState({ id: "availability", state: "offline" });

      assert.deepEqual(mqtt.publishedTo(DEVICE_MAC + "/availability"), [ { payload: "online", retain: true, topic: DEVICE_MAC + "/availability" },
        { payload: "offline", retain: true, topic: DEVICE_MAC + "/availability" } ],
      "an offline availability event records exactly one more statement, retained and reading offline");
    });

    test("states the opener's availability behind the plugin's own statement when a broker session begins", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      // The lever's false-to-true edge is a session restored: the double records the plugin-level statement on the bare tail and then runs every connect registration.
      mqtt.connected = false;
      mqtt.connected = true;

      assert.deepEqual(mqtt.published.slice(0, 2), [ { payload: "online", retain: true, topic: "availability" },
        { payload: "online", retain: true, topic: DEVICE_MAC + "/availability" } ],
      "the plugin-level statement is recorded first, and the opener's own retained statement follows it");
    });

    test("states the opener's retained offline as its final word when the client ends", async () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      assert.deepEqual(await mqtt.end(), [], "the client's end meets no refusal");
      assert.deepEqual(mqtt.publishedTo(DEVICE_MAC + "/availability"), [{ payload: "offline", retain: true, topic: DEVICE_MAC + "/availability" }],
        "the end states the opener offline, retained, while the session still holds");
    });

    test("an opener disposed before the client ends states no final word", async () => {

      const { mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      ratgdo[Symbol.dispose]();
      await mqtt.end();

      assert.deepEqual(mqtt.publishedTo(DEVICE_MAC + "/availability"), [], "disposing the opener released its final word with every other registration it held");
    });
  });

  /* The restatement covers the enabled state topics that report held state, and the rows below hold each opener's default set and the sets an option adds or
   * removes. Each payload is read from the status the test drove, so a payload answered from the wrong field fails here. Every state below differs from the resting
   * snapshot, and paired topics are driven apart (laser on, LED off; occupancy raised while motion has cleared), so no two topics can swap payloads unseen.
   */
  describe("the session restatement", () => {

    test("restates a default Ratgdo opener's state topics with their current payloads, behind both availability statements", () => {

      const { mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([ makeCoverEvent("door", 1), makeLightEvent("light", true),
        makeBinarySensorEvent("obstruction", true), makeLockEvent("lock_remotes", LockState.LOCKED), makeSwitchEvent("laser", true),
        makeBinarySensorEvent("vehicle_detected", true) ]), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      const session = restoreSession(mqtt);

      assert.deepEqual(session.slice(0, 2), [ { payload: "online", retain: true, topic: "availability" },
        { payload: "online", retain: true, topic: DEVICE_MAC + "/availability" } ],
      "the session opens with the plugin-level statement and the opener's own availability, ahead of every state topic");
      assert.deepEqual(restatedIn(session), [ [ "garagedoor", "open", false ], [ "light", "true", false ], [ "lock", "1", false ], [ "obstruction", "true", false ] ],
        "a default Ratgdo opener restates the door, light, obstruction, and lock, while its default-off laser and vehicle presence stay silent with their state raised");
    });

    test("restates a default Konnected opener's state topics with their current payloads", () => {

      const { mqtt } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState([
        makeLightEvent("garage_light", true), makeLockEvent("lock", LockState.LOCKED), makeSwitchEvent("str_output", true) ]), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      assert.deepEqual(restatedIn(restoreSession(mqtt)), [ [ "garagedoor", "closed", false ], [ "light", "true", false ], [ "lock", "1", false ],
        [ "obstruction", "false", false ] ],
      "a default Konnected opener restates the door, light, obstruction, and lock, while its default-off strobe stays silent with its state raised");
    });

    test("adds the Disco laser, LED, and vehicle presence topics when their options are enabled", () => {

      const { mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([ makeSwitchEvent("laser", true), makeBinarySensorEvent("vehicle_detected", true) ]),
        mqtt: true, userOptions: [ "Enable.Disco.Switch.Laser", "Enable.Disco.Switch.Led", "Enable.Disco.OccupancySensor.Vehicle.Presence" ] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      assert.deepEqual(restatedIn(restoreSession(mqtt)), [ [ "garagedoor", "closed", false ], [ "laser", "true", false ], [ "led", "false", false ],
        [ "light", "false", false ], [ "lock", "0", false ], [ "obstruction", "false", false ], [ "vehiclepresence", "true", false ] ],
      "enabling the Disco laser, LED, and vehicle presence options adds their topics beside the default set, each restated with its current payload");
    });

    test("adds the strobe topic when its option is enabled", () => {

      const { mqtt } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED },
        initialState: makeKonnectedInitialState([makeSwitchEvent("str_output", true)]), mqtt: true, userOptions: ["Enable.Konnected.Switch.Strobe"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      assert.deepEqual(restatedIn(restoreSession(mqtt)), [ [ "garagedoor", "closed", false ], [ "light", "false", false ], [ "lock", "0", false ],
        [ "obstruction", "false", false ], [ "strobe", "true", false ] ],
      "enabling the Konnected strobe option adds its topic beside the default set, restated with the strobe on");
    });

    test("leaves the light out when the Light feature is disabled", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Light"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      assert.deepEqual(restatedIn(restoreSession(mqtt)), [ [ "garagedoor", "closed", false ], [ "lock", "0", false ], [ "obstruction", "false", false ] ],
        "an opener whose Light feature is disabled restates the door, lock, and obstruction, and no session restates the light");
    });

    test("leaves the lock out when the lock option is disabled", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Opener.Lock"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      assert.deepEqual(restatedIn(restoreSession(mqtt)), [ [ "garagedoor", "closed", false ], [ "light", "false", false ], [ "obstruction", "false", false ] ],
        "an opener whose lock option is disabled restates the door, light, and obstruction, and no session restates the lock");
    });

    test("adds the door-open occupancy topic when its option is enabled, reading the raised indicator", () => {

      const { clock, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Opener.OccupancySensor"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      // Open the door and hold it open for the configured duration, which raises the door-open indicator.
      // eslint-disable-next-line camelcase
      ratgdo.updateState({ current_operation: "IDLE", id: "cover-door", position: 1, state: "OPEN" });
      clock.advance(RATGDO_OCCUPANCY_DURATION * 1000);

      assert.deepEqual(restatedIn(restoreSession(mqtt)), [ [ "dooropenoccupancy", "true", false ], [ "garagedoor", "open", false ], [ "light", "false", false ],
        [ "lock", "0", false ], [ "obstruction", "false", false ] ],
      "enabling the door-open occupancy sensor adds its topic beside the default set, restated with the raised indicator");
    });

    test("adds the motion occupancy topic when its option is enabled, reading occupancy rather than motion", () => {

      const { clock, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Motion.OccupancySensor"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      // A motion event raises both motion and occupancy. Motion clears after its own short window while occupancy holds for far longer, so they read apart here.
      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });
      clock.advance(RATGDO_MOTION_DURATION * 1000);

      assert.deepEqual(restatedIn(restoreSession(mqtt)), [ [ "garagedoor", "closed", false ], [ "light", "false", false ], [ "lock", "0", false ],
        [ "obstruction", "false", false ], [ "occupancy", "true", false ] ],
      "enabling the motion occupancy sensor adds its topic beside the default set, restated with occupancy still raised after motion has cleared");
    });

    test("never restates the momentary motion and vehicle arriving and leaving events, even mid-event", () => {

      const { mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: [ "Enable.Disco.ContactSensor.Vehicle.Arriving",
        "Enable.Disco.ContactSensor.Vehicle.Leaving" ] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });
      ratgdo.updateState({ id: "binary_sensor-vehicle_arriving", state: "ON" });
      ratgdo.updateState({ id: "binary_sensor-vehicle_leaving", state: "ON" });

      const tails = restatedIn(restoreSession(mqtt)).map(([tail]) => tail);

      for(const momentary of [ "motion", "vehiclearriving", "vehicleleaving" ]) {

        assert.equal(tails.includes(momentary), false, "a momentary event is never restated, since a replayed event is the event happening a second time");
      }
    });

    test("records nothing for a disposed accessory on the next session", () => {

      const { mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      ratgdo[Symbol.dispose]();

      assert.deepEqual(restoreSession(mqtt), [{ payload: "online", retain: true, topic: "availability" }],
        "disposing the accessory releases its connect registration, so the session records the plugin-level statement alone");
    });
  });

  describe("the per-device topic prefix", () => {

    test("prefixes every registered get and set topic with the device MAC", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: [ "Enable.Motion.OccupancySensor", "Enable.Opener.OccupancySensor" ] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      // With every gated feature enabled, the recorded surface spans the full subscription set, so the prefix sweep covers each topic configureMqtt can register.
      const topics = mqtt.subscriptions.map((entry) => entry.topic);

      assert.ok(topics.length > 0, "the accessory registers at least one MQTT subscription to sweep");

      for(const topic of topics) {

        assert.equal(topic.startsWith(DEVICE_MAC + "/"), true, "every registered MQTT topic carries the per-device \"<mac>/\" prefix");
      }
    });
  });
});
