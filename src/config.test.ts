/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * config.test.ts: The webUI's pure platform-configuration interpreter, exercised against the REAL feature-option engine and the REAL option catalog so the assertions
 * bind to the same grammar the plugin's runtime resolves against. Covers every arm of the legacy-settings migration - what migrates, what deletes without migrating,
 * and what declines entirely - plus a round trip proving a migrated configuration runs the platform on the same effective values the legacy one did, the precedence
 * rows for the broker and prefix the library resolves ratgdo's client from, each retired option family the migration carries into the list that superseded it,
 * and the manual-device reads and writes behind the settings page's Add Device card.
 *
 * One discipline binds every claim about a deleted property: a patch carries a deletion as a PRESENT key whose value is undefined, and carries a non-deletion by
 * omitting the key. An equality read cannot tell those apart, and the session's shallow-merge commit treats them oppositely, so presence is asserted with
 * Object.hasOwn and absence with its negation - never with a comparison against undefined.
 */
import { FeatureOptions, createRetiredOptions, displayedName, formatValueList, mqttConnectionSettings } from "homebridge-plugin-utils";
import { RATGDO_LOG_EVENTS_OPTION, RATGDO_VEHICLE_SENSORS_OPTION } from "./webui/settings.ts";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import type { Nullable } from "homebridge-plugin-utils";
import { RATGDO_LOG_EVENTS } from "./webui/log-events.ts";
import { RATGDO_MQTT_TOPIC } from "./settings.ts";
import { RATGDO_RETIRED_FAMILIES } from "./webui/retired-options.ts";
import { RATGDO_VEHICLE_SENSORS } from "./webui/vehicle-sensors.ts";
import assert from "node:assert/strict";
import { makeRatgdoConfig } from "./webui/ratgdo-config.ts";

// The two broker URLs the precedence assertions tell apart: one carried by a legacy property, one already configured as an option entry.
const LEGACY_URL = "mqtt://127.0.0.2:1883";
const OPTION_URL = "mqtt://127.0.0.1:1883";

// An unrelated entry seeded alongside the ones under test, so every assertion that reads the composed array also proves the migration leaves a user's other options
// alone.
const UNRELATED_ENTRY = "Disable.Light.1234567890AB";

// The interpreter under test, built the way the webUI builds it: the real engine class, the real served catalog, HBPU's retired options, and the engine's own list
// formatter.
const config = makeRatgdoConfig({ FeatureOptions, catalog: { categories: featureOptionCategories, options: featureOptions }, createRetiredOptions, displayedName,
  formatValueList });

// The platform's boot view of a configuration, built as the platform builds it, over every retired family.
const bootView = (options: string[]): string[] => [...createRetiredOptions({ categories: featureOptionCategories, families: RATGDO_RETIRED_FAMILIES,
  options: featureOptions }).translate(options).configuredOptions];

// Every entry in an options array that addresses a given option, case-insensitively, in either the enabled or the disabled form.
function entriesFor(options: string[] | undefined, option: string): string[] {

  const prefix = option.toLowerCase();

  return (options ?? []).filter((entry) => [ "enable." + prefix, "disable." + prefix ].some((form) => entry.toLowerCase().startsWith(form)));
}

