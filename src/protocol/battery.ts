/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * battery.ts: Pure parsing of an ESPHome verbose log line into a HomeKit-facing battery charging state.
 */
import type { Nullable } from "homebridge-plugin-utils";

// Regex for extracting the battery state from an ESPHome verbose log message (the Disco firmware reports battery only through logs, not as an entity). This lives as
// a module-level constant rather than being constructed inline so it is compiled once rather than on every call - parseBatteryState runs once per VERBOSE log line,
// a high-frequency hot path, and recompiling the pattern on each invocation would waste cycles for no benefit.
const RATGDO_BATTERY_STATE_REGEX = /\bBattery state=(.+?)\b/;

/* Extract and normalize the battery charging state from an ESPHome verbose log line. Returns the HomeKit-facing state string, or null when the line carries no battery
 * state (an empty or unrelated log line). The current Ratgdo firmware reports CHARGING and FULL with their meanings swapped, so we remap them here so HomeKit shows the
 * correct state; any other value passes through unchanged. Pure and I/O-free so the regex extraction and the swap remap can be unit-tested directly.
 */
export function parseBatteryState(message: string): Nullable<string> {

  const rawState = RATGDO_BATTERY_STATE_REGEX.exec(message)?.[1];

  if(!rawState) {

    return null;
  }

  switch(rawState) {

    case "CHARGING":

      return "FULL";

    case "FULL":

      return "CHARGING";

    default:

      return rawState;
  }
}
