/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.timers.test.ts: Timer-lifecycle concern net for RatgdoAccessory - the one-shot setTimeout machinery the accessory owns (the motion timer that flips
 * MotionDetected back off after RATGDO_MOTION_DURATION, the scheduleUiRevert helper that restores a toggled characteristic RATGDO_UI_REVERT_DELAY after a failed
 * command), plus the [Symbol.dispose] drain that must guarantee no pending timer ever fires into a torn-down accessory.
 *
 * Every test here uses node:test's mock.timers rather than a real-time delay, so a 5-second motion window collapses to a single mock.timers.tick. The motion path is
 * driven through the REAL ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" }) - the exact event id and payload the production switch matches - and the
 * failure-revert path through a triggerSet against a client-unavailable accessory, so the command() failure branch that arms scheduleUiRevert runs unchanged.
 */
import { Characteristic, Service, buildRatgdoAccessory } from "./testing.helpers.ts";
import { RATGDO_MOTION_DURATION, RATGDO_UI_REVERT_DELAY } from "./settings.ts";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import type { EspHomeEvent } from "./types.ts";
import { RatgdoService } from "./types.ts";
import assert from "node:assert/strict";

// The motion timer is armed for RATGDO_MOTION_DURATION seconds; the production code multiplies the seconds constant by 1000 to reach the setTimeout delay, so the tests
// mirror that conversion exactly rather than hardcoding a magic millisecond literal.
const MOTION_DURATION_MS = RATGDO_MOTION_DURATION * 1000;

/* Build a cover EspHomeEvent in the exact shape updateState() consumes (id / state / current_operation / position). Properties are alphabetical per the house style; the
 * current_operation field mirrors the snake_case ESPHome wire shape EspHomeEvent declares, so the camelcase rule is scoped off for this one literal.
 */
// eslint-disable-next-line camelcase
const coverEvent = (id: string, currentOperation: string, state: string, position?: number): EspHomeEvent => ({ current_operation: currentOperation, id, position,
  state });

