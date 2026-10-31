/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.hints.test.ts: Hints concern net for RatgdoAccessory - the buildHints() derivation that resolves every per-device feature option exactly once at
 * construction time and fixes it on the readonly public `ratgdo.hints` record (resolved once, never reassigned).
 *
 * buildHints() is private, so we assert it through its public surface: the readonly `hints` field the constructor assigns. Each test drives the REAL FeatureOptions
 * engine through the harness `userOptions` array, then reads the resolved hint back from `ratgdo.hints`. The net covers every contract: every boolean hint flips when its
 * option moves off its default while every sibling stays at default (asserted by a full-object deepEqual against the spelled-out default record); the variant gates
 * (disco* hints exist only on the Ratgdo variant, konnected* hints only on Konnected) hold even when the underlying option is enabled on the wrong variant; the
 * value-centric duration hints fall back to RATGDO_OCCUPANCY_DURATION by default and honor a userOptions override; and logName resolves through the platform's
 * resolveLogName (empty collapses to undefined). The read-only deviation log - the one side effect the constructor fires after hints resolve - is asserted from the
 * captured log entries.
 */
import { Characteristic, Service, buildRatgdoAccessory, makeKonnectedInitialState, makeRatgdoInitialState } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import { formatLogEntry, loggedAt, triggerSet } from "homebridge-plugin-utils/testing";
import { LockCommand } from "esphome-client";
import { RATGDO_OCCUPANCY_DURATION } from "./settings.ts";
import { RatgdoAccessory } from "./device.ts";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";

/* The fully-spelled hint record a default Ratgdo device resolves to. Spelling it out rather than deriving it from the production code makes this the test's independent
 * contract for "what every default is", and it doubles as the baseline every single-option test deviates exactly one field from. A Konnected device at default reads
 * the same record but for motionSensor: the disco* and konnected* gates all multiply against an option whose default is false, so both collapse to false on either
 * variant, while Motion defaults on and its gate is what turns it off for firmware that reports no motion.
 */
const DEFAULT_HINTS = {

  automationDimmer: false,
  automationSwitch: false,
  discoBattery: false,
  discoLaserSwitch: false,
  discoLedSwitch: false,
  discoVehicleArriving: false,
  discoVehicleLeaving: false,
  discoVehiclePresence: false,
  doorOpenOccupancyDuration: RATGDO_OCCUPANCY_DURATION,
  doorOpenOccupancySensor: false,
  konnectedPcwSwitch: false,
  konnectedStrobeSwitch: false,
  light: true,
  lock: true,
  lockoutSwitch: false,
  logLight: true,
  logMotion: true,
  logName: undefined,
  logObstruction: true,
  logOpener: true,
  logVehiclePresence: true,
  motionOccupancyDuration: RATGDO_OCCUPANCY_DURATION,
  motionOccupancySensor: false,
  motionSensor: true,
  readOnly: false
};

/* The single-option boolean derivation cases, expressed as data so the "flip exactly this hint, leave every sibling at default" contract is netted uniformly across the
 * whole option surface. Each case moves one feature option off its default via the named action and asserts the corresponding hint takes the new value while the rest of
 * the record matches DEFAULT_HINTS. The disco* cases run on the Ratgdo variant where the gate admits them; the konnected* gate is netted separately because it requires
 * the Konnected variant to flip at all.
 */
const booleanHintCases: { action: "Disable" | "Enable"; hint: keyof typeof DEFAULT_HINTS; option: string; value: boolean }[] = [

  { action: "Enable", hint: "automationDimmer", option: "Opener.Dimmer", value: true },
  { action: "Enable", hint: "automationSwitch", option: "Opener.Switch", value: true },
  { action: "Enable", hint: "discoBattery", option: "Disco.Battery", value: true },
  { action: "Enable", hint: "discoLaserSwitch", option: "Disco.Switch.Laser", value: true },
  { action: "Enable", hint: "discoLedSwitch", option: "Disco.Switch.Led", value: true },
  { action: "Enable", hint: "discoVehicleArriving", option: "Disco.ContactSensor.Vehicle.Arriving", value: true },
  { action: "Enable", hint: "discoVehicleLeaving", option: "Disco.ContactSensor.Vehicle.Leaving", value: true },
  { action: "Enable", hint: "discoVehiclePresence", option: "Disco.OccupancySensor.Vehicle.Presence", value: true },
  { action: "Enable", hint: "doorOpenOccupancySensor", option: "Opener.OccupancySensor", value: true },
  { action: "Disable", hint: "light", option: "Light", value: false },
  { action: "Disable", hint: "lock", option: "Opener.Lock", value: false },
  { action: "Enable", hint: "lockoutSwitch", option: "Opener.Switch.RemoteLockout", value: true },
  { action: "Disable", hint: "logLight", option: "Log.Light", value: false },
  { action: "Disable", hint: "logMotion", option: "Log.Motion", value: false },
  { action: "Disable", hint: "logObstruction", option: "Log.Obstruction", value: false },
  { action: "Disable", hint: "logOpener", option: "Log.Opener", value: false },
  { action: "Disable", hint: "logVehiclePresence", option: "Log.VehiclePresence", value: false },
  { action: "Enable", hint: "motionOccupancySensor", option: "Motion.OccupancySensor", value: true },
  { action: "Disable", hint: "motionSensor", option: "Motion", value: false },
  { action: "Enable", hint: "readOnly", option: "Opener.ReadOnly", value: true }
];

