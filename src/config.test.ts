/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * config.test.ts: The webUI's pure platform-configuration interpreter, exercised against the REAL feature-option engine and the REAL option catalog so the assertions
 * bind to the same grammar the plugin's runtime resolves against. Covers every arm of the legacy-settings migration - what migrates, what deletes without migrating,
 * and what declines entirely - plus a round trip proving a migrated configuration runs the platform on the same effective values the legacy one did, the precedence
 * rows for the broker and prefix the library resolves ratgdo's client from, and the manual-device reads and writes behind the settings page's Add Device card.
 *
 * One discipline binds every claim about a deleted property: a patch carries a deletion as a PRESENT key whose value is undefined, and carries a non-deletion by
 * omitting the key. An equality read cannot tell those apart, and the session's shallow-merge commit treats them oppositely, so presence is asserted with
 * Object.hasOwn and absence with its negation - never with a comparison against undefined.
 */
import { FeatureOptions, formatValueList, mqttConnectionSettings } from "homebridge-plugin-utils";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { makeRatgdoConfig, canonicalManualAddress as pageCanonical, isZonedAddress as pageIsZoned } from "../homebridge-ui/public/ratgdo-config.mjs";
import { manualAddressList, canonicalManualAddress as runtimeCanonical, isZonedAddress as runtimeIsZoned } from "./manual.ts";
import type { Nullable } from "homebridge-plugin-utils";
import { RATGDO_MQTT_TOPIC } from "./settings.ts";
import assert from "node:assert/strict";

// The two broker URLs the precedence assertions tell apart: one carried by a legacy property, one already configured as an option entry.
const LEGACY_URL = "mqtt://127.0.0.2:1883";
const OPTION_URL = "mqtt://127.0.0.1:1883";

// An unrelated entry seeded alongside the ones under test, so every assertion that reads the composed array also proves the migration leaves a user's other options
// alone.
const UNRELATED_ENTRY = "Disable.Light.1234567890AB";

// The interpreter under test, built the way the webUI builds it: the real engine class, the real served catalog, and the engine's own list formatter.
const config = makeRatgdoConfig({ FeatureOptions, catalog: { categories: featureOptionCategories, options: featureOptions }, formatValueList });

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

/* The manual-device reads and writes behind the Add Device card, driven against the REAL engine over the REAL catalog.
 *
 * The keystone of this section is that the card and the runtime address ONE entry. The page composes a key write here at the MAC the card's test learned, and every
 * connection to that device reads its key at that MAC - so every stored-key row below reads the composed entry back through the real engine at the device's MAC,
 * which is what would fail if the card wrote anywhere else.
 */
/* The one vector table, run against BOTH halves of the canonical-address rule.
 *
 * The rule is written twice on purpose: the page's copy lives in an import-free browser module and the plugin's lives in a Node module a browser cannot load. Nothing
 * in the language binds the two together, so THIS is what does - every vector is run through both halves and asserted to agree, and then asserted to be the expected
 * form. A drift between the two shows up here rather than as one address the page and the plugin spell two different ways.
 */
describe("the canonical manual address, on both sides of the wire", () => {

  const vectors: readonly (readonly [string, string, string])[] = [

    [ "[2001:db8::5]", "2001:db8::5", "an enclosing bracket pair is removed" ],
    [ "2001:db8::5", "2001:db8::5", "the bare form is already canonical, so both spellings meet here" ],
    [ "Garage.Local", "garage.local", "a hostname is case-insensitive, so its case is settled" ],
    [ "[2001:DB8::5]", "2001:db8::5", "upper-case hex in a bracketed literal is settled by the same pass" ],
    [ "  10.0.0.20  ", "10.0.0.20", "surrounding whitespace is not part of an address" ],
    [ "10.0.0.20", "10.0.0.20", "an IPv4 literal passes through unchanged" ],
    [ "[", "[", "a lone bracket is not an enclosing pair, so only trim and case apply" ],
    [ "fe80::1%en0", "fe80::1%en0", "a zone survives canonicalization - refusing it is a separate decision" ]
  ];

  for(const [ input, expected, why ] of vectors) {

    test(JSON.stringify(input) + " canonicalizes identically on both sides", () => {

      assert.equal(runtimeCanonical(input), expected, "the plugin's own rule answers " + JSON.stringify(expected) + ": " + why);
      assert.equal(pageCanonical(input), expected, "and the page's rule answers the same, which is the whole point of asserting them together");
    });
  }

  test("agrees on which addresses name a zone", () => {

    for(const [input] of vectors) {

      const canonical = runtimeCanonical(input);

      assert.equal(pageIsZoned(canonical), runtimeIsZoned(canonical),
        "both sides read " + JSON.stringify(canonical) + " the same way, so the card refuses exactly what the runtime would refuse");
    }

    assert.equal(runtimeIsZoned("fe80::1%en0"), true, "a zoned literal is refused");
    assert.equal(runtimeIsZoned("fd00::1"), false, "and an ordinary unique-local literal is not");
  });

  test("collapses a bracketed and a bare spelling to one list entry", () => {

    const listed = manualAddressList([ "[2001:DB8::5]", "2001:db8::5" ]);

    assert.deepEqual([...listed], ["2001:db8::5"], "the runtime lists one address where a user wrote two spellings of it");
    assert.equal(pageCanonical("[2001:DB8::5]"), pageCanonical("2001:db8::5"), "and the page spells the two as that one address too");
  });
});

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

      /* The card reads this value straight out of a DOM field, so the guard has to cope with a caller that is not TypeScript at all - which is what the module's own
       * typeof check is for. Calling through an untyped view of the function is how that arm is exercised without an assertion at the call itself.
       */
      const loose = config as unknown as { withManualDevice: (entry: unknown, device: unknown) => unknown };
      const untyped = (device: { address?: unknown; key?: unknown }): unknown => loose.withManualDevice({}, device);

      assert.equal(untyped({}), null, "an address the page never supplied is the user having typed nothing too");
      assert.equal(untyped({ address: 42 }), null, "and an address that is not text at all composes nothing rather than being coerced");

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
