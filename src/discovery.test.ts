/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * discovery.test.ts: Unit tests for the two wire-record readers - the mDNS-service parse and the device-info classification - plus the identity composition,
 * classification, MAC normalization, and validity guards they share.
 */
import { classifyDeviceInfo, normalizeMac, parseRatgdoService } from "./discovery.ts";
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
      assert.equal(result.address, "2001:db8::1", "while the address actually dialed is still the pick out of that same list");
    });
  });

  describe("MAC normalization", () => {

    test("uppercases and colon-delimits the MAC, and derives the bare-hex form", () => {

      const result = parseRatgdoService(makeRatgdoService({ ...ratgdoTxt, mac: "aAbBcCdDeEfF" }));

      assert.equal(result?.macColon, "AA:BB:CC:DD:EE:FF", "the MAC is uppercased and colon-delimited for HomeKit's UUID generator and the dedup set");
      assert.equal(result.strippedMac, "AABBCCDDEEFF", "the bare-hex form strips the colons for device.mac, feature-option keys, and MQTT topics");
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

    /* The ranking is the library's dialAddress. These rows hold the classifier to that pick: a dual-stack set listed either way round is dialed at the address the whole
     * set ranks first rather than at its first-listed address, and a service whose advertisement offers nothing dialable is refused, which an expectation of null marks.
     */
    const rows: { addresses: string[]; expected: Nullable<string>; why: string }[] = [

      { addresses: [ "2001:db8::1", "192.0.2.10" ], expected: "2001:db8::1", why: "a dual-stack device is dialed over IPv6" },
      { addresses: [ "192.0.2.10", "2001:db8::1" ], expected: "2001:db8::1", why: "the same dual-stack set listed the other way answers the same address" },
      { addresses: ["fe80::1%en0"], expected: null, why: "a device advertising nothing but a zoned address cannot be reached and is not classified" }
    ];

    for(const { addresses, expected, why } of rows) {

      test("dials " + (expected ?? "nothing") + " out of [ " + addresses.join(", ") + " ]", () => {

        // The address list is composed onto the resolved service directly rather than through the fixture builder's parameter, because that builder encodes real
        // AAAA records and refuses a zone - and the classify reads nothing but service.addresses.
        assert.equal(parseRatgdoService({ ...makeRatgdoService(ratgdoTxt), addresses })?.address ?? null, expected, why);
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
      assert.equal(colons.strippedMac, "AABBCCDDEEFF", "and yields the bare-hex form downstream consumes");
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
      assert.deepEqual(result.addresses, ["garage.local"], "and it stands in for the advertisement, so a membership test against it answers true rather than false");
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

describe("normalizeMac", () => {

  test("reduces every spelling of one MAC to one identity form", () => {

    assert.equal(normalizeMac("AA:BB:CC:DD:EE:FF"), "AABBCCDDEEFF", "the colon form a device-info record and a server hello carry loses its colons");
    assert.equal(normalizeMac("AABBCCDDEEFF"), "AABBCCDDEEFF", "the bare form a TXT record carries is already the identity form");
    assert.equal(normalizeMac("aa:Bb:cC:dd-EE:ff"), "AABBCCDDEEFF", "a mixed-case spelling with mixed separators is upper-cased to the same identity");
    assert.equal(normalizeMac(""), "", "an input carrying no hex digit reduces to the empty string");
  });
});
/* eslint-enable camelcase */