describe("the ratgdo webUI configuration migration", () => {

  describe("what migrates", () => {

    test("a legacy broker URL composes its option entry and stages the property for deletion", () => {

      // No options key at all is the ordinary shape of a configuration that predates feature options, and it is exactly the shape the decline guard must let through.
      const patch = config.migrate({ mqttUrl: OPTION_URL });

      assert.ok(patch, "a config carrying mqttUrl produces a patch");
      assert.deepEqual(entriesFor(patch.options, "Mqtt.Url"), ["Enable.Mqtt.Url=" + OPTION_URL], "the broker URL composes one entry carrying the exact value");
      assert.ok(Object.hasOwn(patch, "mqttUrl"), "the property is carried by the patch as a present key, so the shallow-merge commit deletes it");
      assert.equal(patch.mqttUrl, undefined, "the property is carried as undefined");
    });

    test("a custom legacy topic composes its option entry", () => {

      const patch = config.migrate({ mqttTopic: "garage", options: [UNRELATED_ENTRY] });

      assert.ok(patch, "a config carrying a custom mqttTopic produces a patch");
      assert.deepEqual(entriesFor(patch.options, "Mqtt.Topic"), ["Enable.Mqtt.Topic=garage"], "the topic composes one entry carrying the exact value");
      assert.ok(patch.options?.includes(UNRELATED_ENTRY), "an unrelated entry survives the migration untouched");
      assert.ok(Object.hasOwn(patch, "mqttTopic"), "the property is carried by the patch for deletion");
    });

    test("a whitespace-padded legacy value migrates trimmed", () => {

      const patch = config.migrate({ mqttTopic: " garage " });

      assert.ok(patch, "the padded value produces a patch");
      assert.deepEqual(entriesFor(patch.options, "Mqtt.Topic"), ["Enable.Mqtt.Topic=garage"], "the engine trims the value it stores");
      assert.ok(Object.hasOwn(patch, "mqttTopic"), "the property is still deleted");
    });

    test("a legacy debug flag set on composes a valueless enable entry", () => {

      const patch = config.migrate({ debug: true });

      assert.ok(patch, "a config carrying debug produces a patch");
      assert.deepEqual(entriesFor(patch.options, "Log.Debug"), ["Enable.Log.Debug"], "a flag composes the valueless enable form, carrying no value");
      assert.ok(Object.hasOwn(patch, "debug"), "the property is carried by the patch for deletion");
    });
  });

  describe("what deletes without migrating", () => {

    test("a legacy topic equal to the catalog default deletes without composing", () => {

      const patch = config.migrate({ mqttTopic: "ratgdo" });

      assert.ok(patch, "the property is still deleted");
      assert.ok(Object.hasOwn(patch, "mqttTopic"), "the property is carried by the patch for deletion");
      assert.ok(!Object.hasOwn(patch, "options"), "a value that only restates the catalog default manufactures no configuration");
    });

    test("an empty-string legacy value deletes without composing", () => {

      const url = config.migrate({ mqttUrl: "" });

      assert.ok(url, "an empty broker URL still produces a deletion patch");
      assert.ok(Object.hasOwn(url, "mqttUrl"), "the empty property is still deleted");
      assert.ok(!Object.hasOwn(url, "options"), "an empty value composes no entry, so the patch carries no options array");

      const topic = config.migrate({ mqttTopic: "" });

      assert.ok(topic, "an empty topic still produces a deletion patch");
      assert.ok(Object.hasOwn(topic, "mqttTopic"), "the empty property is still deleted");
      assert.ok(!Object.hasOwn(topic, "options"), "an empty value composes no entry, so the patch carries no options array");
    });

    test("a legacy debug flag set off, or carrying a hand-edited non-boolean, deletes without composing", () => {

      const off = config.migrate({ debug: false });

      assert.ok(off, "the property is still deleted");
      assert.ok(Object.hasOwn(off, "debug"), "the property is carried by the patch for deletion");
      assert.ok(!Object.hasOwn(off, "options"), "off is what the catalog already declares, so no entry is manufactured for it");

      const handEdited = config.migrate({ debug: "yes" });

      assert.ok(handEdited, "a hand-edited non-boolean still produces a deletion patch");
      assert.ok(Object.hasOwn(handEdited, "debug"), "the property is carried by the patch for deletion");
      assert.ok(!Object.hasOwn(handEdited, "options"), "a value we decline to interpret composes nothing");
    });

    test("a config whose properties all decline stages a pure deletion with no options key", () => {

      const patch = config.migrate({ mqttTopic: "", mqttUrl: "" });

      assert.ok(patch, "the properties are still deleted");
      assert.ok(Object.hasOwn(patch, "mqttTopic"), "the topic property is carried by the patch for deletion");
      assert.ok(Object.hasOwn(patch, "mqttUrl"), "the URL property is carried by the patch for deletion");
      assert.ok(!Object.hasOwn(patch, "options"), "a pure deletion never invents an options array");
    });
  });

  describe("what an existing option entry outranks", () => {

    test("an enabled entry carrying a different value wins, and is left byte-unchanged", () => {

      const existing = "Enable.Mqtt.Url=" + OPTION_URL;
      const patch = config.migrate({ mqttUrl: LEGACY_URL, options: [ existing, UNRELATED_ENTRY ] });

      assert.ok(patch, "the legacy property is still deleted");
      assert.ok(Object.hasOwn(patch, "mqttUrl"), "the superseded property is carried by the patch for deletion");
      assert.ok(!Object.hasOwn(patch, "options"), "an existing entry is the user's own choice, so nothing is composed over it");
      assert.deepEqual(entriesFor([ existing, UNRELATED_ENTRY ], "Mqtt.Url"), [existing], "the entry the user configured is the only one addressing the option");
    });

    test("an explicitly disabled entry counts as configured and wins identically", () => {

      const patch = config.migrate({ mqttUrl: LEGACY_URL, options: ["Disable.Mqtt.Url"] });

      assert.ok(patch, "the legacy property is still deleted");
      assert.ok(Object.hasOwn(patch, "mqttUrl"), "the property is carried by the patch for deletion");
      assert.ok(!Object.hasOwn(patch, "options"), "a disable is a configured entry, so the legacy value does not overwrite it");
    });

    test("a disabled flag entry outranks a legacy debug flag set on", () => {

      // The flag arm reaches its own exists() guard through a textually separate branch from the value arm, so the value rows above cannot stand in for this one.
      const patch = config.migrate({ debug: true, options: [ "Disable.Log.Debug", UNRELATED_ENTRY ] });

      assert.ok(patch, "the legacy property is still deleted");
      assert.ok(Object.hasOwn(patch, "debug"), "the property is carried by the patch for deletion");
      assert.ok(!Object.hasOwn(patch, "options"), "a disable is a configured entry, so the legacy flag does not overwrite it");
    });
  });

  describe("what declines entirely", () => {

    test("a config with nothing to migrate answers null", () => {

      assert.equal(config.migrate(undefined), null, "an absent config has nothing to migrate");
      assert.equal(config.migrate({}), null, "a fresh install carrying none of the legacy properties has nothing to migrate");
      assert.equal(config.migrate({ options: [ "Enable.Mqtt.Url=" + OPTION_URL, UNRELATED_ENTRY ] }), null,
        "an already-migrated config finds nothing to do on a second pass");
    });

    test("an options substrate that is not an array declines rather than guessing", () => {

      assert.equal(config.migrate({ mqttUrl: OPTION_URL, options: "Disable.Light" }), null,
        "a substrate we cannot parse leaves the whole config alone rather than composing onto a guess");
    });

    test("a legacy key present with the value undefined reads as absent", () => {

      assert.equal(config.migrate({ mqttUrl: undefined }), null, "a key staged to undefined is the terminal shape, so a second pass stages nothing");
    });

    test("an already-staged key is left out of a patch a defined sibling drives", () => {

      const patch = config.migrate({ mqttTopic: "garage", mqttUrl: undefined });

      assert.ok(patch, "a genuinely defined sibling still migrates rather than declining wholesale");
      assert.ok(!Object.hasOwn(patch, "mqttUrl"), "the already-staged key is not re-included, which would be churn");
      assert.ok(Object.hasOwn(patch, "mqttTopic"), "the defined sibling still is carried by the patch for deletion");
    });
  });

  test("a migrated configuration resolves the same effective values as the legacy one", () => {

    /* The keystone. debug is seeded true and the topic is seeded away from the catalog default deliberately: seeded otherwise, each side would compare a default
     * against itself and prove nothing about the arms under test.
     */
    const legacy = { debug: true, mqttTopic: "garage", mqttUrl: OPTION_URL };
    const patch = config.migrate(legacy);

    // The identity comparison below would pass vacuously against a migration that did nothing, so the patch is proven non-empty before it is applied.
    assert.ok(patch, "the migration produces a patch");
    assert.ok(patch.options?.length, "the patch carries composed entries");
    assert.deepEqual(entriesFor(patch.options, "Mqtt.Url"), ["Enable.Mqtt.Url=" + OPTION_URL], "the broker URL composes its entry");
    assert.deepEqual(entriesFor(patch.options, "Mqtt.Topic"), ["Enable.Mqtt.Topic=garage"], "the topic composes its entry");
    assert.deepEqual(entriesFor(patch.options, "Log.Debug"), ["Enable.Log.Debug"], "the debug flag composes its entry");

    for(const property of [ "debug", "mqttTopic", "mqttUrl" ]) {

      assert.ok(Object.hasOwn(patch, property), property + " is carried by the patch for deletion");
    }

    // Apply the patch the way the session stages it, then resolve each setting on both shapes through the very functions the platform constructor calls.
    const migrated = { ...legacy, ...patch };
    const before = new FeatureOptions(featureOptionCategories, featureOptions, []);
    const after = new FeatureOptions(featureOptionCategories, featureOptions, migrated.options);
    const beforeSettings = mqttConnectionSettings({ config: legacy, featureOptions: before });

    assert.deepEqual(beforeSettings, { brokerUrl: OPTION_URL, topicPrefix: "garage" },
      "the legacy shape resolves its broker and its custom prefix through its own properties, away from every default");
    assert.equal(before.consolidatedFlag({ fallback: legacy.debug, option: "Log.Debug" }), true,
      "the legacy shape resolves debug on, so the comparisons below are not two defaults agreeing");

    assert.deepEqual(mqttConnectionSettings({ config: migrated, featureOptions: after }), beforeSettings,
      "the migrated config resolves the same effective broker URL and topic prefix");
    assert.equal(after.consolidatedFlag({ fallback: migrated.debug, option: "Log.Debug" }), before.consolidatedFlag({ fallback: legacy.debug, option: "Log.Debug" }),
      "the migrated config resolves the same effective debug flag");
  });
});

