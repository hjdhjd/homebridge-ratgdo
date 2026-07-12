/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * telemetry.ts: Pure translation of ESPHome telemetry events into HBR's accessory-facing event shape.
 */
import { CoverOperation, LockState } from "esphome-client";
import type { EspHomeEvent } from "../types.ts";
import type { TelemetryEvent } from "esphome-client";

/* Translate an ESPHome telemetry event into HBR's accessory-facing EspHomeEvent. The telemetry event is a discriminated union over every entity-type
 * StateEventFor; switching on `data.type` narrows each branch to exactly the fields the matching schema declares. Pure and I/O-free - the platform's telemetry listener
 * calls this and hands the result to RatgdoAccessory.updateState(), so the translation can be unit-tested in isolation from the connection lifecycle.
 */
export function translateTelemetry(data: TelemetryEvent): EspHomeEvent {

  // Build the dispatch key updateState() switches on. data.entity is the firmware's human-readable entity name; lowercasing and replacing spaces with underscores
  // reproduces ESPHome's objectId derivation, yielding the canonical "type-objectId" id (e.g. "cover-door", "lock-lock_remotes") that the switch(event.id) in
  // updateState() (device.ts) matches against, whose case labels mirror the object-ids in the RATGDO_ENTITIES registry (entities.ts). Both sides must agree on this
  // normalization or the dispatch silently misses.
  const payload: EspHomeEvent = { id: (data.type + "-" + data.entity).replace(/ /g, "_").toLowerCase(), state: "" };

  switch(data.type) {

    case "binary_sensor":
    case "switch":

      payload.state = data.state ? "ON" : "OFF";

      break;

    case "cover":

      // Any non-zero position means the door is not fully closed, so it reads as OPEN here; the raw position is forwarded separately on payload.position for the
      // dimmer/percentage path.
      payload.state = data.position ? "OPEN" : "CLOSED";

      switch(data.currentOperation) {

        case CoverOperation.IS_OPENING:

          // eslint-disable-next-line camelcase
          payload.current_operation = "OPENING";

          break;

        case CoverOperation.IS_CLOSING:

          // eslint-disable-next-line camelcase
          payload.current_operation = "CLOSING";

          break;

        case undefined:
        case CoverOperation.IDLE:

          // eslint-disable-next-line camelcase
          payload.current_operation = "IDLE";

          break;

        default: {

          // Compile-time exhaustiveness: if esphome-client ever extends CoverOperation, this assignment fails to type-check and we are forced to handle the new value.
          const _exhaust: never = data.currentOperation;

          void _exhaust;

          // eslint-disable-next-line camelcase
          payload.current_operation = "IDLE";

          break;
        }
      }

      payload.position = data.position;

      break;

    case "light":

      payload.state = data.state ? "ON" : "OFF";

      break;

    case "lock":

      switch(data.state) {

        case LockState.LOCKED:

          payload.state = "LOCKED";

          break;

        case LockState.UNLOCKED:

          payload.state = "UNLOCKED";

          break;

        default:

          // Catches every non-binary LockState: NONE (uninitialized wire-spec rail), JAMMED, the LOCKING / UNLOCKING transitional states, and the door-style
          // OPENING / OPEN values that newer firmware can emit. HBR's downstream device-state model only acts on the binary LOCKED / UNLOCKED cases, so everything
          // else surfaces as "UNKNOWN" and is ignored.
          payload.state = "UNKNOWN";

          break;
      }

      break;

    case "button":

      // The ButtonEvent has `pressed: true` as the literal type - button events only fire on press, so the state is always PRESSED.
      payload.state = "PRESSED";

      break;

    default:

      // Every other ESPHome entity type - the diagnostics and auxiliary components this plugin does not model in HomeKit - keeps the empty initial state set above
      // and is dropped by updateState, whose id switch has no case for it. translateTelemetry deliberately carries only the entity types ratgdo consumes.
      break;
  }

  return payload;
}
