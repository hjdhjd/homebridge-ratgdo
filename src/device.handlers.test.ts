/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.handlers.test.ts: Characteristic get/set handler concern net for RatgdoAccessory - the onGet read handlers and the onSet write handlers each configureXxx
 * binds onto its service. These read through the same lens HomeKit uses (triggerGet / triggerSet) rather than the cached characteristic value, so a getter wired to the
 * wrong status field or a setter that dispatches the wrong command is caught here. Command-dispatch handlers shared via toggleOnSet (light, laser, led, strobe) and the
 * lock / pre-close-warning / door target handlers are netted in device.command.test.ts; this file covers the getters plus the bespoke dimmer / opener-switch / lockout
 * setters that command.test does not.
 *
 * It also holds the lost-opener walk: on a fully loaded accessory of each variant, every characteristic carrying a handler is driven while the opener cannot be
 * reached, and each read and write must refuse with the HAP status error HomeKit renders as No Response, answering again once the opener is back. StatusActive is
 * read here too, held true on every sensor service with no read handler of its own.
 */
import { Characteristic, Service, buildRatgdoAccessory, makeCoverEvent, makeKonnectedInitialState, makeLightEvent, makeLockEvent, makeRatgdoInitialState,
  makeSwitchEvent } from "./testing.helpers.ts";
