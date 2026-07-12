/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.command.test.ts: Command-dispatch concern net for RatgdoAccessory - the path from a HomeKit onSet handler (or its MQTT-set equivalent) through the
 * accessory's command() dispatcher to the esphome-client. These tests reach the REAL onSet handlers production installed during configureXxx (via the accessory's
 * services), fire them the way HomeKit would, and assert on what the fake client recorded: each {id, payload} the device resolved through its entity registry. The
 * variant-keyed entity ids the device dispatches against ("light-light", "switch-laser", "lock-lock_remotes", "cover-door", "switch-str_output",
 * "button-pre-close_warning") are read straight from RATGDO_ENTITIES, so the assertions pin the wire-faithful resolution rather than re-deriving it.
 *
 * Timer-driven command concerns - the command-failure UI revert (RATGDO_UI_REVERT_DELAY) and the Konnected pre-close-warning momentary auto-revert
 * (RATGDO_KONNECTED_PCW_DURATION) - run under node:test mock timers so the deferred characteristic write is observed deterministically without a real-time delay.
 */
import { Characteristic, Service, buildRatgdoAccessory, loggedAt, makeCoverEvent, makeKonnectedInitialState, makeRatgdoInitialState } from "./testing.helpers.ts";
import { RATGDO_KONNECTED_PCW_DURATION, RATGDO_UI_REVERT_DELAY } from "./settings.ts";
import { RatgdoService, RatgdoVariant } from "./types.ts";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { LockCommand } from "esphome-client";
import assert from "node:assert/strict";

