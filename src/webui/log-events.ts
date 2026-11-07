/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * log-events.ts: The event categories the plugin logs: the one table the logging list offers its choices from, the accessory reads its logging against, and the
 * retired per-event logging options migrate through.
 */
import type { FeatureOptionChoice, RetiredFamily } from "homebridge-plugin-utils";
import { RATGDO_LOG_EVENTS_OPTION } from "./settings.ts";

// One event category: the value the logging list stores for it, the label the settings page shows it under, and whether the Disco board alone produces it.
interface RatgdoLogEventEntry {

  readonly disco?: true;
  readonly label: string;
  readonly value: string;
}

/* Every event category the plugin logs, in the order the settings page lists them. Vehicle presence is the one the Disco board alone reports, so it is marked, and
 * the page offers it only where Disco options apply. Motion is not marked: a Konnected opener logs no motion of its own, but its door-open occupancy indicator
 * logs under the motion category, so the category applies to every opener.
 */
export const RATGDO_LOG_EVENTS = [

  { label: "Opener", value: "Opener" },
  { label: "Light", value: "Light" },
  { label: "Motion", value: "Motion" },
  { label: "Obstruction", value: "Obstruction" },
  { disco: true, label: "Vehicle presence", value: "VehiclePresence" }
] as const satisfies readonly RatgdoLogEventEntry[];

// The value of one event category, which is what the logging list stores and what the accessory asks the list about.
export type RatgdoLogEvent = typeof RATGDO_LOG_EVENTS[number]["value"];

/**
 * The event categories the logging list offers, as the choices the settings page lists them by.
 *
 * @param disco - Whether the Disco board's options apply to the device in view, which decides whether vehicle presence is offered.
 *
 * @returns The choices, in the table's order.
 */
export const logEventChoices = (disco: boolean): FeatureOptionChoice[] => RATGDO_LOG_EVENTS.filter((event: RatgdoLogEventEntry) => disco || !event.disco)
  .map(({ label, value }) => ({ label, value }));

/* The retired grammar of the logging list, one boolean option per category, each on by default, as the family HBPU's retired options translate into the list. It
 * is derived from the table, so every category the list offers is one a retired option of the same name carries forward.
 */
export const RATGDO_LOG_EVENTS_FAMILY: RetiredFamily = {

  members: RATGDO_LOG_EVENTS.map(({ value }) => ({ default: true, option: "Log." + value, value })),
  option: RATGDO_LOG_EVENTS_OPTION
};
