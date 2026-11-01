/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.hints.test.ts: Hints concern net for RatgdoAccessory - the buildHints() derivation that resolves every per-device feature option exactly once at
 * construction time and fixes it on the readonly public `ratgdo.hints` record (resolved once, never reassigned).
 *
 * buildHints() is private, so we assert it through its public surface: the readonly `hints` field the constructor assigns. Each test drives the REAL FeatureOptions
 * engine through the harness `userOptions` array, then reads the resolved hint back from `ratgdo.hints`. The net covers every contract: every boolean hint flips when its
 * option moves off its default while every sibling stays at default (asserted by a full-object deepEqual against the spelled-out default record); the variant gates
 * (disco* hints exist only on the Ratgdo variant, konnected* hints only on Konnected) hold even when the underlying option is enabled on the wrong variant; the
 * value-centric duration hints fall back to RATGDO_OCCUPANCY_DURATION by default and honor a userOptions override; and the custom name resolves through HBPU's
 * custom-name rule, a name HomeKit can carry nothing of resolving to none. The deviation logs the constructor fires after hints resolve - read-only mode and the
 * custom name - are asserted from the captured log entries, as is the wiring of every option's deviation line: the logger each level writes through, the variant
 * check, the occupancy durations, and the event log toggles.
 */
import { Characteristic, Service, addRatgdoAccessory, buildRatgdoAccessory, customNameEntry, makeKonnectedInitialState, makeRatgdoInitialState,
  makeTestDevice } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import { linesAt, loggedAt, triggerSet } from "homebridge-plugin-utils/testing";
import { LockCommand } from "esphome-client";
import { RATGDO_OCCUPANCY_DURATION } from "./settings.ts";
import { RatgdoAccessory } from "./device.ts";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";

