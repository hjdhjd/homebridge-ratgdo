/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * manual-address.test.ts: The canonical-address rule's concern net - one vector table over every spelling the rule settles or deliberately leaves alone, the rule's
 * stability on its own output, and the zone predicate. The settings page and the plugin both import the rule, so this one table holds it for both.
 */
import { canonicalManualAddress, isZonedAddress } from "./manual-address.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("canonicalManualAddress", () => {

  /* The whole rule, one row per thing it does and one per thing it deliberately does not. The bracketed rows are the reason this function exists: a user typing an
   * IPv6 literal reaches for the URL spelling, and the bracketed form is not an address to anything downstream - Node's own parser does not read it as an IP
   * literal, so a dial would resolve it as a hostname and retry forever.
   */
  const vectors: readonly (readonly [string, string, string])[] = [

    [ "[2001:db8::5]", "2001:db8::5", "an enclosing bracket pair is removed" ],
    [ "2001:db8::5", "2001:db8::5", "a bare literal is already canonical" ],
    [ "[2001:DB8::5]", "2001:db8::5", "the bracketed and upper-case spelling reaches the same place as the bare lower-case one" ],
    [ "Garage.Local", "garage.local", "a hostname is case-insensitive, so its case is settled here" ],
    [ "  10.0.0.20  ", "10.0.0.20", "surrounding whitespace is not part of an address" ],
    [ "10.0.0.20", "10.0.0.20", "an IPv4 literal passes through unchanged" ],
    [ "[", "[", "a lone bracket is not an enclosing pair, so it stays exactly where the user put it" ],
    [ "[2001:db8::5", "[2001:db8::5", "half a pair is left alone rather than half-removed into a different address" ],
    [ "fe80::1%en0", "fe80::1%en0", "a zone is carried through canonicalization - refusing it is a separate decision, made by a separate predicate" ]
  ];

  for(const [ input, expected, why ] of vectors) {

    test(JSON.stringify(input) + " canonicalizes to " + JSON.stringify(expected), () => {

      assert.equal(canonicalManualAddress(input), expected, why);
    });
  }

  test("is stable: canonicalizing an already-canonical address changes nothing", () => {

    // Every consumer downstream re-reads this form, so a rule that moved a value on a second pass would let two reads of one address disagree.
    for(const [input] of vectors) {

      const once = canonicalManualAddress(input);

      assert.equal(canonicalManualAddress(once), once, "canonicalizing " + JSON.stringify(input) + " twice answers what canonicalizing it once answered");
    }
  });
});

describe("isZonedAddress", () => {

  test("refuses exactly the addresses that name a zone", () => {

    for(const address of [ "fe80::1%en0", "fe80::1%2" ]) {

      assert.equal(isZonedAddress(address), true, address + " names the interface it was heard on, which nothing can dial without that link");
    }

    for(const address of [ "2001:db8::5", "garage.local", "10.0.0.20", "fd00::1" ]) {

      assert.equal(isZonedAddress(address), false, address + " names a device rather than a link, so it is dialable");
    }
  });
});
