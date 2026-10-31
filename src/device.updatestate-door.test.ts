/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.updatestate-door.test.ts: updateState() cover-event concern net for RatgdoAccessory - the per-telemetry-event router's handling of the "cover-door"
 * (Ratgdo) and "cover-garage_door" (Konnected) events.
 *
 * These tests drive RatgdoAccessory.updateState() with EspHomeEvent cover payloads (id, OPEN / CLOSED state, OPENING / CLOSING / IDLE current_operation, and the 0-1
 * float position) and assert the observable contract: CurrentDoorState transitions, the stopped-at-partial semantics for an IDLE cover parked strictly between 0 and 1,
 * the unchanged-state no-op, the door-open occupancy timer (set after the configured duration, plus its clear / cancel paths), the automation dimmer and switch tracking
 * the door, the MQTT garagedoor publish on every real transition, and the capitalized state log gated on Log.Opener. The occupancy duration is exercised by advancing
 * the platform double's test clock, so the test never waits in real time.
 */
import { Characteristic, Service, buildRatgdoAccessory, makeBinarySensorEvent, makeCoverEvent, makeKonnectedInitialState,
  makeRatgdoInitialState } from "./testing.helpers.ts";
import { RatgdoService, RatgdoVariant } from "./types.ts";
import { describe, test } from "node:test";
import { loggedAt, present, triggerGet } from "homebridge-plugin-utils/testing";
import type { EspHomeEvent } from "./types.ts";
import { MQTT_GET_SUFFIX } from "homebridge-plugin-utils";
import { RATGDO_OCCUPANCY_DURATION } from "./settings.ts";
import assert from "node:assert/strict";

/* Build a cover EspHomeEvent in the exact shape updateState() consumes. updateState() reads the EspHomeEvent surface (id / state / current_operation / position), which
 * is distinct from the wire TelemetryEvent shape the initial-state snapshot carries - so we construct these directly rather than through the telemetry factories.
 * Properties are alphabetical per the house style; the current_operation field mirrors the snake_case ESPHome wire shape EspHomeEvent declares, so the camelcase rule
 * is scoped off for this one literal. The position is the 0-1 float ESPHome reports.
 */
// eslint-disable-next-line camelcase
const coverEvent = (id: string, currentOperation: string, state: string, position?: number): EspHomeEvent => ({ current_operation: currentOperation, id, position,
  state });

