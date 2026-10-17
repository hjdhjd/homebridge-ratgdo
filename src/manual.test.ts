/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * manual.test.ts: The manual-address concern net - the canonical address list, the retryable-failure classification, the governance rule that settles two addresses
 * reaching one device, and the connect loop itself. The loop is pure over its ports, so every rule it follows is driven here directly: the dial, the readiness test,
 * and the log are all supplied by the test, and the pause runs on a TestClock so a five-minute retry interval is asserted in virtual time rather than waited out.
 */
import { TestClock, capturingLog, expectAt, loggedAt, settle } from "homebridge-plugin-utils/testing";
import { canonicalManualAddress, governingAddress, isRetryableFailure, isZonedAddress, manualAddressList, runManualAddress } from "./manual.ts";
import { describe, test } from "node:test";
import type { CapturingLog } from "homebridge-plugin-utils/testing";
import type { HomebridgePluginLogging } from "homebridge-plugin-utils";
import type { ManualConnectionFailureReason } from "./connection.ts";
import type { ManualDialOutcome } from "./manual.ts";
import { WakeableWait } from "homebridge-plugin-utils";
import assert from "node:assert/strict";

// The address this suite's loops dial, and the interval they retry on - the production interval, since the pause runs in virtual time and costs nothing to assert.
const ADDRESS = "garage.local";
const RETRY_SECONDS = 300;

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

describe("manualAddressList", () => {

  test("lower-cases every entry, drops duplicates, and keeps the user's order", () => {

    assert.deepEqual(manualAddressList([ "Garage.Local", "10.0.0.20", "GARAGE.local", "FD00::1" ]), [ "garage.local", "10.0.0.20", "fd00::1" ],
      "two spellings of one address are one address, and what survives is the order the user wrote");
  });

  test("collapses the bracketed and bare spellings of one literal into a single entry", () => {

    /* The dedupe proof. Before the bracket rule these were two strings, so the list carried two entries and the platform launched two loops against one device -
     * and the bracketed one could never connect at all.
     */
    assert.deepEqual(manualAddressList([ "[2001:DB8::5]", "2001:db8::5" ]), ["2001:db8::5"],
      "the bracketed and bare spellings of one address are one address, and one list entry");
    assert.deepEqual(manualAddressList([ "[2001:db8::5]", "10.0.0.20" ]), [ "2001:db8::5", "10.0.0.20" ],
      "and the entry that survives is the bare form, which is what the loop dials");
  });

  test("hands the loop a host a dial can actually reach for a bracketed entry", () => {

    /* The dial-host proof on the runtime side: the value a bracketed entry becomes IS the host the platform passes to the ESPHome client factory, since the loop is
     * driven per canonical list entry and the dial closure hands that entry straight through as `host`. The bracketed spelling is not an IP literal to Node's own
     * parser, so this is the difference between a connection and a DNS lookup that fails forever.
     */
    const [host] = manualAddressList(["[2001:DB8::5]"]);

    assert.equal(host, "2001:db8::5", "the host the loop dials is the bare literal");
    assert.equal(canonicalManualAddress(host), host, "and it is already canonical, so nothing downstream changes it again");
  });

  test("an install listing nothing has nothing to dial", () => {

    assert.deepEqual(manualAddressList([]), [], "no addresses listed is no addresses to canonicalize");
  });
});

describe("isRetryableFailure", () => {

  /* Every member of the reason union, with the answer each one earns. The table is typed as a total record over the union, so a reason added to the connect layer
   * fails to compile here until someone has decided whether it is worth retrying - which is the point of writing it as a table rather than as a list of tests.
   */
  const expected: Record<ManualConnectionFailureReason, boolean> = {

    "encryption-invalid": false,
    "encryption-missing": false,
    "permanent": true,
    "shutdown": false,
    "timeout": true,
    "unknown": true,
    "unrecognized": false,
    "unsupported": false
  };

  for(const [ reason, retryable ] of Object.entries(expected) as [ ManualConnectionFailureReason, boolean ][]) {

    test(reason + " is " + (retryable ? "retried" : "final"), () => {

      assert.equal(isRetryableFailure(reason), retryable, retryable ? "another attempt could succeed without the user doing anything" :
        "nothing changes here until a person acts, so retrying would dial forever");
    });
  }

  test("permanent and unknown are the one unreachable class, not two", () => {

    assert.equal(isRetryableFailure("permanent"), isRetryableFailure("unknown"),
      "every existing consumer treats the two as one answer, and splitting them here would be a distinction no caller makes");
  });
});

