/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.construction.test.ts: Construction-time concern net for RatgdoAccessory - the state the accessory is born with from its captured initial telemetry, the
 * services configureDevice wires onto the accessory, and the exported ratgdoInitialStateEntityIds wait-list builder.
 *
 * The accessory is constructed AFTER the platform has captured a complete initial-state snapshot, so configureXxx writes real device state into HAP from frame zero -
 * there is no placeholder window. These tests assert that the populated status lands on the right characteristics: the garage door reflects the captured cover position,
 * the light / lock / sensors reflect their captured states, and the AccessoryInformation service carries the device identity. Feature-option gating (which services exist
 * at all) is asserted here through the default and a representative disable; the full hints derivation is netted in device.hints.test.ts.
 */
import { Characteristic, Service, buildRatgdoAccessory, makeBinarySensorEvent, makeCoverEvent, makeKonnectedInitialState, makeLightEvent, makeLockEvent,
  makeRatgdoInitialState } from "./testing.helpers.ts";
import { CoverOperation, LockState } from "esphome-client";
import { RatgdoService, RatgdoVariant } from "./types.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ratgdoInitialStateEntityIds } from "./entities.ts";

describe("RatgdoAccessory construction", () => {

  describe("the garage door service", () => {

    test("is the primary service and reflects a closed door from the initial snapshot", () => {

      const { accessory } = buildRatgdoAccessory();
      const door = accessory.getService(Service.GarageDoorOpener);

      assert.ok(door, "the garage door opener service is created at construction");
      assert.equal(door.isPrimary, true, "the garage door is marked the accessory's primary service");
      assert.equal(door.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED,
        "a resting (position 0) cover snapshot lands as a CLOSED current door state");
      assert.equal(door.getCharacteristic(Characteristic.TargetDoorState).value, Characteristic.TargetDoorState.CLOSED,
        "the target door state biases to CLOSED for a closed door");
    });

    test("reflects a fully-open door from the initial snapshot", () => {

      const { accessory } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]) });
      const door = accessory.getService(Service.GarageDoorOpener);

      assert.equal(door?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN,
        "a position-1 cover snapshot lands as an OPEN current door state");
    });

    test("reflects a partially-open (stopped) door from the initial snapshot", () => {

      const { accessory } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 0.5, CoverOperation.IDLE)]) });
      const door = accessory.getService(Service.GarageDoorOpener);

      assert.equal(door?.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.STOPPED,
        "an idle cover parked strictly between 0 and 1 lands as a STOPPED current door state");
    });

    test("reflects an obstruction from the initial snapshot", async () => {

      const { accessory } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeBinarySensorEvent("obstruction", true)]) });
      const door = accessory.getService(Service.GarageDoorOpener);

      // Obstruction is exposed through onGet rather than an initial updateCharacteristic write, so we read it the way HomeKit does - by invoking the bound getter.
      assert.equal(await door?.getCharacteristic(Characteristic.ObstructionDetected).triggerGet(), true,
        "an obstruction-detected snapshot is reported through the ObstructionDetected getter");
    });
  });

  describe("the accessory information service", () => {

    test("carries the manufacturer, serial, firmware, and model identity", () => {

      const { accessory } = buildRatgdoAccessory({ device: { firmwareVersion: "2.3.4", mac: "AABBCCDDEEFF", model: "1.2.3" } });
      const info = accessory.getService(Service.AccessoryInformation);

      assert.equal(info?.getCharacteristic(Characteristic.Manufacturer).value, "github.com/hjdhjd", "the manufacturer is the project identity");
      assert.equal(info?.getCharacteristic(Characteristic.SerialNumber).value, "AABBCCDDEEFF", "the serial number is the device MAC");
      assert.equal(info?.getCharacteristic(Characteristic.FirmwareRevision).value, "2.3.4", "the firmware revision is the discovered firmware version");
      assert.equal(info?.getCharacteristic(Characteristic.Model).value, "Ratgdo 1.2.3", "the model prefixes the variant onto the model string");
    });

    test("renders the Konnected variant model prefix", () => {

      const { accessory } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState() });
      const info = accessory.getService(Service.AccessoryInformation);

      assert.equal(info?.getCharacteristic(Characteristic.Model).value, "Konnected 1.0.0", "a Konnected device renders the Konnected model prefix");
    });
  });

  describe("the light service", () => {

    test("exists by default and reflects the captured light state", () => {

      const { accessory } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeLightEvent("light", true)]) });
      const light = accessory.getService(Service.Lightbulb);

      assert.ok(light, "the light service exists by default");
      assert.equal(light.getCharacteristic(Characteristic.On).value, true, "the captured on-state lands on the On characteristic");
    });

    test("is omitted when the Light feature is disabled", () => {

      const { accessory } = buildRatgdoAccessory({ userOptions: ["Disable.Light"] });

      assert.equal(accessory.getService(Service.Lightbulb), undefined, "disabling the Light feature option leaves no light service on the accessory");
    });
  });

  describe("the wireless remote lock", () => {

    test("reflects a locked state from the initial snapshot", () => {

      const { accessory } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeLockEvent("lock_remotes", LockState.LOCKED)]) });
      const door = accessory.getService(Service.GarageDoorOpener);

      assert.equal(door?.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED,
        "a LOCKED lock snapshot lands as a SECURED lock current state on the garage door service");
    });
  });

  describe("the Disco vehicle presence occupancy sensor", () => {

    // Vehicle presence is a persistent state (is a vehicle in the garage right now), unlike the momentary motion and vehicle arriving/leaving sensors, so the accessory
    // must be born reflecting the captured snapshot rather than a hardcoded clear - the OccupancyDetected characteristic reads its seeded status value at construction.
    test("is born reflecting a vehicle already present in the initial snapshot", () => {

      const { accessory } = buildRatgdoAccessory({

        initialState: makeRatgdoInitialState([makeBinarySensorEvent("vehicle_detected", true)]),
        userOptions: ["Enable.Disco.OccupancySensor.Vehicle.Presence"]
      });
      const presence = accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE);

      assert.equal(presence?.getCharacteristic(Characteristic.OccupancyDetected).value, true,
        "a present vehicle in the captured snapshot lands on OccupancyDetected at construction rather than a stale clear");
    });

    test("is born clear when no vehicle is present in the initial snapshot", () => {

      const { accessory } = buildRatgdoAccessory({ userOptions: ["Enable.Disco.OccupancySensor.Vehicle.Presence"] });
      const presence = accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE);

      assert.equal(presence?.getCharacteristic(Characteristic.OccupancyDetected).value, false,
        "an absent vehicle leaves OccupancyDetected clear at construction");
    });
  });

  describe("ratgdoInitialStateEntityIds", () => {

    test("lists the Ratgdo variant's stateful entities", () => {

      const ids = ratgdoInitialStateEntityIds(RatgdoVariant.RATGDO);

      assert.deepEqual([...ids].sort(), [ "binary_sensor-obstruction", "binary_sensor-vehicle_detected", "cover-door", "light-light", "lock-lock_remotes",
        "switch-laser", "switch-led" ].sort(), "the Ratgdo wait-list covers cover, obstruction, light, lock, laser, led, and vehicle detection");
    });

    test("lists the Konnected variant's stateful entities", () => {

      const ids = ratgdoInitialStateEntityIds(RatgdoVariant.KONNECTED);

      assert.deepEqual([...ids].sort(), [ "cover-garage_door", "binary_sensor-obstruction", "light-garage_light", "lock-lock", "switch-str_output" ].sort(),
        "the Konnected wait-list covers garage_door, obstruction, garage_light, lock, and the strobe output");
    });

    test("omits stateless trigger buttons (refresh, pcw) from the wait-list", () => {

      const ids = ratgdoInitialStateEntityIds(RatgdoVariant.KONNECTED);

      assert.equal(ids.some((id) => id.includes("button")), false, "buttons never push state, so they are excluded from the construction wait-list");
    });
  });
});
