/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.updatestate-motion.test.ts: updateState() motion and obstruction concern net for RatgdoAccessory.
 *
 * updateState() is the central per-telemetry-event router. This file locks in the two transient-sensor branches it owns: the "binary_sensor-motion" case (which latches
 * the MotionDetected characteristic, arms a self-clearing timer, and optionally drives a motion-derived occupancy sensor) and the "binary_sensor-obstruction" case (which
 * mirrors the wire obstruction state onto the GarageDoorOpener service, gates its log / MQTT side effects on an actual transition, and re-states the door's target and
 * the automation switch on a transition that changes whether the obstruction holds the door open). Both branches schedule or read real time, so every timer-dependent
 * assertion drives the platform double's test clock rather than waiting on the wall clock. MQTT is enabled on every build so the publish side effects are observable,
 * and the log capture buffer is asserted against the production log strings verbatim.
 */
import { Characteristic, Service, buildRatgdoAccessory, makeBinarySensorEvent, makeCoverEvent, makeRatgdoInitialState } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import { logCount, loggedAt, present, triggerGet, triggerSet } from "homebridge-plugin-utils/testing";
import type { EspHomeEvent } from "./types.ts";
import { MQTT_GET_SUFFIX } from "homebridge-plugin-utils";
import { RATGDO_MOTION_DURATION } from "./webui/settings.ts";
import { RATGDO_OCCUPANCY_DURATION } from "./settings.ts";
import { RatgdoService } from "./types.ts";
import assert from "node:assert/strict";

/* The cover event that moves a door born open to closing at half travel, which the table below and the closing-door rows share. Its current_operation field mirrors
 * the snake_case ESPHome wire shape EspHomeEvent declares, so the camelcase rule is scoped off for that one line.
 */
// eslint-disable-next-line camelcase
const DOOR_CLOSING: EspHomeEvent = { current_operation: "CLOSING", id: "cover-door", position: 0.5, state: "OPEN" };

/* Every door state in which an obstruction holds the door open, each reached from the snapshot position the accessory is born at and the cover event that then moves
 * it, where one is needed, with the target and the switch the door answers by while its beam is clear. The stopped door is born stopped rather than stopped by an
 * event, because a door event leaves a stopped door's target where it was, while a door born stopped targets open. Each cover event carries the shape the telemetry
 * translation gives a door at half travel, and its current_operation field mirrors the snake_case ESPHome wire shape EspHomeEvent declares, so the camelcase rule is
 * scoped off for that one line.
 */
