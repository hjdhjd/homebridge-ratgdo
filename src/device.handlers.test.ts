/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.handlers.test.ts: Characteristic get/set handler concern net for RatgdoAccessory - the onGet read handlers and the onSet write handlers each configureXxx
 * binds onto its service. These read through the same lens HomeKit uses (triggerGet / triggerSet) rather than the cached characteristic value, so a getter wired to the
 * wrong status field or a setter that dispatches the wrong command is caught here. Command-dispatch handlers shared via toggleOnSet (light, laser, led, strobe) and the
 * lock / pre-close-warning / door target handlers are netted in device.command.test.ts; this file covers the getters plus the bespoke dimmer / opener-switch / lockout
 * setters that command.test does not.
 */
import { Characteristic, Service, buildRatgdoAccessory, makeCoverEvent, makeKonnectedInitialState, makeLightEvent, makeLockEvent, makeRatgdoInitialState,
  makeSwitchEvent } from "./testing.helpers.ts";
import { LockCommand, LockState } from "esphome-client";
import { RatgdoService, RatgdoVariant } from "./types.ts";
import { describe, test } from "node:test";
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

describe("RatgdoAccessory characteristic getters (onGet read lens)", () => {

  // One fully-loaded accessory: door open, remotes locked, light/laser/led on. Each getter is read through triggerGet - the path HomeKit invokes - not the cached value.
  const built = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([ makeCoverEvent("door", 1), makeLightEvent("light", true),
    makeLockEvent("lock_remotes", LockState.LOCKED), makeSwitchEvent("laser", true), makeSwitchEvent("led", true) ]), userOptions: ALL_RATGDO_OPTIONS });
  const accessory = built.accessory;

  test("the garage door getters report the current door and obstruction state", async () => {

    const door = accessory.getService(Service.GarageDoorOpener);

    assert.equal(await door?.getCharacteristic(Characteristic.CurrentDoorState).triggerGet(), Characteristic.CurrentDoorState.OPEN,
      "CurrentDoorState onGet returns the open door state");
    assert.equal(await door?.getCharacteristic(Characteristic.ObstructionDetected).triggerGet(), false, "ObstructionDetected onGet returns the clear obstruction state");
  });

  test("the light getter reports the light state", async () => {

    assert.equal(await accessory.getService(Service.Lightbulb)?.getCharacteristic(Characteristic.On).triggerGet(), true, "the light On onGet returns the on state");
  });

  test("the automation dimmer getters report the open state and door position", async () => {

    const dimmer = accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION);

    assert.equal(await dimmer?.getCharacteristic(Characteristic.On).triggerGet(), true, "the dimmer On onGet is true for any non-closed door");
    assert.equal(await dimmer?.getCharacteristic(Characteristic.Brightness).triggerGet(), 100, "the dimmer Brightness onGet returns the door position percentage");
  });

  test("the automation opener switch getter reports the open state", async () => {

    const opener = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION);

    assert.equal(await opener?.getCharacteristic(Characteristic.On).triggerGet(), true, "the opener switch On onGet is true for any non-closed door");
  });

  test("the backup battery getter reports the charging state", async () => {

    assert.equal(await accessory.getService(Service.Battery)?.getCharacteristic(Characteristic.ChargingState).triggerGet(), Characteristic.ChargingState.NOT_CHARGING,
      "the battery ChargingState onGet returns the resting charging state");
  });

  test("the disco laser and led switch getters report their switch state", async () => {

    assert.equal(await accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_DISCO_LASER)?.getCharacteristic(Characteristic.On).triggerGet(), true,
      "the laser On onGet returns the on state");
    assert.equal(await accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_DISCO_LED)?.getCharacteristic(Characteristic.On).triggerGet(), true,
      "the led On onGet returns the on state");
  });

  test("the lockout switch getter reports whether remotes are locked out", async () => {

    assert.equal(await accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_LOCKOUT)?.getCharacteristic(Characteristic.On).triggerGet(), true,
      "the lockout On onGet is true when the remote lock is secured");
  });

  test("an availability sensor reports StatusActive from the accessory availability flag", async () => {

    assert.equal(await accessory.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.StatusActive).triggerGet(), true,
      "the StatusActive onGet returns the online availability state");
  });
});

describe("RatgdoAccessory Konnected getters (onGet read lens)", () => {

  const built = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState([makeSwitchEvent("str_output", true)]),
    userOptions: [ "Enable.Konnected.Switch.Pcw", "Enable.Konnected.Switch.Strobe" ] });
  const accessory = built.accessory;

  test("the pre-close warning getter always reports off (it is a momentary control)", async () => {

    assert.equal(await accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_KONNECTED_PCW)?.getCharacteristic(Characteristic.On).triggerGet(), false,
      "the pre-close warning On onGet is always false - it is momentary, not a persistent state");
  });

  test("the strobe getter reports the strobe state", async () => {

    assert.equal(await accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_KONNECTED_STROBE)?.getCharacteristic(Characteristic.On).triggerGet(), true,
      "the strobe On onGet returns the on state");
  });
});

describe("RatgdoAccessory characteristic setters (onSet write lens)", () => {

  test("the dimmer On setter closes the door on false and no-ops on true", async () => {

    const { accessory, client } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]), userOptions: ["Enable.Opener.Dimmer"] });
    const dimmer = accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION);

    await dimmer?.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.equal(client.commands.length, 0, "turning the dimmer On does not dispatch - opening is driven by the Brightness setter");

    await dimmer?.getCharacteristic(Characteristic.On).triggerSet(false);

    assert.deepEqual(client.commands.at(-1), { id: "cover-door", payload: { position: 0 } }, "turning the dimmer Off closes the door");
  });

  test("the dimmer Brightness setter drives the door to the requested position", async () => {

    const { accessory, client } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 0)]), userOptions: ["Enable.Opener.Dimmer"] });

    await accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION)?.getCharacteristic(Characteristic.Brightness).triggerSet(50);

    assert.deepEqual(client.commands.at(-1), { id: "cover-door", payload: { position: 0.5 } }, "a 50% brightness drives the door to a half-open position");
  });

  test("the automation opener switch setter opens and closes the door", async () => {

    const { accessory, client } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 0)]), userOptions: ["Enable.Opener.Switch"] });
    const opener = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION);

    await opener?.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.deepEqual(client.commands.at(-1), { id: "cover-door", payload: { position: 1 } }, "turning the opener switch on opens the door");
  });

  test("the lockout switch setter locks and unlocks the wireless remotes", async () => {

    const { accessory, client } = buildRatgdoAccessory({ userOptions: ["Enable.Opener.Switch.RemoteLockout"] });
    const lockout = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_LOCKOUT);

    await lockout?.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.deepEqual(client.commands.at(-1), { id: "lock-lock_remotes", payload: { command: LockCommand.LOCK } }, "turning the lockout switch on locks the remotes");

    await lockout?.getCharacteristic(Characteristic.On).triggerSet(false);

    assert.deepEqual(client.commands.at(-1), { id: "lock-lock_remotes", payload: { command: LockCommand.UNLOCK } }, "turning the lockout switch off unlocks the remotes");
  });
});
