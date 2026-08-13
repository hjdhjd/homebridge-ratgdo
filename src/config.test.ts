/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * config.test.ts: The webUI's pure platform-configuration migration, exercised against the REAL feature-option engine and the REAL option catalog so the pins bind to
 * the same grammar the plugin's runtime resolves against. Covers every arm of the legacy-settings migration - what migrates, what deletes without migrating, and what
 * declines entirely - plus a round trip proving a migrated configuration runs the platform on the same effective values the legacy one did.
 *
 * One discipline binds every claim about a deleted property: a patch carries a deletion as a PRESENT key whose value is undefined, and carries a non-deletion by
 * omitting the key. An equality read cannot tell those apart, and the session's shallow-merge commit treats them oppositely, so presence is asserted with
 * Object.hasOwn and absence with its negation - never with a comparison against undefined.
 */
import { consolidatedFlag, consolidatedValue, featureOptionCategories, featureOptions } from "./options.ts";
import { describe, test } from "node:test";
import { FeatureOptions } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { makeRatgdoConfig } from "../homebridge-ui/public/ratgdo-config.mjs";

// The two broker URLs the precedence pins tell apart: one carried by a legacy property, one already configured as an option entry.
const LEGACY_URL = "mqtt://127.0.0.2:1883";
const OPTION_URL = "mqtt://127.0.0.1:1883";

// An unrelated entry seeded alongside the ones under test, so every pin that reads the composed array also proves the migration leaves a user's other options alone.
const UNRELATED_ENTRY = "Disable.Light.1234567890AB";

// The interpreter under test, built the way the webUI builds it: the real engine class and the real served catalog.
const config = makeRatgdoConfig({ FeatureOptions, catalog: { categories: featureOptionCategories, options: featureOptions } });

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
      assert.ok(Object.hasOwn(patch, "mqttUrl"), "the property rides the patch as a present key, so the shallow-merge commit deletes it");
      assert.equal(patch.mqttUrl, undefined, "the property is carried as undefined");
    });

    test("a custom legacy topic composes its option entry", () => {

      const patch = config.migrate({ mqttTopic: "garage", options: [UNRELATED_ENTRY] });

      assert.ok(patch, "a config carrying a custom mqttTopic produces a patch");
      assert.deepEqual(entriesFor(patch.options, "Mqtt.Topic"), ["Enable.Mqtt.Topic=garage"], "the topic composes one entry carrying the exact value");
      assert.ok(patch.options?.includes(UNRELATED_ENTRY), "an unrelated entry survives the migration untouched");
      assert.ok(Object.hasOwn(patch, "mqttTopic"), "the property rides the patch for deletion");
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
      assert.ok(Object.hasOwn(patch, "debug"), "the property rides the patch for deletion");
    });
  });

  describe("what deletes without migrating", () => {

    test("a legacy topic equal to the catalog default deletes without composing", () => {

      const patch = config.migrate({ mqttTopic: "ratgdo" });

      assert.ok(patch, "the property is still deleted");
      assert.ok(Object.hasOwn(patch, "mqttTopic"), "the property rides the patch for deletion");
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
      assert.ok(Object.hasOwn(off, "debug"), "the property rides the patch for deletion");
      assert.ok(!Object.hasOwn(off, "options"), "off is what the catalog already declares, so no entry is manufactured for it");

      const handEdited = config.migrate({ debug: "yes" });

      assert.ok(handEdited, "a hand-edited non-boolean still produces a deletion patch");
      assert.ok(Object.hasOwn(handEdited, "debug"), "the property rides the patch for deletion");
      assert.ok(!Object.hasOwn(handEdited, "options"), "a value we decline to interpret composes nothing");
    });

    test("a config whose properties all decline stages a pure deletion with no options key", () => {

      const patch = config.migrate({ mqttTopic: "", mqttUrl: "" });

      assert.ok(patch, "the properties are still deleted");
      assert.ok(Object.hasOwn(patch, "mqttTopic"), "the topic property rides the patch for deletion");
      assert.ok(Object.hasOwn(patch, "mqttUrl"), "the URL property rides the patch for deletion");
      assert.ok(!Object.hasOwn(patch, "options"), "a pure deletion never invents an options array");
    });
  });

  describe("what an existing option entry outranks", () => {

    test("an enabled entry carrying a different value wins, and is left byte-unchanged", () => {

      const existing = "Enable.Mqtt.Url=" + OPTION_URL;
      const patch = config.migrate({ mqttUrl: LEGACY_URL, options: [ existing, UNRELATED_ENTRY ] });

      assert.ok(patch, "the legacy property is still deleted");
      assert.ok(Object.hasOwn(patch, "mqttUrl"), "the superseded property rides the patch for deletion");
      assert.ok(!Object.hasOwn(patch, "options"), "an existing entry is the user's own choice, so nothing is composed over it");
      assert.deepEqual(entriesFor([ existing, UNRELATED_ENTRY ], "Mqtt.Url"), [existing], "the entry the user configured is the only one addressing the option");
    });

    test("an explicitly disabled entry counts as configured and wins identically", () => {

      const patch = config.migrate({ mqttUrl: LEGACY_URL, options: ["Disable.Mqtt.Url"] });

      assert.ok(patch, "the legacy property is still deleted");
      assert.ok(Object.hasOwn(patch, "mqttUrl"), "the property rides the patch for deletion");
      assert.ok(!Object.hasOwn(patch, "options"), "a disable is a configured entry, so the legacy value does not overwrite it");
    });

    test("a disabled flag entry outranks a legacy debug flag set on", () => {

      // The flag arm reaches its own exists() guard through a textually separate branch from the value arm, so the value rows above cannot stand in for this one.
      const patch = config.migrate({ debug: true, options: [ "Disable.Log.Debug", UNRELATED_ENTRY ] });

      assert.ok(patch, "the legacy property is still deleted");
      assert.ok(Object.hasOwn(patch, "debug"), "the property rides the patch for deletion");
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
      assert.ok(Object.hasOwn(patch, "mqttTopic"), "the defined sibling still rides the patch for deletion");
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

      assert.ok(Object.hasOwn(patch, property), property + " rides the patch for deletion");
    }

    // Apply the patch the way the session stages it, then resolve each setting on both shapes through the very functions the platform constructor calls.
    const migrated = { ...legacy, ...patch };
    const before = new FeatureOptions(featureOptionCategories, featureOptions, []);
    const after = new FeatureOptions(featureOptionCategories, featureOptions, migrated.options);

    assert.equal(consolidatedValue(before, "Mqtt.Url", legacy.mqttUrl), OPTION_URL, "the legacy shape resolves the broker URL through its property");
    assert.equal(consolidatedValue(before, "Mqtt.Topic", legacy.mqttTopic), "garage", "the legacy shape resolves the custom topic through its property");
    assert.equal(consolidatedFlag(before, "Log.Debug", legacy.debug), true, "the legacy shape resolves debug on, so the comparisons below are not two defaults agreeing");

    assert.equal(consolidatedValue(after, "Mqtt.Url", migrated.mqttUrl), consolidatedValue(before, "Mqtt.Url", legacy.mqttUrl),
      "the migrated config resolves the same effective broker URL");
    assert.equal(consolidatedValue(after, "Mqtt.Topic", migrated.mqttTopic), consolidatedValue(before, "Mqtt.Topic", legacy.mqttTopic),
      "the migrated config resolves the same effective topic prefix");
    assert.equal(consolidatedFlag(after, "Log.Debug", migrated.debug), consolidatedFlag(before, "Log.Debug", legacy.debug),
      "the migrated config resolves the same effective debug flag");
  });
});