describe("RatgdoAccessory.updateState() cover events", () => {

  describe("current door state transitions", () => {

    test("transitions to OPENING on an OPENING cover event", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory();

      ratgdo.updateState(coverEvent("cover-door", "OPENING", "OPEN", 0.5));

      assert.equal(accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING,
        "an OPENING current_operation drives CurrentDoorState to OPENING regardless of the reported position");
    });

    test("transitions to CLOSING on a CLOSING cover event", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]) });

      ratgdo.updateState(coverEvent("cover-door", "CLOSING", "CLOSED", 0.5));

      assert.equal(accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSING,
        "a CLOSING current_operation drives CurrentDoorState to CLOSING");
    });

    test("transitions to OPEN on an IDLE cover fully open at position 1", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory();

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 1));

      assert.equal(accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN,
        "an IDLE OPEN cover at the fully-open position lands as a HomeKit OPEN current door state");
    });

    test("transitions to CLOSED on an IDLE cover fully closed at position 0", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]) });

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "CLOSED", 0));

      assert.equal(accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED,
        "an IDLE CLOSED cover at position 0 lands as a HomeKit CLOSED current door state");
    });

    test("transitions to STOPPED for an IDLE cover reported OPEN at a partial position", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory();

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 0.5));

      assert.equal(accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED,
        "an IDLE OPEN cover parked strictly between 0 and 1 is treated as stopped-at-partial rather than fully open");
    });
  });

  describe("the IDLE partial-open boundary", () => {

    test("treats an IDLE OPEN cover at position 0 as OPEN, not STOPPED", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory();

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 0));

      assert.equal(accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN,
        "position 0 is not strictly greater than 0, so the stopped-at-partial condition is false and the OPEN state stands");
    });

    test("treats an IDLE OPEN cover at position 1 as OPEN, not STOPPED", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory();

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 1));

      assert.equal(accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN,
        "position 1 is not strictly less than 1, so the stopped-at-partial condition is false and the OPEN state stands");
    });

    test("treats an IDLE OPEN cover at position 0.99 as STOPPED", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory();

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 0.99));

      assert.equal(accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED,
        "a position just shy of fully open still falls strictly inside (0, 1) and is treated as stopped-at-partial");
    });
  });

  describe("the door-open occupancy timer", () => {

    test("raises door-open occupancy after the configured duration once the door is open", async () => {

      const { accessory, clock, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Opener.OccupancySensor"] });
      const occupancy = accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN);

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 1));

      assert.equal(occupancy?.getCharacteristic(Characteristic.OccupancyDetected).value, Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
        "a freshly-opened door has not yet been open long enough to raise occupancy");
      assert.equal(await mqtt?.invokeGet("dooropenoccupancy" + MQTT_GET_SUFFIX), "false", "the MQTT door-open occupancy getter reports the not-yet-raised state");

      clock.advance(RATGDO_OCCUPANCY_DURATION * 1000);

      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, Characteristic.OccupancyDetected.OCCUPANCY_DETECTED,
        "the OccupancyDetected characteristic is raised once the door has been continuously open for the configured duration");
      assert.equal(await mqtt?.invokeGet("dooropenoccupancy" + MQTT_GET_SUFFIX), "true", "the door-open occupancy status flips true and the MQTT getter reflects it");
      assert.ok(mqtt?.published.some((entry) => entry.topic.endsWith("dooropenoccupancy") && (entry.payload === "true")),
        "the occupancy timer publishes the raised door-open occupancy state to MQTT");
    });

    test("cancels the pending occupancy timer when the door closes before the duration elapses", async () => {

      const { accessory, clock, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Opener.OccupancySensor"] });
      const occupancy = accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN);

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 1));
      ratgdo.updateState(coverEvent("cover-door", "IDLE", "CLOSED", 0));

      clock.advance(RATGDO_OCCUPANCY_DURATION * 1000);

      assert.equal(occupancy?.getCharacteristic(Characteristic.OccupancyDetected).value, Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
        "closing the door before the duration elapses cancels the pending timer, so occupancy is never raised");
      assert.equal(await mqtt?.invokeGet("dooropenoccupancy" + MQTT_GET_SUFFIX), "false",
        "the MQTT getter still reports the unraised state after the cancelled timer's deadline passes");
      assert.equal(mqtt?.published.some((entry) => entry.topic.endsWith("dooropenoccupancy") && (entry.payload === "true")), false,
        "a cancelled occupancy timer never publishes a raised door-open occupancy state to MQTT");
    });

    // Clearing a RAISED door-open occupancy is independent of cancelling a pending timer: once the timer fires (raising occupancy) its handle is null, so leaving the
    // open state clears occupancy on its own condition (status.doorOpenOccupancy), not on the timer handle. This nets that the indicator clears rather than sticking
    // on, because the cover case gates the cancel and the clear as separate concerns that both route through setOccupancy().
    test("clears door-open occupancy when the door leaves the open state after occupancy was raised", async () => {

      const { accessory, clock, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Opener.OccupancySensor"] });
      const occupancy = accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN);

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 1));
      clock.advance(RATGDO_OCCUPANCY_DURATION * 1000);
      ratgdo.updateState(coverEvent("cover-door", "IDLE", "CLOSED", 0));

      assert.equal(occupancy?.getCharacteristic(Characteristic.OccupancyDetected).value, Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
        "leaving the open state clears the OccupancyDetected characteristic");
      assert.equal(await mqtt?.invokeGet("dooropenoccupancy" + MQTT_GET_SUFFIX), "false",
        "the door-open occupancy status flips back to false when the door is no longer open");
    });
  });

  describe("the automation accessories reflect the door", () => {

    test("updates the automation door position dimmer Brightness and On to track the door", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ userOptions: ["Enable.Opener.Dimmer"] });
      const dimmer = accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION);

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 1));

      assert.equal(dimmer?.getCharacteristic(Characteristic.Brightness).value, 100, "a fully-open door drives the dimmer brightness to 100 percent");
      assert.equal(dimmer.getCharacteristic(Characteristic.On).value, true, "any non-zero door position turns the automation dimmer on");

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "CLOSED", 0));

      assert.equal(dimmer.getCharacteristic(Characteristic.Brightness).value, 0, "a closed door drives the dimmer brightness to 0 percent");
      assert.equal(dimmer.getCharacteristic(Characteristic.On).value, false, "a zero door position turns the automation dimmer off");
    });

    test("reads the automation dimmer on for a closing door that has not reached the closed position", async () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]), userOptions: ["Enable.Opener.Dimmer"] });
      const dimmer = present(accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION), "the automation dimmer");

      ratgdo.updateState(coverEvent("cover-door", "CLOSING", "CLOSED", 0.5));

      assert.equal(dimmer.getCharacteristic(Characteristic.On).value, true, "the closing door's event leaves the dimmer on at the position the door has reached");
      assert.equal(await triggerGet(dimmer.getCharacteristic(Characteristic.On)), true,
        "and HomeKit's read answers on too, so the tile shows On beside its Brightness of 50 rather than flipping to Off");
    });

    test("reads the automation dimmer off for an obstructed door at the closed position, from its startup write onward", async () => {

      const { accessory } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeBinarySensorEvent("obstruction", true)]),
        userOptions: ["Enable.Opener.Dimmer"] });
      const dimmer = present(accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION), "the automation dimmer");

      assert.equal(dimmer.getCharacteristic(Characteristic.Brightness).value, 0, "the obstructed door stands at the closed position");
      assert.equal(dimmer.getCharacteristic(Characteristic.On).value, false, "so the dimmer's startup write leaves it off, though the door counts as open");
      assert.equal(await triggerGet(dimmer.getCharacteristic(Characteristic.On)), false, "and HomeKit's read answers off, never On at a Brightness of zero");
    });

    test("updates the automation opener switch On to track the door state", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ userOptions: ["Enable.Opener.Switch"] });
      const automationSwitch = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION);

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 1));

      assert.equal(automationSwitch?.getCharacteristic(Characteristic.On).value, true, "an open door turns the automation opener switch on");

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "CLOSED", 0));

      assert.equal(automationSwitch.getCharacteristic(Characteristic.On).value, false, "a closed door turns the automation opener switch off");
    });
  });

  describe("the side effects of a real transition", () => {

    test("publishes the garage door state to MQTT on each real transition", () => {

      const { mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      ratgdo.updateState(coverEvent("cover-door", "OPENING", "OPEN", 0.5));

      assert.ok(mqtt?.published.some((entry) => entry.topic.endsWith("garagedoor") && (entry.payload === "opening")),
        "the opening transition publishes the human-readable door state to the garagedoor topic");

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 1));

      assert.ok(mqtt?.published.some((entry) => entry.topic.endsWith("garagedoor") && (entry.payload === "open")),
        "the subsequent open transition publishes its own door state to the garagedoor topic");
    });

    test("publishes the stopped state to MQTT for a door parked at a partial position", () => {

      const { mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      // An IDLE cover reported OPEN strictly between 0 and 1 resolves to stopped-at-partial, which is a door state of its own on the wire and in the document.
      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 0.5));

      assert.ok(mqtt?.published.some((entry) => entry.topic.endsWith("garagedoor") && (entry.payload === "stopped")),
        "a door parked at a partial position publishes the stopped state to the garagedoor topic");
    });

    test("logs the capitalized door state at info level when Log.Opener is enabled", () => {

      const { entries, ratgdo } = buildRatgdoAccessory();

      ratgdo.updateState(coverEvent("cover-door", "OPENING", "OPEN", 0.5));

      assert.ok(loggedAt(entries, "info", "Opening."),
        "the opening transition logs the capitalized door state at info level, since Log.Opener defaults on");

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 1));

      assert.ok(loggedAt(entries, "info", "Open."),
        "the open transition logs its own capitalized door state at info level");
    });
  });

  describe("negatives and errors", () => {

    test("does not change state or publish when the resolved door state is unchanged", () => {

      const { accessory, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      // The accessory is born CLOSED from the resting snapshot, so an IDLE CLOSED event resolves to the state it already holds - the no-op guard must short-circuit it.
      ratgdo.updateState(coverEvent("cover-door", "IDLE", "CLOSED", 0));

      assert.equal(accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED,
        "an event that resolves to the current state leaves CurrentDoorState untouched at CLOSED");
      assert.equal(mqtt?.published.some((entry) => entry.topic.endsWith("garagedoor")), false,
        "the no-op guard fires before the garagedoor publish, so an unchanged state produces no MQTT traffic");
    });

    test("does not log the door state when Log.Opener is disabled", () => {

      const { entries, ratgdo } = buildRatgdoAccessory({ userOptions: ["Disable.Log.Opener"] });

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "OPEN", 1));

      assert.equal(loggedAt(entries, "info", "Open."), false,
        "disabling Log.Opener suppresses the capitalized door state info log on a real transition");
    });

    test("logs an error and ignores an unknown current_operation", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      ratgdo.updateState(coverEvent("cover-door", "WIGGLE", "OPEN", 0.5));

      assert.ok(loggedAt(entries, "error", "Unknown door operation detected"),
        "an unrecognized current_operation is reported through an error log");
      assert.equal(accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED,
        "the unrecognized operation returns early, leaving CurrentDoorState untouched at its born CLOSED state");
      assert.equal(mqtt?.published.some((entry) => entry.topic.endsWith("garagedoor")), false,
        "the unrecognized operation returns before the garagedoor publish, so no MQTT traffic is produced");
    });

    test("logs an error and ignores an unknown state on an IDLE cover event", () => {

      // Born OPEN rather than the suite's usual CLOSED default: OPEN is the only reading that tells the guard's early return apart from a resolution that happened to
      // land on the state the accessory already held.
      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]), mqtt: true });

      ratgdo.updateState(coverEvent("cover-door", "IDLE", "UNKNOWN", 0));

      assert.ok(loggedAt(entries, "error", "Unknown door state detected"),
        "an IDLE cover reporting a state outside OPEN and CLOSED is reported through an error log");
      assert.equal(accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN,
        "the unrecognized state returns early, leaving CurrentDoorState at the last known OPEN rather than resolving it to CLOSED");
      assert.equal(mqtt?.published.some((entry) => entry.topic.endsWith("garagedoor")), false,
        "the unrecognized state returns before the garagedoor publish, so no MQTT traffic is produced");
    });
  });

  describe("the Konnected variant", () => {

    test("routes the cover-garage_door event for a Konnected device", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState() });

      ratgdo.updateState(coverEvent("cover-garage_door", "OPENING", "OPEN", 0.5));

      assert.equal(accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPENING,
        "the Konnected cover-garage_door event id routes through the same cover case and drives CurrentDoorState to OPENING");
    });
  });
});
