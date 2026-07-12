/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * discovery.test.ts: Unit tests for parseRatgdoService - the pure mDNS-service-to-recognized-identity parse, classification, MAC normalization, and validity guard.
 */
import { describe, test } from "node:test";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";
import { makeMdnsService } from "./testing.helpers.ts";
import { parseRatgdoService } from "./discovery.ts";

/* This file constructs raw mDNS TXT payloads whose keys are the snake_case ESPHome wire names (esphome_version, project_name, ...), so camelcase is disabled for the
 * file - asserting the classifier against the exact wire shape is the whole point of these tests.
 */
/* eslint-disable camelcase */
describe("parseRatgdoService", () => {

  // A fully-formed Ratgdo TXT advertisement. Individual tests spread this and override fields to exercise the fallbacks and the guard.
  const ratgdoTxt = { esphome_version: "2024.1.0", friendly_name: "Garage", mac: "aabbccddeeff", project_name: "ratgdo.esp32", project_version: "2.5",
    version: "2.0.0" };

  describe("recognition and classification", () => {

    test("recognizes a Ratgdo service and derives its identity", () => {

      const result = parseRatgdoService(makeMdnsService(ratgdoTxt));

      assert.ok(result, "a well-formed Ratgdo advertisement is recognized");
      assert.equal(result.variant, RatgdoVariant.RATGDO, "the ratgdo.* project_name classifies as the Ratgdo variant");
      assert.equal(result.address, "192.0.2.10", "the first advertised address is carried through");
      assert.equal(result.model, "2.5", "project_version becomes the initial device model");
      assert.equal(result.friendlyName, "Garage", "friendly_name is carried as the display-name fallback");
    });

    test("classifies a Konnected service as the Konnected variant", () => {

      const result = parseRatgdoService(makeMdnsService({ ...ratgdoTxt, project_name: "konnected.garage-door-gdov2-s" }));

      assert.equal(result?.variant, RatgdoVariant.KONNECTED, "the konnected.garage-door-gdov2* project_name classifies as the Konnected variant");
    });

    test("rejects a recognized-but-unmatched ESPHome project as not ours", () => {

      assert.equal(parseRatgdoService(makeMdnsService({ ...ratgdoTxt, project_name: "esphome.generic-sensor" })), null,
        "a project_name matching no known pattern is some other ESPHome device");
    });
  });

  describe("MAC normalization", () => {

    test("uppercases and colon-delimits the MAC, and derives the bare-hex form", () => {

      const result = parseRatgdoService(makeMdnsService({ ...ratgdoTxt, mac: "aAbBcCdDeEfF" }));

      assert.equal(result?.macColon, "AA:BB:CC:DD:EE:FF", "the MAC is uppercased and colon-delimited for HomeKit's UUID generator and the dedup set");
      assert.equal(result?.strippedMac, "AABBCCDDEEFF", "the bare-hex form strips the colons for device.mac, feature-option keys, and MQTT topics");
    });
  });

  describe("firmware-version fallback", () => {

    test("prefers version over esphome_version when both are advertised", () => {

      assert.equal(parseRatgdoService(makeMdnsService({ ...ratgdoTxt, esphome_version: "2024.1.0", version: "3.1.4" }))?.firmwareVersion, "3.1.4",
        "version wins over esphome_version");
    });

    test("falls back to esphome_version when version is absent", () => {

      const txt = { esphome_version: "2024.6.1", mac: "aabbccddeeff", project_name: "ratgdo.esp32" };

      assert.equal(parseRatgdoService(makeMdnsService(txt))?.firmwareVersion, "2024.6.1", "esphome_version carries the firmware version when version is absent");
    });
  });

  describe("optional-field passthrough", () => {

    test("yields undefined for an absent friendly_name and project_version", () => {

      const txt = { mac: "aabbccddeeff", project_name: "ratgdo.esp32", version: "2.0.0" };
      const result = parseRatgdoService(makeMdnsService(txt));

      assert.equal(result?.friendlyName, undefined, "an absent friendly_name leaves the display-name fallback undefined");
      assert.equal(result?.model, undefined, "an absent project_version leaves the model undefined");
    });
  });

  describe("the validity guard rejects malformed advertisements", () => {

    test("a service whose TXT record is not an object", () => {

      assert.equal(parseRatgdoService(makeMdnsService(undefined)), null, "a service whose TXT record does not parse is not a device");
    });

    test("a service advertising neither version nor esphome_version", () => {

      assert.equal(parseRatgdoService(makeMdnsService({ mac: "aabbccddeeff", project_name: "ratgdo.esp32" })), null, "a device must advertise a firmware version");
    });

    test("a service with no MAC", () => {

      assert.equal(parseRatgdoService(makeMdnsService({ project_name: "ratgdo.esp32", version: "2.0.0" })), null, "a device must advertise a MAC");
    });

    test("a service with no advertised address", () => {

      assert.equal(parseRatgdoService(makeMdnsService(ratgdoTxt, [])), null, "a service with no advertised IP address cannot be connected to");
    });

    test("a service with no project_name", () => {

      assert.equal(parseRatgdoService(makeMdnsService({ mac: "aabbccddeeff", version: "2.0.0" })), null, "a device must advertise a project_name to be classified");
    });
  });
});
/* eslint-enable camelcase */