const DOORS_AN_OBSTRUCTION_HOLDS_OPEN: { bornAt: number; clearOn: boolean; clearTarget: number; door: string; event?: EspHomeEvent }[] = [

  { bornAt: 0, clearOn: true, clearTarget: Characteristic.TargetDoorState.OPEN, door: "an opening",
    // eslint-disable-next-line camelcase
    event: { current_operation: "OPENING", id: "cover-door", position: 0.5, state: "OPEN" } },
  { bornAt: 1, clearOn: false, clearTarget: Characteristic.TargetDoorState.CLOSED, door: "a closing", event: DOOR_CLOSING },
  { bornAt: 1, clearOn: true, clearTarget: Characteristic.TargetDoorState.OPEN, door: "an open" },
  { bornAt: 0.5, clearOn: true, clearTarget: Characteristic.TargetDoorState.OPEN, door: "a stopped" }
];

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

      assert.equal(motion.getCharacteristic(Characteristic.MotionDetected).value, false, "the restarted timer clears motion 5s after the re-delivered event");
      assert.deepEqual(motionPayloads(), [ "true", "false" ], "the restarted timer publishes exactly one 'false' when it finally fires");
    });

    test("drives the motion occupancy sensor when Motion.OccupancySensor is enabled", async () => {

      const { accessory, clock, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Motion.OccupancySensor"] });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });

      const occupancy = accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_MOTION);

      assert.ok(occupancy, "the motion occupancy sensor service exists when Motion.OccupancySensor is enabled");
      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, Characteristic.OccupancyDetected.OCCUPANCY_DETECTED,
        "a motion event raises OccupancyDetected on the motion occupancy sensor");
      assert.equal(await mqtt.invokeGet("/occupancy" + MQTT_GET_SUFFIX), "true", "status.motionOccupancy is surfaced through the occupancy MQTT get handler");

      /* The expected list carries the transition's own 'true' followed by a second one the driver republished: running a getter through the client's get pattern
       * publishes the answer on the parent topic, exactly as the real client does when a `/get` arrives, so the driver above is itself a publisher. Stating the
       * republished entry keeps this exact rather than loosening it to a presence check, which would stop noticing a duplicate transition publish.
       */
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic.endsWith("/occupancy")).map((entry) => entry.payload), [ "true", "true" ],
        "the motion occupancy transition publishes a single 'true' to MQTT, beside the getter's republish of that same value");
      assert.equal(loggedAt(entries, "info", "Occupancy detected."), true, "the motion occupancy transition logs an info-level occupancy notice");

      clock.advance(RATGDO_OCCUPANCY_DURATION * 1000);

      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
        "the motion occupancy timer clears OccupancyDetected after the duration");
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

    test("publishes nothing on a motion event or its reset when the Motion feature is disabled", () => {

      const { clock, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Motion"] });

      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });

      assert.equal(loggedAt(entries, "info", "Motion detected"), true, "the motion event reaches the motion branch, which logs its detection");
      assert.equal(mqtt?.published.some((entry) => entry.topic.endsWith("/motion")), false, "a disabled motion feature produces no motion MQTT publish");

      clock.advance(RATGDO_MOTION_DURATION * 1000);

      assert.equal(mqtt.published.some((entry) => entry.topic.endsWith("/motion")), false,
        "a disabled motion feature produces no motion MQTT publish when the motion window resets");
    });
  });

  describe("the obstruction branch", () => {

    test("mirrors an obstruction-ON event onto the garage door, logs, and publishes", async () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "ON" });

      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");

      // We read the obstruction the way HomeKit answers a read, through the bound getter, which reports the sensor whatever value was last stored.
      assert.equal(await triggerGet(door.getCharacteristic(Characteristic.ObstructionDetected)), true, "an obstruction-ON event reports true through the getter");
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic.endsWith("/obstruction")).map((entry) => entry.payload), ["true"],
        "an obstruction transition publishes a single 'true' to MQTT");
      assert.equal(loggedAt(entries, "info", "Obstruction detected."), true, "an obstruction transition logs an info-level notice when Log.Obstruction is enabled");
    });

    test("publishes 'false' and logs on the obstruction-cleared transition", async () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "ON" });
      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "OFF" });

      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");

      assert.equal(await triggerGet(door.getCharacteristic(Characteristic.ObstructionDetected)), false, "clearing the obstruction reports false through the getter");
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic.endsWith("/obstruction")).map((entry) => entry.payload), [ "true", "false" ],
        "the obstruction lifecycle publishes 'true' on detection and 'false' when it clears");
      assert.equal(loggedAt(entries, "info", "Obstruction no longer detected."), true, "the obstruction-cleared transition logs an info-level no-longer-detected notice");
    });

    test("treats an obstruction event that matches the current state as a no-op", async () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT client double is present when MQTT is enabled");

      // The resting snapshot has the obstruction clear, so an OFF event is a no-op for the gated side effects.
      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "OFF" });

      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");

      assert.equal(await triggerGet(door.getCharacteristic(Characteristic.ObstructionDetected)), false, "an unchanged obstruction state remains clear");
      assert.equal(mqtt.published.filter((entry) => entry.topic.endsWith("/obstruction")).length, 0, "an unchanged obstruction state publishes nothing to MQTT");
      assert.equal(loggedAt(entries, "info", "Obstruction"), false, "an unchanged obstruction state logs no obstruction notice");
    });

    /* The door's target and the automation switch read the obstruction through whether it holds the door open, so an obstruction that starts or clears writes them
     * again from the door's state wherever that answer changes, which is at every door but a fully closed one. Each row reads the stored value HomeKit holds, and the
     * switch's read beside it, so a branch that left one of them stale would show a tile its own read contradicts.
     */
    test("leaves a closed door targeting closed and the automation switch off as an obstruction starts and clears, while ObstructionDetected follows it", async () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Opener.Switch"] });
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");
      const obstruction = door.getCharacteristic(Characteristic.ObstructionDetected);
      const target = door.getCharacteristic(Characteristic.TargetDoorState);
      const on = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION), "the automation opener switch")
        .getCharacteristic(Characteristic.On);

      assert.equal(target.value, Characteristic.TargetDoorState.CLOSED, "the closed door is born targeting closed");
      assert.equal(on.value, false, "and its automation switch is born off");

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "ON" });

      assert.equal(obstruction.value, true, "the beam break raises the stored ObstructionDetected");
      assert.equal(await triggerGet(obstruction), true, "and HomeKit's read of it answers detected");
      assert.equal(target.value, Characteristic.TargetDoorState.CLOSED, "a closed door with its beam broken has not moved, so its stored target stays closed");
      assert.equal(on.value, false, "and the switch's stored On stays false");
      assert.equal(await triggerGet(on), false, "while HomeKit's read of the switch answers off, agreeing with the stored value");

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "OFF" });

      assert.equal(obstruction.value, false, "the cleared beam lowers the stored ObstructionDetected");
      assert.equal(await triggerGet(obstruction), false, "and HomeKit's read of it answers clear");
      assert.equal(target.value, Characteristic.TargetDoorState.CLOSED, "the cleared obstruction leaves the stored target closed");
      assert.equal(on.value, false, "and the switch's stored On false");
      assert.equal(await triggerGet(on), false, "while HomeKit's read of the switch still answers off");
    });

    test("targets closed with the automation switch off for a closed door born obstructed, and holds them as the obstruction clears", async () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeBinarySensorEvent("obstruction", true)]), mqtt: true,
        userOptions: ["Enable.Opener.Switch"] });
      const target = present(accessory.getService(Service.GarageDoorOpener), "the garage door service").getCharacteristic(Characteristic.TargetDoorState);
      const on = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION), "the automation opener switch")
        .getCharacteristic(Characteristic.On);

      assert.equal(target.value, Characteristic.TargetDoorState.CLOSED, "the obstructed closed door is born targeting closed");
      assert.equal(on.value, false, "and its automation switch is born off");
      assert.equal(await triggerGet(on), false, "and HomeKit's read of the switch answers off, agreeing with the stored value");

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "OFF" });

      assert.equal(target.value, Characteristic.TargetDoorState.CLOSED, "the cleared obstruction leaves the stored target closed");
      assert.equal(on.value, false, "and the switch's stored On false");
      assert.equal(await triggerGet(on), false, "while HomeKit's read of the switch still answers off");
    });

    /* A command at a closed door reaches HomeKit before the door's first movement event does, and an obstruction that starts or clears in that window leaves the
     * command in place: a fully closed door's answer does not depend on the obstruction, so the obstruction event writes neither the target nor the switch there.
     * Each row reads the stored values alone, because a read through the switch's getter answers the closed door itself and writes that answer over the command.
     */
    test("keeps a door tile's open command at a closed door as an obstruction starts and clears before the door moves", async () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Opener.Switch"] });
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");
      const target = door.getCharacteristic(Characteristic.TargetDoorState);
      const automationSwitch = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION), "the automation opener switch");

      await triggerSet(target, Characteristic.TargetDoorState.OPEN);
      accessory.clearObservations();

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "ON" });

      assert.equal(target.value, Characteristic.TargetDoorState.OPEN, "the beam break leaves the stored target the user's open");

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "OFF" });

      assert.equal(target.value, Characteristic.TargetDoorState.OPEN, "and so does the beam clearing");
      assert.deepEqual(accessory.changesOn(door, Characteristic.TargetDoorState).map((change) => change.newValue), [],
        "neither obstruction change writes the closed door's target");
      assert.deepEqual(accessory.changesOn(automationSwitch, Characteristic.On).map((change) => change.newValue), [], "or its automation switch");
    });

    test("keeps the automation switch's open command at a closed door as an obstruction starts and clears before the door moves", async () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Opener.Switch"] });
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");
      const automationSwitch = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION), "the automation opener switch");
      const on = automationSwitch.getCharacteristic(Characteristic.On);

      await triggerSet(on, true);
      accessory.clearObservations();

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "ON" });

      assert.equal(on.value, true, "the beam break leaves the switch's stored On the user's on");

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "OFF" });

      assert.equal(on.value, true, "and so does the beam clearing");
      assert.deepEqual(accessory.changesOn(automationSwitch, Characteristic.On).map((change) => change.newValue), [],
        "neither obstruction change writes the closed door's automation switch");
      assert.deepEqual(accessory.changesOn(door, Characteristic.TargetDoorState).map((change) => change.newValue), [], "or its target");
    });

    test("keeps a door tile's open command at a closed door born obstructed as the obstruction clears before the door moves", async () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeBinarySensorEvent("obstruction", true)]), mqtt: true,
        userOptions: ["Enable.Opener.Switch"] });
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");
      const target = door.getCharacteristic(Characteristic.TargetDoorState);
      const automationSwitch = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION), "the automation opener switch");

      await triggerSet(target, Characteristic.TargetDoorState.OPEN);
      accessory.clearObservations();

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "OFF" });

      assert.equal(target.value, Characteristic.TargetDoorState.OPEN, "the beam clearing leaves the stored target the user's open");
      assert.deepEqual(accessory.changesOn(door, Characteristic.TargetDoorState).map((change) => change.newValue), [],
        "the clearing writes no target at a closed door");
      assert.deepEqual(accessory.changesOn(automationSwitch, Characteristic.On).map((change) => change.newValue), [], "and no automation switch");
    });

    for(const { bornAt, clearOn, clearTarget, door, event } of DOORS_AN_OBSTRUCTION_HOLDS_OPEN) {

      test("targets open and turns the automation switch on when an obstruction starts at " + door + " door, and returns them to the door's answer as it clears",
        async () => {

          const { accessory, ratgdo } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", bornAt)]), mqtt: true,
            userOptions: ["Enable.Opener.Switch"] });
          const target = present(accessory.getService(Service.GarageDoorOpener), "the garage door service").getCharacteristic(Characteristic.TargetDoorState);
          const on = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION), "the automation opener switch")
            .getCharacteristic(Characteristic.On);

          if(event) {

            ratgdo.updateState(event);
          }

          assert.equal(target.value, clearTarget, door + " door with its beam clear holds the target its own state answers");
          assert.equal(on.value, clearOn, "and the switch's stored On its own state answers");

          ratgdo.updateState({ id: "binary_sensor-obstruction", state: "ON" });

          assert.equal(target.value, Characteristic.TargetDoorState.OPEN, "an obstruction at " + door + " door holds it open, so the stored target is open");
          assert.equal(on.value, true, "and the switch's stored On is true");
          assert.equal(await triggerGet(on), true, "while HomeKit's read of the switch answers on, agreeing with the stored value");

          ratgdo.updateState({ id: "binary_sensor-obstruction", state: "OFF" });

          assert.equal(target.value, clearTarget, "the cleared obstruction returns the stored target to the door's own answer");
          assert.equal(on.value, clearOn, "and the switch's stored On with it");
          assert.equal(await triggerGet(on), clearOn, "while HomeKit's read of the switch agrees with the stored value");
        });
    }

    test("re-states a closing door's target and the automation switch as an obstruction starts and clears", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]), mqtt: true,
        userOptions: ["Enable.Opener.Switch"] });
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");
      const automationSwitch = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION), "the automation opener switch");

      ratgdo.updateState(DOOR_CLOSING);
      accessory.clearObservations();

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "ON" });
      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "OFF" });

      assert.deepEqual(accessory.changesOn(door, Characteristic.TargetDoorState).map((change) => change.newValue),
        [ Characteristic.TargetDoorState.OPEN, Characteristic.TargetDoorState.CLOSED ],
        "the beam break re-states the closing door's target open, and its clearing re-states it closed");
      assert.deepEqual(accessory.changesOn(automationSwitch, Characteristic.On).map((change) => change.newValue), [ true, false ],
        "and each re-states the automation switch with it, on and then off");
    });

    test("leaves a stopped door's target untouched as an obstruction starts and clears, while the automation switch still follows", async () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 0.5)]), mqtt: true,
        userOptions: ["Enable.Opener.Switch"] });
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");
      const target = door.getCharacteristic(Characteristic.TargetDoorState);
      const automationSwitch = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION), "the automation opener switch");

      // The user closes the stopped door, and HomeKit holds that target until the door moves.
      await triggerSet(target, Characteristic.TargetDoorState.CLOSED);
      accessory.clearObservations();

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "ON" });
      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "OFF" });

      assert.deepEqual(accessory.changesOn(door, Characteristic.TargetDoorState).map((change) => change.newValue), [],
        "neither obstruction change writes the target of a stopped door, which is at its target by definition");
      assert.equal(target.value, Characteristic.TargetDoorState.CLOSED, "so the target HomeKit holds stays the user's close");
      assert.deepEqual(accessory.changesOn(automationSwitch, Characteristic.On).map((change) => change.newValue), [ true, true ],
        "the switch is written on each change all the same, a stopped door counting as open whether or not it is obstructed");
    });

    test("writes a closing door's target and the automation switch once for an obstruction event delivered twice", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]), mqtt: true,
        userOptions: ["Enable.Opener.Switch"] });
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");
      const automationSwitch = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION), "the automation opener switch");

      // A closing door is one whose answer the obstruction moves, so the first delivery writes the target and the switch, and the repeated one writes neither.
      ratgdo.updateState(DOOR_CLOSING);
      accessory.clearObservations();

      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "ON" });
      ratgdo.updateState({ id: "binary_sensor-obstruction", state: "ON" });

      assert.equal(accessory.changesOn(door, Characteristic.ObstructionDetected).length, 2, "each delivery reaches the branch, which mirrors the obstruction every time");
      assert.deepEqual(accessory.changesOn(door, Characteristic.TargetDoorState).map((change) => change.newValue), [Characteristic.TargetDoorState.OPEN],
        "only the change writes the target, and the repeated delivery writes it no second time");
      assert.deepEqual(accessory.changesOn(automationSwitch, Characteristic.On).map((change) => change.newValue), [true],
        "only the change writes the switch, and the repeated delivery writes it no second time");
    });
  });
});
