/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.updatestate-lock.test.ts: updateState() concern net for the wireless remote lock and the availability transition. These two cases are the lock state
 * translation (LOCKED / UNLOCKED to HomeKit's SECURED / UNSECURED, the lockout automation switch, the deviation log, and the MQTT publish) and the connection
 * availability fan-out (the flip, and the disconnect log that the device - not the platform - owns), beside the per-session identity refresh the platform calls,
 * which the availability transition leaves alone. The file also nets StatusActive as its own concern: it holds true on every sensor service through the
 * availability transition, which never writes it.
 */
import { Characteristic, Service, buildRatgdoAccessory, makeLockEvent, makeRatgdoInitialState } from "./testing.helpers.ts";
import { assertNoUnhandledRejections, hasGetHandler, loggedAt, settle } from "homebridge-plugin-utils/testing";
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
      assert.equal(door.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.SECURED,
        "a LOCKED lock event drives the lock target state to SECURED");

      const lockout = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_LOCKOUT);

      assert.equal(lockout?.getCharacteristic(Characteristic.On).value, true, "the lockout automation switch turns on when the remotes are locked out");
      assert.equal(loggedAt(entries, "info", "Wireless remotes are locked out"), true, "locking the remotes emits the locked-out deviation log");

      const lockPublish = mqtt?.published.find((entry) => entry.topic.endsWith("/lock"));

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
      assert.equal(door.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.UNSECURED,
        "an UNLOCKED lock event drives the lock target state to UNSECURED");
      assert.equal(loggedAt(entries, "info", "Wireless remotes are permitted"), true, "unlocking the remotes emits the permitted deviation log");

      const lockPublish = mqtt?.published.find((entry) => entry.topic.endsWith("/lock"));

      assert.equal(lockPublish?.payload, "0", "the lock case publishes the numeric UNSECURED lock state (0) to the lock MQTT topic");
    });

    test("ignores an UNLOCKED event that matches the current unlocked state, emitting no log and no MQTT publish", () => {

      // The resting Ratgdo snapshot is already unlocked, so an UNLOCKED event short-circuits at the already-at-state guard before any side effect runs.
      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      ratgdo.updateState({ id: "lock-lock_remotes", state: "UNLOCKED" });

      assert.equal(loggedAt(entries, "info", "Wireless remotes"), false, "an unchanged lock state produces no lock deviation log");
      assert.equal(mqtt?.published.some((entry) => entry.topic.endsWith("/lock")), false, "an unchanged lock state produces no lock MQTT publish");
    });

    test("warns and leaves state unchanged for an unrecognized lock state value", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      ratgdo.updateState({ id: "lock-lock_remotes", state: "JAMMED" });

      assert.equal(loggedAt(entries, "warn", "Unknown wireless remote lock state detected: JAMMED"), true,
        "an unrecognized lock state value logs a warning naming the offending value");

      const door = accessory.getService(Service.GarageDoorOpener);

      assert.equal(door?.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED,
        "an unrecognized lock state leaves the lock current state at its prior value");
      assert.equal(mqtt?.published.some((entry) => entry.topic.endsWith("/lock")), false, "an unrecognized lock state produces no lock MQTT publish");
    });

    test("ignores lock updates entirely when the Opener.Lock feature is disabled", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Opener.Lock"] });

      ratgdo.updateState({ id: "lock-lock_remotes", state: "LOCKED" });

      assert.equal(loggedAt(entries, "info", "Wireless remotes"), false, "a disabled lock feature suppresses the lock deviation log");
      assert.equal(loggedAt(entries, "warn", "Unknown wireless remote"), false, "a disabled lock feature bails before the unrecognized-state warning path");
      assert.equal(mqtt?.published.some((entry) => entry.topic.endsWith("/lock")), false, "a disabled lock feature produces no lock MQTT publish");
    });

    test("survives a broker that refuses the lock publish, reporting it once at error level without floating a rejection", async () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the MQTT double is attached when mqtt is enabled");

      /* Arm the refusal lever so the publish the lock transition issues is rejected the way an unreachable broker rejects one. The accessory publishes through the
       * client's guarded path, which answers a failure in the log rather than to its caller, so the whole contract under test is that nothing escapes: the
       * updateState call below returns normally, no rejection reaches the process, and the user learns about it on one error line.
       */
      mqtt.publishRejection = new Error("the broker refused the message");

      await assertNoUnhandledRejections(async () => {

        ratgdo.updateState({ id: "lock-lock_remotes", state: "LOCKED" });

        // The guarded path routes its failure on a later microtask, so the log line and the counter are read only once the turn has drained.
        await settle();
      });

      assert.equal(mqtt.rejectedPublishes, 1, "the refused publish is counted rather than recorded");
      assert.equal(mqtt.published.some((entry) => entry.topic.endsWith("/lock")), false, "a refused publish records nothing, so no lock payload lands");
      assert.equal(loggedAt(entries, "error", "Unable to publish to the MQTT topic"), true,
        "the guarded path reports a genuine publish failure once, at error level, naming the topic");
    });
  });

  describe("availability", () => {

    // Enable every sensor service that carries a StatusActive characteristic so the hold-true row below reads each of them through the availability cycle. Motion is
    // on by default; the occupancy and Disco sensors are opt-in.
    const sensorOptions = [ "Enable.Disco.ContactSensor.Vehicle.Arriving", "Enable.Disco.ContactSensor.Vehicle.Leaving", "Enable.Disco.OccupancySensor.Vehicle.Presence",
      "Enable.Motion.OccupancySensor", "Enable.Opener.OccupancySensor" ];

    test("holds StatusActive true on every sensor service through an offline-then-online cycle, with no read handler bound", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ userOptions: sensorOptions });
      const sensors = [

        accessory.getService(Service.MotionSensor),
        accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_MOTION),
        accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN),
        accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE),
        accessory.getServiceById(Service.ContactSensor, RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING),
        accessory.getServiceById(Service.ContactSensor, RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING)
      ];

      // Read every sensor's StatusActive at one point of the cycle: true, and never backed by a read handler that could answer something else.
      const assertHeldTrue = (phase: string): void => {

        for(const service of sensors) {

          assert.ok(service, "every sensor service is configured");

          const statusActive = service.getCharacteristic(Characteristic.StatusActive);

          assert.equal(statusActive.value, true, "StatusActive reads true on " + service.displayName + " " + phase);
          assert.equal(hasGetHandler(statusActive), false, "StatusActive binds no read handler on " + service.displayName);
        }
      };

      assertHeldTrue("at construction");

      ratgdo.updateState({ id: "availability", state: "offline" });
      assertHeldTrue("while the opener is lost");

      ratgdo.updateState({ id: "availability", state: "online" });
      assertHeldTrue("once the opener is back");
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

    test("the identity refresh re-pushes Model and FirmwareRevision from the device record", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory();

      /* The platform refreshes the identity on every session the client begins, whether or not an outage preceded it: it rewrites the model and the firmware version
       * from the session's device info and calls the accessory's refresh, which the platform lifecycle suite drives. Mutate the model and the firmware version the way
       * the platform does, then confirm the refresh re-pushes them.
       */
      ratgdo.device.firmwareVersion = "2025.1.0";
      ratgdo.device.model = "9.9.9";
      ratgdo.refreshInfo();

      const info = accessory.getService(Service.AccessoryInformation);

      assert.equal(info?.getCharacteristic(Characteristic.Model).value, "Ratgdo 9.9.9",
        "the per-session refresh re-pushes the Model characteristic from the device model");
      assert.equal(info.getCharacteristic(Characteristic.FirmwareRevision).value, "2025.1.0",
        "the per-session refresh re-pushes the FirmwareRevision characteristic from the device firmware version");
    });

    test("leaves the identity to the per-session refresh, so an availability event alone re-pushes neither identity field", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory();

      // A session that heals before any verdict makes no availability statement at all, so the identity cannot be the availability case's to refresh.
      ratgdo.device.firmwareVersion = "2025.1.0";
      ratgdo.device.model = "9.9.9";
      ratgdo.updateState({ id: "availability", state: "offline" });
      ratgdo.updateState({ id: "availability", state: "online" });

      const info = accessory.getService(Service.AccessoryInformation);

      assert.equal(info?.getCharacteristic(Characteristic.Model).value, "Ratgdo 1.0.0", "an availability cycle leaves the Model characteristic as it was");
      assert.equal(info.getCharacteristic(Characteristic.FirmwareRevision).value, "2.0.0", "an availability cycle leaves the FirmwareRevision characteristic as it was");
    });
  });
});
