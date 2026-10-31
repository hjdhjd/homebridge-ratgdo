/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.test.ts: Concern net for the plugin's static settings - the mDNS autodiscovery project table (pattern matching plus variant classification), the RFC 6762
 * service type, and the family of duration / topic constants. These values are pure data with no runtime behavior, so the contract under test is the data itself:
 * the right regexes match the right project names, the service type is the fully qualified name the browser takes, the durations are sane positive numbers, and the
 * MQTT topic is the documented default. The variant assertions cross-check against the real RatgdoVariant const-object so a rename on either side surfaces here.
 * The platform name is spelled again in config.schema.json, which as JSON cannot import the constant, so a row reads the schema and holds each of its spellings to it:
 * the plugin alias, the default of the entry's name, and the default that name's description states.
 */
import { PLATFORM_NAME, RATGDO_MOTION_DURATION, RATGDO_WEBUI_PROBE_TIMEOUT } from "./webui/settings.ts";
import { RATGDO_AUTODISCOVERY_PROJECTS, RATGDO_INITIAL_STATE_TIMEOUT, RATGDO_KONNECTED_PCW_DURATION, RATGDO_MDNS_SERVICE_TYPE, RATGDO_MQTT_TOPIC,
  RATGDO_OCCUPANCY_DURATION, RATGDO_RETRY_INTERVAL, RATGDO_UI_REVERT_DELAY, RATGDO_WEBUI_DISCOVERY_TIMEOUT } from "./settings.ts";
import { describe, test } from "node:test";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/* The places config.schema.json spells the platform name: the plugin alias Config UI X ties a platform entry to this schema by, the default of the entry's name,
 * which the settings page seeds an empty configuration with as well, and the closing sentence of that name's description, which states the default to the user.
 */
interface PlatformNameSpellings {

  readonly pluginAlias: string;
  readonly schema: { readonly properties: { readonly name: { readonly default: string; readonly description: string } } };
}

// We classify a project name exactly the way discovery does - a single `Array.find` over the project table that returns both the gate and the variant in one pass.
const classify = (projectName: string): RatgdoVariant | undefined => RATGDO_AUTODISCOVERY_PROJECTS.find((project) => project.pattern.test(projectName))?.variant;

describe("RATGDO_AUTODISCOVERY_PROJECTS", () => {

  test("classifies a ratgdo.* project name as the Ratgdo variant", () => {

    assert.equal(classify("ratgdo.something"), RatgdoVariant.RATGDO, "a ratgdo-prefixed project name matches the Ratgdo entry and carries the RATGDO variant");
  });

  test("classifies a konnected garage-door-gdov2 project name as the Konnected variant", () => {

    assert.equal(classify("konnected.garage-door-gdov2xyz"), RatgdoVariant.KONNECTED,
      "a konnected.garage-door-gdov2 project name matches the Konnected entry and carries the KONNECTED variant");
  });

  test("matches project names case-insensitively", () => {

    assert.equal(classify("RATGDO.SOMETHING"), RatgdoVariant.RATGDO,
      "the patterns carry the /i flag, so an uppercased ratgdo name still classifies as the Ratgdo variant");
  });

  test("does not match a foreign ESPHome project name", () => {

    assert.equal(classify("esphome.generic"), undefined, "a non-Ratgdo, non-Konnected project name matches neither entry and is gated out of the configuration path");
  });
});

describe("PLATFORM_NAME", () => {

  test("is the platform name config.schema.json spells as its plugin alias, its name default, and the default its name's description states", async () => {

    const schema = JSON.parse(await readFile(new URL("../config.schema.json", import.meta.url), "utf8")) as PlatformNameSpellings;

    assert.equal(schema.pluginAlias, PLATFORM_NAME, "Config UI X ties a platform entry to the schema by its alias, the name the platform registers under");
    assert.equal(schema.schema.properties.name.default, PLATFORM_NAME, "and the entry's name defaults to the name the settings page seeds an empty configuration with");
    assert.ok(schema.schema.properties.name.description.endsWith("Default: " + PLATFORM_NAME + "."), "and the name's description tells the user that same default");
  });
});

describe("RATGDO_MDNS_SERVICE_TYPE", () => {

  test("is the fully qualified DNS-SD type name ESPHome devices advertise under", () => {

    assert.equal(RATGDO_MDNS_SERVICE_TYPE, "_esphomelib._tcp.local",
      "the browser takes a fully qualified DNS-SD type name, so the constant carries the protocol label and the domain as well as the service label");
  });
});

describe("duration and topic constants", () => {

  // Every timing constant must be a positive finite number - a zero, negative, NaN, or Infinity duration would break the timers and schedules these values feed.
  const durations: readonly (readonly [string, number])[] = [
    [ "RATGDO_INITIAL_STATE_TIMEOUT", RATGDO_INITIAL_STATE_TIMEOUT ],
    [ "RATGDO_KONNECTED_PCW_DURATION", RATGDO_KONNECTED_PCW_DURATION ],
    [ "RATGDO_MOTION_DURATION", RATGDO_MOTION_DURATION ],
    [ "RATGDO_OCCUPANCY_DURATION", RATGDO_OCCUPANCY_DURATION ],
    [ "RATGDO_RETRY_INTERVAL", RATGDO_RETRY_INTERVAL ],
    [ "RATGDO_UI_REVERT_DELAY", RATGDO_UI_REVERT_DELAY ],
    [ "RATGDO_WEBUI_DISCOVERY_TIMEOUT", RATGDO_WEBUI_DISCOVERY_TIMEOUT ],
    [ "RATGDO_WEBUI_PROBE_TIMEOUT", RATGDO_WEBUI_PROBE_TIMEOUT ]
  ];

  for(const [ name, value ] of durations) {

    test(name + " is a positive finite number", () => {

      assert.equal(Number.isFinite(value), true, name + " must be a finite number to drive a timer or schedule");
      assert.equal(value > 0, true, name + " must be strictly positive");
    });
  }

  test("RATGDO_MQTT_TOPIC is the documented default topic", () => {

    assert.equal(RATGDO_MQTT_TOPIC, "ratgdo", "the default MQTT topic root is the literal string ratgdo");
  });
});
