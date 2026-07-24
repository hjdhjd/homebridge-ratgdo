/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * entities.test.ts: Unit tests for the entity registry and its derived helpers - the registry's variant-specific fields, the initial-state and status wait sets per
 * variant, idFor's branded-id minting, and presentEntityIds' intersection against a device's advertised entity list. The registry is pure data with no runtime I/O, so
 * the contract under test is the data and the exact wire ids the helpers derive from it; a fake esphome-client stands in for the advertised-entity source.
 */
import { RATGDO_ENTITIES, idFor, presentEntityIds, ratgdoInitialStateEntityIds, ratgdoStatusEntityIds } from "./entities.ts";
import { TestEspHomeClient, asEspHomeClient } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";
import { entityId } from "esphome-client";

describe("RATGDO_ENTITIES", () => {

  test("carries motion as a ratgdo-only binary sensor", () => {

    assert.deepEqual(RATGDO_ENTITIES[RatgdoVariant.RATGDO].motion, { objectId: "motion", type: "binary_sensor" },
      "the ratgdo variant registers the momentary motion sensor by its wire object id");
    assert.equal("motion" in RATGDO_ENTITIES[RatgdoVariant.KONNECTED], false, "Konnected firmware advertises no motion entity, so the field is absent on that variant");
  });
});

describe("idFor", () => {

  test("mints the branded type-objectId wire id for a registry ref", () => {

    assert.equal(idFor(RATGDO_ENTITIES[RatgdoVariant.RATGDO].motion), entityId("binary_sensor", "motion"), "idFor composes the canonical id from the ref");
    assert.equal(idFor(RATGDO_ENTITIES[RatgdoVariant.RATGDO].cover), "cover-door", "the ratgdo cover resolves to the cover-door wire id");
    assert.equal(idFor(RATGDO_ENTITIES[RatgdoVariant.KONNECTED].cover), "cover-garage_door", "the Konnected cover resolves to the cover-garage_door wire id");
  });
});

describe("ratgdoInitialStateEntityIds", () => {

  test("lists the stateful entities the ratgdo variant must push before construction", () => {

    assert.deepEqual(ratgdoInitialStateEntityIds(RatgdoVariant.RATGDO),
      [ "cover-door", "switch-laser", "switch-led", "light-light", "lock-lock_remotes", "binary_sensor-obstruction", "binary_sensor-vehicle_detected" ],
      "the ratgdo wait set covers every stateful entity and excludes the momentary motion sensor and the stateless refresh button");
  });

  test("lists the stateful entities the Konnected variant must push before construction", () => {

    assert.deepEqual(ratgdoInitialStateEntityIds(RatgdoVariant.KONNECTED),
      [ "cover-garage_door", "light-garage_light", "lock-lock", "binary_sensor-obstruction", "switch-str_output" ],
      "the Konnected wait set covers every stateful entity and excludes the stateless query-status button");
  });
});

describe("ratgdoStatusEntityIds", () => {

  test("lists the ratgdo status row universe, motion included, in display order", () => {

    assert.deepEqual(ratgdoStatusEntityIds(RatgdoVariant.RATGDO),
      [ "cover-door", "light-light", "lock-lock_remotes", "binary_sensor-motion", "binary_sensor-obstruction" ],
      "the ratgdo status universe is door, light, lock, motion, obstruction and excludes the laser / led switches");
  });

  test("lists the Konnected status row universe without motion", () => {

    assert.deepEqual(ratgdoStatusEntityIds(RatgdoVariant.KONNECTED),
      [ "cover-garage_door", "light-garage_light", "lock-lock", "binary_sensor-obstruction" ],
      "the Konnected status universe is door, light, lock, obstruction - the firmware advertises no motion sensor");
  });
});

describe("presentEntityIds", () => {

  const coverId = entityId("cover", "door");
  const lightId = entityId("light", "light");
  const lockId = entityId("lock", "lock_remotes");

  test("returns only the wanted ids the device actually advertises, in wanted order", () => {

    // The device advertises the cover and light but not the lock, so a cover + light + lock wait-list collapses to the two advertised entities, keeping the wanted order.
    const client = new TestEspHomeClient({ entities: [ { objectId: "light", type: "light" }, { objectId: "door", type: "cover" } ] });
    const present = presentEntityIds(asEspHomeClient(client), [ coverId, lightId, lockId ]);

    assert.deepEqual(present, [ coverId, lightId ], "the intersection keeps only advertised entities and preserves the wanted order rather than the advertised order");
  });

  test("returns the full wanted list when the device advertises a superset", () => {

    // The device advertises everything wanted plus an extra entity the caller does not ask for; the extra never appears in the result.
    const entities = [ { objectId: "door", type: "cover" }, { objectId: "light", type: "light" }, { objectId: "laser", type: "switch" } ];
    const client = new TestEspHomeClient({ entities });
    const present = presentEntityIds(asEspHomeClient(client), [ coverId, lightId ]);

    assert.deepEqual(present, [ coverId, lightId ], "a device advertising more than the wanted set yields exactly the wanted entities, not the extras");
  });

  test("returns an empty list when the device advertises none of the wanted ids", () => {

    const client = new TestEspHomeClient({ entities: [] });
    const present = presentEntityIds(asEspHomeClient(client), [ coverId, lightId, lockId ]);

    assert.deepEqual(present, [], "a device advertising no wanted entity collapses the intersection to empty");
  });
});
