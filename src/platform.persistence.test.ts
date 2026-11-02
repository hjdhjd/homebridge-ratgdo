/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.persistence.test.ts: How the platform writes the accessory cache. A RatgdoPlatform is built on the shared Homebridge test double with its injectable
 * defaults set to the doubles, openers are discovered and admitted through fake dials, and each row reads the cache calls the API double recorded: the saves the
 * library's persistence helper gathers into its window on the platform's TestClock, the removal it makes for a device the user disabled, and the names a fresh
 * accessory is born with and a session under Sync Name re-states.
 */
import { ACCESSORY_SAVE_WINDOW_MS, getServiceName } from "homebridge-plugin-utils";
import type { BuildPlatformResult, TestEspHomeClient } from "./testing.helpers.ts";
import { Characteristic, Service, buildPlatform, customNameEntry, makeCachedAccessory, makeFakeOpenClient, makeOpenerClient,
  makeOpenerService } from "./testing.helpers.ts";
import type { TestHomebridgeApiCall, TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import { expectAt, logCount, present, settle, settleUntil } from "homebridge-plugin-utils/testing";
import { PLATFORM_NAME } from "./webui/settings.ts";
import { PLUGIN_NAME } from "./settings.ts";
import { RatgdoService } from "./types.ts";
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

// A platform whose dials answer the first opener with the given client, under the given options.
const oneOpener = (client: TestEspHomeClient, userOptions: string[] = []): BuildPlatformResult => buildPlatform({ openClient: makeFakeOpenClient(client),
  userOptions });

// Discover and admit the first opener, and answer the accessory the platform registered for it.
const admitOpener = async (built: BuildPlatformResult): Promise<TestPlatformAccessory> => {

  built.launch().found(makeOpenerService({ address: ADDRESS, mac: MAC }));

  await settleUntil(() => built.platform.configuredDevices.size === 1, { description: "the discovered opener to be admitted" });

  return expectAt(built.api.accessories, 0, "the opener's accessory");
};

// One service of an accessory, told apart from its siblings of the same kind by its subtype.
const serviceOf = (accessory: TestPlatformAccessory, serviceType: { readonly UUID: string }, subtype?: string): TestPlatformAccessory["services"][number] => {

  const isPart = (service: TestPlatformAccessory["services"][number]): boolean => (service.UUID === serviceType.UUID) && (service.subtype === subtype);

  return present(accessory.services.find(isPart), "the accessory's " + (subtype ?? "") + " service");
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

  test("a fresh accessory with neither a custom Name nor Sync Name is born with the opener's own name and no ConfiguredName on its information service", async () => {

    const built = oneOpener(makeOpenerClient({ mac: MAC }));
    const accessory = await admitOpener(built);

    assert.equal(accessory.displayName, "Garage", "the accessory takes the name the opener advertises");
    assert.equal(serviceOf(accessory, Service.AccessoryInformation).testCharacteristic(Characteristic.ConfiguredName), false,
      "its information service is given no ConfiguredName, since the plugin owns no name to hold it to");
    assert.equal(getServiceName(serviceOf(accessory, Service.Lightbulb)), "Garage", "and its parts are named from the same name");
  });

  test("a fresh accessory under a custom Name is born with it, its first save carrying the ConfiguredName its information service is given", async () => {

    const built = oneOpener(makeOpenerClient({ mac: MAC }), [customNameEntry("Workshop", MAC)]);
    const accessory = await admitOpener(built);
    const info = serviceOf(accessory, Service.AccessoryInformation);

    assert.equal(accessory.displayName, "Workshop", "the accessory is born with the custom Name");
    assert.equal(info.testCharacteristic(Characteristic.ConfiguredName), true, "its information service is given a ConfiguredName");
    assert.equal(getServiceName(info), "Workshop", "and that ConfiguredName carries the custom Name");
    assert.equal(getServiceName(serviceOf(accessory, Service.Lightbulb)), "Workshop", "its parts are named from the custom Name");
    assert.equal(logCount(built.entries, "info", "Configuring: Workshop (address: " + ADDRESS), 1, "and the platform names the opener by it");
    assert.equal(saves(built).length, 0, "nothing is saved before the window closes");

    built.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

    assert.equal(saves(built).length, 1, "construction's one save carries the names it wrote");
    assert.deepEqual(expectAt(saves(built), 0, "the construction save").accessories, [accessory], "and the save carries the fresh accessory");
  });

  test("under Sync Name a session naming nothing saves nothing, a rename re-states every name and saves, and undoing a Home app rename saves once with no rename logged",
    async () => {

      const client = makeOpenerClient({ mac: MAC });
      const built = oneOpener(client, [ "Enable.Device.SyncName", "Enable.Opener.Switch" ]);
      const accessory = await admitOpener(built);
      const info = serviceOf(accessory, Service.AccessoryInformation);
      const light = serviceOf(accessory, Service.Lightbulb);
      const opener = serviceOf(accessory, Service.Switch, RatgdoService.SWITCH_OPENER_AUTOMATION);

      built.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      const afterConstruction = saves(built).length;

      assert.equal(getServiceName(info), "Garage", "Sync Name holds the information service to the name the opener advertises");

      client.emit("lifecycle", { kind: "disconnect" });
      client.emit("lifecycle", { encrypted: false, kind: "connect" });
      built.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      assert.equal(saves(built).length, afterConstruction, "a session whose device-info record carries no name keeps the seeded name, so it saves nothing");
      assert.equal(accessory.displayName, "Garage", "and the accessory keeps its name");
      assert.equal(logCount(built.entries, "info", "Detected a name change on the device"), 0, "so no rename is logged");

      Object.assign(present(client.deviceInfo(), "the opener's device-info record"), { friendlyName: "Workshop" });
      client.emit("lifecycle", { kind: "disconnect" });
      client.emit("lifecycle", { encrypted: false, kind: "connect" });
      built.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      assert.equal(saves(built).length, afterConstruction + 1, "a session that renames the opener moves the names the cache holds, so it saves");
      assert.deepEqual([ accessory.displayName, getServiceName(info), getServiceName(light), getServiceName(opener) ],
        [ "Workshop", "Workshop", "Workshop", "Workshop Automation Opener" ],
        "the accessory, its information service, and every part are re-stated to the opener's new name");
      assert.equal(logCount(built.entries, "info", "Detected a name change on the device; updating the HomeKit name to Workshop."), 1,
        "and the rename is logged once, naming the opener's new HomeKit name");

      // A plugin-side write of the information service's ConfiguredName stands for a rename still standing when a session begins. The name watch never reads the plugin's
      // own write as a rename, so nothing puts the service back before the session's re-state does.
      info.getCharacteristic(Characteristic.ConfiguredName).updateValue("Shop");

      const beforeRestate = saves(built).length;
      const restatedFrom = built.entries.length;

      client.emit("lifecycle", { kind: "disconnect" });
      client.emit("lifecycle", { encrypted: false, kind: "connect" });
      built.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      assert.equal(saves(built).length, beforeRestate + 1, "a session whose re-state writes over a Home app rename moves a name the cache holds, so it saves once");
      assert.equal(getServiceName(info), "Workshop", "the re-state puts the information service back to the name the plugin owns");
      assert.equal(accessory.displayName, "Workshop", "while the accessory's display name, which no Home app rename touches, stays where it was");
      assert.equal(logCount(built.entries.slice(restatedFrom), "info", "Detected a name change on the device"), 0,
        "so the session logs no rename, since a write that moves no display name is no change on the device");
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
