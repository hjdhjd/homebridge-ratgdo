/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * types.test.ts: Types-index concern net - the const-object "enums" exported from types.ts (RatgdoService, RatgdoVariant) and the plugin registration
 * entry point in index.ts.
 *
 * RatgdoService and RatgdoVariant are modelled as `as const` objects paired with same-named string-literal unions rather than TypeScript enums (see the rationale in
 * types.ts: enums are non-erasable and clash with the "erasableSyntaxOnly" tsconfig flag). The call-site shape mimics an enum, so these tests pin the
 * representative member-to-string resolutions and the full key/value contract. Because `as const` is a compile-time-only narrowing, the emitted JavaScript is a plain
 * mutable object - we assert that runtime reality (Object.isFrozen is false) and lean on the exhaustive key/value snapshot as the immutability contract proxy.
 *
 * The registration smoke drives index.ts's default export against a minimal fake Homebridge API whose registerPlatform is a node:test mock, asserting the entry point
 * wires the plugin name, platform name, and the RatgdoPlatform constructor through in a single call.
 */
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import { RatgdoService, RatgdoVariant } from "./types.ts";
import { describe, mock, test } from "node:test";
import type { API } from "homebridge";
import { RatgdoPlatform } from "./platform.ts";
import assert from "node:assert/strict";
import registerRatgdoPlatform from "./index.ts";

describe("RatgdoService const-object enum", () => {

  test("resolves representative members to their HomeKit subtype string values", () => {

    assert.equal(RatgdoService.GARAGE_DOOR, "GarageDoor", "RatgdoService.GARAGE_DOOR resolves to the \"GarageDoor\" cache-key / subtype string");
    assert.equal(RatgdoService.LIGHT, "Light", "RatgdoService.LIGHT resolves to the \"Light\" cache-key / subtype string");
  });

  test("is not runtime-frozen because `as const` is a compile-time-only narrowing", () => {

    // The `as const` assertion narrows the static type to readonly literals, but it emits a plain mutable object - it never calls Object.freeze - so the runtime
    // object reports as not frozen. We pin that reality here rather than asserting a frozen state the production idiom does not actually provide.
    assert.equal(Object.isFrozen(RatgdoService), false, "`as const` narrows types at compile time only, so the emitted RatgdoService object is not runtime-frozen");
  });

  test("exposes the exact, exhaustive key-to-value mapping as the immutability contract proxy", () => {

    // With no runtime freeze to assert, the full key/value snapshot is the strongest available contract: any added, removed, or retitled member trips this assertion.
    assert.deepEqual(RatgdoService, {

      BATTERY: "Battery",
      CONTACT_DISCO_VEHICLE_ARRIVING: "ContactSensor.Disco.Vehicle.Arriving",
      CONTACT_DISCO_VEHICLE_LEAVING: "ContactSensor.Disco.Vehicle.Leaving",
      DIMMER_OPENER_AUTOMATION: "Dimmer.Opener.Automation",
      GARAGE_DOOR: "GarageDoor",
      LIGHT: "Light",
      MOTION_SENSOR: "MotionSensor",
      OCCUPANCY_DISCO_VEHICLE_PRESENCE: "OccupancySensor.Disco.Vehicle.Presence",
      OCCUPANCY_SENSOR_DOOR_OPEN: "OccupancySensor.DoorOpen",
      OCCUPANCY_SENSOR_MOTION: "OccupancySensor.Motion",
      SWITCH_DISCO_LASER: "Switch.Disco.Laser",
      SWITCH_DISCO_LED: "Switch.Disco.Led",
      SWITCH_KONNECTED_PCW: "Switch.Konnected.PCW",
      SWITCH_KONNECTED_STROBE: "Switch.Konnected.Strobe",
      SWITCH_LOCKOUT: "Switch.Lockout",
      SWITCH_OPENER_AUTOMATION: "Switch.Opener.Automation"
    }, "RatgdoService carries exactly its sixteen documented members, each mapping to its literal string value");
  });
});

describe("RatgdoVariant const-object enum", () => {

  test("resolves both variant members to their lowercase project-prefix string values", () => {

    assert.equal(RatgdoVariant.RATGDO, "ratgdo", "RatgdoVariant.RATGDO resolves to the \"ratgdo\" variant tag");
    assert.equal(RatgdoVariant.KONNECTED, "konnected", "RatgdoVariant.KONNECTED resolves to the \"konnected\" variant tag");
  });

  test("is not runtime-frozen because `as const` is a compile-time-only narrowing", () => {

    assert.equal(Object.isFrozen(RatgdoVariant), false, "`as const` narrows types at compile time only, so the emitted RatgdoVariant object is not runtime-frozen");
  });

  test("exposes the exact, exhaustive key-to-value mapping as the immutability contract proxy", () => {

    assert.deepEqual(RatgdoVariant, { KONNECTED: "konnected", RATGDO: "ratgdo" },
      "RatgdoVariant carries exactly its two documented members, each mapping to its lowercase tag");
  });
});

describe("plugin registration entry point", () => {

  test("registers the RatgdoPlatform under the plugin and platform names exactly once", () => {

    const registerPlatform = mock.fn();

    // The entry point only ever touches api.registerPlatform, so a stub carrying just that mocked method is a faithful minimal Homebridge API for this seam.
    const api = { registerPlatform } as unknown as API;

    registerRatgdoPlatform(api);

    const [call] = registerPlatform.mock.calls;

    assert.equal(registerPlatform.mock.callCount(), 1, "invoking the default export registers exactly one platform");
    assert.ok(call, "registerPlatform recorded a call");
    assert.deepEqual(call.arguments, [ PLUGIN_NAME, PLATFORM_NAME, RatgdoPlatform ],
      "registerPlatform receives the plugin name, the platform name, and the RatgdoPlatform constructor in that order");
  });

  test("passes the RatgdoPlatform class itself - not a wrapper or instance - as the constructor argument", () => {

    const registerPlatform = mock.fn();
    const api = { registerPlatform } as unknown as API;

    registerRatgdoPlatform(api);

    const [call] = registerPlatform.mock.calls;

    assert.ok(call, "registerPlatform recorded a call");

    // Homebridge constructs the platform itself, so the third argument must be the class reference identically - a wrapper or pre-built instance would break discovery.
    assert.equal(call.arguments[2], RatgdoPlatform, "the third registration argument is the RatgdoPlatform constructor by identity");
    assert.equal(call.arguments[1], PLATFORM_NAME, "the second registration argument is the configured platform name");
  });
});