describe("RatgdoAccessory hints", () => {

  describe("default derivation", () => {

    test("resolves every hint at its documented default on a Ratgdo device", () => {

      const { ratgdo } = buildRatgdoAccessory();

      assert.deepEqual(ratgdo.hints, DEFAULT_HINTS, "an unconfigured Ratgdo device resolves the full default hint record");
    });

    test("resolves the defaults on a Konnected device but for the hints its firmware cannot serve", () => {

      const { ratgdo } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState() });

      assert.deepEqual(ratgdo.hints, { ...DEFAULT_HINTS, motionSensor: false },
        "an unconfigured Konnected device resolves the same defaults - the disco and konnected gates collapse to false - but for the motion its firmware never reports");
    });
  });

  describe("single-option boolean derivation", () => {

    for(const testCase of booleanHintCases) {

      test(testCase.action + "." + testCase.option + " moves only the " + testCase.hint + " hint", () => {

        const { ratgdo } = buildRatgdoAccessory({ userOptions: [testCase.action + "." + testCase.option] });
        const expected = { ...DEFAULT_HINTS, [testCase.hint]: testCase.value };

        assert.deepEqual(ratgdo.hints, expected, testCase.option + " flips its hint to " + String(testCase.value) + " and leaves every sibling hint at default");
      });
    }
  });

  describe("variant gating", () => {

    test("admits every disco hint on the Ratgdo variant when its option is enabled", () => {

      const { ratgdo } = buildRatgdoAccessory({ userOptions: [ "Enable.Disco.Battery", "Enable.Disco.Switch.Laser", "Enable.Disco.Switch.Led",
        "Enable.Disco.ContactSensor.Vehicle.Arriving", "Enable.Disco.ContactSensor.Vehicle.Leaving", "Enable.Disco.OccupancySensor.Vehicle.Presence" ] });

      assert.deepEqual({ discoBattery: ratgdo.hints.discoBattery, discoLaserSwitch: ratgdo.hints.discoLaserSwitch, discoLedSwitch: ratgdo.hints.discoLedSwitch,
        discoVehicleArriving: ratgdo.hints.discoVehicleArriving, discoVehicleLeaving: ratgdo.hints.discoVehicleLeaving,
        discoVehiclePresence: ratgdo.hints.discoVehiclePresence }, { discoBattery: true, discoLaserSwitch: true, discoLedSwitch: true, discoVehicleArriving: true,
        discoVehicleLeaving: true, discoVehiclePresence: true }, "every disco hint is true on a Ratgdo device once its feature option is enabled");
    });

    test("suppresses every disco hint on the Konnected variant even when its option is enabled", () => {

      const { ratgdo } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(),
        userOptions: [ "Enable.Disco.Battery", "Enable.Disco.Switch.Laser", "Enable.Disco.Switch.Led", "Enable.Disco.ContactSensor.Vehicle.Arriving",
          "Enable.Disco.ContactSensor.Vehicle.Leaving", "Enable.Disco.OccupancySensor.Vehicle.Presence" ] });

      assert.deepEqual({ discoBattery: ratgdo.hints.discoBattery, discoLaserSwitch: ratgdo.hints.discoLaserSwitch, discoLedSwitch: ratgdo.hints.discoLedSwitch,
        discoVehicleArriving: ratgdo.hints.discoVehicleArriving, discoVehicleLeaving: ratgdo.hints.discoVehicleLeaving,
        discoVehiclePresence: ratgdo.hints.discoVehiclePresence }, { discoBattery: false, discoLaserSwitch: false, discoLedSwitch: false, discoVehicleArriving: false,
        discoVehicleLeaving: false, discoVehiclePresence: false }, "the variant gate keeps every disco hint false on a Konnected device regardless of the option");
    });

    test("admits the konnected hints on the Konnected variant when their option is enabled", () => {

      const { ratgdo } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(),
        userOptions: [ "Enable.Konnected.Switch.Pcw", "Enable.Konnected.Switch.Strobe" ] });

      assert.deepEqual({ konnectedPcwSwitch: ratgdo.hints.konnectedPcwSwitch, konnectedStrobeSwitch: ratgdo.hints.konnectedStrobeSwitch },
        { konnectedPcwSwitch: true, konnectedStrobeSwitch: true }, "both konnected hints are true on a Konnected device once their feature option is enabled");
    });

    test("suppresses both motion hints on the Konnected variant even when the occupancy option is enabled", () => {

      const { ratgdo } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(),
        userOptions: ["Enable.Motion.OccupancySensor"] });

      assert.deepEqual({ motionOccupancySensor: ratgdo.hints.motionOccupancySensor, motionSensor: ratgdo.hints.motionSensor },
        { motionOccupancySensor: false, motionSensor: false },
        "the variant gate keeps both motion hints false on a Konnected device regardless of the option, Motion's own default-on included");
    });

    test("suppresses the konnected hints on the Ratgdo variant even when their option is enabled", () => {

      const { ratgdo } = buildRatgdoAccessory({ userOptions: [ "Enable.Konnected.Switch.Pcw", "Enable.Konnected.Switch.Strobe" ] });

      assert.deepEqual({ konnectedPcwSwitch: ratgdo.hints.konnectedPcwSwitch, konnectedStrobeSwitch: ratgdo.hints.konnectedStrobeSwitch },
        { konnectedPcwSwitch: false, konnectedStrobeSwitch: false }, "the variant gate keeps both konnected hints false on a Ratgdo device regardless of the option");
    });
  });

  describe("duration hints", () => {

    test("default both occupancy durations to RATGDO_OCCUPANCY_DURATION", () => {

      const { ratgdo } = buildRatgdoAccessory();

      assert.equal(ratgdo.hints.doorOpenOccupancyDuration, RATGDO_OCCUPANCY_DURATION, "the door-open occupancy duration defaults to the shared occupancy duration");
      assert.equal(ratgdo.hints.motionOccupancyDuration, RATGDO_OCCUPANCY_DURATION, "the motion occupancy duration defaults to the shared occupancy duration");
    });

    test("honor a door-open occupancy duration override from userOptions", () => {

      const { ratgdo } = buildRatgdoAccessory({ userOptions: ["Enable.Opener.OccupancySensor.Duration.600"] });

      assert.deepEqual(ratgdo.hints, { ...DEFAULT_HINTS, doorOpenOccupancyDuration: 600 },
        "the door-open duration override lands on its hint and leaves the motion duration at default");
    });

    test("honor a motion occupancy duration override from userOptions", () => {

      const { ratgdo } = buildRatgdoAccessory({ userOptions: ["Enable.Motion.OccupancySensor.Duration.45"] });

      assert.deepEqual(ratgdo.hints, { ...DEFAULT_HINTS, motionOccupancyDuration: 45 },
        "the motion duration override lands on its hint and leaves the door-open duration at default");
    });
  });

  describe("logName resolution", () => {

    test("resolves to undefined by default, the empty configured value collapsing to undefined", () => {

      const { ratgdo } = buildRatgdoAccessory();

      assert.equal(ratgdo.hints.logName, undefined, "an unconfigured Device.LogName (empty default value) collapses to an undefined logName hint");
    });

    test("resolves the configured Device.LogName value", () => {

      const { ratgdo } = buildRatgdoAccessory({ userOptions: ["Enable.Device.LogName.GarageLogger"] });

      assert.equal(ratgdo.hints.logName, "GarageLogger", "a configured Device.LogName value resolves straight onto the logName hint via the platform resolveLogName");
    });

    test("fronts the device log prefix when a logName is configured", () => {

      const { entries } = buildRatgdoAccessory({ userOptions: [ "Enable.Device.LogName.GarageLogger", "Enable.Opener.ReadOnly" ] });
      const readOnlyEntry = entries.find((entry) => formatLogEntry(entry).includes("Read-only mode"));

      assert.ok(readOnlyEntry, "the read-only deviation log fires so we have a log line to inspect the prefix on");
      assert.ok(formatLogEntry(readOnlyEntry).startsWith("GarageLogger: "), "the configured logName fronts every log line through the name getter's prefix");
    });
  });

  describe("read-only deviation logging", () => {

    test("fires the read-only deviation log when Opener.ReadOnly is enabled", () => {

      const { entries } = buildRatgdoAccessory({ userOptions: ["Enable.Opener.ReadOnly"] });

      assert.equal(loggedAt(entries, "info", "Read-only mode"), true, "enabling the off-by-default read-only option emits its deviation log at info level");
    });

    test("fires the read-only deviation log on a Konnected device when Opener.ReadOnly is enabled", () => {

      const { entries } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(),
        userOptions: ["Enable.Opener.ReadOnly"] });

      assert.equal(loggedAt(entries, "info", "Read-only mode"), true, "the read-only deviation log fires on a Konnected device too, since read-only is variant-agnostic");
    });

    test("stays silent on the read-only deviation log when Opener.ReadOnly is at its default", () => {

      const { entries } = buildRatgdoAccessory();

      assert.equal(loggedAt(entries, "info", "Read-only mode"), false, "leaving read-only at its disabled default emits no read-only deviation log");
    });
  });

  /* The lock hint is the one hint that decides whether a HomeKit characteristic exists at all, so its net asserts the resulting shape of the garage door service
   * rather than only the resolved hint. testCharacteristic is the right reader here because it answers presence without creating anything, which is the same
   * distinction the presence gate itself turns on.
   */
  describe("the wireless remote lock characteristic pair", () => {

    test("leaves both lock characteristics off the garage door service when Opener.Lock is disabled", () => {

      const { accessory } = buildRatgdoAccessory({ userOptions: ["Disable.Opener.Lock"] });
      const service = accessory.getService(Service.GarageDoorOpener);

      assert.ok(service, "the garage door service is configured regardless of the lock feature");
      assert.equal(service.testCharacteristic(Characteristic.LockCurrentState), false, "the current-state characteristic is absent with the lock feature off");
      assert.equal(service.testCharacteristic(Characteristic.LockTargetState), false, "the target-state characteristic is absent with the lock feature off");
    });

    test("carries both lock characteristics on the garage door service when Opener.Lock is enabled", () => {

      const { accessory } = buildRatgdoAccessory();
      const service = accessory.getService(Service.GarageDoorOpener);

      assert.ok(service, "the garage door service is configured");
      assert.equal(service.testCharacteristic(Characteristic.LockCurrentState), true, "the current-state characteristic is present at the lock feature's default");
      assert.equal(service.testCharacteristic(Characteristic.LockTargetState), true, "the target-state characteristic is present at the lock feature's default");
    });

    test("binds a live lock handler on a configure pass over a service that already carries the pair", async () => {

      const { accessory, client, platform, ratgdo } = buildRatgdoAccessory();
      const service = accessory.getService(Service.GarageDoorOpener);

      assert.ok(service, "the first pass configured the garage door service");
      assert.equal(service.testCharacteristic(Characteristic.LockTargetState), true,
        "the first pass leaves the pair present, so the second pass below is the one that meets an already-carried characteristic");

      /* Stand in for the handler the previous process bound with one that dispatches nothing, which is what makes this test able to tell the two outcomes apart: a
       * HAP characteristic keeps a single set handler, so a pass that skipped the bind would leave this inert one in place and the set below would reach no device.
       */
      let inertHandlerRan = false;

      service.getCharacteristic(Characteristic.LockTargetState).onSet((): void => {

        inertHandlerRan = true;
      });

      /* A second accessory over the SAME PlatformAccessory is what a cached accessory restored after a Homebridge restart looks like: the service and its
       * characteristics survive, and nothing bound in the previous process does. Constructing through the helper again would fabricate a fresh accessory and never
       * reach that state, so this repeats the helper's own platform cast against the handles it already returned.
       */
      const restored = new RatgdoAccessory(platform as unknown as ConstructorParameters<typeof RatgdoAccessory>[0], accessory, ratgdo.device,
        makeRatgdoInitialState());

      assert.ok(restored, "the restored accessory configures over the service it inherited");

      client.commands.length = 0;

      await triggerSet(service.getCharacteristic(Characteristic.LockTargetState), Characteristic.LockTargetState.SECURED);

      assert.equal(inertHandlerRan, false, "the restored pass replaced the inert handler rather than leaving the characteristic bound to it");
      assert.deepEqual(client.commands, [{ id: "lock-lock_remotes", payload: { command: LockCommand.LOCK } }],
        "setting the inherited target-state characteristic reaches the device, so the pass bound its own handler over a characteristic it did not create");
    });
  });
});
