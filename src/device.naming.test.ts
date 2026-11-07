/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.naming.test.ts: Naming concern net for RatgdoAccessory - who owns the opener's HomeKit name under HBPU's family naming rule, the names the accessory and
 * each of its parts carry, the watches that hold an owned name against a rename in the Home app, and the private door-state translation / capitalization helpers, all
 * reached strictly through the accessory's public surface (the HAP services it configures, MQTT get handlers, and the door telemetry router).
 *
 * A rename in the Home app is a controller's write to a service's ConfiguredName, which the suite makes through HBPU's triggerSet and then lets the watch's restore
 * land, as HBPU's own suite renames one. A part HomeKit names with Name alone gives the Home app nothing to write, so its rows read the Name characteristic HAP holds
 * read-only to a controller rather than inventing a rename. translateCurrentDoorState() and capitalize() are private, so we observe them through the two public
 * surfaces that consume them: the MQTT "garagedoor" get handler (which returns the lowercase translation) and the door-transition info log (which emits the
 * capitalized translation, e.g. "Open.", "Closed."). Door states are driven through ratgdo.updateState() with the EspHomeEvent cover shape.
 */
import { Characteristic, Service, buildRatgdoAccessory, customNameEntry, logEventsWithout, makeKonnectedInitialState, makeRatgdoInitialState,
  makeTestPlatform } from "./testing.helpers.ts";
