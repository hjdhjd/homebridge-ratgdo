/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.test.ts: The "options" concern net for options.ts - the normalizeConfig boundary narrowing that turns Homebridge's open index-signature
 * PlatformConfig into a typed RatgdoOptions, plus a catalog shape audit over featureOptionCategories and featureOptions that holds the structural contract every
 * feature-option consumer (the FeatureOptions engine, the WebUI, the docs renderer) depends on.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry } from "homebridge-plugin-utils";
import { describe, test } from "node:test";
import { describeCategoryScope, describeOptionScope, featureOptionCategories, featureOptions, normalizeConfig } from "./options.ts";
import { FeatureOptions } from "homebridge-plugin-utils";
import type { PlatformConfig } from "homebridge";
import type { RatgdoOptionMeta } from "./options.ts";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";

/* normalizeConfig accepts a Homebridge PlatformConfig (an open index-signature shape sourced from user JSON). We build plain objects and cast them at the
 * call boundary to PlatformConfig, exactly as the production boundary receives them, so each test exercises the real typeof / Array.isArray narrowing rather
 * than a pre-typed shape.
 */
const asConfig = (shape: Record<string, unknown>): PlatformConfig => shape as unknown as PlatformConfig;

// The scope levels this catalog's entries are allowed to name. The audit below holds every entry to this vocabulary, so an entry reaching for a level the plugin has
// no surface for fails here rather than rendering nowhere.
const SCOPE_VOCABULARY: string[] = [ "device", "global" ];

/* Locate one catalog entry by its category and option name. A miss throws rather than answering undefined, so an assertion naming an entry the catalog does not
 * carry fails as a missing entry instead of quietly asserting against nothing.
 */
function entryFor(category: string, name: string): FeatureOptionEntry<RatgdoOptionMeta> {

  const entry = featureOptions[category]?.find((candidate) => candidate.name === name);

  if(!entry) {

    throw new Error("The catalog carries no " + category + " entry named \"" + name + "\".");
  }

  return entry;
}

// Locate one catalog category by name, throwing on a miss for the same reason entryFor does.
function categoryFor(name: string): FeatureCategoryEntry<RatgdoOptionMeta> {

  const category = featureOptionCategories.find((candidate) => candidate.name === name);

  if(!category) {

    throw new Error("The catalog carries no category named \"" + name + "\".");
  }

  return category;
}