/* The retired per-event logging options, carried into the one events list through HBPU's retired options and read back through the REAL engine the way the accessory
 * reads its logging: the list at a device's MAC and at the global level, against every category the plugin logs. Each row states a configuration in the retired
 * grammar, the entries the migration writes in its place, and what the opener and every other device logged under the retired grammar, and it reads that the
 * migrated configuration and the platform's boot view of the retired one both log exactly that. A scope's narrower or wider selection the rewrite dropped therefore
 * fails a reading, not just a spelling.
 */
describe("the retired event logging options", () => {

  // The opener a row narrows or widens, and a second device that inherits the global selection.
  const OPENER = "AABBCCDDEEFF";
  const OTHER = "112233445566";

  // Every category the plugin logs, which is the domain the accessory reads the list against.
  const EVERY_EVENT: string[] = RATGDO_LOG_EVENTS.map(({ value }) => value);

  // Every category but light, which is what a global light switch turned off leaves.
  const WITHOUT_LIGHT = [ "Opener", "Motion", "Obstruction", "VehiclePresence" ];

  // What a device logs under a configuration in the current grammar, read as the accessory reads it.
  const loggedAt = (options: readonly string[], device: string): readonly string[] => new FeatureOptions(featureOptionCategories, featureOptions, [...options])
    .valueList({ defaultWhenUnset: true, device, domain: EVERY_EVENT, option: RATGDO_LOG_EVENTS_OPTION });

  const rows: { entries: string[]; name: string; opener: string[]; other: string[]; retired: string[] }[] = [

    { entries: [ UNRELATED_ENTRY, "Enable.Log.Events=Opener,Motion,Obstruction,VehiclePresence" ], name: "a global narrowing becomes the global list",
      opener: WITHOUT_LIGHT, other: WITHOUT_LIGHT, retired: [ "Disable.Log.Light", UNRELATED_ENTRY ] },
    { entries: ["Enable.Log.Events." + OPENER + "=Opener,Motion,Obstruction,VehiclePresence"],
      name: "a device's narrowing becomes that device's list, leaving the global selection whole", opener: WITHOUT_LIGHT, other: EVERY_EVENT,
      retired: ["Disable.Log.Light." + OPENER] },
    { entries: [ "Enable.Log.Events=Opener,Motion,Obstruction,VehiclePresence", "Enable.Log.Events." + OPENER + "=*" ],
      name: "a device wider than the global selection keeps every category", opener: EVERY_EVENT, other: WITHOUT_LIGHT,
      retired: [ "Disable.Log.Light", "Enable.Log.Light." + OPENER ] },
    { entries: [ "Enable.Log.Events=Opener,Motion,Obstruction,VehiclePresence", "Enable.Log.Events." + OPENER + "=Opener,Obstruction,VehiclePresence" ],
      name: "a device narrower than a narrowed global selection keeps both narrowings", opener: [ "Opener", "Obstruction", "VehiclePresence" ], other: WITHOUT_LIGHT,
      retired: [ "Disable.Log.Light", "Disable.Log.Motion." + OPENER ] },
    { entries: [], name: "every category selected restates the default, so its entries leave and nothing is written in their place", opener: EVERY_EVENT,
      other: EVERY_EVENT, retired: [ "Enable.Log.Light", "Enable.Log.Opener" ] },
    { entries: ["Disable.Log.Events"], name: "every category turned off becomes the list turned off", opener: [], other: [],
      retired: EVERY_EVENT.map((value) => "Disable.Log." + value) }
  ];

  for(const { entries, name, opener, other, retired } of rows) {

    test(name, () => {

      const patch = config.migrate({ options: retired });

      assert.ok(patch, "a configuration carrying a retired logging option produces a patch");
      assert.deepEqual(patch.options, entries, "the retired entries leave, and the list entries stating each scope's selection follow the entries that survive");
      assert.deepEqual(loggedAt(entries, OPENER), opener, "the opener logs what it logged under the retired options");
      assert.deepEqual(loggedAt(entries, OTHER), other, "and so does a device inheriting the global selection");
      assert.deepEqual([ loggedAt(bootView(retired), OPENER), loggedAt(bootView(retired), OTHER) ], [ opener, other ],
        "and the platform's boot view of the unmigrated configuration logs the same, so an upgrader who never opens the page loses nothing");
      assert.equal(config.migrate({ options: patch.options }), null, "and a second pass over the migrated configuration writes nothing");
    });
  }

  test("a retired logging option and a legacy property migrate in one patch", () => {

    const patch = config.migrate({ debug: true, options: ["Disable.Log.Light"] });

    assert.ok(patch, "the configuration produces a patch");
    assert.deepEqual(patch.options, [ "Enable.Log.Events=Opener,Motion,Obstruction,VehiclePresence", "Enable.Log.Debug" ],
      "the retired option becomes the list entry, and the debug property composes its entry onto the rewritten configuration");
    assert.ok(Object.hasOwn(patch, "debug"), "and the property is carried by the patch for deletion");
  });
});