/* The fully-spelled hint record a default Ratgdo device resolves to. Spelling it out rather than deriving it from the production code makes this the test's independent
 * contract for "what every default is", and it doubles as the baseline every single-option test deviates exactly one field from. A Konnected device at default reads
 * the same record but for motionSensor and logVehiclePresence: the disco* and konnected* gates all multiply against an option whose default is false, so both collapse
 * to false on either variant, while Motion and the vehicle-presence log default on and the gate is what turns them off for firmware that reports neither.
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
  logObstruction: true,
  logOpener: true,
  logVehiclePresence: true,
  motionOccupancyDuration: RATGDO_OCCUPANCY_DURATION,
  motionOccupancySensor: false,
  motionSensor: true,
  nameOverride: null,
  readOnly: false,
  syncName: false
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
  { action: "Enable", hint: "readOnly", option: "Opener.ReadOnly", value: true },
  { action: "Enable", hint: "syncName", option: "Device.SyncName", value: true }
];

describe("RatgdoAccessory hints", () => {

  describe("default derivation", () => {

    test("resolves every hint at its documented default on a Ratgdo device", () => {

      const { ratgdo } = buildRatgdoAccessory();

      assert.deepEqual(ratgdo.hints, DEFAULT_HINTS, "an unconfigured Ratgdo device resolves the full default hint record");
    });

    test("resolves the defaults on a Konnected device but for the hints its firmware cannot serve", () => {

      const { ratgdo } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState() });

      assert.deepEqual(ratgdo.hints, { ...DEFAULT_HINTS, logVehiclePresence: false, motionSensor: false },
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

  describe("the custom name", () => {

    test("resolves the custom name set at the opener's MAC onto its hint, trimmed", () => {

      const { ratgdo } = buildRatgdoAccessory({ userOptions: [customNameEntry("  Workshop Door  ")] });

      assert.deepEqual(ratgdo.hints, { ...DEFAULT_HINTS, nameOverride: "Workshop Door" }, "the custom name lands on its hint trimmed and moves no other hint");
    });

    test("resolves a custom name HomeKit can carry nothing of to none", () => {

      const { ratgdo } = buildRatgdoAccessory({ userOptions: [customNameEntry("\u{1F319}")] });

      assert.equal(ratgdo.hints.nameOverride, null, "a custom name HomeKit's naming rule empties counts as no custom name at all");
    });

    test("logs the custom name it applies, as HomeKit's naming rule cleans it, and prefixes every line with it", () => {

      const { entries } = buildRatgdoAccessory({ userOptions: [customNameEntry("Workshop \u{1F319}")] });

      assert.deepEqual(linesAt(entries, "info"), ["Workshop: Custom HomeKit name set to Workshop."],
        "the one line the custom name draws names the name HomeKit carries, and the opener's own lines carry it as their prefix");
      assert.deepEqual(linesAt(entries, "warn"), [], "a custom name HomeKit can carry draws no warning");
    });

    test("warns of a custom name HomeKit can display nothing of, naming it as the user set it, and names the opener by its own name", () => {

      const { entries } = buildRatgdoAccessory({ userOptions: [customNameEntry("\u{1F319}")] });

      assert.deepEqual(linesAt(entries, "warn"), ["Test Ratgdo: The custom name \"\u{1F319}\" leaves nothing HomeKit can display, so it is not applied."],
        "the refusal is said once, quoting the value the user set, under the opener's own name");
      assert.deepEqual(linesAt(entries, "info"), [], "and no custom name is reported as set");
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

  /* The plugin's wiring of HBPU's logFeature, run through the REAL engine. HBPU owns which level earns a line, so these assert what this plugin decides: the logger each
   * level writes through, the variant check, and which options report at all. The two loggers are told apart by the prefix, since the opener's prefixes its name and
   * the plugin's carries none.
   */
  describe("feature-option deviation lines", () => {

    const SECOND_OPENER = makeTestDevice({ mac: "112233445566", name: "Second Ratgdo" });

    test("a global setting writes one line through the plugin's logger, however many openers it governs", () => {

      const { entries, platform } = buildRatgdoAccessory({ userOptions: ["Enable.Opener.ReadOnly"] });

      addRatgdoAccessory(platform, SECOND_OPENER);

      assert.deepEqual(linesAt(entries, "info"), ["Read-only mode enabled."], "both openers are read-only, and the setting that made them so is announced once");
    });

    test("a setting on one opener writes through that opener's logger", () => {

      const { entries } = buildRatgdoAccessory({ userOptions: ["Enable.Opener.ReadOnly.AABBCCDDEEFF"] });

      assert.deepEqual(linesAt(entries, "info"), ["Test Ratgdo: Read-only mode enabled."], "the line names the opener the setting was made on");
    });

    test("an opener overriding a global setting back to the default says so itself, and the global line still reaches the openers that follow it", () => {

      const { entries, platform } = buildRatgdoAccessory({ userOptions: [ "Enable.Opener.ReadOnly", "Disable.Opener.ReadOnly.AABBCCDDEEFF" ] });

      assert.deepEqual(linesAt(entries, "info"), ["Test Ratgdo: Read-only mode disabled."], "the overriding opener reports its own setting and nothing global");

      addRatgdoAccessory(platform, SECOND_OPENER);

      assert.deepEqual(linesAt(entries, "info"), [ "Test Ratgdo: Read-only mode disabled.", "Read-only mode enabled." ],
        "the opener that inherits the global setting announces it through the plugin's logger");
    });

    /* Options the catalog declares for the other variant, enabled or disabled globally and on the opener. Each stays silent because the opener has no such hardware,
     * which is what keeps a global setting from announcing a feature on an install holding no opener that has it.
     */
    const OTHER_VARIANT_CASES: { option: string; variant: RatgdoVariant }[] = [

      { option: "Enable.Konnected.Switch.Pcw", variant: RatgdoVariant.RATGDO },
      { option: "Enable.Konnected.Switch.Pcw.AABBCCDDEEFF", variant: RatgdoVariant.RATGDO },
      { option: "Enable.Konnected.Switch.Strobe", variant: RatgdoVariant.RATGDO },
      { option: "Enable.Disco.Battery", variant: RatgdoVariant.KONNECTED },
      { option: "Enable.Disco.Battery.AABBCCDDEEFF", variant: RatgdoVariant.KONNECTED },
      { option: "Enable.Disco.ContactSensor.Vehicle.Arriving", variant: RatgdoVariant.KONNECTED },
      { option: "Enable.Disco.ContactSensor.Vehicle.Leaving", variant: RatgdoVariant.KONNECTED },
      { option: "Enable.Disco.OccupancySensor.Vehicle.Presence", variant: RatgdoVariant.KONNECTED },
      { option: "Enable.Disco.Switch.Laser", variant: RatgdoVariant.KONNECTED },
      { option: "Enable.Disco.Switch.Led", variant: RatgdoVariant.KONNECTED },
      { option: "Disable.Log.VehiclePresence", variant: RatgdoVariant.KONNECTED },
      { option: "Disable.Motion", variant: RatgdoVariant.KONNECTED },
      { option: "Enable.Motion.OccupancySensor", variant: RatgdoVariant.KONNECTED }
    ];

    for(const { option, variant } of OTHER_VARIANT_CASES) {

      test(option + " writes nothing from a " + variant + " opener", () => {

        const { entries } = buildRatgdoAccessory({ device: { variant }, userOptions: [option] });

        assert.deepEqual(linesAt(entries, "info"), [], "the opener has no such hardware to report on");
      });
    }

    test("a hardware-specific option reports from an opener that has the hardware", () => {

      const ratgdo = buildRatgdoAccessory({ userOptions: [ "Disable.Motion", "Enable.Disco.Battery" ] });
      const konnected = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, userOptions: ["Enable.Konnected.Switch.Pcw"] });

      assert.deepEqual(linesAt(ratgdo.entries, "info"), [ "Motion sensor disabled.", "Ratgdo (ESP32) backup battery status enabled." ],
        "a Ratgdo opener reports the Motion and Disco settings");
      assert.deepEqual(linesAt(konnected.entries, "info"), ["Konnected pre-close warning switch enabled."], "a Konnected opener reports the Konnected settings");
    });

    test("on a mixed install a global hardware-specific setting is announced when the first opener with the hardware arrives", () => {

      const { entries, platform } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, userOptions: ["Enable.Disco.Battery"] });

      assert.deepEqual(linesAt(entries, "info"), [], "the Konnected opener says nothing about a Disco feature");

      addRatgdoAccessory(platform, SECOND_OPENER);

      assert.deepEqual(linesAt(entries, "info"), ["Ratgdo (ESP32) backup battery status enabled."], "the Ratgdo opener announces it");
    });

    // Each event log toggle defaults on, so turning one off is the setting a reader wants to see when the events they expected stop appearing.
    const EVENT_LOG_CASES: { line: string; option: string }[] = [

      { line: "Light event logging disabled.", option: "Log.Light" },
      { line: "Motion event logging disabled.", option: "Log.Motion" },
      { line: "Obstruction event logging disabled.", option: "Log.Obstruction" },
      { line: "Opener event logging disabled.", option: "Log.Opener" },
      { line: "Vehicle presence event logging disabled.", option: "Log.VehiclePresence" }
    ];

    for(const { line, option } of EVENT_LOG_CASES) {

      test("disabling " + option + " globally reports through the plugin's logger, and on the opener through the opener's", () => {

        assert.deepEqual(linesAt(buildRatgdoAccessory({ userOptions: ["Disable." + option] }).entries, "info"), [line]);
        assert.deepEqual(linesAt(buildRatgdoAccessory({ userOptions: ["Disable." + option + ".AABBCCDDEEFF"] }).entries, "info"), ["Test Ratgdo: " + line]);
      });
    }

    // The occupancy durations, as the deviation lines they earn. Each case lists the entries configured beside the expected duration line, if any.
    const DURATION_CASES: { expected: string[]; name: string; options: string[]; variant?: RatgdoVariant }[] = [

      { expected: ["Motion occupancy sensor duration set to 45 s."], name: "a global motion duration names the plugin's logger, rendered",
        options: [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Duration.45" ] },
      { expected: ["Door open indicator occupancy sensor duration set to 10 min."], name: "a global door-open duration names the plugin's logger, rendered",
        options: [ "Enable.Opener.OccupancySensor", "Enable.Opener.OccupancySensor.Duration.600" ] },
      { expected: ["Test Ratgdo: Motion occupancy sensor duration set to 45 s."], name: "a duration set on the opener names the opener's logger",
        options: [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Duration.AABBCCDDEEFF.45" ] },
      { expected: [], name: "a duration at the default is silent", options: [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Duration.300" ] },
      { expected: [], name: "an unset duration is silent", options: [ "Enable.Motion.OccupancySensor", "Enable.Opener.OccupancySensor" ] },
      { expected: [], name: "a duration with its sensor off is silent",
        options: [ "Enable.Motion.OccupancySensor.Duration.45", "Enable.Opener.OccupancySensor.Duration.600" ] },
      { expected: [], name: "a motion duration on hardware with no motion is silent",
        options: [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Duration.45" ], variant: RatgdoVariant.KONNECTED }
    ];

    for(const { expected, name, options, variant } of DURATION_CASES) {

      test(name, () => {

        const { entries } = buildRatgdoAccessory({ device: { variant: variant ?? RatgdoVariant.RATGDO }, userOptions: options });

        assert.deepEqual(linesAt(entries, "info").filter((line) => line.includes("duration")), expected);
      });
    }
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
