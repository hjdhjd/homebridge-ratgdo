/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.updatestate-lock.test.ts: updateState() concern net for the wireless remote lock and the availability transition. These two cases are the lock state
 * translation (LOCKED / UNLOCKED to HomeKit's SECURED / UNSECURED, the lockout automation switch, the deviation log, and the MQTT publish) and the connection
 * availability fan-out (Model refresh, StatusActive across every sensor service, and the disconnect log that the device - not the platform - owns).
 */
import { Characteristic, Service, buildRatgdoAccessory, loggedAt, makeLockEvent, makeRatgdoInitialState } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import { LockState } from "esphome-client";
import { RatgdoService } from "./types.ts";
import assert from "node:assert/strict";

describe("RatgdoAccessory.updateState() lock and availability", () => {

  describe("the wireless remote lock", () => {

    test("translates a LOCKED telemetry event into a SECURED lock, an engaged lockout switch, a deviation log, and an MQTT publish", () => {

      // The lockout automation switch only materializes when Opener.Lock (default on) and Opener.Switch.RemoteLockout are both enabled, so we opt the latter in here.
      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Opener.Switch.RemoteLockout"] });

      ratgdo.updateState({ id: "lock-lock_remotes", state: "LOCKED" });

      const door = accessory.getService(Service.GarageDoorOpener);

      assert.equal(door?.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED,
        "a LOCKED lock event lands as a SECURED lock current state on the garage door service");
      assert.equal(door?.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.SECURED,
        "a LOCKED lock event drives the lock target state to SECURED");

      const lockout = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_LOCKOUT);

      assert.equal(lockout?.getCharacteristic(Characteristic.On).value, true, "the lockout automation switch turns on when the remotes are locked out");
      assert.equal(loggedAt(entries, "info", "Wireless remotes are locked out"), true, "locking the remotes emits the locked-out deviation log");

      const lockPublish = mqtt?.publishes.find((entry) => entry.topic.endsWith("/lock"));

      assert.equal(lockPublish?.payload, "1", "the lock case publishes the numeric SECURED lock state (1) to the lock MQTT topic");
    });

    test("translates an UNLOCKED telemetry event into an UNSECURED lock, a permitted log, and an MQTT publish", () => {

      // Start from a LOCKED snapshot so the UNLOCKED event is a real transition rather than a no-op against the default-unlocked resting state.
      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeLockEvent("lock_remotes", LockState.LOCKED)]),
        mqtt: true });

      ratgdo.updateState({ id: "lock-lock_remotes", state: "UNLOCKED" });

      const door = accessory.getService(Service.GarageDoorOpener);

      assert.equal(door?.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED,
        "an UNLOCKED lock event lands as an UNSECURED lock current state on the garage door service");
      assert.equal(door?.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.UNSECURED,
        "an UNLOCKED lock event drives the lock target state to UNSECURED");
      assert.equal(loggedAt(entries, "info", "Wireless remotes are permitted"), true, "unlocking the remotes emits the permitted deviation log");

      const lockPublish = mqtt?.publishes.find((entry) => entry.topic.endsWith("/lock"));

      assert.equal(lockPublish?.payload, "0", "the lock case publishes the numeric UNSECURED lock state (0) to the lock MQTT topic");
    });

    test("ignores an UNLOCKED event that matches the current unlocked state, emitting no log and no MQTT publish", () => {

      // The resting Ratgdo snapshot is already unlocked, so an UNLOCKED event short-circuits at the already-at-state guard before any side effect runs.
      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      ratgdo.updateState({ id: "lock-lock_remotes", state: "UNLOCKED" });

      assert.equal(loggedAt(entries, "info", "Wireless remotes"), false, "an unchanged lock state produces no lock deviation log");
      assert.equal(mqtt?.publishes.some((entry) => entry.topic.endsWith("/lock")), false, "an unchanged lock state produces no lock MQTT publish");
    });

    test("warns and leaves state unchanged for an unrecognized lock state value", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      ratgdo.updateState({ id: "lock-lock_remotes", state: "JAMMED" });

      assert.equal(loggedAt(entries, "warn", "Unknown wireless remote lock state detected: JAMMED"), true,
        "an unrecognized lock state value logs a warning naming the offending value");

      const door = accessory.getService(Service.GarageDoorOpener);

      assert.equal(door?.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED,
        "an unrecognized lock state leaves the lock current state at its prior value");
      assert.equal(mqtt?.publishes.some((entry) => entry.topic.endsWith("/lock")), false, "an unrecognized lock state produces no lock MQTT publish");
    });

    test("ignores lock updates entirely when the Opener.Lock feature is disabled", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Opener.Lock"] });

      ratgdo.updateState({ id: "lock-lock_remotes", state: "LOCKED" });

      assert.equal(loggedAt(entries, "info", "Wireless remotes"), false, "a disabled lock feature suppresses the lock deviation log");
      assert.equal(loggedAt(entries, "warn", "Unknown wireless remote"), false, "a disabled lock feature bails before the unrecognized-state warning path");
      assert.equal(mqtt?.publishes.some((entry) => entry.topic.endsWith("/lock")), false, "a disabled lock feature produces no lock MQTT publish");
    });
  });

  describe("availability", () => {

    // Enable every sensor service that carries a StatusActive characteristic so the availability fan-out has services to write to. Motion is on by default; the
    // occupancy and Disco sensors are opt-in.
    const sensorOptions = [ "Enable.Disco.ContactSensor.Vehicle.Arriving", "Enable.Disco.ContactSensor.Vehicle.Leaving", "Enable.Disco.OccupancySensor.Vehicle.Presence",
      "Enable.Motion.OccupancySensor", "Enable.Opener.OccupancySensor" ];

    test("sets StatusActive true across every sensor service when the device comes online", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ userOptions: sensorOptions });

      // Drive offline first so the online transition is observable - the resting availability is already true at construction.
      ratgdo.updateState({ id: "availability", state: "offline" });
      ratgdo.updateState({ id: "availability", state: "online" });

      const statusActiveServices = [

        accessory.getService(Service.MotionSensor),
        accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_MOTION),
        accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN),
        accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE),
        accessory.getServiceById(Service.ContactSensor, RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING),
        accessory.getServiceById(Service.ContactSensor, RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING)
      ];

      for(const service of statusActiveServices) {

        assert.equal(service?.getCharacteristic(Characteristic.StatusActive).value, true, "an online availability event sets StatusActive true on each sensor service");
      }
    });

    test("sets StatusActive false across every sensor service when the device goes offline", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ userOptions: sensorOptions });

      ratgdo.updateState({ id: "availability", state: "offline" });

      const statusActiveServices = [

        accessory.getService(Service.MotionSensor),
        accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_MOTION),
        accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN),
        accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE),
        accessory.getServiceById(Service.ContactSensor, RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING),
        accessory.getServiceById(Service.ContactSensor, RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING)
      ];

      for(const service of statusActiveServices) {

        assert.equal(service?.getCharacteristic(Characteristic.StatusActive).value, false,
          "an offline availability event sets StatusActive false on each sensor service");
      }
    });

    test("logs the disconnect on the true-to-false availability transition", () => {

      const { entries, ratgdo } = buildRatgdoAccessory();

      ratgdo.updateState({ id: "availability", state: "offline" });

      assert.equal(loggedAt(entries, "info", "Ratgdo disconnected."), true, "going offline from the connected resting state emits the disconnect log");
    });

    test("does not emit the connected announcement, which the platform owns", () => {

      const { entries, ratgdo } = buildRatgdoAccessory();

      ratgdo.updateState({ id: "availability", state: "online" });

      assert.equal(loggedAt(entries, "info", "Ratgdo connected."), false,
        "the online availability case never emits the connected announcement - that lives in the platform");
    });

    test("refreshes the Model characteristic when the device comes online", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory();

      // Mutate the device model the way the platform does on reconnect, then confirm the online availability event re-pushes it through refreshModel().
      ratgdo.device.model = "9.9.9";
      ratgdo.updateState({ id: "availability", state: "online" });

      const info = accessory.getService(Service.AccessoryInformation);

      assert.equal(info?.getCharacteristic(Characteristic.Model).value, "Ratgdo 9.9.9",
        "an online availability event refreshes the Model characteristic from the device model");
    });
  });
});
