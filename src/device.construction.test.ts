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
import { present, triggerGet } from "homebridge-plugin-utils/testing";
import type { Mock } from "node:test";
import type { TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { ratgdoInitialStateEntityIds } from "./entities.ts";

// A HAP service as the runtime's namespace constructs it, the type a seed's added service carries.
type HapService = InstanceType<typeof Service>;

describe("RatgdoAccessory construction", () => {

  describe("the garage door service", () => {

    test("is the primary service and reflects a closed door from the initial snapshot", () => {

      const { accessory } = buildRatgdoAccessory();
      const door = accessory.getService(Service.GarageDoorOpener);

      assert.ok(door, "the garage door opener service is created at construction");
      assert.equal(door.isPrimaryService, true, "the garage door is marked the accessory's primary service");
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
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");

      // Obstruction is exposed through onGet rather than an initial updateCharacteristic write, so we read it the way HomeKit does - by invoking the bound getter.
      assert.equal(await triggerGet(door.getCharacteristic(Characteristic.ObstructionDetected)), true,
        "an obstruction-detected snapshot is reported through the ObstructionDetected getter");
    });
  });

  describe("the accessory information service", () => {

    test("carries the manufacturer, serial, firmware, and model identity", () => {

      const { accessory } = buildRatgdoAccessory({ device: { firmwareVersion: "2.3.4", mac: "AABBCCDDEEFF", model: "1.2.3" } });
      const info = accessory.getService(Service.AccessoryInformation);

      assert.equal(info?.getCharacteristic(Characteristic.Manufacturer).value, "github.com/hjdhjd", "the manufacturer is the project identity");
      assert.equal(info.getCharacteristic(Characteristic.SerialNumber).value, "AABBCCDDEEFF", "the serial number is the device MAC");
      assert.equal(info.getCharacteristic(Characteristic.FirmwareRevision).value, "2.3.4", "the firmware revision is the discovered firmware version");
      assert.equal(info.getCharacteristic(Characteristic.Model).value, "Ratgdo 1.2.3", "the model prefixes the variant onto the model string");
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

    /* The light and the automation dimmer are both Lightbulb services, the light without a subtype and the dimmer with one. A fresh accessory with the dimmer
     * enabled constructs with both Lightbulbs, the light's ahead of the dimmer's.
     */
    test("sits ahead of the automation dimmer on a fresh accessory with the dimmer enabled, which carries both", () => {

      const { accessory } = buildRatgdoAccessory({ userOptions: ["Enable.Opener.Dimmer"] });
      const lightIndex = accessory.services.findIndex((service) => (service.UUID === Service.Lightbulb.UUID) && (service.subtype === undefined));
      const dimmerIndex = accessory.services.findIndex((service) => (service.UUID === Service.Lightbulb.UUID) &&
        (service.subtype === RatgdoService.DIMMER_OPENER_AUTOMATION));

      assert.notEqual(lightIndex, -1, "the fresh accessory carries the light's own Lightbulb, with no subtype");
      assert.notEqual(dimmerIndex, -1, "the fresh accessory carries the dimmer's subtyped Lightbulb");
      assert.ok(lightIndex < dimmerIndex, "the light's Lightbulb sits ahead of the dimmer's on the fresh accessory");
    });

    // configureDevice acquires the light before the dimmer, so a fresh accessory takes the light through the library's plain add. A dimmer acquired first would
    // already be on the accessory when the light joins, and the library would detach and re-add it to make room, which is the detach this row counts.
    test("goes on a fresh accessory with the dimmer enabled without detaching any service", (t) => {

      let removeService: Mock<TestPlatformAccessory["removeService"]> | undefined;

      buildRatgdoAccessory({ seed: (accessory) => {

        removeService = t.mock.method(accessory, "removeService");
      }, userOptions: ["Enable.Opener.Dimmer"] });

      assert.equal(present(removeService, "the removeService spy the seed installed").mock.callCount(), 0,
        "constructing a fresh accessory with the dimmer enabled detaches no service");
    });

    /* An accessory restored from the cache can carry the dimmer's subtyped Lightbulb without the light's. The library makes room for the light by detaching the
     * dimmer, adding the light, and re-adding the same dimmer instance, so construction succeeds with the light's Lightbulb ahead of the dimmer's and the dimmer on
     * the accessory is the one the cache handed back rather than a newly created one.
     */
    test("joins a cached accessory that carries only the automation dimmer, ahead of the same dimmer instance", () => {

      let dimmer: HapService | undefined;

      const { accessory } = buildRatgdoAccessory({ seed: (cached) => {

        dimmer = cached.addService(Service.Lightbulb, cached.displayName, RatgdoService.DIMMER_OPENER_AUTOMATION);
      }, userOptions: ["Enable.Opener.Dimmer"] });

      const lightIndex = accessory.services.findIndex((service) => (service.UUID === Service.Lightbulb.UUID) && (service.subtype === undefined));
      const dimmerIndex = accessory.services.findIndex((service) => (service.UUID === Service.Lightbulb.UUID) &&
        (service.subtype === RatgdoService.DIMMER_OPENER_AUTOMATION));

      assert.equal(accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION), present(dimmer, "the dimmer the seed added"),
        "the dimmer on the constructed accessory is the instance the cache handed back, not a newly created one");
      assert.notEqual(lightIndex, -1, "the cached accessory gains the light's own Lightbulb, with no subtype");
      assert.ok(lightIndex < dimmerIndex, "the light's Lightbulb sits ahead of the dimmer's on the cached accessory");
    });

    // The light's presence gate matches a Lightbulb by type and subtype together, so turning the light off finds no light to remove and leaves the dimmer's
    // subtyped Lightbulb alone. A lookup by type alone would answer the dimmer here and take it off the accessory.
    test("leaves the automation dimmer in place when the Light feature is disabled", () => {

      const { accessory } = buildRatgdoAccessory({ userOptions: [ "Disable.Light", "Enable.Opener.Dimmer" ] });

      assert.ok(accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION), "the dimmer's subtyped Lightbulb survives the light's off verdict");
      assert.equal(accessory.services.some((service) => (service.UUID === Service.Lightbulb.UUID) && (service.subtype === undefined)), false,
        "the accessory carries no Lightbulb without a subtype, since the light is disabled");
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

      assert.equal(presence?.getCharacteristic(Characteristic.OccupancyDetected).value, Characteristic.OccupancyDetected.OCCUPANCY_DETECTED,
        "a present vehicle in the captured snapshot lands on OccupancyDetected at construction rather than a stale clear");
    });

    test("is born clear when no vehicle is present in the initial snapshot", () => {

      const { accessory } = buildRatgdoAccessory({ userOptions: ["Enable.Disco.OccupancySensor.Vehicle.Presence"] });
      const presence = accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE);

      assert.equal(presence?.getCharacteristic(Characteristic.OccupancyDetected).value, Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
        "an absent vehicle leaves OccupancyDetected clear at construction");
    });
  });

  describe("the motion services on an accessory restored from the cache", () => {

    /* Give the accessory Homebridge hands back for a device it has seen before the motion sensor and the motion occupancy sensor a previous run wired onto it. Each is
     * seeded through the same service type and subtype the production configure path looks it up by, so the presence gate finds what a real restore would hand it -
     * seeded any other way, the lookup would miss and the removal assertion below would hold for the wrong reason.
     */
    const seedMotionServices = (accessory: TestPlatformAccessory): void => {

      accessory.addService(Service.MotionSensor, accessory.displayName);
      accessory.addService(Service.OccupancySensor, accessory.displayName, RatgdoService.OCCUPANCY_SENSOR_MOTION);
    };

    test("keeps both on a Ratgdo device, whose firmware drives them", () => {

      const { accessory } = buildRatgdoAccessory({ seed: (cached) => {

        seedMotionServices(cached);

        assert.ok(cached.getService(Service.MotionSensor), "the restored accessory carries the motion sensor before construction");
        assert.ok(cached.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_MOTION),
          "the restored accessory carries the motion occupancy sensor before construction");
      }, userOptions: ["Enable.Motion.OccupancySensor"] });

      assert.ok(accessory.getService(Service.MotionSensor), "a Ratgdo device keeps the restored motion sensor, since its hint stays true");
      assert.ok(accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_MOTION),
        "a Ratgdo device keeps the restored motion occupancy sensor, since its hint stays true");
    });

    test("strips both from a Konnected device, whose firmware reports no motion", () => {

      const { accessory } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(), seed: (cached) => {

        seedMotionServices(cached);

        assert.ok(cached.getService(Service.MotionSensor), "the restored accessory carries the motion sensor before construction");
        assert.ok(cached.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_MOTION),
          "the restored accessory carries the motion occupancy sensor before construction");
      }, userOptions: ["Enable.Motion.OccupancySensor"] });

      assert.equal(accessory.getService(Service.MotionSensor), undefined, "the variant gate takes the cached motion sensor off a Konnected accessory at construction");
      assert.equal(accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_MOTION), undefined,
        "the variant gate takes the cached motion occupancy sensor off a Konnected accessory at construction");
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
