/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.test.ts: The "options" concern net for options.ts - the normalizeConfig boundary narrowing that turns Homebridge's open index-signature
 * PlatformConfig into a typed RatgdoOptions, plus a catalog shape audit over featureOptionCategories and featureOptions that pins the structural contract every
 * feature-option consumer (the FeatureOptions engine, the WebUI, the docs renderer) depends on.
 */
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions, normalizeConfig } from "./options.ts";
import type { PlatformConfig } from "homebridge";
import assert from "node:assert/strict";

/* normalizeConfig accepts a Homebridge PlatformConfig (an open index-signature shape sourced from user JSON). We build plain objects and cast them at the call seam to
 * PlatformConfig, exactly as the production boundary receives them, so each test exercises the real typeof / Array.isArray narrowing rather than a pre-typed shape.
 */
const asConfig = (shape: Record<string, unknown>): PlatformConfig => shape as unknown as PlatformConfig;

describe("normalizeConfig", () => {

  describe("the empty inputs", () => {

    test("returns an empty object for undefined input", () => {

      const result = normalizeConfig(undefined);

      assert.deepEqual(result, {}, "an undefined config short-circuits to an empty RatgdoOptions with no fields populated");
    });

    test("returns all-undefined fields with debug false for a bare config", () => {

      const result = normalizeConfig(asConfig({ name: "Ratgdo", platform: "Ratgdo" }));

      assert.equal(result.debug, false, "an absent debug field narrows to a strict false rather than undefined");
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

    test("is false for a truthy non-true debug value", () => {

      const result = normalizeConfig(asConfig({ debug: 1 }));

      assert.equal(result.debug, false, "a truthy-but-not-true debug value (1) is rejected by the strict === true guard and yields false");
    });

    test("is false for the truthy string \"true\"", () => {

      const result = normalizeConfig(asConfig({ debug: "true" }));

      assert.equal(result.debug, false, "the string \"true\" is truthy but not the boolean true, so the strict === true guard yields false");
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

      assert.deepEqual(names, [ "Device", "Disco", "Konnected", "Light", "Log", "Motion", "Opener" ].sort(),
        "the category roster is the seven device-facing concerns the plugin exposes");
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
});
