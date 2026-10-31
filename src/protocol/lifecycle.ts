/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * lifecycle.ts: Pure translation of ESPHome lifecycle events into the opener's availability statement.
 */
import type { LifecycleEvent } from "esphome-client";
import type { Nullable } from "homebridge-plugin-utils";
import { PermanentError } from "esphome-client";

// What a lifecycle event says about whether the opener can be reached: offline, online, or nothing at all, which is null.
export type AvailabilityStatement = Nullable<"offline" | "online">;

/* Translate an ESPHome lifecycle event into the opener's availability statement. Availability follows the client's reachability verdicts rather than its session
 * boundaries: `lost` states offline and `recovered` states online, while `connect` marks a session beginning and states nothing, because a session can begin
 * without the opener ever having been reported unreachable. A plain `disconnect` states nothing as well: the client's patience window between a drop and its verdict
 * is where a drop it heals on the first attempt stays unseen. The one disconnect that states offline is a PermanentError's, the class the client's default retry
 * predicate refuses, because no reconnect attempt follows that cause and so no verdict ever would. Pure and I/O-free - the platform's lifecycle listener and the
 * webUI status feed each apply the answer, so HomeKit, MQTT and the settings panel agree on when an opener is reachable.
 */
export function translateLifecycle(event: LifecycleEvent): AvailabilityStatement {

  switch(event.kind) {

    case "connect":

      return null;

    case "disconnect":

      return (event.cause instanceof PermanentError) ? "offline" : null;

    case "lost":

      return "offline";

    case "recovered":

      return "online";

    default: {

      // Compile-time exhaustiveness: if a new LifecycleEvent kind is added upstream, this statement fails to type-check and forces us to handle it explicitly.
      event satisfies never;

      return null;
    }
  }
}