import { HAPStatus, MQTT_GET_SUFFIX, ServiceEventTypes, getServiceName } from "homebridge-plugin-utils";
import { RatgdoService, RatgdoVariant } from "./types.ts";
import { describe, test } from "node:test";
import { hapStatus, logCount, loggedAt, present, settle, triggerSet } from "homebridge-plugin-utils/testing";
import type { BuildRatgdoAccessoryResult } from "./testing.helpers.ts";
import type { EspHomeEvent } from "./types.ts";
import { RatgdoAccessory } from "./device.ts";
import type { TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";

// One service a test accessory carries, as HAP holds it.
type TestService = TestPlatformAccessory["services"][number];

// The Sync Name entry for every opener, spelled the way the options editor writes it.
const SYNC_NAME = "Enable.Device.SyncName";

/* One part named from the opener: its key, the HAP service it is and the subtype it carries, the suffix it adds to the opener's name, the variant it belongs to, and
 * the feature option that configures it where it is off by default. The suffixes are spelled here rather than read from the accessory, so a part named with the
 * wrong suffix fails its row.
 */
interface NamedPart {

  readonly option?: string;
  readonly part: RatgdoService;
  readonly serviceType: { readonly UUID: string };
  readonly subtype?: string;
  readonly suffix: string;
  readonly variant: RatgdoVariant;
}

// The parts HomeKit names with Name alone, which the Home app cannot rename, so the plugin names each of them and watches none.
const NAME_ONLY_PARTS: readonly NamedPart[] = [

  { option: "Enable.Disco.Battery", part: RatgdoService.BATTERY, serviceType: Service.Battery, suffix: "", variant: RatgdoVariant.RATGDO }
];

// The parts carrying ConfiguredName, the name a rename in the Home app writes, one for each configure site naming one, so each row reads one site's watch.
const WATCHED_PARTS: readonly NamedPart[] = [

  { part: RatgdoService.GARAGE_DOOR, serviceType: Service.GarageDoorOpener, suffix: "", variant: RatgdoVariant.RATGDO },
  { part: RatgdoService.LIGHT, serviceType: Service.Lightbulb, suffix: "", variant: RatgdoVariant.RATGDO },
  { option: "Enable.Opener.Dimmer", part: RatgdoService.DIMMER_OPENER_AUTOMATION, serviceType: Service.Lightbulb, subtype: RatgdoService.DIMMER_OPENER_AUTOMATION,
    suffix: " Automation Door Position", variant: RatgdoVariant.RATGDO },
  { option: "Enable.Opener.Switch", part: RatgdoService.SWITCH_OPENER_AUTOMATION, serviceType: Service.Switch, subtype: RatgdoService.SWITCH_OPENER_AUTOMATION,
    suffix: " Automation Opener", variant: RatgdoVariant.RATGDO },
  { option: "Enable.Opener.Switch.RemoteLockout", part: RatgdoService.SWITCH_LOCKOUT, serviceType: Service.Switch, subtype: RatgdoService.SWITCH_LOCKOUT,
    suffix: " Lockout", variant: RatgdoVariant.RATGDO },
  { option: "Enable.Opener.OccupancySensor", part: RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN, serviceType: Service.OccupancySensor,
    subtype: RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN, suffix: " Open", variant: RatgdoVariant.RATGDO },
  { part: RatgdoService.MOTION_SENSOR, serviceType: Service.MotionSensor, suffix: "", variant: RatgdoVariant.RATGDO },
  { option: "Enable.Motion.OccupancySensor", part: RatgdoService.OCCUPANCY_SENSOR_MOTION, serviceType: Service.OccupancySensor,
    subtype: RatgdoService.OCCUPANCY_SENSOR_MOTION, suffix: "", variant: RatgdoVariant.RATGDO },
  { option: "Enable.Disco.Switch.Laser", part: RatgdoService.SWITCH_DISCO_LASER, serviceType: Service.Switch, subtype: RatgdoService.SWITCH_DISCO_LASER,
    suffix: " Laser", variant: RatgdoVariant.RATGDO },
  { option: "Enable.Disco.Switch.Led", part: RatgdoService.SWITCH_DISCO_LED, serviceType: Service.Switch, subtype: RatgdoService.SWITCH_DISCO_LED, suffix: " LED",
    variant: RatgdoVariant.RATGDO },
  { option: "Enable.Disco.ContactSensor.Vehicle.Arriving", part: RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING, serviceType: Service.ContactSensor,
    subtype: RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING, suffix: " Vehicle Arriving", variant: RatgdoVariant.RATGDO },
  { option: "Enable.Disco.ContactSensor.Vehicle.Leaving", part: RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING, serviceType: Service.ContactSensor,
    subtype: RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING, suffix: " Vehicle Leaving", variant: RatgdoVariant.RATGDO },
  { option: "Enable.Disco.OccupancySensor.Vehicle.Presence", part: RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE, serviceType: Service.OccupancySensor,
    subtype: RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE, suffix: " Vehicle Presence", variant: RatgdoVariant.RATGDO },
  { option: "Enable.Konnected.Switch.Pcw", part: RatgdoService.SWITCH_KONNECTED_PCW, serviceType: Service.Switch, subtype: RatgdoService.SWITCH_KONNECTED_PCW,
    suffix: " Pre Close Warning", variant: RatgdoVariant.KONNECTED },
  { option: "Enable.Konnected.Switch.Strobe", part: RatgdoService.SWITCH_KONNECTED_STROBE, serviceType: Service.Switch, subtype: RatgdoService.SWITCH_KONNECTED_STROBE,
    suffix: " Strobe", variant: RatgdoVariant.KONNECTED }
];

// The door, the part carrying the name of the opener's own tile.
const GARAGE_DOOR = present(WATCHED_PARTS.find(({ part }) => (part === RatgdoService.GARAGE_DOOR)), "the garage door part");

// The light, the part the rows reading a single watch rename.
const LIGHT = present(WATCHED_PARTS.find(({ part }) => (part === RatgdoService.LIGHT)), "the light part");

// Every part of one variant, and the feature options that configure each of them, so a build of that variant carries every part it can.
const partsOf = (variant: RatgdoVariant): NamedPart[] => [ ...NAME_ONLY_PARTS, ...WATCHED_PARTS ].filter((named) => (named.variant === variant));
const partOptions = (variant: RatgdoVariant): string[] => partsOf(variant).flatMap(({ option }) => ((option === undefined) ? [] : [option]));

// Build an opener of a variant with every part it can carry, under the given naming options, and under its own name where a row gives it one.
const buildOpener = ({ name, options = [], variant = RatgdoVariant.RATGDO }: { name?: string; options?: string[]; variant?: RatgdoVariant } = {}):
BuildRatgdoAccessoryResult => buildRatgdoAccessory({ device: { variant, ...((name === undefined) ? {} : { name }) }, userOptions: [ ...partOptions(variant),
  ...options ] });

/* Construct the opener again over the accessory a previous construction configured, under new naming options, which is what a Homebridge restart after the user
 * changed them looks like: the previous run is disposed, and the accessory keeps every service and every name it left behind.
 */
const restart = ({ accessory, ratgdo }: BuildRatgdoAccessoryResult, naming: string[]): { accessory: TestPlatformAccessory; ratgdo: RatgdoAccessory } => {

  const variant = ratgdo.device.variant;

  ratgdo[Symbol.dispose]();

  const { platform } = makeTestPlatform({ userOptions: [ ...partOptions(variant), ...naming ] });

  return { accessory, ratgdo: new RatgdoAccessory(platform as unknown as ConstructorParameters<typeof RatgdoAccessory>[0], accessory, ratgdo.device,
    (variant === RatgdoVariant.KONNECTED) ? makeKonnectedInitialState() : makeRatgdoInitialState()) };
};

// One part's own service on an accessory, told apart from its siblings of the same kind by its subtype.
const partOf = (accessory: TestPlatformAccessory, { part, serviceType, subtype }: NamedPart): TestService => {

  const isPart = (service: TestService): boolean => (service.UUID === serviceType.UUID) && (service.subtype === subtype);

  return present(accessory.services.find(isPart), "the " + part + " part's service");
};

// The information service of an accessory, which carries the accessory's name.
const infoOf = (accessory: TestPlatformAccessory): TestService => present(accessory.getService(Service.AccessoryInformation), "the accessory's information service");

// The listeners a service carries for changes to its characteristics, which is where a watch listens.
const listeners = (service: TestService): number => service.listenerCount(ServiceEventTypes.CHARACTERISTIC_CHANGE);

// Rename a service in the Home app: a controller's write to its ConfiguredName, then the turn a watch's restore waits for, as HBPU's own suite renames one.
const renameInHomeApp = async (service: TestService, name: string): Promise<void> => {

  await triggerSet(service.getCharacteristic(Characteristic.ConfiguredName), name);
  await settle();
};

// Build a cover telemetry event in the EspHomeEvent shape updateState() consumes. Properties are alphabetical per the house style; current_operation drives the
// transition class (OPENING / CLOSING / IDLE). For an IDLE cover the reported state resolves the branch: an OPEN state at a partial position (strictly between 0 and 1)
// reads as stopped-at-partial. The current_operation field mirrors the snake_case ESPHome wire shape EspHomeEvent declares, so the camelcase rule is scoped off here.
// eslint-disable-next-line camelcase
const coverEvent = (id: string, state: string, currentOperation: string, position: number): EspHomeEvent => ({ current_operation: currentOperation, id, position,
  state });

describe("RatgdoAccessory naming", () => {

  describe("the opener's name in HomeKit", () => {

    test("with neither a custom Name nor Sync Name, the accessory and every part carry the opener's own name, and a Home app rename of any part stands", async () => {

      const { accessory } = buildOpener();

      assert.equal(infoOf(accessory).testCharacteristic(Characteristic.ConfiguredName), false,
        "the information service is given no ConfiguredName, since the plugin owns no name to hold it to");

      for(const named of partsOf(RatgdoVariant.RATGDO)) {

        assert.equal(getServiceName(partOf(accessory, named)), "Test Ratgdo" + named.suffix, "the " + named.part + " part is named from the opener's own name");
      }

      for(const named of WATCHED_PARTS.filter(({ variant }) => variant === RatgdoVariant.RATGDO)) {

        const service = partOf(accessory, named);

        // eslint-disable-next-line no-await-in-loop
        await renameInHomeApp(service, "Renamed");

        assert.equal(getServiceName(service), "Renamed", "a Home app rename of the " + named.part + " part stands, since the user owns the name");
      }
    });

    test("a custom Name names the accessory and every part at creation", () => {

      const { accessory } = buildOpener({ options: [customNameEntry("Workshop")] });

      assert.equal(accessory.displayName, "Workshop", "the accessory takes the custom Name");
      assert.equal(getServiceName(infoOf(accessory)), "Workshop", "and so does the ConfiguredName its information service is given");

      for(const named of partsOf(RatgdoVariant.RATGDO)) {

        assert.equal(getServiceName(partOf(accessory, named)), "Workshop" + named.suffix, "the " + named.part + " part is named from the custom Name");
      }
    });

    test("clearing a custom Name moves the accessory's display name back to the opener's own name at the restart, while HomeKit keeps the names it left", () => {

      const { accessory } = restart(buildOpener({ options: [customNameEntry("Workshop")] }), []);

      assert.equal(accessory.displayName, "Test Ratgdo", "the display name the cache and the settings sidebar read follows the opener's own name");
      assert.equal(getServiceName(infoOf(accessory)), "Workshop", "the information service keeps the name it carries, since the user now owns it");
      assert.equal(getServiceName(partOf(accessory, LIGHT)), "Workshop", "and so does every part");
    });

    test("with Sync Name on and no custom Name, the opener's own name owns: a restart puts it back over a Home app rename, and a later rename is put back at once",
      async () => {

        const first = buildOpener({ name: "Garage" });
        const light = partOf(first.accessory, LIGHT);

        await renameInHomeApp(light, "Workshop Light");

        assert.equal(getServiceName(light), "Workshop Light", "while the user owns the name, the rename stands");

        restart(first, [SYNC_NAME]);

        assert.equal(getServiceName(light), "Garage", "once Sync Name owns the name, the restart puts the opener's own name back over the rename");
        assert.equal(getServiceName(infoOf(first.accessory)), "Garage", "and names the information service with it");

        await renameInHomeApp(light, "Workshop Light");

        assert.equal(getServiceName(light), "Garage", "and a later Home app rename is put back to the opener's own name at once");
      });

    for(const named of WATCHED_PARTS) {

      test("puts the custom Name back on the " + named.part + " part, which carries ConfiguredName, the moment the Home app renames it", async () => {

        const { accessory, entries } = buildOpener({ options: [customNameEntry("Workshop")], variant: named.variant });
        const service = partOf(accessory, named);

        await renameInHomeApp(service, "Renamed");

        assert.equal(getServiceName(service), "Workshop" + named.suffix, "the name the plugin owns for the part is put back over the rename");
        assert.equal(logCount(entries, "info", "Restored the name the plugin owns for a service after the Home app renamed it."), 1, "and the restore is reported once");
      });
    }

    for(const named of NAME_ONLY_PARTS) {

      test("re-states the custom Name on the " + named.part + " part, which carries Name alone, and gives the Home app nothing to rename", async () => {

        const restarted = restart(buildOpener(), [customNameEntry("Workshop")]);
        const service = partOf(restarted.accessory, named);
        const name = service.getCharacteristic(Characteristic.Name);

        assert.equal(service.testCharacteristic(Characteristic.ConfiguredName), false, "the part carries no ConfiguredName, and naming it attached none");
        assert.equal(name.value, "Workshop", "its Name carries the custom Name the restart re-stated over the opener's own name");

        await assert.rejects(triggerSet(name, "Renamed"), hapStatus(HAPStatus.READ_ONLY_CHARACTERISTIC), "the Name it carries is read-only to the Home app");
        await settle();

        assert.equal(name.value, "Workshop", "so no rename reaches it, and it keeps the custom Name");
      });
    }

    /* A restored door can carry no ConfiguredName, since HBPU names only a service it creates and the plugin's re-state is the one other writer. While the user owns the
     * name nothing re-states the door, so it stays as it was restored, and once the plugin owns the name the re-state attaches the characteristic ahead of the watch.
     */
    test("a door restored without ConfiguredName stays without one while the user owns the name, and gains one with a watch once the plugin owns it", async () => {

      const restoredDoor = (): BuildRatgdoAccessoryResult => {

        const built = buildOpener();
        const door = partOf(built.accessory, GARAGE_DOOR);

        door.removeCharacteristic(door.getCharacteristic(Characteristic.ConfiguredName));

        return built;
      };

      const userOwned = partOf(restart(restoredDoor(), []).accessory, GARAGE_DOOR);

      assert.equal(userOwned.testCharacteristic(Characteristic.ConfiguredName), false, "a restart leaves the door as it was restored while the user owns the name");

      const owned = partOf(restart(restoredDoor(), [customNameEntry("Workshop")]).accessory, GARAGE_DOOR);

      assert.equal(owned.getCharacteristic(Characteristic.ConfiguredName).value, "Workshop", "the re-state attaches the ConfiguredName carrying the custom Name");

      await renameInHomeApp(owned, "Renamed");

      assert.equal(getServiceName(owned), "Workshop", "and the watch puts the custom Name back over a Home app rename");
    });

    test("holds the information service to a custom Name through its ConfiguredName", async () => {

      const { accessory } = buildOpener({ options: [customNameEntry("Workshop")] });
      const info = infoOf(accessory);

      await renameInHomeApp(info, "Renamed");

      assert.equal(getServiceName(info), "Workshop", "a controller's write to the information service's ConfiguredName is put back to the custom Name");
      assert.equal(accessory.displayName, "Workshop", "and the accessory's display name never moved");
    });

    test("watches nothing while the user owns the name, and while it owns the name watches the information service and each part carrying ConfiguredName once", () => {

      const owned = buildOpener({ options: [customNameEntry("Workshop")] });
      const userOwned = buildOpener();

      // A watch is one listener on its service, so the listeners an owned opener's service carries beyond the same service of a user-owned opener are its watches.
      const watches = (select: (accessory: TestPlatformAccessory) => TestService): number => listeners(select(owned.accessory)) - listeners(select(userOwned.accessory));

      assert.equal(watches(infoOf), 1, "the information service carries one watch while the plugin owns the name, and none while the user does");

      for(const named of partsOf(RatgdoVariant.RATGDO)) {

        assert.equal(watches((accessory) => partOf(accessory, named)), WATCHED_PARTS.includes(named) ? 1 : 0,
          "the " + named.part + " part carries " + (WATCHED_PARTS.includes(named) ? "one watch" : "no watch, having nothing a rename could write") +
          " while the plugin owns the name, and none while the user does");
      }
    });

    test("ends every watch when the accessory is disposed, so a Home app rename afterward stands", async () => {

      const { accessory, ratgdo } = buildOpener({ options: [customNameEntry("Workshop")] });
      const light = partOf(accessory, LIGHT);
      const info = infoOf(accessory);

      ratgdo[Symbol.dispose]();

      await renameInHomeApp(light, "Renamed");
      await renameInHomeApp(info, "Renamed Accessory");

      assert.equal(getServiceName(light), "Renamed", "a disposed accessory puts back no part's name");
      assert.equal(getServiceName(info), "Renamed Accessory", "nor its information service's name");
    });
  });

  describe("translateCurrentDoorState and capitalize", () => {

    test("translates an open door to \"open\" for MQTT and \"Open.\" for the info log", async () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));

      assert.equal(await mqtt.invokeGet("garagedoor" + MQTT_GET_SUFFIX), "open", "the garagedoor get handler returns the lowercase translation of the open door state");
      assert.equal(mqtt.published.some((entry) => entry.topic.endsWith("garagedoor") && (entry.payload === "open")), true,
        "the open transition publishes the lowercase door state to the garagedoor topic");
      assert.equal(loggedAt(entries, "info", "Open."), true, "the open transition logs the capitalized door state when the logging list selects opener events");
    });

    test("translates a closed door to \"closed\" for MQTT and \"Closed.\" for the info log", async () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      // The accessory is born closed, so we first open it to make the subsequent close an actual transition the router will act on and log.
      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));
      ratgdo.updateState(coverEvent("cover-door", "CLOSED", "IDLE", 0));

      assert.equal(await mqtt.invokeGet("garagedoor" + MQTT_GET_SUFFIX), "closed",
        "the garagedoor get handler returns the lowercase translation of the closed door state");
      assert.equal(loggedAt(entries, "info", "Closed."), true, "the close transition logs the capitalized door state when the logging list selects opener events");
    });

    test("translates an opening door to \"opening\" for MQTT and \"Opening.\" for the info log", async () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      ratgdo.updateState(coverEvent("cover-door", "OPENING", "OPENING", 0.5));

      assert.equal(await mqtt.invokeGet("garagedoor" + MQTT_GET_SUFFIX), "opening",
        "the garagedoor get handler returns the lowercase translation of the opening door state");
      assert.equal(loggedAt(entries, "info", "Opening."), true, "the opening transition logs the capitalized door state when the logging list selects opener events");
    });

    test("translates a closing door to \"closing\" for MQTT and \"Closing.\" for the info log", async () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      ratgdo.updateState(coverEvent("cover-door", "CLOSING", "CLOSING", 0.5));

      assert.equal(await mqtt.invokeGet("garagedoor" + MQTT_GET_SUFFIX), "closing",
        "the garagedoor get handler returns the lowercase translation of the closing door state");
      assert.equal(loggedAt(entries, "info", "Closing."), true, "the closing transition logs the capitalized door state when the logging list selects opener events");
    });

    test("translates a stopped (partially-open) door to \"stopped\" for MQTT and \"Stopped.\" for the info log", async () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      // An idle cover reported OPEN at a position strictly between 0 and 1 is the stopped-at-partial case.
      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 0.5));

      assert.equal(await mqtt.invokeGet("garagedoor" + MQTT_GET_SUFFIX), "stopped",
        "the garagedoor get handler returns the lowercase translation of the stopped door state");
      assert.equal(loggedAt(entries, "info", "Stopped."), true, "the stopped transition logs the capitalized door state when the logging list selects opener events");
    });

    test("reports the born-closed door as \"closed\" through MQTT with no transition log", async () => {

      const { entries, mqtt } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      // The resting initial snapshot is a closed door; the get handler must reflect that translation without any updateState transition having occurred.
      assert.equal(await mqtt.invokeGet("garagedoor" + MQTT_GET_SUFFIX), "closed", "the born-closed door translates to the lowercase closed state on a cold read");
      assert.equal(loggedAt(entries, "info", "Closed."), false, "no door-state info line is emitted at construction, only on an actual transition");
    });

    test("translates a Konnected cover (cover-garage_door) the same way as a Ratgdo cover", async () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(), mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      ratgdo.updateState(coverEvent("cover-garage_door", "OPEN", "IDLE", 1));

      assert.equal(await mqtt.invokeGet("garagedoor" + MQTT_GET_SUFFIX), "open",
        "the Konnected garage_door cover id resolves through the same translation as the Ratgdo cover");
      assert.equal(loggedAt(entries, "info", "Open."), true, "the Konnected open transition logs the capitalized door state when the logging list selects opener events");
    });

    test("does not emit the capitalized door log when the logging list leaves opener events out", async () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: [logEventsWithout("Opener")] });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));

      assert.equal(await mqtt.invokeGet("garagedoor" + MQTT_GET_SUFFIX), "open", "the MQTT translation still reflects the open state regardless of the logging option");
      assert.equal(loggedAt(entries, "info", "Open."), false, "with opener events left out of the logging list, the capitalized door-state info line is suppressed");
    });

    test("does not re-publish the door state when an identical cover event repeats", () => {

      const { mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "an MQTT double is attached when mqtt is requested");

      // The first open is a real transition; the identical second event must short-circuit before the garagedoor publish, leaving exactly one open publish.
      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));
      ratgdo.updateState(coverEvent("cover-door", "OPEN", "IDLE", 1));

      assert.equal(mqtt.published.filter((entry) => entry.topic.endsWith("garagedoor") && (entry.payload === "open")).length, 1,
        "an unchanged door state is a no-op that publishes the garagedoor state exactly once");
    });
  });
});
