/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.updatestate-motion.test.ts: updateState() motion and obstruction concern net for RatgdoAccessory.
 *
 * updateState() is the central per-telemetry-event router. This file pins the two transient-sensor branches it owns: the "binary_sensor-motion" case (which latches the
 * MotionDetected characteristic, arms a self-clearing timer, and optionally drives a motion-derived occupancy sensor) and the "binary_sensor-obstruction" case (which
 * mirrors the wire obstruction state onto the GarageDoorOpener service and gates its log / MQTT side effects on an actual transition). Both branches schedule or read
 * real time, so every timer-dependent assertion drives the platform double's test clock rather than waiting on the wall clock. MQTT is enabled on every build so the
 * publish side effects are observable, and the log capture buffer is asserted against the production log strings verbatim.
 */
import { Characteristic, Service, buildRatgdoAccessory } from "./testing.helpers.ts";
import { RATGDO_MOTION_DURATION, RATGDO_OCCUPANCY_DURATION } from "./settings.ts";
import { describe, test } from "node:test";
import { logCount, loggedAt } from "homebridge-plugin-utils/testing";
import { MQTT_GET_SUFFIX } from "homebridge-plugin-utils";
import { RatgdoService } from "./types.ts";
import assert from "node:assert/strict";

describe("RatgdoAccessory.updateState() motion and obstruction handling", () => {

  describe("the motion sensor branch", () => {

    test("latches MotionDetected, logs, and publishes on the first motion event", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });

      const motion = accessory.getService(Service.MotionSensor);

      assert.equal(motion?.getCharacteristic(Characteristic.MotionDetected).value, true, "the first motion-ON event latches MotionDetected true");
      assert.equal(loggedAt(entries, "info", "Motion detected."), true, "the first motion event logs an info-level motion notice when Log.Motion is enabled");
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic.endsWith("/motion")).map((entry) => entry.payload), ["true"],
        "the first motion event publishes a single motion 'true' to MQTT");
    });

    test("clears MotionDetected and publishes 'false' after RATGDO_MOTION_DURATION elapses", () => {

      const { accessory, clock, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });
      clock.advance(RATGDO_MOTION_DURATION * 1000);

      const motion = accessory.getService(Service.MotionSensor);

      assert.equal(motion?.getCharacteristic(Characteristic.MotionDetected).value, false, "the motion timer clears MotionDetected once the duration elapses");
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic.endsWith("/motion")).map((entry) => entry.payload), [ "true", "false" ],
        "the motion lifecycle publishes 'true' on detection and 'false' when the timer clears it");
    });

    test("restarts the timer on a re-delivered motion event without double-firing the log or publish", () => {

      const { accessory, clock, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      const countMotionLogs = (): number => logCount(entries, "info", "Motion detected.");

      // The recorded payload keeps whatever type the publisher handed the client, so the reduction carries the client's own union rather than narrowing to string
      // and hiding a publish that was not one.
      const motionPayloads = (): (Buffer | string)[] => mqtt.published.filter((entry) => entry.topic.endsWith("/motion")).map((entry) => entry.payload);

      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });
      clock.advance(3000);

      // Re-deliver motion before the original 5s timer would fire. This must cancel and re-arm the timer, not re-announce the event.
      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });
      clock.advance(3000);

      const motion = accessory.getService(Service.MotionSensor);

      assert.equal(motion?.getCharacteristic(Characteristic.MotionDetected).value, true, "motion remains latched 6s after first detection because the timer restarted");
      assert.equal(countMotionLogs(), 1, "a re-delivered motion event does not emit a second 'Motion detected.' log");
      assert.deepEqual(motionPayloads(), ["true"], "a re-delivered motion event does not re-publish 'true' to MQTT");

      // Advance the remaining 2s to reach the full duration measured from the second delivery.
      clock.advance(2000);

      assert.equal(motion?.getCharacteristic(Characteristic.MotionDetected).value, false, "the restarted timer clears motion 5s after the re-delivered event");
      assert.deepEqual(motionPayloads(), [ "true", "false" ], "the restarted timer publishes exactly one 'false' when it finally fires");
    });

    test("drives the motion occupancy sensor when Motion.OccupancySensor is enabled", async () => {

      const { accessory, clock, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Motion.OccupancySensor"] });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });

      const occupancy = accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_MOTION);

      assert.ok(occupancy, "the motion occupancy sensor service exists when Motion.OccupancySensor is enabled");
      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, true, "a motion event raises OccupancyDetected on the motion occupancy sensor");
      assert.equal(await mqtt.invokeGet("/occupancy" + MQTT_GET_SUFFIX), "true", "status.motionOccupancy is surfaced through the occupancy MQTT get handler");

      /* The expected list carries the transition's own 'true' followed by a second one the driver republished: running a getter through the client's get pattern
       * publishes the answer on the parent topic, exactly as the real client does when a `/get` arrives, so the driver above is itself a publisher. Stating the
       * republished entry keeps this exact rather than loosening it to a presence check, which would stop noticing a duplicate transition publish.
       */
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic.endsWith("/occupancy")).map((entry) => entry.payload), [ "true", "true" ],
        "the motion occupancy transition publishes a single 'true' to MQTT, beside the getter's republish of that same value");
      assert.equal(loggedAt(entries, "info", "Occupancy detected."), true, "the motion occupancy transition logs an info-level occupancy notice");

      clock.advance(RATGDO_OCCUPANCY_DURATION * 1000);

      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, false, "the motion occupancy timer clears OccupancyDetected after the duration");
      assert.equal(await mqtt.invokeGet("/occupancy" + MQTT_GET_SUFFIX), "false", "status.motionOccupancy is cleared once the motion occupancy timer fires");
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic.endsWith("/occupancy")).map((entry) => entry.payload), [ "true", "true", "false", "false" ],
        "the motion occupancy lifecycle publishes 'true' on detection and 'false' when the timer clears it, each beside its own getter republish");
      assert.equal(loggedAt(entries, "info", "Occupancy no longer detected."), true, "the motion occupancy clear logs an info-level no-longer-detected notice");
    });

    test("updates the characteristic and publishes but suppresses the info log when Log.Motion is disabled", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Log.Motion"] });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });

      const motion = accessory.getService(Service.MotionSensor);

      assert.equal(loggedAt(entries, "info", "Motion detected."), false, "no info-level motion notice is logged when Log.Motion is disabled");
      assert.equal(motion?.getCharacteristic(Characteristic.MotionDetected).value, true, "disabling Log.Motion does not suppress the MotionDetected update");
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic.endsWith("/motion")).map((entry) => entry.payload), ["true"],
        "disabling Log.Motion does not suppress the motion MQTT publish");
    });

    test("ignores a motion-OFF event entirely", async () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      ratgdo.updateState({ id: "binary_sensor-motion", state: "OFF" });

      assert.equal(await mqtt.invokeGet("/motion" + MQTT_GET_SUFFIX), "false", "a motion-OFF event leaves status.motion cleared");

      // The one entry on the motion topic is the getter's own republish, so the event itself published nothing - which is what this test is for. Stating the entry
      // explicitly keeps the claim exact: a publish the motion-OFF branch made would land ahead of the republish and fail this comparison.
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic.endsWith("/motion")).map((entry) => entry.payload), ["false"],
        "a motion-OFF event publishes nothing to MQTT beyond the getter's republish");
      assert.equal(loggedAt(entries, "info", "Motion detected."), false, "a motion-OFF event logs no motion notice");
    });
  });

  describe("the obstruction branch", () => {

    test("mirrors an obstruction-ON event onto the garage door, logs, and publishes", async () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "ON" });

      const door = accessory.getService(Service.GarageDoorOpener);

      // Obstruction is exposed through onGet rather than a cached value, so we read it the way HomeKit does - by invoking the bound getter.
      assert.equal(await door?.getCharacteristic(Characteristic.ObstructionDetected).triggerGet(), true, "an obstruction-ON event reports true through the getter");
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic.endsWith("/obstruction")).map((entry) => entry.payload), ["true"],
        "an obstruction transition publishes a single 'true' to MQTT");
      assert.equal(loggedAt(entries, "info", "Obstruction detected."), true, "an obstruction transition logs an info-level notice when Log.Obstruction is enabled");
    });

    test("publishes 'false' and logs on the obstruction-cleared transition", async () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "ON" });
      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "OFF" });

      const door = accessory.getService(Service.GarageDoorOpener);

      assert.equal(await door?.getCharacteristic(Characteristic.ObstructionDetected).triggerGet(), false, "clearing the obstruction reports false through the getter");
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic.endsWith("/obstruction")).map((entry) => entry.payload), [ "true", "false" ],
        "the obstruction lifecycle publishes 'true' on detection and 'false' when it clears");
      assert.equal(loggedAt(entries, "info", "Obstruction no longer detected."), true, "the obstruction-cleared transition logs an info-level no-longer-detected notice");
    });

    test("treats an obstruction event that matches the current state as a no-op", async () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      // The resting snapshot has the obstruction clear, so an OFF event is a no-op for the gated side effects.
      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "OFF" });

      const door = accessory.getService(Service.GarageDoorOpener);

      assert.equal(await door?.getCharacteristic(Characteristic.ObstructionDetected).triggerGet(), false, "an unchanged obstruction state remains clear");
      assert.equal(mqtt.published.filter((entry) => entry.topic.endsWith("/obstruction")).length, 0, "an unchanged obstruction state publishes nothing to MQTT");
      assert.equal(loggedAt(entries, "info", "Obstruction"), false, "an unchanged obstruction state logs no obstruction notice");
    });
  });
});