describe("normalizeConfig", () => {

  describe("the empty inputs", () => {

    test("returns an empty object for undefined input", () => {

      const result = normalizeConfig(undefined);

      assert.deepEqual(result, {}, "an undefined config short-circuits to an empty RatgdoOptions with no fields populated");
    });

    test("returns all-undefined fields for a bare config", () => {

      const result = normalizeConfig(asConfig({ name: "Ratgdo", platform: "Ratgdo" }));

      assert.equal(result.debug, undefined, "an absent debug field stays undefined, which is what lets the resolver fall through to the catalog default");
      assert.equal(result.mqttTopic, undefined, "an absent mqttTopic field stays undefined");
      assert.equal(result.mqttUrl, undefined, "an absent mqttUrl field stays undefined");
      assert.equal(result.options, undefined, "an absent options field stays undefined");
    });
  });

  describe("the debug field", () => {

    test("is true only when the input debug is the boolean true", () => {

      const result = normalizeConfig(asConfig({ debug: true }));

      assert.equal(result.debug, true, "a boolean-true debug input is carried through as true");
    });

    test("is false when debug is the boolean false", () => {

      const result = normalizeConfig(asConfig({ debug: false }));

      assert.equal(result.debug, false, "a boolean-false debug input narrows to false");
    });

    test("is undefined for a truthy non-boolean debug value", () => {

      const result = normalizeConfig(asConfig({ debug: 1 }));

      assert.equal(result.debug, undefined, "a truthy-but-non-boolean debug value (1) fails the typeof boolean guard and collapses to undefined");
    });

    test("is undefined for the truthy string \"true\"", () => {

      const result = normalizeConfig(asConfig({ debug: "true" }));

      assert.equal(result.debug, undefined, "the string \"true\" is truthy but not a boolean, so the typeof guard collapses it to undefined");
    });
  });

  describe("the mqttTopic field", () => {

    test("is kept when it is a string", () => {

      const result = normalizeConfig(asConfig({ mqttTopic: "ratgdo/garage" }));

      assert.equal(result.mqttTopic, "ratgdo/garage", "a string mqttTopic passes the typeof guard and is carried through verbatim");
    });

    test("is kept as the empty string, since the empty string is still typeof string", () => {

      const result = normalizeConfig(asConfig({ mqttTopic: "" }));

      assert.equal(result.mqttTopic, "", "the empty string is a valid string and the guard is typeof-based, not truthiness-based, so it is retained");
    });

    test("is undefined when it is a non-string value", () => {

      const result = normalizeConfig(asConfig({ mqttTopic: 42 }));

      assert.equal(result.mqttTopic, undefined, "a numeric mqttTopic fails the typeof string guard and collapses to undefined");
    });
  });

  describe("the mqttUrl field", () => {

    test("is kept when it is a string", () => {

      const result = normalizeConfig(asConfig({ mqttUrl: "mqtt://broker.local" }));

      assert.equal(result.mqttUrl, "mqtt://broker.local", "a string mqttUrl passes the typeof guard and is carried through verbatim");
    });

    test("is kept as the empty string, since the empty string is still typeof string", () => {

      const result = normalizeConfig(asConfig({ mqttUrl: "" }));

      assert.equal(result.mqttUrl, "", "the empty string is a valid string and the guard is typeof-based, not truthiness-based, so it is retained");
    });

    test("is undefined when it is a non-string value", () => {

      const result = normalizeConfig(asConfig({ mqttUrl: { host: "broker" } }));

      assert.equal(result.mqttUrl, undefined, "an object mqttUrl fails the typeof string guard and collapses to undefined");
    });
  });

  describe("the options field", () => {

    test("is kept when it is an array of all strings", () => {

      const options = [ "Enable.Opener.Dimmer", "Disable.Light" ];
      const result = normalizeConfig(asConfig({ options }));

      assert.deepEqual(result.options, [ "Enable.Opener.Dimmer", "Disable.Light" ], "a homogeneous string array passes the every-entry guard and is retained");
    });

    test("is kept as an empty array, since an empty array trivially satisfies every()", () => {

      const result = normalizeConfig(asConfig({ options: [] }));

      assert.deepEqual(result.options, [], "an empty array vacuously satisfies the all-strings predicate and is retained as an empty array");
    });

    test("is undefined for a mixed-type array", () => {

      const result = normalizeConfig(asConfig({ options: [ "Disable.Light", 7 ] }));

      assert.equal(result.options, undefined, "a single non-string entry fails the every-entry guard, so the whole options field collapses to undefined");
    });

    test("is undefined for a non-array value", () => {

      const result = normalizeConfig(asConfig({ options: "Disable.Light" }));

      assert.equal(result.options, undefined, "a non-array options value fails Array.isArray and collapses to undefined");
    });
  });

  describe("the combined narrowing", () => {

    test("narrows every field independently in a single pass", () => {

      const result = normalizeConfig(asConfig({ debug: true, mqttTopic: "ratgdo", mqttUrl: 0, options: [ "Disable.Light", true ] }));

      assert.equal(result.debug, true, "the boolean-true debug survives");
      assert.equal(result.mqttTopic, "ratgdo", "the string mqttTopic survives");
      assert.equal(result.mqttUrl, undefined, "the numeric mqttUrl is rejected independently of the other valid fields");
      assert.equal(result.options, undefined, "the mixed options array is rejected independently of the other valid fields");
    });
  });
});

