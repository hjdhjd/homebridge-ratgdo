/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * retired-options.ts: The retired feature option families, the one list the platform's boot view and the settings page's migration both translate a configuration
 * through, so the two can never disagree about which retired options carry forward.
 */
import { RATGDO_LOG_EVENTS_FAMILY } from "./log-events.ts";
import { RATGDO_VEHICLE_SENSORS_FAMILY } from "./vehicle-sensors.ts";
import type { RetiredFamily } from "homebridge-plugin-utils";

// Every retired family, in the order their compositions are written.
export const RATGDO_RETIRED_FAMILIES: readonly RetiredFamily[] = [ RATGDO_LOG_EVENTS_FAMILY, RATGDO_VEHICLE_SENSORS_FAMILY ];