import { LockCommand, LockState } from "esphome-client";
import { RatgdoService, RatgdoVariant } from "./types.ts";
import { describe, test } from "node:test";
import { hapStatus, hasGetHandler, hasSetHandler, present, triggerGet, triggerSet } from "homebridge-plugin-utils/testing";
import type { BuildRatgdoAccessoryOptions } from "./testing.helpers.ts";
import type { CharacteristicValue } from "homebridge";
import { HAPStatus } from "homebridge-plugin-utils";
import type { TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";

// Enable every optional Ratgdo-variant service so a single accessory exposes the full getter surface. Light, Motion, and Opener.Lock default on, so they need no flag.
const ALL_RATGDO_OPTIONS = [

  "Enable.Disco.Battery",
  "Enable.Disco.ContactSensor.Vehicle.Arriving",
  "Enable.Disco.ContactSensor.Vehicle.Leaving",
  "Enable.Disco.OccupancySensor.Vehicle.Presence",
  "Enable.Disco.Switch.Laser",
  "Enable.Disco.Switch.Led",
  "Enable.Motion.OccupancySensor",
  "Enable.Opener.Dimmer",
  "Enable.Opener.OccupancySensor",
  "Enable.Opener.Switch",
  "Enable.Opener.Switch.RemoteLockout"
];

// Enable every Konnected-only switch, the optional services that variant adds over the shared opener surface.
const ALL_KONNECTED_OPTIONS = [ "Enable.Konnected.Switch.Pcw", "Enable.Konnected.Switch.Strobe" ];

// The service kinds that carry StatusActive, by HAP UUID. A sensor is found by its kind rather than by the characteristic under test, so a sensor that missed the write
// is still read.
const SENSOR_KINDS: readonly string[] = [ Service.ContactSensor.UUID, Service.MotionSensor.UUID, Service.OccupancySensor.UUID ];

/* A write for each characteristic kind the lost-opener walk meets, keyed by HAP UUID. Each differs from the resting value a fresh accessory is born with, so a refused
 * write HAP cached anyway would show as a changed value, and each reaches its handler when the opener is reachable. The walk's evidence for each handler is its
 * rejection, and the empty command list is the one check the walk's writes share.
 */
const WRITES = new Map<string, CharacteristicValue>([

  [ Characteristic.Brightness.UUID, 50 ],
  [ Characteristic.LockTargetState.UUID, Characteristic.LockTargetState.SECURED ],
  [ Characteristic.On.UUID, true ],
  [ Characteristic.TargetDoorState.UUID, Characteristic.TargetDoorState.OPEN ]
]);

/* The fully loaded accessory of each variant the lost-opener walk runs over. The Ratgdo accessory carries every optional Ratgdo service and the Konnected one adds the
 * Konnected switches, so every handler the accessory binds is on at least one of them. The light's wire id differs by variant, which the recovery row reads.
 */
const LOADED_VARIANTS: readonly { label: string; lightId: string; options: BuildRatgdoAccessoryOptions }[] = [

  { label: "Ratgdo", lightId: "light-light", options: { userOptions: ALL_RATGDO_OPTIONS } },
  { label: "Konnected", lightId: "light-garage_light", options: { device: { variant: RatgdoVariant.KONNECTED }, userOptions: ALL_KONNECTED_OPTIONS } }
];

// A HAP characteristic as the runtime's namespace constructs it, the type the walk carries.
type HapCharacteristic = InstanceType<typeof Characteristic>;

// Each entry is one characteristic the walk drives, carrying the service and kind it was found under so a failure names it.
interface Handled {

  characteristic: HapCharacteristic;
  where: string;
}

/* This returns every characteristic on an accessory that carries the production handler the predicate selects, in service order. HAP binds AccessoryInformation's
 * Identify itself, with a set listener of its own that the accessory never binds, so the walk passes over it: it is no handler the opener's reachability governs.
 */
function handled(accessory: TestPlatformAccessory, bound: (characteristic: HapCharacteristic) => boolean): Handled[] {

  return accessory.services.flatMap((service) => service.characteristics.filter((characteristic) => (characteristic.UUID !== Characteristic.Identify.UUID) &&
    bound(characteristic)).map((characteristic) => ({ characteristic, where: service.displayName + " " + characteristic.displayName })));
}

// Every refusal is validated here: it must be a deliberate refusal, never a handler fault HAP reports at the same status, and it must carry the status HomeKit
// renders as No Response.
const isNoResponse = hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

describe("RatgdoAccessory characteristic getters (onGet read lens)", () => {

  // One fully-loaded accessory: door open, remotes locked, light/laser/led on. Each getter is read through triggerGet - the path HomeKit invokes - not the cached value.
  const built = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([ makeCoverEvent("door", 1), makeLightEvent("light", true),
    makeLockEvent("lock_remotes", LockState.LOCKED), makeSwitchEvent("laser", true), makeSwitchEvent("led", true) ]), userOptions: ALL_RATGDO_OPTIONS });
  const accessory = built.accessory;

  test("the garage door getters report the current door and obstruction state", async () => {

    const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");

    assert.equal(await triggerGet(door.getCharacteristic(Characteristic.CurrentDoorState)), Characteristic.CurrentDoorState.OPEN,
      "CurrentDoorState onGet returns the open door state");
    assert.equal(await triggerGet(door.getCharacteristic(Characteristic.ObstructionDetected)), false, "ObstructionDetected onGet returns the clear obstruction state");
  });

  test("the light getter reports the light state", async () => {

    const light = present(accessory.getService(Service.Lightbulb), "the light service");

    assert.equal(await triggerGet(light.getCharacteristic(Characteristic.On)), true, "the light On onGet returns the on state");
  });

  test("the automation dimmer getters report the open state and door position", async () => {

    const dimmer = present(accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION), "the automation dimmer");

    assert.equal(await triggerGet(dimmer.getCharacteristic(Characteristic.On)), true, "the dimmer On onGet is true for any non-closed door");
    assert.equal(await triggerGet(dimmer.getCharacteristic(Characteristic.Brightness)), 100, "the dimmer Brightness onGet returns the door position percentage");
  });

  test("the automation opener switch getter reports the open state", async () => {

    const opener = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION), "the automation opener switch");

    assert.equal(await triggerGet(opener.getCharacteristic(Characteristic.On)), true, "the opener switch On onGet is true for any non-closed door");
  });

  test("the backup battery getter reports the charging state", async () => {

    const battery = present(accessory.getService(Service.Battery), "the backup battery service");

    assert.equal(await triggerGet(battery.getCharacteristic(Characteristic.ChargingState)), Characteristic.ChargingState.NOT_CHARGING,
      "the battery ChargingState onGet returns the resting charging state");
  });

  test("the disco laser and led switch getters report their switch state", async () => {

    const laser = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_DISCO_LASER), "the laser switch");
    const led = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_DISCO_LED), "the led switch");

    assert.equal(await triggerGet(laser.getCharacteristic(Characteristic.On)), true, "the laser On onGet returns the on state");
    assert.equal(await triggerGet(led.getCharacteristic(Characteristic.On)), true, "the led On onGet returns the on state");
  });

  test("the lockout switch getter reports whether remotes are locked out", async () => {

    const lockout = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_LOCKOUT), "the lockout switch");

    assert.equal(await triggerGet(lockout.getCharacteristic(Characteristic.On)), true, "the lockout On onGet is true when the remote lock is secured");
  });

  test("every sensor service carries StatusActive held true with no read handler", () => {

    const sensors = accessory.services.filter((service) => SENSOR_KINDS.includes(service.UUID));

    assert.equal(sensors.length, 6, "a fully loaded Ratgdo accessory carries every sensor service");

    for(const sensor of sensors) {

      const statusActive = sensor.getCharacteristic(Characteristic.StatusActive);

      assert.equal(statusActive.value, true, "StatusActive reads true on " + sensor.displayName);
      assert.equal(hasGetHandler(statusActive), false, "StatusActive binds no read handler on " + sensor.displayName);
    }
  });

  test("the reachability accessor follows the same flag in both directions", () => {

    /* The one field of the status record the platform reads from outside the accessory, so it is held to the same flag every handler reads to decide whether the
     * opener answers, rather than to a second copy of it. A fresh accessory is born online, because the platform constructs one only after a connection has
     * captured its state.
     */
    const { ratgdo } = buildRatgdoAccessory();

    assert.equal(ratgdo.isOnline, true, "an accessory constructed from a captured snapshot is reachable");

    ratgdo.updateState({ id: "availability", state: "offline" });

    assert.equal(ratgdo.isOnline, false, "and a disconnect the platform announces is what makes it unreachable");
  });
});