/* The retired per-sensor vehicle options, carried into the one vehicle sensor list through HBPU's retired options and read back through the REAL engine the way the
 * accessory reads its sensors: the list at a device's MAC and at the global level, against every sensor the Disco board drives. Each row states a configuration in the
 * retired grammar, the entries the migration writes in its place, and the sensors the opener and every other device carried under the retired grammar, and it reads
 * that the migrated configuration and the platform's boot view of the retired one both carry exactly those sensors, so a HomeKit tile a user relies on is never lost.
 */
describe("the retired vehicle sensor options", () => {

  // The opener a row narrows or widens, and a second device that inherits the global selection.
  const OPENER = "AABBCCDDEEFF";
  const OTHER = "112233445566";

  // Every vehicle sensor, in the order the list reads them back.
  const EVERY_SENSOR: string[] = RATGDO_VEHICLE_SENSORS.map(({ value }) => value);

  // The sensors a device carries under a configuration in the current grammar, read as the accessory reads them.
  const sensorsAt = (options: readonly string[], device: string): readonly string[] => new FeatureOptions(featureOptionCategories, featureOptions, [...options])
    .valueList({ defaultWhenUnset: true, device, option: RATGDO_VEHICLE_SENSORS_OPTION });

  const rows: { entries: string[]; name: string; opener: string[]; other: string[]; retired: string[] }[] = [

    { entries: [ UNRELATED_ENTRY, "Enable.Disco.VehicleSensors=Presence" ], name: "a sensor enabled globally becomes the global list", opener: ["Presence"],
      other: ["Presence"], retired: [ "Enable.Disco.OccupancySensor.Vehicle.Presence", UNRELATED_ENTRY ] },
    { entries: ["Enable.Disco.VehicleSensors." + OPENER + "=Presence"], name: "a sensor enabled on a device becomes that device's list alone", opener: ["Presence"],
      other: [], retired: ["Enable.Disco.OccupancySensor.Vehicle.Presence." + OPENER] },
    { entries: ["Enable.Disco.VehicleSensors=*"], name: "every sensor enabled globally becomes the list of every sensor", opener: EVERY_SENSOR, other: EVERY_SENSOR,
      retired: RATGDO_VEHICLE_SENSORS.map(({ retired }) => "Enable." + retired) },
    { entries: [ "Enable.Disco.VehicleSensors=Presence", "Disable.Disco.VehicleSensors." + OPENER ],
      name: "a sensor turned off on a device beneath a global one turns that device's list off", opener: [], other: ["Presence"],
      retired: [ "Enable.Disco.OccupancySensor.Vehicle.Presence", "Disable.Disco.OccupancySensor.Vehicle.Presence." + OPENER ] },
    { entries: [ "Enable.Disco.VehicleSensors=Arriving", "Enable.Disco.VehicleSensors." + OPENER + "=Presence,Arriving" ],
      name: "a device with a sensor beyond the global selection keeps both", opener: [ "Presence", "Arriving" ], other: ["Arriving"],
      retired: [ "Enable.Disco.ContactSensor.Vehicle.Arriving", "Enable.Disco.OccupancySensor.Vehicle.Presence." + OPENER ] },
    { entries: [], name: "a sensor turned off globally restates the default, so its entry leaves and nothing is written in its place", opener: [], other: [],
      retired: ["Disable.Disco.OccupancySensor.Vehicle.Presence"] }
  ];

  for(const { entries, name, opener, other, retired } of rows) {

    test(name, () => {

      const patch = config.migrate({ options: retired });

      assert.ok(patch, "a configuration carrying a retired vehicle sensor option produces a patch");
      assert.deepEqual(patch.options, entries, "the retired entries leave, and the list entries stating each scope's selection follow the entries that survive");
      assert.deepEqual(sensorsAt(entries, OPENER), opener, "the opener carries the sensors it carried under the retired options");
      assert.deepEqual(sensorsAt(entries, OTHER), other, "and so does a device inheriting the global selection");
      assert.deepEqual([ sensorsAt(bootView(retired), OPENER), sensorsAt(bootView(retired), OTHER) ], [ opener, other ],
        "and the platform's boot view of the unmigrated configuration carries the same, so an upgrader who never opens the page loses no sensor");
      assert.equal(config.migrate({ options: patch.options }), null, "and a second pass over the migrated configuration writes nothing");
    });
  }

  test("retired logging and vehicle sensor options migrate in one patch", () => {

    const patch = config.migrate({ options: [ "Disable.Log.Light", "Enable.Disco.ContactSensor.Vehicle.Leaving" ] });

    assert.ok(patch, "the configuration produces a patch");
    assert.deepEqual(patch.options, [ "Enable.Log.Events=Opener,Motion,Obstruction,VehiclePresence", "Enable.Disco.VehicleSensors=Leaving" ],
      "each retired family composes the list that superseded it");
  });
});

