/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.naming.test.ts: Naming concern net for RatgdoAccessory - the private `name` getter's precedence chain and the private door-state translation /
 * capitalization helpers, all reached strictly through the accessory's public surface (log prefixes, MQTT get handlers, and the door telemetry router).
 *
 * The `name` getter fronts every info / warn / error log line via prefixed(), so we observe its precedence by driving a logging event (a door transition with the
 * default-on Log.Opener) and asserting the captured entry's parameters[0] prefix. translateCurrentDoorState() and capitalize() are private, so we observe them through
 * the two public surfaces that consume them: the MQTT "garagedoor" get handler (which returns the lowercase translation) and the door-transition info log (which
 * emits the capitalized translation, e.g. "Open.", "Closed."). Door states are driven through ratgdo.updateState() with the EspHomeEvent cover shape.
 */
import { Characteristic, Service, buildRatgdoAccessory, loggedAt, makeKonnectedInitialState } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import type { EspHomeEvent } from "./types.ts";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";

// Build a cover telemetry event in the EspHomeEvent shape updateState() consumes. Properties are alphabetical per the house style; current_operation drives the
// transition class (OPENING / CLOSING / IDLE). For an IDLE cover the reported state resolves the branch: an OPEN state at a partial position (strictly between 0 and 1)
// reads as stopped-at-partial. The current_operation field mirrors the snake_case ESPHome wire shape EspHomeEvent declares, so the camelcase rule is scoped off here.
// eslint-disable-next-line camelcase
const coverEvent = (id: string, state: string, currentOperation: string, position: number): EspHomeEvent => ({ current_operation: currentOperation, id, position,
  state });