describe("RatgdoAccessory timers", () => {

  // Enable the fake setTimeout before every test so the accessory's timer registry (its keyed and anonymous timers and the dispose drain) runs against a controllable
  // clock. mock.timers ties clearTimeout into the same fake registry whenever setTimeout is enabled - it is not a separately-selectable api - so cancellations and the
  // dispose drain are mocked alongside the scheduling. We tear the fake timers down after every test so no mocked clock state leaks across cases.
  beforeEach(() => {

    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {

    mock.timers.reset();
  });

  describe("the motion timer", () => {

    test("clears motion and publishes false when the timer fires naturally", () => {

      const { accessory, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });
      const motionService = accessory.getService(Service.MotionSensor);

      assert.ok(motionService, "the motion sensor service exists by default so the motion timer has a characteristic to flip");
      assert.ok(mqtt, "MQTT is enabled, so the recording MQTT double is present");

      // Deliver a motion-ON event. This raises MotionDetected, publishes the leading "true", and arms the motion timer for the full duration.
      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });

      assert.equal(motionService.getCharacteristic(Characteristic.MotionDetected).value, true, "a motion-ON event raises MotionDetected immediately");

      const motionPublishes = mqtt.publishes.filter((entry) => entry.topic.endsWith("/motion"));

      assert.equal(motionPublishes.length, 1, "the leading motion event publishes exactly one MQTT motion message");
      assert.equal(motionPublishes[0]?.payload, "true", "the leading motion publish carries the 'true' payload");

      // Advance past the motion duration. The one-shot timer fires, flips MotionDetected back off, and publishes the trailing "false".
      mock.timers.tick(MOTION_DURATION_MS);

      assert.equal(motionService.getCharacteristic(Characteristic.MotionDetected).value, false, "the motion timer flips MotionDetected back to false after the duration");

      const afterFire = mqtt.publishes.filter((entry) => entry.topic.endsWith("/motion"));

      assert.equal(afterFire.length, 2, "the natural fire publishes exactly one additional motion message - the timer self-removes rather than firing repeatedly");
      assert.equal(afterFire[1]?.payload, "false", "the trailing motion publish carries the 'false' payload");
    });

    test("does not flip motion before the duration elapses", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ mqtt: true });
      const motionService = accessory.getService(Service.MotionSensor);

      assert.ok(motionService, "the motion sensor service exists by default");

      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });

      // One millisecond short of the duration the timer must not have fired yet.
      mock.timers.tick(MOTION_DURATION_MS - 1);

      assert.equal(motionService.getCharacteristic(Characteristic.MotionDetected).value, true, "MotionDetected is still true one millisecond before the timer is due");
    });

    test("restarts the timer on a second motion event rather than stacking timers", () => {

      const { accessory, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });
      const motionService = accessory.getService(Service.MotionSensor);

      assert.ok(motionService, "the motion sensor service exists by default");
      assert.ok(mqtt, "MQTT is enabled, so the recording MQTT double is present");

      // Arm the first motion timer at t=0 (due at MOTION_DURATION_MS).
      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });

      // Advance partway, then deliver a second motion-ON event. The production code cancels the inflight timer and re-arms a fresh one from this point.
      mock.timers.tick(MOTION_DURATION_MS - 2000);
      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });

      // Cross the moment the ORIGINAL timer would have fired. Because that timer was cancelled and replaced, motion must still be detected here.
      mock.timers.tick(2000);

      assert.equal(motionService.getCharacteristic(Characteristic.MotionDetected).value, true,
        "the original timer was cancelled, so motion remains detected past its would-be fire instant");

      const motionPublishes = mqtt.publishes.filter((entry) => entry.topic.endsWith("/motion"));

      assert.equal(motionPublishes.length, 1, "a second motion event while already detecting restarts the timer without re-publishing the leading 'true'");
      assert.equal(motionPublishes.some((entry) => entry.payload === "false"), false, "no trailing 'false' publishes while the restarted timer is still pending");

      // Advance to the restarted timer's due instant. Only now does the single surviving timer fire.
      mock.timers.tick(MOTION_DURATION_MS - 2000);

      assert.equal(motionService.getCharacteristic(Characteristic.MotionDetected).value, false, "the restarted timer fires exactly once at its own due instant");
    });
  });

  describe("the motion occupancy timer", () => {

    test("restarts the occupancy timer on a repeated motion event rather than firing at the original due instant", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Motion.OccupancySensor"] });
      const occupancy = accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_MOTION);

      assert.ok(occupancy, "the motion occupancy sensor materializes when Enable.Motion.OccupancySensor is set");

      const occupancyMs = ratgdo.hints.motionOccupancyDuration * 1000;

      // Arm the occupancy timer at t=0: a motion event raises motion occupancy immediately and schedules its release for occupancyMs.
      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });

      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, true, "the leading motion event raises motion occupancy immediately");

      // Advance partway, then deliver a second motion event. The occupancy timer restarts from this point rather than firing at its original instant.
      mock.timers.tick(occupancyMs - 2000);
      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });

      // Cross the moment the ORIGINAL occupancy timer would have fired. Because it was restarted, occupancy must still be raised here.
      mock.timers.tick(2000);

      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, true,
        "the original occupancy timer was restarted, so occupancy remains raised past its would-be fire instant");

      // Advance to the restarted timer's due instant. The single surviving timer fires exactly once, releasing occupancy.
      mock.timers.tick(occupancyMs - 2000);

      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, false,
        "the restarted occupancy timer fires exactly once at its own due instant, releasing occupancy");
    });
  });

  describe("the door-open occupancy timer", () => {

    test("arms once - a repeated door-open event does not restart the occupancy timer", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ userOptions: ["Enable.Opener.OccupancySensor"] });
      const occupancy = accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN);

      assert.ok(occupancy, "the door-open occupancy sensor materializes when Enable.Opener.OccupancySensor is set");

      const doorMs = ratgdo.hints.doorOpenOccupancyDuration * 1000;

      // Open the door at t=0: the occupancy timer schedules for doorMs.
      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 1));

      // Advance partway, then deliver a second open event. A repeated open must NOT restart the dwell - the door-state short-circuit swallows the duplicate before the
      // open case re-runs, and the defensive has() guard backs it up should a future event path re-enter the case with the window running. Either way the observable
      // contract is the same: a continuously-open door keeps its original deadline.
      mock.timers.tick(doorMs - 2000);
      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 1));

      // Cross the ORIGINAL due instant. Because the window was never restarted, the timer fires here and raises occupancy.
      mock.timers.tick(2000);

      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, true,
        "the door-open occupancy timer armed once and fired at its original deadline despite the repeated open");
    });
  });

  describe("[Symbol.dispose]", () => {

    test("drains a pending motion timer so it never fires after disposal", () => {

      const { accessory, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });
      const motionService = accessory.getService(Service.MotionSensor);

      assert.ok(motionService, "the motion sensor service exists by default");
      assert.ok(mqtt, "MQTT is enabled, so the recording MQTT double is present");

      // Arm the motion timer, then capture the count of motion publishes before disposal so we can prove no late publish escapes.
      ratgdo.updateState({ id: "binary_sensor-motion", state: "ON" });

      const beforeDispose = mqtt.publishes.filter((entry) => entry.topic.endsWith("/motion")).length;

      assert.equal(beforeDispose, 1, "the armed motion event has published exactly the leading 'true' before disposal");

      // Dispose the accessory. This clears every tracked timer and drains the timer set.
      ratgdo[Symbol.dispose]();

      // Advance well past the motion duration. The drained timer must not fire.
      mock.timers.tick(MOTION_DURATION_MS * 2);

      assert.equal(motionService.getCharacteristic(Characteristic.MotionDetected).value, true, "disposal drained the motion timer, so the late false-flip never fires");

      const afterDispose = mqtt.publishes.filter((entry) => entry.topic.endsWith("/motion"));

      assert.equal(afterDispose.length, 1, "disposal drained the motion timer, so no trailing motion message is published after the accessory is torn down");
      assert.equal(afterDispose.some((entry) => entry.payload === "false"), false, "no 'false' motion publish escapes after disposal");
    });
  });

  describe("scheduleUiRevert", () => {

    test("reverts the toggled lock characteristic after the revert delay when the command fails", async () => {

      // A client-unavailable accessory makes command() return false, which is the branch that arms scheduleUiRevert on the lock onSet handler.
      const { accessory, client, ratgdo } = buildRatgdoAccessory({ clientUnavailable: true });
      const door = accessory.getService(Service.GarageDoorOpener);

      assert.ok(door, "the garage door service carries the lock target state onSet by default");

      // Reference the constructed accessory so the build is not flagged as unused; the onSet drives the production timer path under test.
      assert.ok(ratgdo, "the accessory under test is constructed");

      const lockTarget = door.getCharacteristic(Characteristic.LockTargetState);

      // Fire the HomeKit set against LockTargetState.SECURED. The handler's command() fails (no client), so the optimistic value is cached and a revert is scheduled.
      await lockTarget.triggerSet(Characteristic.LockTargetState.SECURED);

      assert.equal(lockTarget.value, Characteristic.LockTargetState.SECURED, "HomeKit's optimistic set caches the toggled value before the revert fires");
      assert.equal(client.commands.length, 0, "no command reached the device because the client was unavailable");

      // The revert must not fire one millisecond before the delay elapses.
      mock.timers.tick(RATGDO_UI_REVERT_DELAY - 1);

      assert.equal(lockTarget.value, Characteristic.LockTargetState.SECURED, "the revert has not yet fired one millisecond before the revert delay");

      // Cross the revert delay. The scheduled revert restores LockTargetState and LockCurrentState to the device's real (unlocked) state.
      mock.timers.tick(1);

      assert.equal(lockTarget.value, Characteristic.LockTargetState.UNSECURED, "the revert restores LockTargetState to the real unsecured state after the delay");
      assert.equal(door.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED,
        "the revert restores LockCurrentState to the device's real unsecured state after the delay");
    });

    test("does not schedule a UI revert when the lock command dispatches successfully", async () => {

      // With the client available, command() succeeds and the failure-revert branch is never taken.
      const { accessory, client, ratgdo } = buildRatgdoAccessory();
      const door = accessory.getService(Service.GarageDoorOpener);

      assert.ok(door, "the garage door service carries the lock target state onSet by default");
      assert.ok(ratgdo, "the accessory under test is constructed");

      const lockTarget = door.getCharacteristic(Characteristic.LockTargetState);

      await lockTarget.triggerSet(Characteristic.LockTargetState.SECURED);

      assert.equal(client.commands.length, 1, "a successful lock onSet dispatches exactly one command to the device");

      // Advance well past the revert delay. Because no revert was scheduled, the optimistic value must remain untouched.
      mock.timers.tick(RATGDO_UI_REVERT_DELAY * 10);

      assert.equal(lockTarget.value, Characteristic.LockTargetState.SECURED, "a successful command leaves the toggled value in place - no revert is scheduled");
    });
  });
});
