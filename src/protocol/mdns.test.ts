/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns.test.ts: Unit tests for parseMdnsTxt - the untrusted bonjour TXT narrowing into the typed MdnsTxt shape.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseMdnsTxt } from "./mdns.ts";

/* This file constructs raw mDNS TXT payloads whose keys are the snake_case ESPHome wire names (esphome_version, project_name, ...), so camelcase is disabled for the
 * file - asserting the parser against the exact wire shape is the whole point of these tests.
 */
/* eslint-disable camelcase */
describe("parseMdnsTxt", () => {

  test("returns undefined for non-object input", () => {

    assert.equal(parseMdnsTxt("a string"), undefined, "a string is not a TXT record");
    assert.equal(parseMdnsTxt(42), undefined, "a number is not a TXT record");
    assert.equal(parseMdnsTxt(null), undefined, "null is not a TXT record");
    assert.equal(parseMdnsTxt(undefined), undefined, "undefined is not a TXT record");
  });

  test("narrows a fully-populated TXT record into the typed shape", () => {

    const txt = parseMdnsTxt({ esphome_version: "2024.1.0", friendly_name: "Garage", mac: "AABBCCDDEEFF", project_name: "ratgdo.esp32", project_version: "1.2.3",
      version: "2.0.0" });

    assert.deepEqual(txt, { esphome_version: "2024.1.0", friendly_name: "Garage", mac: "AABBCCDDEEFF", project_name: "ratgdo.esp32", project_version: "1.2.3",
      version: "2.0.0" }, "every advertised string field is carried through verbatim");
  });

  test("narrows non-string field values to undefined", () => {

    const txt = parseMdnsTxt({ esphome_version: 2024, mac: "AABBCCDDEEFF", project_name: { nested: true } });

    assert.equal(txt?.mac, "AABBCCDDEEFF", "a string field is retained");
    assert.equal(txt?.esphome_version, undefined, "a numeric field is narrowed away");
    assert.equal(txt?.project_name, undefined, "an object field is narrowed away");
  });

  test("yields all-undefined fields for an empty object", () => {

    const txt = parseMdnsTxt({});

    assert.ok(txt, "an empty object is still a valid (if empty) TXT record");
    assert.equal(txt.mac, undefined, "absent fields are undefined");
    assert.equal(txt.project_name, undefined, "absent fields are undefined");
  });

  test("ignores unknown extra fields", () => {

    const txt = parseMdnsTxt({ extra_field: "ignored", mac: "AABBCCDDEEFF" });

    assert.equal(txt?.mac, "AABBCCDDEEFF", "known fields are read");
    assert.equal(Object.keys(txt ?? {}).includes("extra_field"), false, "unknown fields do not leak into the typed result");
  });
});
/* eslint-enable camelcase */
