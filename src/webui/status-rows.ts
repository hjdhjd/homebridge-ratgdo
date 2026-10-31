/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * status-rows.ts: The settings panel's status-row vocabulary - each row's identity, label, width reservation, momentary latch, display value, and place in the
 * panel's order - which the settings page and the plugin's status feed both import.
 *
 * The feed builds every snapshot row from a template here, renders its value through mapRowValue, and lists the rows in the panel's order, and the page hands the same
 * templates in that order to the panel as the skeleton it renders before the first snapshot, so a row reads the same label, holds the same width and place, and clears
 * its momentary value on the same latch before and after its device answers.
 */
import type { StatusRowLatch, StatusTextRowTemplate } from "homebridge-plugin-utils";
import type { EspHomeEvent } from "../types.ts";
import { RATGDO_MOTION_DURATION } from "./settings.ts";

// The panel's row identities, a closed union that types the label, sizer, and latch records exhaustively. The wire carries a row id as a plain string; this closed
// union is ratgdo's own, so a new row must extend it here and gains its label and sizer entries at compile time.
export type StatusRowId = "door" | "light" | "lock" | "motion" | "obstruction";

// The human-readable label for each row identity. The "Remotes" label reflects that the lock entity controls the opener's remote lockout rather than a physical deadbolt.
const STATUS_ROW_LABELS: Record<StatusRowId, string> = {

  door: "Door",
  light: "Light",
  lock: "Remotes",
  motion: "Motion",
  obstruction: "Obstruction"
};

/* Map a translated telemetry event to its display value for a given row. The switch is exhaustive over StatusRowId. The door reads current_operation first so a moving
 * door shows its transition, then falls back to position: a raw 0-1 cover position of >= 1 is Open, <= 0 is Closed (the translation reads the wire's omitted zero as
 * 0, so a closed door arrives at the closed position, and an absence the event's type still allows reads as Closed too), and anything strictly between is a partial
 * stop. The remaining rows are straight state translations.
 *
 * @param rowId - The row the value renders in.
 * @param event - The translated telemetry event.
 *
 * @returns The row's display value.
 */
export function mapRowValue(rowId: StatusRowId, event: EspHomeEvent): string {

  switch(rowId) {

    case "door": {

      if(event.current_operation === "OPENING") {

        return "Opening";
      }

      if(event.current_operation === "CLOSING") {

        return "Closing";
      }

      const position = event.position;

      if((position === undefined) || (position <= 0)) {

        return "Closed";
      }

      if(position >= 1) {

        return "Open";
      }

      return "Stopped (" + String(Math.round(position * 100)) + "%)";
    }

    case "light": {

      return (event.state === "ON") ? "On" : "Off";
    }

    case "lock": {

      switch(event.state) {

        case "LOCKED":

          return "Locked";

        case "UNLOCKED":

          return "Unlocked";

        default:

          return "Unknown";
      }
    }

    case "motion": {

      return (event.state === "ON") ? "Detected" : "";
    }

    case "obstruction": {

      return (event.state === "ON") ? "Obstructed" : "Clear";
    }

    default: {

      // Compile-time exhaustiveness: a new StatusRowId fails to type-check here until it is handled.
      rowId satisfies never;

      return "";
    }
  }
}

/* The widest display value each row's vocabulary can produce, one entry per row id. This lives beside mapRowValue because the two share one vocabulary: a change to a
 * row's value set - a new lock state, a wider door label - must update the widest member here in the same edit. The frontend renders each as an invisible width
 * reservation so a column is born at its maximum-ever width and never truncates a value or shifts. The door's "Stopped (100%)" is its widest because the three-digit
 * percentage is the longest partial-position label; "Off", "Unlocked", "Detected", and "Obstructed" are each the longest member of their row's closed value set. Typing
 * the map as a Record over StatusRowId makes it fail to compile until every row id is covered.
 */
const STATUS_ROW_SIZERS: Record<StatusRowId, string> = {

  door: "Stopped (100%)",
  light: "Off",
  lock: "Unlocked",
  motion: "Detected",
  obstruction: "Obstructed"
};

/* The latch each momentary row carries. A momentary row's value clears back to its placeholder on its latch, motion's Detected on the same duration the accessory's own
 * motion state clears on, and a steady-state row carries none.
 */
const STATUS_ROW_LATCHES: Partial<Record<StatusRowId, StatusRowLatch>> = {

  motion: { seconds: RATGDO_MOTION_DURATION, value: "Detected" }
};

/* One row's static vocabulary as the panel's template form states it: its identity, its label, its width reservation, and its latch when it has one. A snapshot row is
 * this template plus the value the device reports, so the feed builds each one from here.
 *
 * @param rowId - The row identity.
 *
 * @returns The row's template.
 */
export function statusRowTemplate(rowId: StatusRowId): StatusTextRowTemplate {

  const template: StatusTextRowTemplate = { id: rowId, label: STATUS_ROW_LABELS[rowId], sizer: STATUS_ROW_SIZERS[rowId] };
  const latch = STATUS_ROW_LATCHES[rowId];

  // A steady-state row carries no latch key at all rather than an undefined one, so the template matches the shape the panel's own contract states.
  if(latch) {

    template.latch = latch;
  }

  return template;
}

// The order the panel lists its rows in. This is the one statement of it - the page's skeleton is built in this order and the feed lists every snapshot's rows in
// it - so a row renders in the same place before and after its device answers, whichever rows a variant advertises.
export const STATUS_ROW_ORDER: readonly StatusRowId[] = [ "door", "lock", "motion", "light", "obstruction" ];

// The row templates in the panel's order, which is the skeleton the page renders before the first snapshot.
export const STATUS_ROW_TEMPLATES: readonly StatusTextRowTemplate[] = STATUS_ROW_ORDER.map((rowId) => statusRowTemplate(rowId));
