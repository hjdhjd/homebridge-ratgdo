/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * telemetry.test.ts: Unit tests for translateTelemetry - the pure ESPHome-wire-to-EspHomeEvent translation, across every entity type the plugin consumes.
 */
import { CoverOperation, LockState } from "esphome-client";
import { describe, test } from "node:test";
import { makeBinarySensorEvent, makeCoverEvent, makeLightEvent, makeLockEvent, makeSwitchEvent, makeTelemetry } from "../testing.helpers.ts";
import assert from "node:assert/strict";
import { translateTelemetry } from "./telemetry.ts";

describe("translateTelemetry", () => {

  describe("the dispatch id", () => {

    test("derives the canonical type-objectId id, lowercasing and replacing spaces with underscores", () => {

      assert.equal(translateTelemetry(makeTelemetry("binary_sensor", "Vehicle Detected", { state: true })).id, "binary_sensor-vehicle_detected",
        "the firmware's human-readable entity name normalizes to ESPHome's objectId form so it matches the device registry");
    });
  });

  describe("binary_sensor and switch", () => {

    test("map a truthy state to ON and a falsy state to OFF", () => {

      assert.equal(translateTelemetry(makeBinarySensorEvent("obstruction", true)).state, "ON", "a detected binary sensor is ON");
      assert.equal(translateTelemetry(makeBinarySensorEvent("obstruction", false)).state, "OFF", "a clear binary sensor is OFF");
      assert.equal(translateTelemetry(makeSwitchEvent("laser", true)).state, "ON", "an on switch is ON");
      assert.equal(translateTelemetry(makeSwitchEvent("laser", false)).state, "OFF", "an off switch is OFF");
    });
  });

  describe("cover", () => {

    test("maps a non-zero position to OPEN and a zero position to CLOSED, forwarding the raw position", () => {

      const open = translateTelemetry(makeCoverEvent("door", 1, CoverOperation.IDLE));

      assert.equal(open.state, "OPEN", "any non-zero position reads as OPEN");
      assert.equal(open.position, 1, "the raw position is forwarded for the dimmer/percentage path");
      assert.equal(translateTelemetry(makeCoverEvent("door", 0, CoverOperation.IDLE)).state, "CLOSED", "a zero position reads as CLOSED");
    });

    test("translates each CoverOperation to its current_operation string", () => {

      assert.equal(translateTelemetry(makeCoverEvent("door", 1, CoverOperation.IS_OPENING)).current_operation, "OPENING", "IS_OPENING maps to OPENING");
      assert.equal(translateTelemetry(makeCoverEvent("door", 1, CoverOperation.IS_CLOSING)).current_operation, "CLOSING", "IS_CLOSING maps to CLOSING");
      assert.equal(translateTelemetry(makeCoverEvent("door", 1, CoverOperation.IDLE)).current_operation, "IDLE", "IDLE maps to IDLE");
    });

    test("treats an absent currentOperation as IDLE", () => {

      assert.equal(translateTelemetry(makeTelemetry("cover", "door", { position: 0.5 })).current_operation, "IDLE",
        "an undefined currentOperation collapses to IDLE");
    });
  });

  describe("light", () => {

    test("maps a truthy state to ON and a falsy state to OFF", () => {

      assert.equal(translateTelemetry(makeLightEvent("light", true)).state, "ON", "an on light is ON");
      assert.equal(translateTelemetry(makeLightEvent("light", false)).state, "OFF", "an off light is OFF");
    });
  });

  describe("lock", () => {

    test("maps LOCKED and UNLOCKED to their binary strings", () => {

      assert.equal(translateTelemetry(makeLockEvent("lock_remotes", LockState.LOCKED)).state, "LOCKED", "a LOCKED lock maps to LOCKED");
      assert.equal(translateTelemetry(makeLockEvent("lock_remotes", LockState.UNLOCKED)).state, "UNLOCKED", "an UNLOCKED lock maps to UNLOCKED");
    });

    test("maps every non-binary lock state to UNKNOWN", () => {

      assert.equal(translateTelemetry(makeLockEvent("lock_remotes", LockState.JAMMED)).state, "UNKNOWN", "a JAMMED lock is UNKNOWN");
      assert.equal(translateTelemetry(makeLockEvent("lock_remotes", LockState.NONE)).state, "UNKNOWN", "an uninitialized NONE lock is UNKNOWN");
    });
  });

  describe("button", () => {

    test("always maps to PRESSED", () => {

      assert.equal(translateTelemetry(makeTelemetry("button", "query_status", { pressed: true })).state, "PRESSED",
        "button events only fire on press, so the state is always PRESSED");
    });
  });

  describe("unmodeled entity types", () => {

    test("normalize to an empty-state passthrough that updateState drops", () => {

      // A diagnostic sensor (voltage here) is an entity type ratgdo does not model. translateTelemetry preserves the wire id but leaves the state empty, and
      // updateState has no matching case for it, so it is dropped. This pins the deliberate catch-all rather than special-casing every unconsumed ESPHome type.
      const event = translateTelemetry(makeTelemetry("sensor", "voltage", { state: 12.5 }));

      assert.equal(event.id, "sensor-voltage", "the wire id is preserved for an unmodeled entity type");
      assert.equal(event.state, "", "an unmodeled entity type carries no state, so updateState's id switch drops it");
    });
  });
});
