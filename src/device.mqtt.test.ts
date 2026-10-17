/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.mqtt.test.ts: MQTT concern net for RatgdoAccessory.configureMqtt - the subscribeGet / subscribeSet handlers the accessory registers on the platform's
 * MqttClient at configuration time.
 *
 * configureMqtt wires a fixed set of get topics (garagedoor, lock, obstruction) plus its feature-gated get topics (dooropenoccupancy, light, occupancy, motion) and a
 * single set topic (garagedoor). The recording MqttClient double retains every registered handler by topic, so these tests invoke a get handler and assert its returned
 * string, invoke a set handler and assert the resulting setDoorState -> client command dispatch (or the error log on an unrecognized verb), and confirm that every gated
 * subscription is present exactly when its feature option is enabled and absent otherwise. The per-device topic prefix ("<mac>/<suffix>") is asserted across the whole
 * registered surface in one sweep.
 */
import { MQTT_GET_SUFFIX, MQTT_SET_SUFFIX } from "homebridge-plugin-utils";
import { buildRatgdoAccessory, makeBinarySensorEvent, makeCoverEvent, makeKonnectedInitialState, makeLightEvent, makeLockEvent,
  makeRatgdoInitialState } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import { LockState } from "esphome-client";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";
import { loggedAt } from "homebridge-plugin-utils/testing";

// The default device MAC the harness stamps onto every accessory. configureMqtt prefixes every topic with "<mac>/", so this is the prefix every recorded subscription
// must carry.
const DEVICE_MAC = "AABBCCDDEEFF";

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
