/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.persistence.test.ts: How the platform writes the accessory cache. A RatgdoPlatform is built on the shared Homebridge test double with its injectable
 * defaults set to the doubles, openers are discovered and admitted through fake dials, and each row reads the cache calls the API double recorded: the saves the
 * library's persistence helper gathers into its window on the platform's TestClock, and the removal it makes for a device the user disabled.
 */
import type { BuildPlatformResult, TestEspHomeClient } from "./testing.helpers.ts";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { TestHomebridgeApiCall, TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import { buildPlatform, makeCachedAccessory, makeFakeOpenClient, makeOpenerClient, makeOpenerService } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import { expectAt, logCount, present, settle, settleUntil } from "homebridge-plugin-utils/testing";
import { ACCESSORY_SAVE_WINDOW_MS } from "homebridge-plugin-utils";
import assert from "node:assert/strict";

// The openers this suite admits, each in the plugin's identity form, and the address each advertises.
const MAC = "AABBCCDDEEFF";
const MAC_TWO = "112233445566";
const ADDRESS = "192.0.2.10";
const ADDRESS_TWO = "192.0.2.11";

// The saves the API double recorded, in the order Homebridge accepted them.
const saves = (built: BuildPlatformResult): TestHomebridgeApiCall[] => built.api.calls.filter((call) => call.kind === "update");

// A platform whose dials answer each opener at its own address with that opener's client.
const twoOpeners = (): { built: BuildPlatformResult; clients: Map<string, TestEspHomeClient> } => {

  const clients = new Map([ [ ADDRESS, makeOpenerClient({ mac: MAC }) ], [ ADDRESS_TWO, makeOpenerClient({ mac: MAC_TWO }) ] ]);
  const built = buildPlatform({ openClient: makeFakeOpenClient(async (options) => present(clients.get(options.host), "the opener answering at " + options.host)) });

  return { built, clients };
};

describe("RatgdoPlatform accessory cache", () => {

  test("saves several openers configured inside one save window in a single update once the window closes", async () => {

    const { built } = twoOpeners();
    const browser = built.launch();

    browser.found(makeOpenerService({ address: ADDRESS, mac: MAC }));
    browser.found(makeOpenerService({ address: ADDRESS_TWO, mac: MAC_TWO }));

    await settleUntil(() => built.platform.configuredDevices.size === 2, { description: "every discovered opener to be admitted" });

    assert.equal(saves(built).length, 0, "the saves wait for the window rather than going to Homebridge one opener at a time");

    built.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

    const [save] = saves(built);

    assert.equal(saves(built).length, 1, "the window closes on one save");
    assert.deepEqual(new Set(present(save, "the window's save").accessories), new Set(built.api.accessories),
      "and that save carries every opener configured inside the window, the cache its construction built");
  });

  test("a session that moves the opener's identity saves its accessory, and one that moves nothing saves nothing", async () => {

    const { built, clients } = twoOpeners();

    built.launch().found(makeOpenerService({ address: ADDRESS, mac: MAC }));

    await settleUntil(() => built.platform.configuredDevices.size === 1, { description: "the discovered opener to be admitted" });

    built.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

    const afterConstruction = saves(built).length;
    const client = present(clients.get(ADDRESS), "the opener's client");

    client.emit("lifecycle", { kind: "disconnect" });
    client.emit("lifecycle", { encrypted: false, kind: "connect" });
    built.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

    assert.equal(saves(built).length, afterConstruction, "a session on the same firmware changes nothing the cache holds, so it saves nothing");

    Object.assign(present(client.deviceInfo(), "the opener's device-info record"), { esphomeVersion: "2025.10.1", projectVersion: "2.5.0" });
    client.emit("lifecycle", { kind: "disconnect" });
    client.emit("lifecycle", { encrypted: false, kind: "connect" });
    built.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

    assert.equal(saves(built).length, afterConstruction + 1, "a session on new firmware moves the Model and FirmwareRevision the cache holds, so it saves");
    assert.deepEqual(expectAt(saves(built), afterConstruction, "the identity save").accessories, built.api.accessories, "and the save carries the opener's accessory");
  });

  test("a device the user disabled is removed from the cache through the persistence helper", async () => {

    const built = buildPlatform({ openClient: makeFakeOpenClient(makeOpenerClient({ mac: MAC })), userOptions: ["Disable.Device." + MAC] });
    const accessory: TestPlatformAccessory = makeCachedAccessory({ api: built.api, mac: MAC });

    built.api.restorePlatformAccessories({ accessories: [accessory], platform: built.platform, platformName: PLATFORM_NAME, pluginIdentifier: PLUGIN_NAME });
    built.launch().found(makeOpenerService({ address: ADDRESS, mac: MAC }));

    await settleUntil(() => built.api.calls.some((call) => call.kind === "unregister"), { description: "the disabled device's removal" });
    await settle();

    const removals = built.api.calls.filter((call) => call.kind === "unregister");

    assert.equal(removals.length, 1, "the disabled device's cached accessory is removed once");
    assert.deepEqual(expectAt(removals, 0, "the removal").accessories, [accessory], "and the removal names the accessory the cache restored");
    assert.equal(logCount(built.entries, "info", "Removing device from HomeKit."), 1, "the user is told the device left HomeKit");
    assert.equal(built.platform.configuredDevices.size, 0, "and nothing configures a device the user disabled");
  });
});