/* The manual-device reads and writes behind the Add Device card, driven against the REAL engine over the REAL catalog.
 *
 * The keystone of this section is that the card and the runtime address ONE entry. The page composes a key write here at the MAC the card's test learned, and every
 * connection to that device reads its key at that MAC - so every stored-key row below reads the composed entry back through the real engine at the device's MAC,
 * which is what would fail if the card wrote anywhere else.
 */
describe("the ratgdo webUI manual-device composition", () => {

  // The address shapes a user can type - an IPv4 address, a hostname, and an IPv6 literal. Whichever of them the card tested, the key is stored at the MAC of the
  // device that answered, so the row that cares about storage drives every one.
  const ADDRESSES = [ "10.0.0.20", "garage.local", "fd00::1" ];
  const KEY = "c2VjcmV0LWtleQ==";

  // The MAC the card's test learned, in the plugin's identity form.
  const MAC = "AABBCCDDEEFF";

  // The key the real engine resolves at the device's MAC in a composed patch, which is exactly what every connection to that device reads.
  const keyAtMac = (options: string[] | undefined): Nullable<string | undefined> => new FeatureOptions(featureOptionCategories, featureOptions,
    options ?? []).value("Device.Encryption.Key", MAC);

  // The entry addressing an option at a given id, read out of a composed patch. Reading by prefix rather than by a written-out string is what lets the row assert the
  // WHOLE entry it found, including the value, without restating the engine's own spelling of the name.
  const entryAt = (options: string[] | undefined, option: string, id: string): string | undefined => {

    const prefix = ("Enable." + option + "." + id).toLowerCase() + "=";

    return (options ?? []).find((entry) => entry.toLowerCase().startsWith(prefix));
  };

  describe("reading the listed addresses", () => {

    test("reads exactly what the runtime's own list read reads, messy stored list and all", () => {

      /* The page and the runtime must agree about what counts as one entry, so this row drives a deliberately messy stored list - padding, an empty element, a
       * duplicate - through BOTH readers and compares them to each other rather than to a literal. A comparison against a written-out expectation would pass even if
       * both sides drifted together; comparing the two readers cannot.
       */
      const stored = "Enable.Device.Address= 10.0.0.20 ,, garage.local,10.0.0.20 ";
      const fromInterpreter = config.manualAddresses({ options: [stored] });
      const fromRuntime = new FeatureOptions(featureOptionCategories, featureOptions, [stored]).valueList({ option: "Device.Address" });

      assert.deepEqual([...fromInterpreter], [...fromRuntime], "the card's read and the plugin's read answer the same list for the same stored string");
      assert.deepEqual([...fromInterpreter], [ "10.0.0.20", "garage.local", "10.0.0.20" ],
        "the engine trims each entry and drops the empty one, while duplicates and order are the user's own and survive");
    });

    test("reads an empty list for a configuration that has never listed an address", () => {

      assert.deepEqual([...config.manualAddresses({})], [], "an install with no options at all lists no addresses");
      assert.deepEqual([...config.manualAddresses({ options: [UNRELATED_ENTRY] })], [], "an install with unrelated options still lists no addresses");
    });
  });

  describe("composing a manual device", () => {

    test("appends to an empty list and to a populated one, leaving every other entry alone", () => {

      const fresh = config.withManualDevice({}, { address: "10.0.0.20", mac: MAC });

      assert.ok(fresh, "an address for a configuration that lists none produces a patch");
      assert.deepEqual(entriesFor(fresh.options, "Device.Address"), ["Enable.Device.Address=10.0.0.20"], "the first address composes the list entry");

      const populated = config.withManualDevice({ options: [ "Enable.Device.Address=10.0.0.20", UNRELATED_ENTRY ] }, { address: "garage.local", mac: MAC });

      assert.ok(populated, "a second address produces a patch");
      assert.deepEqual(entriesFor(populated.options, "Device.Address"), ["Enable.Device.Address=10.0.0.20,garage.local"],
        "the new address is appended in the engine's own canonical spelling rather than replacing the list");
      assert.ok(populated.options.includes(UNRELATED_ENTRY), "an unrelated entry survives untouched");
    });

    test("refuses an address that is empty or nothing but whitespace, and trims the one it accepts", () => {

      for(const address of [ "", "   " ]) {

        assert.equal(config.withManualDevice({}, { address, mac: MAC }), null,
          "an address of " + JSON.stringify(address) + " is the user having typed nothing, so nothing is composed");
      }

      const patch = config.withManualDevice({}, { address: "  10.0.0.20  ", mac: MAC });

      assert.ok(patch, "a padded address is still an address");
      assert.deepEqual(entriesFor(patch.options, "Device.Address"), ["Enable.Device.Address=10.0.0.20"], "and it is stored trimmed");
    });

    test("stores a typed key at the tested device's MAC, for every address shape", () => {

      // The entry this composes is read back by the real engine at the device's MAC, so a key written anywhere else fails here, whatever address was typed.
      for(const address of ADDRESSES) {

        const patch = config.withManualDevice({}, { address, key: KEY, mac: MAC });

        assert.ok(patch, "the address " + address + " composes a patch");
        assert.equal(entryAt(patch.options, "Device.Encryption.Key", MAC), "Enable.Device.Encryption.Key." + MAC + "=" + KEY,
          "the key typed beside " + address + " is stored at the MAC of the device that answered there");
        assert.equal(keyAtMac(patch.options), KEY, "and the real engine resolves it back at that MAC, which is exactly where every connection to the device reads it");
      }
    });

    test("accepts an already-listed address and rewrites only its key", () => {

      /* This is how a user fixes a key they got wrong, so the row asserts BOTH halves: the list is untouched (no duplicate entry) and the key entry is the only
       * thing that moved.
       */
      const patch = config.withManualDevice({ options: [ "Enable.Device.Address=10.0.0.20", "Enable.Device.Encryption.Key." + MAC + "=old-key" ] },
        { address: "10.0.0.20", key: KEY, mac: MAC });

      assert.ok(patch, "a listed address with a new key still produces a patch");
      assert.deepEqual(entriesFor(patch.options, "Device.Address"), ["Enable.Device.Address=10.0.0.20"], "the address is not listed a second time");
      assert.equal(entryAt(patch.options, "Device.Encryption.Key", MAC), "Enable.Device.Encryption.Key." + MAC + "=" + KEY,
        "and the key entry at the device's MAC is rewritten");
    });

    test("matches an already-listed address without regard to case, since a hostname and an IPv6 literal are both case-insensitive", () => {

      const patch = config.withManualDevice({ options: ["Enable.Device.Address=Garage.Local"] }, { address: "garage.local", key: KEY, mac: MAC });

      assert.ok(patch, "the key still composes");
      assert.deepEqual(entriesFor(patch.options, "Device.Address"), ["Enable.Device.Address=Garage.Local"],
        "a differing spelling of a listed address adds no second entry, and the user's own spelling is left as they wrote it");
    });

    test("answers null when neither the address nor the key would move", () => {

      assert.equal(config.withManualDevice({ options: ["Enable.Device.Address=10.0.0.20"] }, { address: "10.0.0.20", mac: MAC }), null,
        "a listed address with no key typed changes nothing, so there is nothing to commit");
      assert.equal(config.withManualDevice({ options: [ "Enable.Device.Address=10.0.0.20", "Enable.Device.Encryption.Key." + MAC + "=" + KEY ] },
        { address: "10.0.0.20", key: KEY, mac: MAC }), null, "re-confirming the key already stored at the device's MAC changes nothing either");
    });

    test("writes no key entry for a key the engine already resolves globally", () => {

      // The engine walks the device's entry and then the global one, so a device whose key is inherited needs no entry of its own - writing one would manufacture
      // configuration that says nothing the configuration did not already say.
      const patch = config.withManualDevice({ options: [ "Enable.Device.Address=10.0.0.20", "Enable.Device.Encryption.Key=" + KEY ] },
        { address: "10.0.0.20", key: KEY, mac: MAC });

      assert.equal(patch, null, "a key equal to the global one composes no entry at the device's MAC, and with nothing else to do the whole patch is null");
    });

    test("never clears a stored key when the user leaves the field blank", () => {

      const stored = [ "Enable.Device.Address=10.0.0.20", "Enable.Device.Encryption.Key." + MAC + "=" + KEY ];

      for(const key of [ "", undefined ]) {

        assert.equal(config.withManualDevice({ options: stored }, { address: "10.0.0.20", key, mac: MAC }), null,
          "a blank key field says nothing about the key rather than asking to delete it, so nothing is composed");
      }
    });

    test("recognizes the bracketed spelling of a listed bare address as already listed", () => {

      /* The already-listed decision runs on canonical forms on BOTH sides of the comparison - the typed address and every entry already in the list - so a user who
       * lists "2001:db8::5" and later types "[2001:db8::5]" is told it is already there rather than given a second list entry for one device.
       */
      assert.equal(config.withManualDevice({ options: ["Enable.Device.Address=2001:db8::5"] }, { address: "[2001:DB8::5]", mac: MAC }), null,
        "the bracketed spelling of a listed address changes nothing");
      assert.equal(config.withManualDevice({ options: ["Enable.Device.Address=[2001:db8::5]"] }, { address: "2001:db8::5", mac: MAC }), null,
        "and so does the bare spelling of a bracketed listed entry, since both sides of the comparison are canonicalized");
    });

    test("writes the canonical form into the list and stores the key at the device's MAC", () => {

      const patch = config.withManualDevice({}, { address: "[2001:DB8::5]", key: KEY, mac: MAC });

      assert.ok(patch, "a bracketed address still composes a patch");
      assert.deepEqual(entriesFor(patch.options, "Device.Address"), ["Enable.Device.Address=2001:db8::5"],
        "what is written is the bare literal, which is what the plugin dials and what Node's own parser reads as an address");
      assert.equal(entryAt(patch.options, "Device.Encryption.Key", MAC), "Enable.Device.Encryption.Key." + MAC + "=" + KEY,
        "and the key is stored at the device's MAC, whatever spelling of its address was typed");
    });

    test("writes a typed key at the device's MAC, skips one already resolved there or globally, and reads the global key", () => {

      /* The whole key rule the card composes by, against the real engine: a key goes to the MAC the card's test learned, a key the engine already resolves there -
       * stored for that MAC or inherited from the global key - writes nothing, and the global key the card compares a MAC-silent device against reads back as
       * exactly what the engine answers with no device named.
       */
      const written = config.withManualDevice({}, { address: "10.0.0.20", key: KEY, mac: MAC });

      assert.equal(keyAtMac(written?.options), KEY, "a typed key is written where the engine resolves it at the device's MAC");
      assert.equal(config.withManualDevice({ options: [ "Enable.Device.Address=10.0.0.20", "Enable.Device.Encryption.Key." + MAC + "=" + KEY ] },
        { address: "10.0.0.20", key: KEY, mac: MAC }), null, "a key already stored at the device's MAC writes nothing");
      assert.equal(config.withManualDevice({ options: [ "Enable.Device.Address=10.0.0.20", "Enable.Device.Encryption.Key=" + KEY ] },
        { address: "10.0.0.20", key: KEY, mac: MAC }), null, "and neither does a key the device inherits globally");
      assert.equal(config.globalKey({ options: [ "Enable.Device.Encryption.Key=" + KEY, "Enable.Device.Encryption.Key." + MAC + "=other" ] }), KEY,
        "the global key reads the global entry alone, not a device's own");
      assert.equal(config.globalKey({ options: ["Enable.Device.Encryption.Key="] }), undefined, "an empty global entry is no global key");
      assert.equal(config.globalKey({}), undefined, "and a configuration with no entry at all has none");
    });

    test("refuses an address naming a zone outright", () => {

      // A zone identifier names the interface a link-local address was heard on and means nothing without that link, so there is nothing to write and nothing that
      // could be dialed. The card renders the refusal; the composer simply has nothing to compose.
      assert.equal(config.withManualDevice({}, { address: "fe80::1%en0", key: KEY, mac: MAC }), null, "a zoned address composes no patch at all, key or no key");
      assert.equal(config.withManualDevice({ options: ["Enable.Device.Address=10.0.0.20"] }, { address: "[fe80::1%en0]", mac: MAC }), null,
        "and stripping its brackets first does not make it dialable");
    });

    test("composes the address and its key in ONE patch, never two", () => {

      // A card-added device always carries its key, and both halves reach disk in a single commit.
      const patch = config.withManualDevice({}, { address: "garage.local", key: KEY, mac: MAC });

      assert.ok(patch, "a new address with a key produces a patch");
      assert.deepEqual(entriesFor(patch.options, "Device.Address"), ["Enable.Device.Address=garage.local"], "the one patch carries the list entry");
      assert.equal(entryAt(patch.options, "Device.Encryption.Key", MAC), "Enable.Device.Encryption.Key." + MAC + "=" + KEY,
        "and the same patch carries the key entry at the device's MAC, so a save is one write rather than two");
    });
  });
});