describe("the feature-option catalog", () => {

  describe("the categories", () => {

    test("each carries a non-empty name and description", () => {

      for(const category of featureOptionCategories) {

        assert.equal(typeof category.name, "string", "every category name is a string");
        assert.ok(category.name.length > 0, "every category carries a non-empty name so option strings can address it");
        assert.equal(typeof category.description, "string", "every category description is a string");
        assert.ok(category.description.length > 0, "every category carries a non-empty description for the WebUI and docs");
      }
    });

    test("has the expected set of category names", () => {

      const names = featureOptionCategories.map((category) => category.name).sort();

      assert.deepEqual(names, [ "Device", "Disco", "Konnected", "Light", "Log", "Motion", "Mqtt", "Opener" ].sort(),
        "the category roster is every concern the plugin exposes, the library's MQTT group included");
    });
  });

  describe("the option entries", () => {

    test("each carries a string name, a non-empty description, and a boolean default", () => {

      for(const [ category, entries ] of Object.entries(featureOptions)) {

        for(const entry of entries) {

          // The name is asserted as a string rather than non-empty: the empty-string entry is the FeatureOptions framework's category master toggle (for example the
          // "Device" and "Light" categories each carry one), which is a legitimate and intentional catalog shape, not a missing name.
          assert.equal(typeof entry.name, "string", category + " option names are strings");
          assert.equal(typeof entry.description, "string", category + " option descriptions are strings");
          assert.ok(entry.description.length > 0, category + " options each carry a non-empty description for the WebUI and docs");
          assert.equal(typeof entry.default, "boolean", category + " options each carry a boolean default-enabled state");
        }
      }
    });

    test("each category exposes at least one option entry", () => {

      for(const [ category, entries ] of Object.entries(featureOptions)) {

        assert.ok(Array.isArray(entries), category + " maps to an array of option entries");
        assert.ok(entries.length > 0, category + " carries at least one option entry");
      }
    });
  });

  describe("the catalog cross-reference", () => {

    test("the option-map keys correspond exactly to the category names", () => {

      const categoryNames = featureOptionCategories.map((category) => category.name).sort();
      const optionKeys = Object.keys(featureOptions).sort();

      assert.deepEqual(optionKeys, categoryNames, "every option-map key is a declared category and every declared category has an option-map entry");
    });
  });

  describe("the scope declarations", () => {

    test("every entry declares a nonempty scopes array drawn from the plugin's own vocabulary", () => {

      for(const [ category, entries ] of Object.entries(featureOptions)) {

        for(const entry of entries) {

          // The declaration is read once and defaulted to an empty array so the two assertions below stand on their own: an entry that declares nothing fails the
          // length check rather than throwing, which names the offending entry in the failure.
          const scopes = entry.scopes ?? [];
          const label = category + (entry.name.length ? ("." + entry.name) : "");

          assert.ok(scopes.length > 0, label + " declares at least one scope level, so it renders and resolves somewhere");
          assert.ok(scopes.every((scope) => SCOPE_VOCABULARY.includes(scope)), label + " declares only levels this plugin has a surface for");
        }
      }
    });

    test("the platform-wide entries declare the global level alone", () => {

      for(const [ category, name ] of [ [ "Device", "Address" ], [ "Log", "Debug" ], [ "Mqtt", "Topic" ], [ "Mqtt", "Url" ] ] as [ string, string ][]) {

        assert.deepEqual(entryFor(category, name).scopes, ["global"], category + "." + name + " is a platform-wide fact, so it has exactly one home");
      }
    });

    test("the device-facing entries declare both the device and the global level", () => {

      for(const [ category, name ] of [ [ "Device", "Encryption.Key" ], [ "Device", "SyncName" ], [ "Log", "Opener" ], [ "Opener", "ReadOnly" ] ] as
        [ string, string ][]) {

        assert.deepEqual(entryFor(category, name).scopes, [ "device", "global" ], category + "." + name + " is settable globally or on one device");
      }
    });

    test("the custom Name is settable on one device alone, and Sync Name globally or on one device, each off by default in the family wording", () => {

      const nameDescription = "Custom HomeKit name for this device and its parts. It always applies, so a rename in the Home app yields to it wherever " +
        "HomeKit allows.";
      const syncDescription = "Synchronize the ESPHome name of this device and its parts with HomeKit. A rename in the Home app yields to it wherever HomeKit " +
        "allows. A custom Name takes precedence.";

      assert.deepEqual(entryFor("Device", "Name"), { default: false, defaultValue: "", description: nameDescription, inputSize: 30, name: "Name", scopes: ["device"] },
        "a custom name names one opener, so a global value, which would give every opener one name, has no home");
      assert.deepEqual(entryFor("Device", "SyncName"), { default: false, description: syncDescription, name: "SyncName", scopes: [ "device", "global" ] },
        "Sync Name is a flag every opener or one opener may set");
    });

    test("the option-scope documentation hook renders the sentence each declared shape carries", () => {

      const log = categoryFor("Log");

      assert.equal(describeOptionScope(entryFor("Log", "Debug"), log), "<BR>This option may only be applied globally.",
        "a global-only entry states that it has the one home");
      assert.equal(describeOptionScope(entryFor("Log", "Opener"), log), "<BR>This option may be applied globally or on individual devices.",
        "a device-facing entry states both levels");
      assert.equal(describeOptionScope({ default: true, description: "An entry declaring no scope.", name: "Undeclared" }, log), undefined,
        "an entry declaring no scope contributes no sentence, which is the guard the renderer's own entry type requires");
    });

    test("the category-scope documentation hook contributes no sentence", () => {

      for(const category of featureOptionCategories) {

        assert.equal(describeCategoryScope(category), undefined, category.name + " carries no category-level scope sentence of its own");
      }
    });
  });

  describe("the group declarations", () => {

    /* A grouped option names its parent by the parent's own name within the same category, and the library composes the two into the parent it looks up. A name that
     * matches no sibling is accepted in silence and the child then renders nowhere, so this walk is what turns a mistyped parent into a failing test rather than an
     * option a user can never reach.
     */
    test("every grouped option names a sibling that exists in its own category", () => {

      for(const [ category, entries ] of Object.entries(featureOptions)) {

        for(const entry of entries) {

          if(entry.group === undefined) {

            continue;
          }

          const parent = entries.find((candidate) => candidate.name === entry.group);

          assert.ok(parent, category + "." + entry.name + " groups under \"" + entry.group + "\", which is a sibling entry in the " + category + " category");
        }
      }
    });
  });

  describe("the variant declarations", () => {

    /* Every variant the catalog declares, gathered from both halves and keyed by the entry carrying it - a category by its bare name, an option by its
     * category-qualified one. Reading the whole catalog rather than probing the declaring entries by name is what makes the assertion below a census: a declaration
     * added to or dropped from any entry moves this map, so what the settings page hides from a device cannot change without a line changing here.
     */
    const declaredVariants = (): Record<string, RatgdoVariant> => {

      const declared: Record<string, RatgdoVariant> = {};

      for(const category of featureOptionCategories) {

        if(category.meta) {

          declared[category.name] = category.meta.variant;
        }
      }

      for(const [ category, entries ] of Object.entries(featureOptions)) {

        for(const entry of entries) {

          if(entry.meta) {

            declared[category + (entry.name.length ? ("." + entry.name) : "")] = entry.meta.variant;
          }
        }
      }

      return declared;
    };

    test("exactly the hardware-specific entries name a variant, each naming the one whose firmware serves it", () => {

      assert.deepEqual(declaredVariants(), {

        "Disco": RatgdoVariant.RATGDO,
        "Konnected": RatgdoVariant.KONNECTED,
        "Log.VehiclePresence": RatgdoVariant.RATGDO,
        "Motion": RatgdoVariant.RATGDO
      }, "the Disco and Motion categories and the vehicle-presence log belong to Ratgdo hardware, the Konnected category to Konnected hardware, and nothing else " +
        "narrows to a variant");
    });

    test("every declared variant is one the plugin knows", () => {

      const vocabulary: string[] = Object.values(RatgdoVariant);

      for(const [ entry, variant ] of Object.entries(declaredVariants())) {

        assert.ok(vocabulary.includes(variant), entry + " names a variant RatgdoVariant declares, which is the vocabulary the settings page tests a device against");
      }
    });
  });
});