describe("governingAddress", () => {

  // The canonical list this suite's governance questions are asked against.
  const order = manualAddressList([ "garage.local", "10.0.0.20", "fd00::1" ]);

  test("an ungoverned device is governed by whichever address reached it", () => {

    assert.equal(governingAddress(undefined, "10.0.0.20", order), "10.0.0.20", "the first address to reach a device governs it, since nothing else does yet");
  });

  test("an earlier-listed candidate takes over from a later-listed one", () => {

    assert.equal(governingAddress("10.0.0.20", "garage.local", order), "garage.local",
      "the list's order decides, so the device lands on the same address on every run however the two loops race");
  });

  test("a later-listed candidate yields to the address already governing", () => {

    assert.equal(governingAddress("garage.local", "10.0.0.20", order), "garage.local", "and the answer is the same with the two arriving in the other order");
  });

  test("an address the list does not carry yields to any address it does", () => {

    assert.equal(governingAddress("removed.local", "fd00::1", order), "fd00::1",
      "a device governed by an address that has since left the list is taken over by a listed one rather than left on a dead address");
  });

  test("a case-differing spelling is the same address once the list is canonical", () => {

    /* The pairing that makes the rule work: the list and the candidate both come through manualAddressList, so "GARAGE.local" and "garage.local" are one entry and
     * one rank. Were either side left uncanonical, the spelling would rank after everything and a second loop would take a device its own governor already held.
     */
    const candidate = expectAt(manualAddressList(["GARAGE.local"]), 0, "the canonical list carries the entry");

    assert.equal(candidate, "garage.local", "the canonical form is what governance is asked about");
    assert.equal(governingAddress("10.0.0.20", candidate, order), "garage.local", "so the differently-spelled entry ranks as the entry it is");
  });
});