describe("RatgdoAccessory command dispatch", () => {

  // Every command-concern test either dispatches no timer (the happy paths) or relies on a deferred revert; enabling fake setTimeout for all of them keeps the timing
  // deterministic and lets the failure / momentary tests tick the clock forward without any real-time wait.
  beforeEach(() => {

    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {

    mock.timers.reset();
  });

  describe("the light switch", () => {

    test("dispatches a light-on command when the On characteristic is set true", async () => {

      const { accessory, client } = buildRatgdoAccessory();
      const light = accessory.getService(Service.Lightbulb);

      await light?.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.deepEqual(client.commands, [{ id: "light-light", payload: { state: true } }],
        "setting the light On true resolves the light entity and dispatches a state-true command");
    });

    test("dispatches a light-off command when the On characteristic is set false", async () => {

      const { accessory, client } = buildRatgdoAccessory();
      const light = accessory.getService(Service.Lightbulb);

      await light?.getCharacteristic(Characteristic.On).triggerSet(false);

      assert.deepEqual(client.commands, [{ id: "light-light", payload: { state: false } }],
        "setting the light On false dispatches a state-false command against the light entity");
    });
  });

  describe("the Ratgdo Disco switches", () => {

    test("dispatches a laser-on command from the Disco laser switch onSet", async () => {

      const { accessory, client } = buildRatgdoAccessory({ userOptions: ["Enable.Disco.Switch.Laser"] });
      const laser = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_DISCO_LASER);

      await laser?.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.deepEqual(client.commands, [{ id: "switch-laser", payload: { state: true } }],
        "the Disco laser switch dispatches a state-true command against the laser switch entity");
    });

    test("dispatches an led-on command from the Disco LED switch onSet", async () => {

      const { accessory, client } = buildRatgdoAccessory({ userOptions: ["Enable.Disco.Switch.Led"] });
      const led = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_DISCO_LED);

      await led?.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.deepEqual(client.commands, [{ id: "switch-led", payload: { state: true } }],
        "the Disco LED switch dispatches a state-true command against the led switch entity");
    });
  });

  describe("the Konnected strobe switch", () => {

    test("dispatches a strobe-on command from the strobe switch onSet on a Konnected device", async () => {

      const { accessory, client } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(),
        userOptions: ["Enable.Konnected.Switch.Strobe"] });
      const strobe = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_KONNECTED_STROBE);

      await strobe?.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.deepEqual(client.commands, [{ id: "switch-str_output", payload: { state: true } }],
        "the Konnected strobe switch resolves the str_output entity and dispatches a state-true command");
    });
  });

  describe("the wireless remote lock", () => {

    test("dispatches a LOCK command when the LockTargetState is set to SECURED", async () => {

      const { accessory, client } = buildRatgdoAccessory();
      const door = accessory.getService(Service.GarageDoorOpener);

      await door?.getCharacteristic(Characteristic.LockTargetState).triggerSet(Characteristic.LockTargetState.SECURED);

      assert.deepEqual(client.commands, [{ id: "lock-lock_remotes", payload: { command: LockCommand.LOCK } }],
        "securing the lock dispatches a LockCommand.LOCK against the wireless remote lock entity");
    });

    test("dispatches an UNLOCK command when the LockTargetState is set to UNSECURED", async () => {

      const { accessory, client } = buildRatgdoAccessory();
      const door = accessory.getService(Service.GarageDoorOpener);

      await door?.getCharacteristic(Characteristic.LockTargetState).triggerSet(Characteristic.LockTargetState.UNSECURED);

      assert.deepEqual(client.commands, [{ id: "lock-lock_remotes", payload: { command: LockCommand.UNLOCK } }],
        "unsecuring the lock dispatches a LockCommand.UNLOCK against the wireless remote lock entity");
    });
  });

  describe("the garage door target state", () => {

    test("dispatches a full-open cover command when the TargetDoorState is set to OPEN on a closed door", async () => {

      const { accessory, client } = buildRatgdoAccessory();
      const door = accessory.getService(Service.GarageDoorOpener);

      await door?.getCharacteristic(Characteristic.TargetDoorState).triggerSet(Characteristic.TargetDoorState.OPEN);

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 1 } }],
        "targeting OPEN on a closed door dispatches a position-1 cover command");
    });

    test("dispatches a full-close cover command when the TargetDoorState is set to CLOSED on an open door", async () => {

      const { accessory, client } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]) });
      const door = accessory.getService(Service.GarageDoorOpener);

      await door?.getCharacteristic(Characteristic.TargetDoorState).triggerSet(Characteristic.TargetDoorState.CLOSED);

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 0 } }],
        "targeting CLOSED on an open door dispatches a position-0 cover command");
    });

    test("dispatches nothing when the TargetDoorState is set to the state the door is already in", async () => {

      const { accessory, client } = buildRatgdoAccessory();
      const door = accessory.getService(Service.GarageDoorOpener);

      await door?.getCharacteristic(Characteristic.TargetDoorState).triggerSet(Characteristic.TargetDoorState.CLOSED);

      assert.deepEqual(client.commands, [], "targeting CLOSED on an already-closed door is a no-op and dispatches no command");
    });
  });

  describe("door action payloads via the MQTT garage door set handler", () => {

    test("translates an \"open 50\" set into a half-open cover position command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      await mqtt?.invokeSet("garagedoor", "open 50");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 0.5 } }],
        "an \"open 50\" MQTT set maps the 0-100 percentage onto the 0-1 cover position scale");
    });

    test("translates a bare \"open\" set into a full-open cover position command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      await mqtt?.invokeSet("garagedoor", "open");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 1 } }],
        "a bare \"open\" MQTT set with no position dispatches a full-open position-1 command");
    });

    test("translates a \"close\" set into a full-close cover position command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]), mqtt: true });

      await mqtt?.invokeSet("garagedoor", "close");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 0 } }],
        "a \"close\" MQTT set on an open door dispatches a full-close position-0 command");
    });

    test("translates an open / close request mid-transition into a stop cover command", async () => {

      const { client, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      // Drive the door into a transitioning (OPENING) state so the next set is interpreted as a user-initiated stop rather than a fresh open / close. The
      // current_operation field mirrors the snake_case ESPHome wire shape EspHomeEvent declares, so the camelcase rule is scoped off for this one literal.
      // eslint-disable-next-line camelcase
      ratgdo.updateState({ current_operation: "OPENING", id: "cover-door", position: 0.5, state: "OPENING" });

      await mqtt?.invokeSet("garagedoor", "close");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { stop: true } }],
        "a set issued while the door is transitioning dispatches a stop command against the cover entity");
    });

    test("logs an error and dispatches nothing for an unrecognized verb", async () => {

      const { client, entries, mqtt } = buildRatgdoAccessory({ mqtt: true });

      await mqtt?.invokeSet("garagedoor", "wiggle");

      assert.deepEqual(client.commands, [], "an unrecognized MQTT verb dispatches no command to the device");
      assert.equal(loggedAt(entries, "error", "Invalid garage door MQTT command received"), true,
        "an unrecognized MQTT verb is reported through the error log");
    });
  });

  describe("command failure handling", () => {

    test("reverts the characteristic to its prior value when the client is unavailable", async () => {

      const { accessory, client } = buildRatgdoAccessory({ clientUnavailable: true });
      const on = accessory.getService(Service.Lightbulb)?.getCharacteristic(Characteristic.On);

      await on?.triggerSet(true);

      assert.deepEqual(client.commands, [], "with no client the command never reaches the device");
      assert.equal(on?.value, true, "the user's set value is held until the deferred revert fires");

      // The failed onSet scheduled a deferred revert; advancing past the revert delay must put the characteristic back to its prior off state.
      mock.timers.tick(RATGDO_UI_REVERT_DELAY);

      assert.equal(on?.value, false, "after the revert delay elapses the On characteristic reverts to its prior off value");
    });
  });

  describe("the Konnected pre-close warning switch", () => {

    test("dispatches a momentary button command then auto-reverts the switch off", async () => {

      const { accessory, client } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(),
        userOptions: ["Enable.Konnected.Switch.Pcw"] });
      const on = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_KONNECTED_PCW)?.getCharacteristic(Characteristic.On);

      await on?.triggerSet(true);

      assert.deepEqual(client.commands, [{ id: "button-pre-close_warning", payload: {} }],
        "the pre-close warning switch dispatches an empty-payload momentary press against the pcw button entity");
      assert.equal(on?.value, true, "the switch stays on while the pre-close warning audio plays");

      // The momentary switch auto-reverts to off after the pre-close warning duration elapses.
      mock.timers.tick(RATGDO_KONNECTED_PCW_DURATION * 1000);

      assert.equal(on?.value, false, "after the pre-close warning duration the momentary switch reverts to off");
    });
  });
});