describe("RatgdoAccessory Konnected getters (onGet read lens)", () => {

  const built = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState([makeSwitchEvent("str_output", true)]),
    userOptions: ALL_KONNECTED_OPTIONS });
  const accessory = built.accessory;

  test("the pre-close warning getter always reports off (it is a momentary control)", async () => {

    const pcw = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_KONNECTED_PCW), "the pre-close warning switch");

    assert.equal(await triggerGet(pcw.getCharacteristic(Characteristic.On)), false,
      "the pre-close warning On onGet is always false - it is momentary, not a persistent state");
  });

  test("the strobe getter reports the strobe state", async () => {

    const strobe = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_KONNECTED_STROBE), "the strobe switch");

    assert.equal(await triggerGet(strobe.getCharacteristic(Characteristic.On)), true, "the strobe On onGet returns the on state");
  });
});

describe("RatgdoAccessory characteristic setters (onSet write lens)", () => {

  test("the dimmer On setter closes the door on false and no-ops on true", async () => {

    const { accessory, client } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]), userOptions: ["Enable.Opener.Dimmer"] });
    const dimmer = present(accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION), "the automation dimmer");

    await triggerSet(dimmer.getCharacteristic(Characteristic.On), true);

    assert.equal(client.commands.length, 0, "turning the dimmer On does not dispatch - opening is driven by the Brightness setter");

    await triggerSet(dimmer.getCharacteristic(Characteristic.On), false);

    assert.deepEqual(client.commands.at(-1), { id: "cover-door", payload: { position: 0 } }, "turning the dimmer Off closes the door");
  });

  test("the dimmer Brightness setter drives the door to the requested position", async () => {

    const { accessory, client } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 0)]), userOptions: ["Enable.Opener.Dimmer"] });

    const dimmer = present(accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION), "the automation dimmer");

    await triggerSet(dimmer.getCharacteristic(Characteristic.Brightness), 50);

    assert.deepEqual(client.commands.at(-1), { id: "cover-door", payload: { position: 0.5 } }, "a 50% brightness drives the door to a half-open position");
  });

  test("the automation opener switch setter opens and closes the door", async () => {

    const { accessory, client } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 0)]), userOptions: ["Enable.Opener.Switch"] });
    const opener = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION), "the automation opener switch");

    await triggerSet(opener.getCharacteristic(Characteristic.On), true);

    assert.deepEqual(client.commands.at(-1), { id: "cover-door", payload: { position: 1 } }, "turning the opener switch on opens the door");
  });

  test("the lockout switch setter locks and unlocks the wireless remotes", async () => {

    const { accessory, client } = buildRatgdoAccessory({ userOptions: ["Enable.Opener.Switch.RemoteLockout"] });
    const lockout = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_LOCKOUT), "the lockout switch");

    await triggerSet(lockout.getCharacteristic(Characteristic.On), true);

    assert.deepEqual(client.commands.at(-1), { id: "lock-lock_remotes", payload: { command: LockCommand.LOCK } }, "turning the lockout switch on locks the remotes");

    await triggerSet(lockout.getCharacteristic(Characteristic.On), false);

    assert.deepEqual(client.commands.at(-1), { id: "lock-lock_remotes", payload: { command: LockCommand.UNLOCK } }, "turning the lockout switch off unlocks the remotes");
  });
});