describe("runManualAddress", () => {

  /* Build a loop and everything it runs on: a virtual clock, a wakeable pause bound to a lifetime this test controls, a capturing log, and a dial that answers from
   * a script of outcomes. Every attempt writes the same error line through the log it was handed, and the level each attempt's line reaches the capturing log at is
   * how the demotion is observed.
   */
  const harness = (script: ManualDialOutcome[], options: { served?: () => boolean } = {}) => {

    const clock = new TestClock();
    const lifetime = new AbortController();
    const log = capturingLog();
    const pause = new WakeableWait({ clock, signal: lifetime.signal });
    const dialed: string[] = [];
    const dial = async (attemptLog: Parameters<Parameters<typeof runManualAddress>[0]["dial"]>[0]): Promise<ManualDialOutcome> => {

      // Every attempt says the same thing at error level. What differs between attempts is only whether the loop let that line through, which is what is asserted.
      attemptLog.error("Failed to establish connection: %s", "ECONNREFUSED");
      dialed.push("attempt");

      return script[dialed.length - 1] ?? { ok: false, reason: "timeout" };
    };

    const loop = runManualAddress({ address: ADDRESS, dial, isServed: options.served ?? ((): boolean => false), log, pause,
      retrySeconds: RETRY_SECONDS });

    return { clock, dialed, lifetime, log, loop, pause };
  };

  // How many times the capturing log recorded the dial's diagnostic at a level, which is the whole observation the demotion rows rest on.
  const diagnostics = (log: CapturingLog, level: "debug" | "error"): number => log.entries.filter((entry) => (entry.level === level) &&
    entry.message.includes("Failed to establish connection")).length;

  test("an address a configured device already holds is not dialed at all", async () => {

    const rig = harness([], { served: (): boolean => true });

    await rig.loop;

    assert.equal(rig.dialed.length, 0, "the readiness test is asked before anything is dialed, so a served address costs the device no connection");
    assert.equal(rig.log.entries.length, 0, "and an address with nothing to do says nothing");
  });

  test("a dial that lands ends the loop after one attempt", async () => {

    const rig = harness([{ ok: true }]);

    await rig.loop;

    assert.equal(rig.dialed.length, 1, "a device that answered needs no second attempt - its own client owns every reconnect from here");
    assert.equal(rig.clock.requested.length, 0, "and no pause was ever registered, so the loop ended rather than waiting to end");
  });

  /* Every outcome that ends an address's loop without a retry, and what the user is told about each. The two key failures earn a line naming where the key is
   * entered, because that is the one failure a user can fix and the one place they can fix it; the others have already said everything there is to say.
   */
  const finalReasons: { guidance: boolean; reason: ManualConnectionFailureReason }[] = [

    { guidance: true, reason: "encryption-invalid" },
    { guidance: true, reason: "encryption-missing" },
    { guidance: false, reason: "shutdown" },
    { guidance: false, reason: "unrecognized" },
    { guidance: false, reason: "unsupported" }
  ];

  for(const { guidance, reason } of finalReasons) {

    test(reason + " ends the loop after one attempt" + (guidance ? ", naming where the key is entered" : ""), async () => {

      const rig = harness([{ ok: false, reason }]);

      await rig.loop;

      assert.equal(rig.dialed.length, 1, "nothing here changes without the user acting, so a second attempt would dial forever");
      assert.equal(rig.clock.requested.length, 0, "and no retry was scheduled");
      assert.equal(loggedAt(rig.log.entries, "error",
        "garage.local: the device refused the encryption key. Enter this device's key through Add Device in the plugin's settings."), guidance,
      guidance ? "a key failure tells the user where a manually addressed device's key is entered" : "and no other failure reaches for that advice");
    });
  }

  test("a retryable failure waits the retry interval and dials again", async () => {

    const rig = harness([ { ok: false, reason: "timeout" }, { ok: true } ]);

    await settle();

    assert.equal(rig.dialed.length, 1, "the first attempt has run and the loop is now pausing");
    assert.deepEqual(rig.clock.requested, [300000], "the pause asked for the retry interval, in milliseconds");

    rig.clock.advance(300000);

    await rig.loop;

    assert.equal(rig.dialed.length, 2, "crossing the interval is what produces the second attempt");
  });

  test("a repeating failure is reported once and then quieted, and a new failure is reported again", async () => {

    /* Risk 3, as its own row. The script is timeout, timeout, encryption-invalid: the first timeout is news and reaches the user, the second is the same news and
     * goes to debug, and the encryption failure that follows is NEW news and must reach the user at error even though it arrived on the heels of a quieted run.
     * An implementation that decided the demotion from the previous attempt's reason - the only way to decide it without holding the line - demotes exactly that
     * third report, which is the one that matters.
     */
    const rig = harness([ { ok: false, reason: "timeout" }, { ok: false, reason: "timeout" }, { ok: false, reason: "encryption-invalid" } ]);

    await settle();

    assert.equal(diagnostics(rig.log, "error"), 1, "the first failure of a reason is reported at the level the connect layer chose");

    rig.clock.advance(300000);
    await settle();

    assert.equal(diagnostics(rig.log, "error"), 1, "the same failure repeating adds no second error line");
    assert.equal(diagnostics(rig.log, "debug"), 1, "it is quieted to debug rather than dropped, so a support request can still find it");

    rig.clock.advance(300000);

    await rig.loop;

    assert.equal(diagnostics(rig.log, "error"), 2, "a changed reason ends the quieting, so a new fault following a quieted run is reported in full");
    assert.equal(rig.dialed.length, 3, "and the loop ended on that final reason rather than pausing again");
  });

  test("a line the kept connection writes after its attempt has ended reaches the log at its own level", async () => {

    // A dial that connects hands its client the log it was given, and the client keeps writing through it for the connection's whole life. Once the attempt has
    // answered there is no verdict left for a later line to wait on, so it has to reach the log at the level it was written at.
    const clock = new TestClock();
    const lifetime = new AbortController();
    const log = capturingLog();
    const pause = new WakeableWait({ clock, signal: lifetime.signal });
    const kept: HomebridgePluginLogging[] = [];

    await runManualAddress({ address: ADDRESS, dial: async (attemptLog): Promise<ManualDialOutcome> => {

      kept.push(attemptLog);

      return { ok: true };
    }, isServed: (): boolean => false, log, pause, retrySeconds: RETRY_SECONDS });

    expectAt(kept, 0, "the log the one attempt was handed").warn("The connection reported a fault after its attempt ended.");

    assert.ok(loggedAt(log.entries, "warn", "The connection reported a fault after its attempt ended."),
      "a line written after the attempt answered is recorded at warn rather than held back with nothing left to release it");
  });

  test("a wake ends the pause at once and the loop re-reads whether the address is served", async () => {

    // The window the wakeable pause exists to close: something configures this device a moment after a failed attempt started its five-minute pause.
    let served = false;
    const rig = harness([{ ok: false, reason: "timeout" }], { served: (): boolean => served });

    await settle();

    assert.equal(rig.dialed.length, 1, "the loop is pausing after its failed attempt");

    served = true;
    rig.pause.wake("configured");

    await rig.loop;

    assert.equal(rig.dialed.length, 1, "the woken loop re-read the readiness test and ended without dialing a device that is already connected");
    assert.equal(rig.clock.requested.length, 1, "no further pause was registered");
  });

  test("an abort mid-pause settles the loop with nothing logged at error", async () => {

    const rig = harness([{ ok: false, reason: "timeout" }]);

    await settle();

    const errorsBefore = rig.log.entries.filter((entry) => entry.level === "error").length;

    rig.lifetime.abort(new Error("shutdown"));

    await rig.loop.catch(() => undefined);

    assert.equal(rig.dialed.length, 1, "a torn-down loop does not dial again");
    assert.equal(rig.log.entries.filter((entry) => entry.level === "error").length, errorsBefore,
      "shutdown is not a fault, so the unwind adds no error line of its own");
  });

  test("a dial that comes back as shutdown settles the loop with nothing logged at error", async () => {

    // The other half of the same teardown: the abort lands while the connect is in flight, so the dial classifies it rather than the pause rejecting.
    const clock = new TestClock();
    const lifetime = new AbortController();
    const log = capturingLog();
    const pause = new WakeableWait({ clock, signal: lifetime.signal });
    let dials = 0;

    await runManualAddress({ address: ADDRESS, dial: async (): Promise<ManualDialOutcome> => {

      dials++;
      lifetime.abort(new Error("shutdown"));

      return { ok: false, reason: "shutdown" };
    }, isServed: (): boolean => false, log, pause, retrySeconds: RETRY_SECONDS });

    assert.equal(dials, 1, "the loop ends on a shutdown rather than pausing to try again");
    assert.equal(clock.requested.length, 0, "and registers no pause on the way out");
    assert.equal(log.entries.filter((entry) => entry.level === "error").length, 0, "shutdown says nothing, because the platform is going away on purpose");
  });
});
