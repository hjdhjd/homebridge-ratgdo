/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * battery.test.ts: Unit tests for parseBatteryState - the verbose-log extraction plus the firmware CHARGING/FULL swap remap.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseBatteryState } from "./battery.ts";

describe("parseBatteryState", () => {

  test("remaps the firmware-swapped CHARGING to FULL", () => {

    assert.equal(parseBatteryState("Battery state=CHARGING"), "FULL", "the firmware reports CHARGING for a full battery, so it remaps to FULL");
  });

  test("remaps the firmware-swapped FULL to CHARGING", () => {

    assert.equal(parseBatteryState("Battery state=FULL"), "CHARGING", "the firmware reports FULL while charging, so it remaps to CHARGING");
  });

  test("passes an unswapped state through verbatim", () => {

    assert.equal(parseBatteryState("Battery state=LOW"), "LOW", "any state other than the swapped pair passes through unchanged");
  });

  test("extracts the state from a longer log line up to the next word boundary", () => {

    assert.equal(parseBatteryState("[12:00:00][D] Battery state=CHARGING reported"), "FULL",
      "the non-greedy capture stops at the word boundary and the extracted state still remaps");
  });

  test("returns null when the line carries no battery state", () => {

    assert.equal(parseBatteryState("Some unrelated verbose log line"), null, "a line without a battery state yields null so the caller ignores it");
  });

  test("returns null for an empty line", () => {

    assert.equal(parseBatteryState(""), null, "an empty log line yields null");
  });
});
