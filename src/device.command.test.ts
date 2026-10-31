/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.command.test.ts: Command-dispatch concern net for RatgdoAccessory - the path from a HomeKit onSet handler (or its MQTT-set equivalent) through the
 * accessory's command() dispatcher to the esphome-client. These tests reach the REAL onSet handlers production installed during configureXxx (via the accessory's
 * services), fire them the way HomeKit would, and assert on what the fake client recorded: each {id, payload} the device resolved through its entity registry. The
 * variant-keyed entity ids the device dispatches against ("light-light", "switch-laser", "lock-lock_remotes", "cover-door", "switch-str_output",
 * "button-pre-close_warning") are read straight from RATGDO_ENTITIES, so the assertions lock in the wire-faithful resolution rather than re-deriving it.
 *
 * Timer-driven command concerns - the command-failure UI revert (RATGDO_UI_REVERT_DELAY) and the Konnected pre-close-warning momentary auto-revert
 * (RATGDO_KONNECTED_PCW_DURATION) - run on the platform double's test clock, so the deferred characteristic write is observed deterministically without a real-time
 * delay.
 */
import { Characteristic, Service, buildRatgdoAccessory, makeCoverEvent, makeKonnectedInitialState, makeRatgdoInitialState } from "./testing.helpers.ts";
import { RATGDO_KONNECTED_PCW_DURATION, RATGDO_UI_REVERT_DELAY } from "./settings.ts";
import { RatgdoService, RatgdoVariant } from "./types.ts";
import { describe, test } from "node:test";
import { loggedAt, present, triggerSet } from "homebridge-plugin-utils/testing";
import { LockCommand } from "esphome-client";
import { MQTT_SET_SUFFIX } from "homebridge-plugin-utils";
import assert from "node:assert/strict";