describe("RatgdoAccessory naming", () => {

  describe("the device log-name precedence", () => {

    test("uses the configured Device.LogName as the log-line prefix when set", () => {

      const { entries, ratgdo } = buildRatgdoAccessory({ userOptions: ["Enable.Device.LogName.MyDoor"] });

      // Drive a door-open transition. Log.Opener defaults on, so this emits an info line fronted by the name getter via prefixed().
      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));

      const opened = entries.find((entry) => (entry.level === "info") && String(entry.parameters[0]).endsWith("Open."));

      assert.ok(opened, "a door-open transition with Log.Opener enabled emits an info line");
      assert.ok(String(opened.parameters[0]).startsWith("MyDoor: "), "the log line is prefixed with the configured Device.LogName value");
    });

    test("prefers the configured Device.LogName over the GarageDoorOpener Name characteristic", () => {

      const { accessory, entries, ratgdo } = buildRatgdoAccessory({ userOptions: ["Enable.Device.LogName.MyDoor"] });

      // Seed a HomeKit rename on the garage door's Name characteristic. The LogName cache must still win over it.
      accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.Name).updateValue("RenamedDoor");
      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));

      const opened = entries.find((entry) => (entry.level === "info") && String(entry.parameters[0]).endsWith("Open."));

      assert.ok(opened, "a door-open transition emits an info line");
      assert.ok(String(opened.parameters[0]).startsWith("MyDoor: "), "the configured LogName takes precedence over the service Name characteristic");
    });

    test("falls back to the GarageDoorOpener Name characteristic when no LogName is configured", () => {

      const { accessory, entries, ratgdo } = buildRatgdoAccessory();

      // No LogName is set, so the getter's second precedence tier - the HomeKit-renamed service Name characteristic - is what logs should follow.
      accessory.getService(Service.GarageDoorOpener)?.getCharacteristic(Characteristic.Name).updateValue("RenamedDoor");
      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));

      const opened = entries.find((entry) => (entry.level === "info") && String(entry.parameters[0]).endsWith("Open."));

      assert.ok(opened, "a door-open transition emits an info line");
      assert.ok(String(opened.parameters[0]).startsWith("RenamedDoor: "), "with no LogName, the prefix follows the service Name characteristic");
    });

    test("falls back to the accessory displayName when neither LogName nor a service Name is set", () => {

      const { entries, ratgdo } = buildRatgdoAccessory();

      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));

      const opened = entries.find((entry) => (entry.level === "info") && String(entry.parameters[0]).endsWith("Open."));

      assert.ok(opened, "a door-open transition emits an info line");
      assert.ok(String(opened.parameters[0]).startsWith("Test Ratgdo: "), "the prefix falls back to the accessory displayName / device.name");
    });

    test("ignores a Device.LogName enabled without a value and falls back to the displayName", () => {

      // A bare Enable on the value option resolves to "enabled, no value", which resolveLogName collapses to undefined - so the prefix must fall back, not become empty.
      const { entries, ratgdo } = buildRatgdoAccessory({ userOptions: ["Enable.Device.LogName"] });

      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));

      const opened = entries.find((entry) => (entry.level === "info") && String(entry.parameters[0]).endsWith("Open."));

      assert.ok(opened, "a door-open transition emits an info line");
      assert.ok(String(opened.parameters[0]).startsWith("Test Ratgdo: "), "a valueless LogName does not blank the prefix; it falls back to the displayName");
    });
  });

  describe("translateCurrentDoorState and capitalize", () => {

    test("translates an open door to \"open\" for MQTT and \"Open.\" for the info log", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));

      assert.equal(mqtt.invokeGet("garagedoor"), "open", "the garagedoor get handler returns the lowercase translation of the open door state");
      assert.equal(mqtt.publishes.some((entry) => entry.topic.endsWith("garagedoor") && (entry.payload === "open")), true,
        "the open transition publishes the lowercase door state to the garagedoor topic");
      assert.equal(loggedAt(entries, "info", "Open."), true, "the open transition logs the capitalized door state when Log.Opener is enabled");
    });

    test("translates a closed door to \"closed\" for MQTT and \"Closed.\" for the info log", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      // The accessory is born closed, so we first open it to make the subsequent close an actual transition the router will act on and log.
      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));
      ratgdo.updateState(coverEvent("cover-door", "CLOSED", "IDLE", 0));

      assert.equal(mqtt.invokeGet("garagedoor"), "closed", "the garagedoor get handler returns the lowercase translation of the closed door state");
      assert.equal(loggedAt(entries, "info", "Closed."), true, "the close transition logs the capitalized door state when Log.Opener is enabled");
    });

    test("translates an opening door to \"opening\" for MQTT and \"Opening.\" for the info log", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      ratgdo.updateState(coverEvent("cover-door", "OPENING", "OPENING", 0.5));

      assert.equal(mqtt.invokeGet("garagedoor"), "opening", "the garagedoor get handler returns the lowercase translation of the opening door state");
      assert.equal(loggedAt(entries, "info", "Opening."), true, "the opening transition logs the capitalized door state when Log.Opener is enabled");
    });

    test("translates a closing door to \"closing\" for MQTT and \"Closing.\" for the info log", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      ratgdo.updateState(coverEvent("cover-door", "CLOSING", "CLOSING", 0.5));

      assert.equal(mqtt.invokeGet("garagedoor"), "closing", "the garagedoor get handler returns the lowercase translation of the closing door state");
      assert.equal(loggedAt(entries, "info", "Closing."), true, "the closing transition logs the capitalized door state when Log.Opener is enabled");
    });

    test("translates a stopped (partially-open) door to \"stopped\" for MQTT and \"Stopped.\" for the info log", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      // An idle cover reported OPEN at a position strictly between 0 and 1 is the stopped-at-partial case.
      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 0.5));

      assert.equal(mqtt.invokeGet("garagedoor"), "stopped", "the garagedoor get handler returns the lowercase translation of the stopped door state");
      assert.equal(loggedAt(entries, "info", "Stopped."), true, "the stopped transition logs the capitalized door state when Log.Opener is enabled");
    });

    test("reports the born-closed door as \"closed\" through MQTT with no transition log", () => {

      const { entries, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      // The resting initial snapshot is a closed door; the get handler must reflect that translation without any updateState transition having occurred.
      assert.equal(mqtt.invokeGet("garagedoor"), "closed", "the born-closed door translates to the lowercase closed state on a cold read");
      assert.equal(loggedAt(entries, "info", "Closed."), false, "no door-state info line is emitted at construction, only on an actual transition");
    });

    test("translates a Konnected cover (cover-garage_door) the same way as a Ratgdo cover", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(), mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      ratgdo.updateState(coverEvent("cover-garage_door", "OPEN", "IDLE", 1));

      assert.equal(mqtt.invokeGet("garagedoor"), "open", "the Konnected garage_door cover id resolves through the same translation as the Ratgdo cover");
      assert.equal(loggedAt(entries, "info", "Open."), true, "the Konnected open transition logs the capitalized door state when Log.Opener is enabled");
    });

    test("does not emit the capitalized door log when Log.Opener is disabled", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Log.Opener"] });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));

      assert.equal(mqtt.invokeGet("garagedoor"), "open", "the MQTT translation still reflects the open state regardless of the logging option");
      assert.equal(loggedAt(entries, "info", "Open."), false, "with Log.Opener disabled, the capitalized door-state info line is suppressed");
    });

    test("does not re-publish the door state when an identical cover event repeats", () => {

      const { mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      // The first open is a real transition; the identical second event must short-circuit before the garagedoor publish, leaving exactly one open publish.
      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));
      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));

      assert.equal(mqtt.publishes.filter((entry) => entry.topic.endsWith("garagedoor") && (entry.payload === "open")).length, 1,
        "an unchanged door state is a no-op that publishes the garagedoor state exactly once");
    });
  });
});
