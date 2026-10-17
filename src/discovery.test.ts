/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * discovery.test.ts: Unit tests for the two wire-record readers - the mDNS-service parse and the device-info classification - plus the identity composition,
 * classification, MAC normalization, and validity guards they share.
 */
import { classifyDeviceInfo, isAdvertisedAt, parseRatgdoService } from "./discovery.ts";
import { describe, test } from "node:test";
import type { DeviceInfo } from "esphome-client";
import type { Nullable } from "homebridge-plugin-utils";
import { RATGDO_AUTODISCOVERY_PROJECTS } from "./settings.ts";
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

describe("classifyDeviceInfo", () => {

  // The address a manual dial opened its connection at, which is the address a device-info record's identity carries.
  const DIALED = "192.0.2.10";

  /* A fully-formed device-info record for the same device the service fixture above describes, spelled the way a connected ESPHome client reports it: a
   * colon-delimited MAC, and the firmware version under esphomeVersion alone since a record carries no separate version member.
   */
  const ratgdoInfo: DeviceInfo = { esphomeVersion: "2024.1.0", friendlyName: "Garage", macAddress: "AA:BB:CC:DD:EE:FF", projectName: "ratgdo.esp32",
    projectVersion: "2.5" };

  describe("the identity both wire records compose", () => {

    test("a service and a device-info record naming one device derive one identity", () => {

      /* The whole point of the shared composition, asserted as an equality rather than field by field: a device reached at an address the user typed and the same
       * device reached by its advertisement must be indistinguishable to everything downstream, or the two paths would configure one device two ways. The service
       * advertises exactly the address the record's connection was opened at, so even the two address fields coincide and the identities are equal outright.
       */
      const fromService = parseRatgdoService({ ...makeRatgdoService({ esphome_version: "2024.1.0", friendly_name: "Garage", mac: "aabbccddeeff",
        project_name: "ratgdo.esp32", project_version: "2.5" }), addresses: [DIALED] });

      assert.deepEqual(classifyDeviceInfo(ratgdoInfo, DIALED), fromService, "the record and the advertisement compose the same identity, field for field");
    });

    test("both MAC spellings normalize to one pair of representations", () => {

      const colons = classifyDeviceInfo(ratgdoInfo, DIALED);
      const bareHex = classifyDeviceInfo({ ...ratgdoInfo, macAddress: "aabbccddeeff" }, DIALED);

      assert.equal(colons?.macColon, "AA:BB:CC:DD:EE:FF", "a colon-delimited wire MAC keeps its colons and is uppercased");
      assert.equal(colons?.strippedMac, "AABBCCDDEEFF", "and yields the bare-hex form downstream consumes");
      assert.deepEqual(bareHex, colons, "a bare-hex wire MAC naming the same device derives the same identity, colons and all");
    });

    test("an empty friendly name falls back to the device's own name", () => {

      assert.equal(classifyDeviceInfo({ ...ratgdoInfo, friendlyName: "", name: "garage-door" }, DIALED)?.friendlyName, "garage-door",
        "an empty member is no name at all, exactly as an empty TXT value is, so the device's own name answers instead");
      assert.equal(classifyDeviceInfo({ ...ratgdoInfo, friendlyName: undefined, name: undefined }, DIALED)?.friendlyName, undefined,
        "a record offering neither leaves the display-name fallback undefined for the platform's own default to fill");
    });

    test("the dialed address becomes both the address and the whole advertisement", () => {

      const result = classifyDeviceInfo(ratgdoInfo, "garage.local");

      assert.equal(result?.address, "garage.local", "the address that answered is the address this identity says to dial");
      assert.deepEqual(result?.addresses, ["garage.local"], "and it stands in for the advertisement, so a membership test against it answers true rather than false");
    });

    test("the project version becomes the model and an absent one leaves it undefined", () => {

      assert.equal(classifyDeviceInfo(ratgdoInfo, DIALED)?.model, "2.5", "the advertised project version seeds the device model");
      assert.equal(classifyDeviceInfo({ ...ratgdoInfo, projectVersion: "" }, DIALED)?.model, undefined, "an empty project version is no model");
    });
  });

  describe("variant classification over the autodiscovery registry", () => {

    /* One project name per variant the registry recognizes. A pattern cannot yield a string that matches it, so the sample names are written out - but the rows below
     * are the registry's own entries, and this table is closed over the variant union, so a variant added to either side without the other stops compiling here
     * rather than going untested.
     */
    const sampleProjectNames = {

      konnected: "konnected.garage-door-gdov2-s",
      ratgdo: "ratgdo.esp32"
    } as const satisfies Record<RatgdoVariant, string>;

    for(const entry of RATGDO_AUTODISCOVERY_PROJECTS) {

      test("classifies " + sampleProjectNames[entry.variant] + " as the " + entry.variant + " variant", () => {

        assert.equal(classifyDeviceInfo({ ...ratgdoInfo, projectName: sampleProjectNames[entry.variant] }, DIALED)?.variant, entry.variant,
          "the registry entry's pattern is both the recognition gate and the variant classifier for a device-info record, exactly as it is for an advertisement");
      });
    }
  });

  describe("refusals", () => {

    /* Every way a record fails to name an opener, as a table. Each row replaces one member of the well-formed record above, so the row is the only difference
     * between a refusal and the success the suite already asserted.
     */
    const rows: { info: Nullable<DeviceInfo>; why: string }[] = [

      { info: null, why: "a client with no device-info record at all has told us nothing to identify" },
      { info: { ...ratgdoInfo, macAddress: undefined }, why: "a record with no MAC names no device, and the MAC is the identity" },
      { info: { ...ratgdoInfo, macAddress: "" }, why: "an empty MAC member is as unusable as an absent one" },
      { info: { ...ratgdoInfo, projectName: undefined }, why: "a record with no project name cannot be classified as any variant" },
      { info: { ...ratgdoInfo, projectName: "" }, why: "an empty project name matches no pattern and is read as absent" },
      { info: { ...ratgdoInfo, esphomeVersion: undefined }, why: "a record with no firmware version is not a fully-formed ESPHome identity" },
      { info: { ...ratgdoInfo, projectName: "esphome.generic-sensor" }, why: "an ESPHome device matching no known pattern is something else answering at this address" }
    ];

    for(const { info, why } of rows) {

      test(why, () => assert.equal(classifyDeviceInfo(info, DIALED), null, why));
    }
  });
});
/* eslint-enable camelcase */