describe("RatgdoAccessory while the opener cannot be reached", () => {

  for(const { label, lightId, options } of LOADED_VARIANTS) {

    test("the " + label + " accessory refuses every read with the status HomeKit renders as No Response", async (t) => {

      const { accessory, ratgdo } = buildRatgdoAccessory(options);

      ratgdo.updateState({ id: "availability", state: "offline" });

      const reads = handled(accessory, hasGetHandler);

      t.diagnostic("The " + label + " walk drove " + reads.length.toString() + " read handlers.");
      assert.ok(reads.length > 0, "the walk visits at least one read handler on the " + label + " accessory, and it visited " + reads.length.toString());

      await Promise.all(reads.map(({ characteristic, where }) => assert.rejects(triggerGet(characteristic), isNoResponse,
        where + " refuses its read while the opener is lost")));
    });

    test("the " + label + " accessory refuses every write before dispatching it, leaving each cached value as it was", async (t) => {

      const { accessory, client, ratgdo } = buildRatgdoAccessory(options);

      ratgdo.updateState({ id: "availability", state: "offline" });

      const writes = handled(accessory, hasSetHandler);
      const before = writes.map(({ characteristic }) => characteristic.value);
      let refused = 0;

      t.diagnostic("The " + label + " walk drove " + writes.length.toString() + " write handlers.");
      assert.ok(writes.length > 0, "the walk visits at least one write handler on the " + label + " accessory, and it visited " + writes.length.toString());

      await Promise.all(writes.map(async ({ characteristic, where }) => {

        const write = WRITES.get(characteristic.UUID);

        assert.ok(write !== undefined, "the walk has a write for " + where);
        assert.notEqual(write, characteristic.value, "the write to " + where + " differs from its cached value, so a write HAP cached would show");

        await assert.rejects(triggerSet(characteristic, write), isNoResponse, where + " refuses its write while the opener is lost");

        refused++;
      }));

      assert.equal(refused, writes.length, "every write handler the walk met refused its write");
      assert.deepEqual(writes.map(({ characteristic }) => characteristic.value), before, "no refused write changed a cached value");
      assert.deepEqual(client.commands, [], "no refused write reached the client");
    });

    test("the " + label + " accessory answers again once the opener is back, with no rewiring", async () => {

      const { accessory, client, ratgdo } = buildRatgdoAccessory(options);
      const reads = handled(accessory, hasGetHandler);
      const light = accessory.getService(Service.Lightbulb)?.getCharacteristic(Characteristic.On);

      assert.ok(light, "the " + label + " accessory carries the light");

      ratgdo.updateState({ id: "availability", state: "offline" });

      await assert.rejects(triggerGet(light), isNoResponse, "the light refuses its read while the opener is lost");

      ratgdo.updateState({ id: "availability", state: "online" });

      await Promise.all(reads.map(({ characteristic, where }) => assert.doesNotReject(triggerGet(characteristic), where + " answers its read once the opener is back")));
      await triggerSet(light, true);

      assert.deepEqual(client.commands, [{ id: lightId, payload: { state: true } }], "the light's write dispatches one command once the opener is back");
    });
  }

  test("an accessory whose client is momentarily unavailable still answers reads, because the status record decides and not the client", async () => {

    const { accessory, ratgdo } = buildRatgdoAccessory({ clientUnavailable: true, userOptions: ALL_RATGDO_OPTIONS });
    const reads = handled(accessory, hasGetHandler);

    assert.equal(ratgdo.isOnline, true, "the status record reads available, as it does for any accessory the platform constructs");
    assert.ok(reads.length > 0, "the walk visits at least one read handler, and it visited " + reads.length.toString());

    await Promise.all(reads.map(({ characteristic, where }) => assert.doesNotReject(triggerGet(characteristic),
      where + " answers its read while the record reads available")));
  });
});
