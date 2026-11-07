/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.restore.test.ts: A restored accessory before and after this run reaches its opener. A previous run's accessory is made by constructing it once, and it
 * is restored into a RatgdoPlatform built on the shared Homebridge test double with its injectable defaults set to the doubles, so HomeKit's reads and writes meet
 * the bindings the platform's configureAccessory gave it, and then whatever construction leaves of them once a discovered opener is admitted.
 */
import type { BuildPlatformResult, TestEspHomeClient } from "./testing.helpers.ts";
import { Characteristic, Service, buildPlatform, makeCachedAccessory, makeFakeOpenClient, makeOpenerClient, makeOpenerService,
  vehicleSensorsEntry } from "./testing.helpers.ts";
import { HAPStatus, Perms } from "homebridge-plugin-utils";
import { describe, test } from "node:test";
import { drainClock, hapStatus, present, settle, settleUntil, triggerGet, triggerSet } from "homebridge-plugin-utils/testing";
import { PLATFORM_NAME } from "./webui/settings.ts";
import { PLUGIN_NAME } from "./settings.ts";
import type { TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";

// The opener this suite restores and admits, and another opener the platform reaches instead, each in the plugin's identity form.
const MAC = "AABBCCDDEEFF";
const OTHER = "112233445566";

// The fully loaded Ratgdo configuration, so the cached accessory carries every service a previous run could have attached, each with its own characteristics.
const ALL_OPTIONS = [ "Enable.Disco.Battery", "Enable.Disco.Switch.Laser", "Enable.Disco.Switch.Led", vehicleSensorsEntry(), "Enable.Motion.OccupancySensor",
  "Enable.Opener.Dimmer", "Enable.Opener.OccupancySensor", "Enable.Opener.Switch", "Enable.Opener.Switch.RemoteLockout" ];

// The refusal HomeKit renders as No Response.
const isNoResponse = hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

// One characteristic HomeKit can reach, as the accessory under test holds it.
type HapCharacteristic = TestPlatformAccessory["services"][number]["characteristics"][number];

// Every characteristic on the accessory's services other than AccessoryInformation, which is what HomeKit reads and writes an opener through, each with the place it
// lives for an assertion's message.
const reachable = (accessory: TestPlatformAccessory): { characteristic: HapCharacteristic; where: string }[] => {

  return accessory.services.filter((service) => service.UUID !== Service.AccessoryInformation.UUID).flatMap((service) => service.characteristics.map(
    (characteristic) => ({ characteristic, where: service.displayName + " / " + characteristic.displayName })));
};

// Whether HomeKit may read or write a characteristic, from the permissions HAP itself enforces.
const readable = (characteristic: HapCharacteristic): boolean => characteristic.props.perms.includes(Perms.PAIRED_READ);
const writable = (characteristic: HapCharacteristic): boolean => characteristic.props.perms.includes(Perms.PAIRED_WRITE);

// The light's own Lightbulb, told apart from the automation dimmer's, which is a Lightbulb carrying a subtype.
const lightOf = (accessory: TestPlatformAccessory): TestPlatformAccessory["services"][number] => {

  return present(accessory.services.find((service) => (service.UUID === Service.Lightbulb.UUID) && (service.subtype === undefined)), "the light's Lightbulb service");
};

/* Restore a previous run's accessory for an opener into a platform built with the fully loaded configuration, the restore running Homebridge's own order: the
 * accessory is handed to the platform's configureAccessory and bridged once that call returns.
 */
const restore = ({ mac = MAC, mqtt = false, openClient }: { mac?: string; mqtt?: boolean; openClient?: ReturnType<typeof makeFakeOpenClient> } = {}):
{ accessory: TestPlatformAccessory; built: BuildPlatformResult } => {

  const built = buildPlatform({ mqtt, openClient, userOptions: ALL_OPTIONS });
  const accessory = makeCachedAccessory({ api: built.api, mac, userOptions: ALL_OPTIONS });

  built.api.restorePlatformAccessories({ accessories: [accessory], platform: built.platform, platformName: PLATFORM_NAME, pluginIdentifier: PLUGIN_NAME });

  return { accessory, built };
};

// Launch the platform, advertise an opener, and wait for the platform to configure it.
const admit = async (built: BuildPlatformResult, mac: string, address: string): Promise<void> => {

  built.launch().found(makeOpenerService({ address, mac }));

  await settleUntil(() => built.platform.configuredDevices.size === 1, { description: "the discovered opener to be admitted" });
};

// An opener's dial, answered by that opener's client double.
const dialing = (client: TestEspHomeClient): ReturnType<typeof makeFakeOpenClient> => makeFakeOpenClient(client);

describe("RatgdoPlatform restored accessories", () => {

  test("a restored opener refuses every read and every write with No Response until this run reaches it, and MQTT already states it offline", async () => {

    const { accessory, built } = restore({ mqtt: true });
    const walked = reachable(accessory);
    const names = new Set(walked.map(({ characteristic }) => characteristic.displayName));

    for(const name of [ "Configured Name", "Current Door State", "Status Active", "Target Door State" ]) {

      assert.ok(names.has(name), "the cached accessory carries a " + name + " for the walk to reach");
    }

    for(const { characteristic, where } of walked) {

      if(readable(characteristic)) {

        // The walk awaits each request in turn, so a refusal reads against the characteristic that produced it.
        // eslint-disable-next-line no-await-in-loop
        await assert.rejects(triggerGet(characteristic), isNoResponse, "HomeKit's read of " + where + " refuses with No Response before admission");
      }

      if(writable(characteristic)) {

        // eslint-disable-next-line no-await-in-loop
        await assert.rejects(triggerSet(characteristic, present(characteristic.value, "the value " + where + " holds")), isNoResponse,
          "HomeKit's write of " + where + " refuses with No Response before admission");
      }
    }

    const mqtt = present(built.mqtt, "the MQTT double");

    mqtt.connected = false;
    mqtt.connected = true;

    await settle();

    assert.deepEqual(mqtt.publishedTo(MAC + "/availability").map(({ payload, retain }) => ({ payload, retain })), [{ payload: "offline", retain: true }],
      "the broker session states the restored, unreached opener offline, so HomeKit and MQTT agree");
  });

  test("an admitted opener answers every read on every characteristic, those its construction leaves unbound among them", async () => {

    const { accessory, built } = restore({ openClient: dialing(makeOpenerClient({ mac: MAC })) });

    await admit(built, MAC, "192.0.2.10");

    assert.ok(built.platform.configuredDevices.has(accessory.UUID), "the platform constructed the opener over the accessory it restored");

    const walked = reachable(accessory).filter(({ characteristic }) => readable(characteristic));

    // Construction binds no read on these, so a read of them meets the binding the restore left behind, which must answer once the opener is claimed.
    for(const name of [ "Status Active", "Target Door State" ]) {

      assert.ok(walked.some(({ characteristic }) => characteristic.displayName === name), "the walk reads " + name + ", which construction does not rebind");
    }

    for(const { characteristic, where } of walked) {

      // eslint-disable-next-line no-await-in-loop
      await assert.doesNotReject(triggerGet(characteristic), "HomeKit's read of " + where + " answers once this run has reached the opener");
    }
  });

  test("a Home app rename of a restored service is stored once the opener is admitted", async () => {

    const { accessory, built } = restore({ openClient: dialing(makeOpenerClient({ mac: MAC })) });
    const configuredName = present(lightOf(accessory).characteristics.find((characteristic) => characteristic.UUID === Characteristic.ConfiguredName.UUID),
      "the restored light's ConfiguredName");

    assert.ok(writable(configuredName), "the restored light carries a writable ConfiguredName, which the restore bound a write on");

    await admit(built, MAC, "192.0.2.10");
    await triggerSet(configuredName, "Workshop Light");
    await drainClock(built.clock);

    assert.equal(configuredName.value, "Workshop Light", "HAP stores the rename, and nothing the restore left behind writes another name over it");
  });

  test("a restored accessory this run never reaches keeps refusing while another opener is admitted", async () => {

    const { accessory, built } = restore({ openClient: dialing(makeOpenerClient({ mac: OTHER })) });

    await admit(built, OTHER, "192.0.2.11");
    await drainClock(built.clock);

    assert.equal(built.platform.configuredDevices.has(accessory.UUID), false, "the opener the cache restored was never reached");

    const door = present(accessory.getService(Service.GarageDoorOpener), "the restored garage door");

    await assert.rejects(triggerGet(door.getCharacteristic(Characteristic.CurrentDoorState)), isNoResponse, "its door still refuses HomeKit's read");
    await assert.rejects(triggerSet(door.getCharacteristic(Characteristic.TargetDoorState), Characteristic.TargetDoorState.OPEN), isNoResponse,
      "and its door still refuses HomeKit's write");
  });
});