describe("RatgdoAccessory command dispatch", () => {

  describe("the light switch", () => {

    test("dispatches a light-on command when the On characteristic is set true", async () => {

      const { accessory, client } = buildRatgdoAccessory();
      const light = present(accessory.getService(Service.Lightbulb), "the light service");

      await triggerSet(light.getCharacteristic(Characteristic.On), true);

      assert.deepEqual(client.commands, [{ id: "light-light", payload: { state: true } }],
        "setting the light On true resolves the light entity and dispatches a state-true command");
    });

    test("dispatches a light-off command when the On characteristic is set false", async () => {

      const { accessory, client } = buildRatgdoAccessory();
      const light = present(accessory.getService(Service.Lightbulb), "the light service");

      await triggerSet(light.getCharacteristic(Characteristic.On), false);

      assert.deepEqual(client.commands, [{ id: "light-light", payload: { state: false } }],
        "setting the light On false dispatches a state-false command against the light entity");
    });
  });

  describe("the Ratgdo Disco switches", () => {

    test("dispatches a laser-on command from the Disco laser switch onSet", async () => {

      const { accessory, client } = buildRatgdoAccessory({ userOptions: ["Enable.Disco.Switch.Laser"] });
      const laser = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_DISCO_LASER), "the Disco laser switch");

      await triggerSet(laser.getCharacteristic(Characteristic.On), true);

      assert.deepEqual(client.commands, [{ id: "switch-laser", payload: { state: true } }],
        "the Disco laser switch dispatches a state-true command against the laser switch entity");
    });

    test("dispatches an led-on command from the Disco LED switch onSet", async () => {

      const { accessory, client } = buildRatgdoAccessory({ userOptions: ["Enable.Disco.Switch.Led"] });
      const led = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_DISCO_LED), "the Disco LED switch");

      await triggerSet(led.getCharacteristic(Characteristic.On), true);

      assert.deepEqual(client.commands, [{ id: "switch-led", payload: { state: true } }],
        "the Disco LED switch dispatches a state-true command against the led switch entity");
    });
  });

  describe("the Konnected strobe switch", () => {

    test("dispatches a strobe-on command from the strobe switch onSet on a Konnected device", async () => {

      const { accessory, client } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(),
        userOptions: ["Enable.Konnected.Switch.Strobe"] });
      const strobe = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_KONNECTED_STROBE), "the Konnected strobe switch");

      await triggerSet(strobe.getCharacteristic(Characteristic.On), true);

      assert.deepEqual(client.commands, [{ id: "switch-str_output", payload: { state: true } }],
        "the Konnected strobe switch resolves the str_output entity and dispatches a state-true command");
    });
  });

  describe("the wireless remote lock", () => {

    test("dispatches a LOCK command when the LockTargetState is set to SECURED", async () => {

      const { accessory, client } = buildRatgdoAccessory();
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");

      await triggerSet(door.getCharacteristic(Characteristic.LockTargetState), Characteristic.LockTargetState.SECURED);

      assert.deepEqual(client.commands, [{ id: "lock-lock_remotes", payload: { command: LockCommand.LOCK } }],
        "securing the lock dispatches a LockCommand.LOCK against the wireless remote lock entity");
    });

    test("dispatches an UNLOCK command when the LockTargetState is set to UNSECURED", async () => {

      const { accessory, client } = buildRatgdoAccessory();
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");

      await triggerSet(door.getCharacteristic(Characteristic.LockTargetState), Characteristic.LockTargetState.UNSECURED);

      assert.deepEqual(client.commands, [{ id: "lock-lock_remotes", payload: { command: LockCommand.UNLOCK } }],
        "unsecuring the lock dispatches a LockCommand.UNLOCK against the wireless remote lock entity");
    });
  });

  describe("the garage door target state", () => {

    test("dispatches a full-open cover command when the TargetDoorState is set to OPEN on a closed door", async () => {

      const { accessory, client } = buildRatgdoAccessory();
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");

      await triggerSet(door.getCharacteristic(Characteristic.TargetDoorState), Characteristic.TargetDoorState.OPEN);

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 1 } }],
        "targeting OPEN on a closed door dispatches a position-1 cover command");
    });

    test("dispatches a full-close cover command when the TargetDoorState is set to CLOSED on an open door", async () => {

      const { accessory, client } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]) });
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");

      await triggerSet(door.getCharacteristic(Characteristic.TargetDoorState), Characteristic.TargetDoorState.CLOSED);

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 0 } }],
        "targeting CLOSED on an open door dispatches a position-0 cover command");
    });

    test("dispatches nothing when the TargetDoorState is set to the state the door is already in", async () => {

      const { accessory, client } = buildRatgdoAccessory();
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");

      await triggerSet(door.getCharacteristic(Characteristic.TargetDoorState), Characteristic.TargetDoorState.CLOSED);

      assert.deepEqual(client.commands, [], "targeting CLOSED on an already-closed door is a no-op and dispatches no command");
    });
  });

  describe("door action payloads via the MQTT garage door set handler", () => {

    test("translates an \"open 50\" set into a half-open cover position command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      await mqtt?.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "open 50");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 0.5 } }],
        "an \"open 50\" MQTT set maps the 0-100 percentage onto the 0-1 cover position scale");
    });

    test("translates a bare \"open\" set into a full-open cover position command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      await mqtt?.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "open");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 1 } }],
        "a bare \"open\" MQTT set with no position dispatches a full-open position-1 command");
    });

    test("translates a \"close\" set into a full-close cover position command", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]), mqtt: true });

      await mqtt?.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "close");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { position: 0 } }],
        "a \"close\" MQTT set on an open door dispatches a full-close position-0 command");
    });

    test("translates an open / close request mid-transition into a stop cover command", async () => {

      const { client, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      // Drive the door into a transitioning (OPENING) state so the next set is interpreted as a user-initiated stop rather than a fresh open / close. The
      // current_operation field mirrors the snake_case ESPHome wire shape EspHomeEvent declares, so the camelcase rule is scoped off for this one literal.
      // eslint-disable-next-line camelcase
      ratgdo.updateState({ current_operation: "OPENING", id: "cover-door", position: 0.5, state: "OPENING" });

      await mqtt?.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "close");

      assert.deepEqual(client.commands, [{ id: "cover-door", payload: { stop: true } }],
        "a set issued while the door is transitioning dispatches a stop command against the cover entity");
    });

    test("logs an error and dispatches nothing for an unrecognized verb", async () => {

      const { client, entries, mqtt } = buildRatgdoAccessory({ mqtt: true });

      await mqtt?.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "wiggle");

      assert.deepEqual(client.commands, [], "an unrecognized MQTT verb dispatches no command to the device");
      assert.equal(loggedAt(entries, "error", "Invalid garage door MQTT command received"), true,
        "an unrecognized MQTT verb is reported through the error log");
    });
  });

  describe("command failure handling", () => {

    test("reverts the characteristic to its prior value when the client is unavailable", async () => {

      const { accessory, client, clock } = buildRatgdoAccessory({ clientUnavailable: true });
      const on = present(accessory.getService(Service.Lightbulb), "the light service").getCharacteristic(Characteristic.On);

      await triggerSet(on, true);

      assert.deepEqual(client.commands, [], "with no client the command never reaches the device");
      assert.equal(on.value, true, "the user's set value is held until the deferred revert fires");

      // The failed onSet scheduled a deferred revert; advancing past the revert delay must put the characteristic back to its prior off state.
      clock.advance(RATGDO_UI_REVERT_DELAY);

      assert.equal(on.value, false, "after the revert delay elapses the On characteristic reverts to its prior off value");
    });

    /* A held client between sessions - the patience window before its verdict - would drop a frame it has no session to send on, so a write in that window is
     * refused before it reaches the client and the UI goes back to what the status record says, rather than showing a write that never reached the door.
     */
    test("refuses a light toggle while the client's session is not live, and reverts On", async () => {

      const { accessory, client, clock } = buildRatgdoAccessory();
      const on = present(accessory.getService(Service.Lightbulb), "the light service").getCharacteristic(Characteristic.On);

      client.live = false;

      await triggerSet(on, true);

      assert.deepEqual(client.commands, [], "a toggle never reaches a client that holds no live session");

      clock.advance(RATGDO_UI_REVERT_DELAY);

      assert.equal(on.value, false, "the refused toggle reverts On to the light's recorded state");
    });

    test("refuses a lock write while the client's session is not live, and reverts the lock from the status record", async () => {

      const { accessory, client, clock } = buildRatgdoAccessory();
      const door = present(accessory.getService(Service.GarageDoorOpener), "the garage door service");

      client.live = false;

      await triggerSet(door.getCharacteristic(Characteristic.LockTargetState), Characteristic.LockTargetState.SECURED);

      assert.deepEqual(client.commands, [], "a lock write never reaches a client that holds no live session");

      clock.advance(RATGDO_UI_REVERT_DELAY);

      assert.equal(door.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.UNSECURED,
        "the refused lock write reverts the target to the recorded unsecured lock");
    });

    test("refuses a door write while the client's session is not live, and reverts the target from the status record", async () => {

      const { accessory, client, clock } = buildRatgdoAccessory();
      const target = present(accessory.getService(Service.GarageDoorOpener), "the garage door service").getCharacteristic(Characteristic.TargetDoorState);

      client.live = false;

      await triggerSet(target, Characteristic.TargetDoorState.OPEN);

      assert.deepEqual(client.commands, [], "a door write never reaches a client that holds no live session");
      assert.equal(target.value, Characteristic.TargetDoorState.OPEN, "HomeKit holds the user's target until the deferred revert fires");

      clock.advance(RATGDO_UI_REVERT_DELAY);

      assert.equal(target.value, Characteristic.TargetDoorState.CLOSED, "the refused write reverts the target to the closed door the status record holds");
    });

    test("refuses a stop while the client's session is not live, and reverts the target to where the moving door is headed", async () => {

      const { accessory, client, clock, ratgdo } = buildRatgdoAccessory();
      const target = present(accessory.getService(Service.GarageDoorOpener), "the garage door service").getCharacteristic(Characteristic.TargetDoorState);

      // The current_operation field mirrors the snake_case ESPHome wire shape EspHomeEvent declares, so the camelcase rule is scoped off for this one literal.
      // eslint-disable-next-line camelcase
      ratgdo.updateState({ current_operation: "OPENING", id: "cover-door", position: 0.5, state: "OPENING" });
      client.live = false;

      await triggerSet(target, Characteristic.TargetDoorState.CLOSED);

      assert.deepEqual(client.commands, [], "the stop never reaches a client that holds no live session");

      clock.advance(RATGDO_UI_REVERT_DELAY);

      assert.equal(target.value, Characteristic.TargetDoorState.OPEN, "the refused stop reverts the target to open, where the opening door is still headed");
    });

    test("refuses an MQTT door set while the client's session is not live", async () => {

      const { client, mqtt } = buildRatgdoAccessory({ mqtt: true });

      client.live = false;

      await mqtt?.invokeSet("garagedoor" + MQTT_SET_SUFFIX, "open");

      assert.deepEqual(client.commands, [], "an MQTT set never reaches a client that holds no live session");
    });

    test("refuses a dimmer position write while the client's session is not live, and reverts Brightness and On from the status record", async () => {

      const { accessory, client, clock } = buildRatgdoAccessory({ userOptions: ["Enable.Opener.Dimmer"] });
      const dimmer = present(accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION), "the automation dimmer");

      client.live = false;

      await triggerSet(dimmer.getCharacteristic(Characteristic.On), true);
      await triggerSet(dimmer.getCharacteristic(Characteristic.Brightness), 50);

      assert.deepEqual(client.commands, [], "the position write never reaches a client that holds no live session");

      clock.advance(RATGDO_UI_REVERT_DELAY);

      assert.equal(dimmer.getCharacteristic(Characteristic.Brightness).value, 0, "the refused write reverts Brightness to the closed door's recorded position");
      assert.equal(dimmer.getCharacteristic(Characteristic.On).value, false, "and reverts On to the closed door the status record holds");
    });

    test("refuses a dimmer close while the client's session is not live, and reverts On from the status record", async () => {

      const { accessory, client, clock } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 1)]),
        userOptions: ["Enable.Opener.Dimmer"] });
      const dimmer = present(accessory.getServiceById(Service.Lightbulb, RatgdoService.DIMMER_OPENER_AUTOMATION), "the automation dimmer");

      client.live = false;

      await triggerSet(dimmer.getCharacteristic(Characteristic.On), false);

      assert.deepEqual(client.commands, [], "the close never reaches a client that holds no live session");

      clock.advance(RATGDO_UI_REVERT_DELAY);

      assert.equal(dimmer.getCharacteristic(Characteristic.On).value, true, "the refused close reverts On to the open door the status record holds");
      assert.equal(dimmer.getCharacteristic(Characteristic.Brightness).value, 100, "and leaves Brightness on the open door's recorded position");
    });

    /* Read-only mode refuses every door write, and the target goes back to where the status record says the door is headed. A stopped door targets open, so a
     * refused open leaves the target open rather than flipping it to closed, which would show a stopped door headed somewhere it is not.
     */
    test("reverts a read-only door write to the status record's target, so a stopped door keeps targeting open", async () => {

      const { accessory, client, clock } = buildRatgdoAccessory({ initialState: makeRatgdoInitialState([makeCoverEvent("door", 0.5)]),
        userOptions: ["Enable.Opener.ReadOnly"] });
      const target = present(accessory.getService(Service.GarageDoorOpener), "the garage door service").getCharacteristic(Characteristic.TargetDoorState);

      assert.equal(target.value, Characteristic.TargetDoorState.OPEN, "a stopped door is born targeting open");

      await triggerSet(target, Characteristic.TargetDoorState.OPEN);
      clock.advance(RATGDO_UI_REVERT_DELAY);

      assert.deepEqual(client.commands, [], "read-only mode dispatches nothing");
      assert.equal(target.value, Characteristic.TargetDoorState.OPEN, "the refused write leaves the stopped door targeting open, the status record's target");
    });
  });

  describe("the Konnected pre-close warning switch", () => {

    test("dispatches a momentary button command then auto-reverts the switch off", async () => {

      const { accessory, client, clock } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(),
        userOptions: ["Enable.Konnected.Switch.Pcw"] });
      const on = present(accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_KONNECTED_PCW), "the pre-close warning switch")
        .getCharacteristic(Characteristic.On);

      await triggerSet(on, true);

      assert.deepEqual(client.commands, [{ id: "button-pre-close_warning", payload: {} }],
        "the pre-close warning switch dispatches an empty-payload momentary press against the pcw button entity");
      assert.equal(on.value, true, "the switch stays on while the pre-close warning audio plays");

      // The momentary switch auto-reverts to off after the pre-close warning duration elapses.
      clock.advance(RATGDO_KONNECTED_PCW_DURATION * 1000);

      assert.equal(on.value, false, "after the pre-close warning duration the momentary switch reverts to off");
    });
  });
});
