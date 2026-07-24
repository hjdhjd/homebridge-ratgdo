/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.test.ts: Concern net for the plugin's static settings - the mDNS autodiscovery project table (pattern matching plus variant classification), the RFC 6762
 * warmup-offset burst, and the family of duration / topic constants. These values are pure data with no runtime behavior, so the contract under test is the data itself:
 * the right regexes match the right project names, the warmup schedule is the documented doubling burst, the durations are sane positive numbers, and the MQTT topic is
 * the documented default. The variant assertions cross-check against the real RatgdoVariant const-object so a rename on either side surfaces here.
 */
import { RATGDO_AUTODISCOVERY_INTERVAL, RATGDO_AUTODISCOVERY_PROJECTS, RATGDO_AUTODISCOVERY_WARMUP_OFFSETS, RATGDO_INITIAL_STATE_TIMEOUT,
  RATGDO_KONNECTED_PCW_DURATION, RATGDO_MOTION_DURATION, RATGDO_MQTT_TOPIC, RATGDO_OCCUPANCY_DURATION, RATGDO_UI_REVERT_DELAY, RATGDO_WEBUI_DISCOVERY_TIMEOUT,
  RATGDO_WEBUI_MDNS_REQUERY_INTERVAL } from "./settings.ts";
import { describe, test } from "node:test";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";

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

describe("RATGDO_AUTODISCOVERY_WARMUP_OFFSETS", () => {

  test("is the RFC 6762 doubling burst starting at t=0", () => {

    assert.deepEqual([...RATGDO_AUTODISCOVERY_WARMUP_OFFSETS], [ 0, 1, 2, 4, 8 ],
      "the warmup schedule is the five-query doubling burst at t=0, 1, 2, 4, and 8 seconds");
  });
});

describe("duration and topic constants", () => {

  // Every timing constant must be a positive finite number - a zero, negative, NaN, or Infinity duration would break the timers and schedules these values feed.
  const durations: readonly (readonly [string, number])[] = [
    [ "RATGDO_AUTODISCOVERY_INTERVAL", RATGDO_AUTODISCOVERY_INTERVAL ],
    [ "RATGDO_INITIAL_STATE_TIMEOUT", RATGDO_INITIAL_STATE_TIMEOUT ],
    [ "RATGDO_KONNECTED_PCW_DURATION", RATGDO_KONNECTED_PCW_DURATION ],
    [ "RATGDO_MOTION_DURATION", RATGDO_MOTION_DURATION ],
    [ "RATGDO_OCCUPANCY_DURATION", RATGDO_OCCUPANCY_DURATION ],
    [ "RATGDO_UI_REVERT_DELAY", RATGDO_UI_REVERT_DELAY ],
    [ "RATGDO_WEBUI_DISCOVERY_TIMEOUT", RATGDO_WEBUI_DISCOVERY_TIMEOUT ],
    [ "RATGDO_WEBUI_MDNS_REQUERY_INTERVAL", RATGDO_WEBUI_MDNS_REQUERY_INTERVAL ]
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
