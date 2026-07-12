/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * entities.ts: The single source of truth for the ESPHome entity identities ratgdo addresses, plus the derived initial-state wait set.
 */
import type { EntityId } from "esphome-client";
import { RatgdoVariant } from "./types.ts";
import { entityId } from "esphome-client";

/* The local union of ESPHome entity types ratgdo identifies. esphome-client's EntityType spans every ESPHome entity type - many we do not consume - so narrowing
 * to just our consumed set keeps `RATGDO_ENTITIES`'s typing precise and the registry self-documenting. Widening this union to add a new ratgdo-consumed entity
 * type is a one-line, additive edit here; the compile-time enforcement that keeps every variant in sync comes from the entity interfaces below requiring a
 * matching field, not from this union edit itself.
 */
type RatgdoEntityType = "binary_sensor" | "button" | "cover" | "light" | "lock" | "switch";

export interface RatgdoEntityRef<T extends RatgdoEntityType = RatgdoEntityType> {

  readonly objectId: string;
  readonly type: T;
}

/* Variant-keyed registries of every ESPHome entity ratgdo identifies. Each variant has its own required set of entities, expressed as a typed map so the
 * compiler enforces "this entity exists on this variant" at every access site. Cross-variant entities live in `BaseEntities` (cover, light, lock, obstruction,
 * refresh); each variant extends the base with its own additions. No field is optional - the absence-on-the-wrong-variant case is expressed by the variant's type
 * not declaring the field at all, which means consumers narrow on `this.device.variant` to reach variant-specific entities and the access at that narrowed site is
 * statically guaranteed to be defined. Adding a new required field fails compilation at the `RATGDO_ENTITIES` literal (and at any consumer that already requires
 * that field); adding a new variant fails compilation only at the sites that already switch exhaustively over `RatgdoVariant`.
 *
 * The momentary binary sensors (motion, vehicle_arriving, vehicle_leaving) intentionally do not appear here: they are not used for command dispatch or initial-state
 * extraction, and their absent-pushes-on-SUBSCRIBE behavior must not block construction. Adding them here would imply a wait-set membership that would be incorrect.
 */
interface BaseEntities {

  readonly cover: RatgdoEntityRef<"cover">;
  readonly light: RatgdoEntityRef<"light">;
  readonly lock: RatgdoEntityRef<"lock">;
  readonly obstruction: RatgdoEntityRef<"binary_sensor">;
  readonly refresh: RatgdoEntityRef<"button">;
}

interface RatgdoEntities extends BaseEntities {

  readonly laser: RatgdoEntityRef<"switch">;
  readonly led: RatgdoEntityRef<"switch">;
  readonly vehicleDetected: RatgdoEntityRef<"binary_sensor">;
}

interface KonnectedEntities extends BaseEntities {

  readonly pcw: RatgdoEntityRef<"button">;
  readonly strOutput: RatgdoEntityRef<"switch">;
}

interface RatgdoEntityRegistry {

  readonly [RatgdoVariant.KONNECTED]: KonnectedEntities;
  readonly [RatgdoVariant.RATGDO]: RatgdoEntities;
}

/* The single source of truth for ratgdo entity identities. Every site that needs to address an ESPHome entity by wire id - the initial-state readers in
 * `buildInitialStatus`, the dispatcher in `command()`, the wait-list builder for `captureInitialState` - resolves through this map. No production site constructs
 * `entityId(...)` from literal strings outside this registry (test fixtures aside); this is a maintained convention rather than a type-system guarantee.
 */
export const RATGDO_ENTITIES: RatgdoEntityRegistry = {

  [RatgdoVariant.KONNECTED]: {

    cover: { objectId: "garage_door", type: "cover" },
    light: { objectId: "garage_light", type: "light" },
    lock: { objectId: "lock", type: "lock" },
    obstruction: { objectId: "obstruction", type: "binary_sensor" },
    pcw: { objectId: "pre-close_warning", type: "button" },
    refresh: { objectId: "query_status", type: "button" },
    strOutput: { objectId: "str_output", type: "switch" }
  },
  [RatgdoVariant.RATGDO]: {

    cover: { objectId: "door", type: "cover" },
    laser: { objectId: "laser", type: "switch" },
    led: { objectId: "led", type: "switch" },
    light: { objectId: "light", type: "light" },
    lock: { objectId: "lock_remotes", type: "lock" },
    obstruction: { objectId: "obstruction", type: "binary_sensor" },
    refresh: { objectId: "query_status", type: "button" },
    vehicleDetected: { objectId: "vehicle_detected", type: "binary_sensor" }
  }
};

// Resolve a typed entity ref into the ESPHome client's branded EntityId. Module-scope so the registry's structural shape can be consumed without instance state - the
// initial-state wait-list builder calls this before any RatgdoAccessory exists.
export const idFor = <T extends RatgdoEntityType>(ref: RatgdoEntityRef<T>): EntityId<T> => entityId(ref.type, ref.objectId);

/* Derive the initial-state wait set from the registry. captureInitialState gates RatgdoAccessory construction on every one of these entities appearing in the ESPHome
 * client's LatestStateCache, so the list controls exactly which entities must push state before HomeKit sees the device. We switch on variant so each branch reads
 * from its variant-narrowed registry and the entity refs are required (no optional handling). Stateless triggers (`refresh`, `pcw`) are intentionally absent from
 * the lists - buttons never push state, so waiting on them would hang. The switch is exhaustive: adding a new variant fails compilation here until handled, which
 * is the architectural guarantee that this list cannot fall out of sync with the variant taxonomy.
 */
export function ratgdoInitialStateEntityIds(variant: RatgdoVariant): readonly EntityId[] {

  switch(variant) {

    case RatgdoVariant.KONNECTED: {

      const entities = RATGDO_ENTITIES[RatgdoVariant.KONNECTED];

      return [

        idFor(entities.cover),
        idFor(entities.light),
        idFor(entities.lock),
        idFor(entities.obstruction),
        idFor(entities.strOutput)
      ];
    }

    case RatgdoVariant.RATGDO: {

      const entities = RATGDO_ENTITIES[RatgdoVariant.RATGDO];

      return [

        idFor(entities.cover),
        idFor(entities.laser),
        idFor(entities.led),
        idFor(entities.light),
        idFor(entities.lock),
        idFor(entities.obstruction),
        idFor(entities.vehicleDetected)
      ];
    }
  }
}
