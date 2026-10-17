/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * discovery.test.ts: Unit tests for parseRatgdoService - the pure mDNS-service-to-recognized-identity parse, classification, MAC normalization, and validity guard.
 */
import { describe, test } from "node:test";
import { isAdvertisedAt, parseRatgdoService } from "./discovery.ts";
import type { Nullable } from "homebridge-plugin-utils";
import { RatgdoVariant } from "./types.ts";
import assert from "node:assert/strict";
import { makeRatgdoService } from "./testing.helpers.ts";

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

      const result = parseRatgdoService(makeRatgdoService(ratgdoTxt));

      assert.ok(result, "a well-formed Ratgdo advertisement is recognized");
      assert.equal(result.variant, RatgdoVariant.RATGDO, "the ratgdo.* project_name classifies as the Ratgdo variant");
      assert.equal(result.address, "192.0.2.10", "the first advertised address is carried through");
      assert.equal(result.model, "2.5", "project_version becomes the initial device model");
      assert.equal(result.friendlyName, "Garage", "friendly_name is carried as the display-name fallback");
    });

    test("classifies a Konnected service as the Konnected variant", () => {

      const result = parseRatgdoService(makeRatgdoService({ ...ratgdoTxt, project_name: "konnected.garage-door-gdov2-s" }));

      assert.equal(result?.variant, RatgdoVariant.KONNECTED, "the konnected.garage-door-gdov2* project_name classifies as the Konnected variant");
    });

    test("rejects a recognized-but-unmatched ESPHome project as not ours", () => {

      assert.equal(parseRatgdoService(makeRatgdoService({ ...ratgdoTxt, project_name: "esphome.generic-sensor" })), null,
        "a project_name matching no known pattern is some other ESPHome device");
    });

    test("carries the advertised address list verbatim, zoned entries included", () => {

      // The carried list is the advertisement rather than a set of dial targets, so nothing the pick refuses is filtered out of it: an address this plugin will never
      // dial is still the device saying it answers there, and that is what makes the membership test a statement about the device rather than about the pick. The
      // expectation is built independently of the input so a filtered or re-derived list cannot pass by sharing the input's reference.
      const advertised = [ "fe80::1%en0", "2001:db8::1", "192.0.2.10" ];
      const result = parseRatgdoService({ ...makeRatgdoService(ratgdoTxt), addresses: [...advertised] });

      assert.deepEqual(result?.addresses, advertised, "every advertised address is carried, in the order the browser listed them, the zoned one included");
      assert.equal(result?.address, "2001:db8::1", "while the address actually dialed is still the pick out of that same list");
    });
  });

  describe("MAC normalization", () => {

    test("uppercases and colon-delimits the MAC, and derives the bare-hex form", () => {

      const result = parseRatgdoService(makeRatgdoService({ ...ratgdoTxt, mac: "aAbBcCdDeEfF" }));

      assert.equal(result?.macColon, "AA:BB:CC:DD:EE:FF", "the MAC is uppercased and colon-delimited for HomeKit's UUID generator and the dedup set");
      assert.equal(result?.strippedMac, "AABBCCDDEEFF", "the bare-hex form strips the colons for device.mac, feature-option keys, and MQTT topics");
    });
  });

  describe("firmware-version fallback", () => {

    test("prefers version over esphome_version when both are advertised", () => {

      assert.equal(parseRatgdoService(makeRatgdoService({ ...ratgdoTxt, esphome_version: "2024.1.0", version: "3.1.4" }))?.firmwareVersion, "3.1.4",
        "version wins over esphome_version");
    });

    test("falls back to esphome_version when version is absent", () => {

      const txt = { esphome_version: "2024.6.1", mac: "aabbccddeeff", project_name: "ratgdo.esp32" };

      assert.equal(parseRatgdoService(makeRatgdoService(txt))?.firmwareVersion, "2024.6.1", "esphome_version carries the firmware version when version is absent");
    });
  });

  describe("optional-field passthrough", () => {

    test("yields undefined for an absent friendly_name and project_version", () => {

      const txt = { mac: "aabbccddeeff", project_name: "ratgdo.esp32", version: "2.0.0" };
      const result = parseRatgdoService(makeRatgdoService(txt));

      assert.equal(result?.friendlyName, undefined, "an absent friendly_name leaves the display-name fallback undefined");
      assert.equal(result?.model, undefined, "an absent project_version leaves the model undefined");
    });

    test("yields undefined for an advertised-but-empty friendly_name", () => {

      assert.equal(parseRatgdoService(makeRatgdoService({ ...ratgdoTxt, friendly_name: "" }))?.friendlyName, undefined,
        "an empty advertised name is no name, so the platform's own fallback names the device rather than an empty string reaching HomeKit");
    });
  });

  describe("the address this plugin dials", () => {

    /* The pick's whole contract, as a table. Each row is a set of advertised addresses and the one address the plugin dials out of it, and the pairs of rows that
     * carry the same set in two orders are the rows that hold the pick to the set rather than to the listing order - the property both consumers depend on, since
     * each reads a changed address as the device having moved. An expectation of null is a service the validity guard refuses for having nothing dialable.
     */
    const rows: { addresses: string[]; expected: Nullable<string>; why: string }[] = [

      { addresses: ["192.0.2.10"], expected: "192.0.2.10", why: "a device advertising only IPv4 is dialed there" },
      { addresses: [ "2001:db8::1", "192.0.2.10" ], expected: "2001:db8::1", why: "a dual-stack device is dialed over IPv6" },
      { addresses: [ "192.0.2.10", "2001:db8::1" ], expected: "2001:db8::1", why: "the same dual-stack set listed the other way answers the same address" },
      { addresses: [ "192.0.2.10", "fd00::1", "2001:db8::1" ], expected: "fd00::1", why: "a unique-local address outranks a global one, which an ISP prefix can rotate" },
      { addresses: [ "2001:db8::1", "fd00::1" ], expected: "fd00::1", why: "the unique-local preference holds with the global address listed first" },
      { addresses: [ "fd00::2", "fd00::1" ], expected: "fd00::1", why: "within the unique-local class the lowest address wins, not the first listed" },
      { addresses: [ "fd00::1", "fd00::2" ], expected: "fd00::1", why: "the same unique-local pair listed the other way answers the same address" },
      { addresses: [ "2001:db8::2", "2001:db8::1" ], expected: "2001:db8::1", why: "within the global class the lowest address wins, not the first listed" },
      { addresses: [ "2001:db8::1", "2001:db8::2" ], expected: "2001:db8::1", why: "the same global pair listed the other way answers the same address" },
      { addresses: [ "fe80::1%en0", "2001:db8::1" ], expected: "2001:db8::1", why: "a zoned address is never dialed, so the routable one is taken" },
      { addresses: [ "fe80::1", "192.0.2.10" ], expected: "192.0.2.10", why: "an unzoned link-local address yields to IPv4" },
      { addresses: [ "fe80::1", "2001:db8::1" ], expected: "2001:db8::1", why: "an unzoned link-local address yields to a routable IPv6 address" },
      { addresses: [ "febf::1", "192.0.2.10" ], expected: "192.0.2.10", why: "the link-local range runs to febf, matching the library's own fe80::/10 test" },
      { addresses: [ "fe80::2", "fe80::1" ], expected: "fe80::1", why: "among link-local addresses of last resort the lowest wins, not the first listed" },
      { addresses: [ "fe80::1%en0", "192.0.2.10" ], expected: "192.0.2.10", why: "a zoned address is skipped in favor of IPv4" },
      { addresses: ["fe80::1%en0"], expected: null, why: "a device advertising nothing but a zoned address cannot be reached and is not classified" },
      { addresses: [], expected: null, why: "a service advertising no address at all cannot be connected to" }
    ];

    for(const { addresses, expected, why } of rows) {

      test("dials " + (expected ?? "nothing") + " out of [ " + addresses.join(", ") + " ]", () => {

        // The address list is composed onto the resolved service directly rather than through the fixture builder's parameter, because that builder encodes real
        // AAAA records and refuses a zone - and the classify reads nothing but service.addresses.
        assert.equal(parseRatgdoService({ ...makeRatgdoService(ratgdoTxt), addresses })?.address ?? null, expected, why);
      });
    }
  });

  describe("isAdvertisedAt - the membership test both connection owners ask", () => {

    /* The predicate's contract as a table, one row per behavior the platform and the status feed share. Each row is the address a live connection was opened at, the
     * list the device advertises now, and whether that connection is still a connection to this device. The rows where an advertised held address is not the address
     * the pick would choose are the ones that earn the predicate: those are exactly the healthy connections a comparison against the pick tears down.
     */
    const rows: { addresses: string[]; advertised: boolean; held: string; why: string }[] = [

      { addresses: ["192.0.2.10"], advertised: true, held: "192.0.2.10", why: "a device advertising the one address its connection uses has not moved" },
      { addresses: ["192.0.2.11"], advertised: false, held: "192.0.2.10", why: "a device advertising a different address and nothing else has moved" },
      { addresses: [ "192.0.2.10", "2001:db8::1" ], advertised: false, held: "fd00::1",
        why: "a held address gone from the list reads as moved, which is also how a lapse of its own record reads - the advertisement cannot tell the two apart" },
      { addresses: [ "192.0.2.10", "2001:db8::1", "fd00::1" ], advertised: true, held: "2001:db8::1",
        why: "a preferred record returning moves the pick to fd00::1, but the connection's own address is still advertised, so the device has not moved" },
      { addresses: [ "fd00::1", "2001:db8::1" ], advertised: true, held: "fd00::1", why: "a set carrying the held address is membership, whatever its order" },
      { addresses: [ "2001:db8::1", "fd00::1" ], advertised: true, held: "fd00::1", why: "and the same set listed the other way answers the same" },
      { addresses: [ "2001:db8::1", "192.0.2.10" ], advertised: true, held: "192.0.2.10",
        why: "a device that gained a higher-ranked IPv6 address still advertises the IPv4 address its connection is on" }
    ];

    for(const { addresses, advertised, held, why } of rows) {

      test("a connection at " + held + " against [ " + addresses.join(", ") + " ] is " + (advertised ? "still this device" : "stale"), () => {

        const discovered = parseRatgdoService({ ...makeRatgdoService(ratgdoTxt), addresses });

        assert.ok(discovered, "the advertisement classifies, so there is an identity to ask");
        assert.equal(isAdvertisedAt(discovered, held), advertised, why);
      });
    }
  });

  describe("the validity guard rejects malformed advertisements", () => {

    test("a service advertising neither version nor esphome_version", () => {

      assert.equal(parseRatgdoService(makeRatgdoService({ mac: "aabbccddeeff", project_name: "ratgdo.esp32" })), null, "a device must advertise a firmware version");
    });

    test("a service with no MAC", () => {

      assert.equal(parseRatgdoService(makeRatgdoService({ project_name: "ratgdo.esp32", version: "2.0.0" })), null, "a device must advertise a MAC");
    });

    test("a service with no advertised address", () => {

      assert.equal(parseRatgdoService({ ...makeRatgdoService(ratgdoTxt), addresses: [] }), null,
        "a service with no advertised IP address cannot be connected to");
    });

    test("a service whose MAC is a bare flag or an empty value", () => {

      assert.equal(parseRatgdoService(makeRatgdoService({ ...ratgdoTxt, mac: null })), null, "a mac advertised as a bare flag carries no value and is not a MAC");
      assert.equal(parseRatgdoService(makeRatgdoService({ ...ratgdoTxt, mac: "" })), null,
        "a mac written with nothing after its equals sign is as unusable as one never advertised");
    });

    test("a service with no project_name", () => {

      assert.equal(parseRatgdoService(makeRatgdoService({ mac: "aabbccddeeff", version: "2.0.0" })), null, "a device must advertise a project_name to be classified");
    });
  });
});
/* eslint-enable camelcase */
