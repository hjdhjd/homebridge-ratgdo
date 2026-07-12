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
import { buildRatgdoAccessory, loggedAt, makeBinarySensorEvent, makeCoverEvent, makeKonnectedInitialState, makeLightEvent, makeLockEvent,
  makeRatgdoInitialState } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import { LockState } from "esphome-client";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";

// The default device MAC the harness stamps onto every accessory. configureMqtt prefixes every topic with "<mac>/", so this is the prefix every recorded subscription
// must carry.
const DEVICE_MAC = "AABBCCDDEEFF";

describe("RatgdoAccessory MQTT configuration", () => {

  describe("the garage door get subscription", () => {

    test("returns the translated current door state for a resting closed door", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("garagedoor"), "closed", "a resting (closed) cover snapshot is reported through the garagedoor getter as the string \"closed\"");
    });

    test("returns the translated current door state for an open door", () => {

      const { mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("garagedoor"), "open", "a fully-open cover snapshot is reported through the garagedoor getter as the string \"open\"");
    });
  });

  describe("the garage door set subscription", () => {

    test("opens a closed door by dispatching a full-open cover command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor", "open");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 1 } }],
        "an \"open\" verb on a closed door dispatches a position-1 cover command to the resolved cover entity");
    });

    test("closes an open door by dispatching a full-close cover command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor", "close");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 0 } }],
        "a \"close\" verb on an open door dispatches a position-0 cover command to the resolved cover entity");
    });

    test("parses a positional \"open 50\" command into a half-open set command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor", "open 50");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 0.5 } }],
        "an \"open 50\" command parses the position and dispatches a 0.5 fractional cover position");
    });

    test("accepts a zero position boundary in \"open 0\" as an explicit set command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor", "open 0");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 0 } }],
        "an \"open 0\" command treats 0 as a valid in-range position and dispatches a 0 fractional cover position");
    });

    test("ignores an out-of-range position in \"open 150\" and falls back to a plain full-open", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor", "open 150");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 1 } }],
        "a position above 100 is discarded, so \"open 150\" degrades to a plain open dispatching a position-1 cover command");
    });

    test("routes the door command to the Konnected variant's cover entity", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor", "open");

      assert.deepEqual(client.commands, [{ id: "cover-garage_door", payload: { position: 1 } }],
        "a Konnected device resolves the cover command to the garage_door entity id");
    });

    test("logs an error and dispatches nothing for an unrecognized verb", async () => {

      const { client, entries, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor", "frobnicate");

      assert.equal(loggedAt(entries, "error", "Invalid garage door MQTT command received"), true, "an unrecognized verb is rejected with an error log");
      assert.equal(client.commands.length, 0, "an unrecognized verb dispatches no cover command");
    });

    test("treats a bare \"stop\" verb as an unrecognized MQTT command", async () => {

      const { client, entries, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor", "stop");

      assert.equal(loggedAt(entries, "error", "Invalid garage door MQTT command received"),
        true, "the MQTT set handler recognizes only open and close, so a bare \"stop\" verb falls through to the error path");
      assert.equal(client.commands.length, 0, "a bare \"stop\" verb dispatches no cover command");
    });

    test("dispatches nothing when the ESPHome client is unavailable", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ clientUnavailable: true, mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      await mqtt.invokeSet("garagedoor", "open");

      assert.equal(client.commands.length, 0, "with no ESPHome client resolved, the door command silently dispatches nothing");
    });
  });

  describe("the lock get subscription", () => {

    test("returns the stringified lock current state for a resting unlocked device", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("lock"), "0", "a resting UNSECURED lock current state stringifies to \"0\"");
    });

    test("returns the stringified lock current state for a locked device", () => {

      const { mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeLockEvent("lock_remotes", LockState.LOCKED)]), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("lock"), "1", "a LOCKED snapshot maps to the SECURED current state and stringifies to \"1\"");
    });
  });

  describe("the obstruction get subscription", () => {

    test("returns the stringified obstruction state for a clear door", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("obstruction"), "false", "a clear obstruction state stringifies to \"false\"");
    });

    test("returns the stringified obstruction state for an obstructed door", () => {

      const { mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeBinarySensorEvent("obstruction", true)]), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("obstruction"), "true", "an obstructed snapshot stringifies to \"true\"");
    });
  });

  describe("the door-open occupancy get subscription", () => {

    test("is present and reflects the door-open occupancy status when the feature is enabled", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Opener.OccupancySensor"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("dooropenoccupancy"), "false",
        "with the opener occupancy sensor enabled, the dooropenoccupancy getter reports the resting (cleared) occupancy status as \"false\"");
    });

    test("is absent when the opener occupancy sensor feature is disabled by default", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("dooropenoccupancy"), undefined,
        "the opener occupancy sensor is off by default, so no dooropenoccupancy subscription is registered");
    });
  });

  describe("the light get subscription", () => {

    test("is present and reflects the on light state when the Light feature is enabled by default", () => {

      const { mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeLightEvent("light", true)]), mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("light"), "true", "with the Light feature enabled, an on light snapshot is reported through the light getter as \"true\"");
    });

    test("is absent when the Light feature is disabled", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Light"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("light"), undefined, "disabling the Light feature leaves no light subscription registered");
    });
  });

  describe("the motion occupancy get subscription", () => {

    test("is present and reflects the motion occupancy status when the feature is enabled", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Motion.OccupancySensor"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("/occupancy"), "false",
        "with the motion occupancy sensor enabled, the occupancy getter reports the resting (cleared) occupancy status as \"false\"");
    });

    test("is absent when the motion occupancy sensor feature is disabled by default", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("/occupancy"), undefined, "the motion occupancy sensor is off by default, so no occupancy subscription is registered");
    });
  });

  describe("the motion get subscription", () => {

    test("is present and reflects the motion state when the Motion feature is enabled by default", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("motion"), "false", "with the Motion feature enabled, the resting (untriggered) motion state is reported as \"false\"");
    });

    test("is absent when the Motion feature is disabled", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Motion"] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");
      assert.equal(mqtt.invokeGet("motion"), undefined, "disabling the Motion feature leaves no motion subscription registered");
    });
  });

  describe("the per-device topic prefix", () => {

    test("prefixes every registered get and set topic with the device MAC", () => {

      const { mqtt } = buildRatgdoAccessory({ mqtt: true, userOptions: [ "Enable.Motion.OccupancySensor", "Enable.Opener.OccupancySensor" ] });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      // With every gated feature enabled, the recorded surface spans the full subscription set, so the prefix sweep covers each topic configureMqtt can register.
      const topics = [ ...mqtt.gets, ...mqtt.sets ].map((entry) => entry.topic);

      assert.ok(topics.length > 0, "the accessory registers at least one MQTT subscription to sweep");

      for(const topic of topics) {

        assert.equal(topic.startsWith(DEVICE_MAC + "/"), true, "every registered MQTT topic carries the per-device \"<mac>/\" prefix");
      }
    });
  });
});