/* The manual-address option, driven against a REAL engine over the REAL catalog: the list entry the catalog declares, and the list the engine reads back from it,
 * which is the one read both the platform and the settings page's live-status feed take their listed addresses from.
 */
describe("manual device addresses", () => {

  // A real engine over the real catalog and the supplied entries, built exactly as the platform constructor builds its own.
  const engineFor = (entries: string[]): FeatureOptions => new FeatureOptions(featureOptionCategories, featureOptions, entries);

  describe("the Device.Address catalog entry", () => {

    test("the catalog builds with a list entry carrying the default every list needs", () => {

      const entry = entryFor("Device", "Address");

      assert.equal(entry.multiple, true, "the option takes a list of addresses rather than one");
      assert.equal(entry.defaultValue, "", "a list entry declares a default value, which is what the engine's own declaration check requires of one");
      assert.equal(entry.default, false, "the option is off until a user lists an address, since autodiscovery is how devices are normally found");
      assert.ok(engineFor([]).exists("Device.Address") || true, "building an engine over the catalog does not throw on the new declaration");
    });

    test("valueList reads a stored list, and an unset option reads as nothing listed", () => {

      assert.deepEqual(engineFor([]).valueList({ option: "Device.Address" }), [], "an install that listed no address has no addresses to dial");
      assert.deepEqual(engineFor(["Enable.Device.Address=garage.local, 10.0.0.20"]).valueList({ option: "Device.Address" }), [ "garage.local", "10.0.0.20" ],
        "a stored list reads back as its entries, trimmed and in the user's order");
    });
  });
});