/* The broker URL and topic prefix the platform constructs its MQTT client from, resolved by the library over ratgdo's own catalog. These rows are the precedence
 * contract the constructor depends on, driven against a REAL engine over the REAL catalog so they bind to the same grammar it resolves against. Each row carries
 * distinct values on its option side and its property side, so a resolution that transposed its arms - or that reached for the property first - fails rather than
 * agreeing with itself.
 */
describe("the MQTT connection settings ratgdo resolves", () => {

  // A real engine over the real catalog and the supplied entries, built exactly as the platform constructor builds its own.
  const engineFor = (entries: string[]): FeatureOptions => new FeatureOptions(featureOptionCategories, featureOptions, entries);

  test("the raw configuration properties alone resolve to themselves", () => {

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: "garage", mqttUrl: LEGACY_URL }, featureOptions: engineFor([]) }),
      { brokerUrl: LEGACY_URL, topicPrefix: "garage" }, "a configuration nobody has opened the webUI on keeps running on its own properties");
  });

  test("a configured option rules over a differing raw property, on the broker and the prefix alike", () => {

    const engine = engineFor([ "Enable.Mqtt.Topic=garage", "Enable.Mqtt.Url=" + OPTION_URL ]);

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: "attic", mqttUrl: LEGACY_URL }, featureOptions: engine }),
      { brokerUrl: OPTION_URL, topicPrefix: "garage" }, "configuring an option is the user saying what they want, so it outranks the property beside it");
  });

  test("a broker with no topic configured anywhere takes the prefix the catalog registers", () => {

    assert.deepEqual(mqttConnectionSettings({ config: { mqttUrl: LEGACY_URL }, featureOptions: engineFor([]) }),
      { brokerUrl: LEGACY_URL, topicPrefix: RATGDO_MQTT_TOPIC }, "the prefix a user never sets is the one the catalog answers with");
  });

  test("a broker whose raw topic property is blank takes the prefix the catalog registers", () => {

    assert.deepEqual(mqttConnectionSettings({ config: { mqttTopic: "", mqttUrl: LEGACY_URL }, featureOptions: engineFor([]) }),
      { brokerUrl: LEGACY_URL, topicPrefix: RATGDO_MQTT_TOPIC },
      "a blank field is the absence of a topic rather than a topic of nothing, so the catalog default answers and MQTT runs for a user who configured a broker");
  });

  test("no broker configured anywhere resolves to no client at all", () => {

    assert.equal(mqttConnectionSettings({ config: {}, featureOptions: engineFor([]) }), null, "MQTT is off until a broker is configured");
  });

  test("a blank raw broker URL resolves to no client at all", () => {

    assert.equal(mqttConnectionSettings({ config: { mqttUrl: "" }, featureOptions: engineFor([]) }), null,
      "a blank broker field leaves nothing to connect to, so MQTT stays off");
  });
});
