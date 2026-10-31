/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * manual.test.ts: The manual-address concern net - the canonical address list, the retryable-failure classification, the governance rule that settles two addresses
 * reaching one device, and the slow loop with the listed-address connect built on it. The loop is pure over its ports, so every rule it follows is driven here
 * directly: the dial, the readiness test, and the log are all supplied by the test, and the pause runs on a TestClock so the pause between attempts is asserted in
 * virtual time rather than waited out.
 */
import { TestClock, capturingLog, expectAt, logCount, loggedAt, settle } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import { governingAddress, isRetryableFailure, manualAddressList, runManualAddress, runRetryLoop } from "./manual.ts";
import type { CapturingLog } from "homebridge-plugin-utils/testing";
import type { DialOutcome } from "./manual.ts";
import type { HomebridgePluginLogging } from "homebridge-plugin-utils";
import type { ManualConnectionFailureReason } from "./connection.ts";
import { WakeableWait } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { canonicalManualAddress } from "./webui/manual-address.ts";

// The address this suite's loops dial, and the interval they retry on - the production interval, since the pause runs in virtual time and costs nothing to assert.
const ADDRESS = "garage.local";
const RETRY_SECONDS = 300;

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
    "identity-mismatch": false,
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
        "nothing changes here until a person acts, so a warm of the settings page does not dial it again");
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
  const harness = (script: DialOutcome[], options: { served?: () => boolean } = {}): { clock: TestClock; dialed: string[]; lifetime: AbortController;
    log: CapturingLog; loop: Promise<void>; pause: WakeableWait; } => {

    const clock = new TestClock();
    const lifetime = new AbortController();
    const log = capturingLog();
    const pause = new WakeableWait({ clock, signal: lifetime.signal });
    const dialed: string[] = [];
    const dial = async (attemptLog: Parameters<Parameters<typeof runManualAddress>[0]["dial"]>[0]): Promise<DialOutcome> => {

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

  // The line a key failure earns, naming where a manually addressed device's key is entered.
  const KEY_HINT = "garage.local: the device refused the encryption key. Enter this device's key through Add Device in the plugin's settings.";

  /* Every refusal a person has to fix, retried on the slow interval rather than ending the address's loop: a key corrected on the device, a firmware update, or an
   * address another device gives back is picked up by a later attempt rather than by a restart, which is the family's rule for a refused sign-in. The key failures
   * earn a line naming where the key is entered, because that is the one place a user can fix it from the settings page, and it is quieted with the failure it
   * explains, so a refusal that repeats every interval gives that advice once.
   */
  const refusals: { guidance: boolean; reason: ManualConnectionFailureReason }[] = [

    { guidance: true, reason: "encryption-invalid" },
    { guidance: true, reason: "encryption-missing" },
    { guidance: false, reason: "identity-mismatch" },
    { guidance: false, reason: "unrecognized" },
    { guidance: false, reason: "unsupported" }
  ];

  for(const { guidance, reason } of refusals) {

    test(reason + " is retried after the retry interval" + (guidance ? ", naming where the key is entered once" : ""), async () => {

      const rig = harness([ { ok: false, reason }, { ok: false, reason }, { ok: true } ]);

      await settle();

      assert.equal(rig.dialed.length, 1, "the first attempt has run");
      assert.deepEqual(rig.clock.requested, [300000], "and the refusal pauses for the retry interval rather than ending the loop");
      assert.equal(logCount(rig.log.entries, "error", KEY_HINT), guidance ? 1 : 0,
        guidance ? "a key failure tells the user where a manually addressed device's key is entered" : "and no other failure reaches for that advice");

      rig.clock.advance(300000);
      await settle();

      assert.equal(rig.dialed.length, 2, "crossing the interval dials the refused address again");
      assert.equal(logCount(rig.log.entries, "error", KEY_HINT), guidance ? 1 : 0, "the same refusal repeating repeats no advice at error");
      assert.equal(logCount(rig.log.entries, "debug", KEY_HINT), guidance ? 1 : 0, "the repeat's advice is quieted to debug with the failure it explains");

      rig.clock.advance(300000);

      await rig.loop;

      assert.equal(rig.dialed.length, 3, "and an attempt that lands once the refusal clears ends the loop");
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

    /* The script is timeout, timeout, encryption-invalid: the first timeout is news and reaches the user, the second is the same news and goes to debug, and the
     * encryption failure that follows is NEW news and must reach the user at error even though it arrived on the heels of a quieted run. An implementation that
     * decided the demotion from the previous attempt's reason - the only way to decide it without holding the line - demotes exactly that third report, which is the
     * one that matters. The attempt after it lands, which is what ends the loop.
     */
    const rig = harness([ { ok: false, reason: "timeout" }, { ok: false, reason: "timeout" }, { ok: false, reason: "encryption-invalid" }, { ok: true } ]);

    await settle();

    assert.equal(diagnostics(rig.log, "error"), 1, "the first failure of a reason is reported at the level the connect layer chose");

    rig.clock.advance(300000);
    await settle();

    assert.equal(diagnostics(rig.log, "error"), 1, "the same failure repeating adds no second error line");
    assert.equal(diagnostics(rig.log, "debug"), 1, "it is quieted to debug rather than dropped, so a support request can still find it");

    rig.clock.advance(300000);
    await settle();

    assert.equal(diagnostics(rig.log, "error"), 2, "a changed reason ends the quieting, so a new fault following a quieted run is reported in full");

    rig.clock.advance(300000);

    await rig.loop;

    assert.equal(rig.dialed.length, 4, "and the loop paused after that refusal too, ending only on the attempt that landed");
  });

  test("a line the kept connection writes after its attempt has ended reaches the log at its own level", async () => {

    // A dial that connects hands its client the log it was given, and the client keeps writing through it for the connection's whole life. Once the attempt has
    // answered there is no verdict left for a later line to wait on, so it has to reach the log at the level it was written at.
    const clock = new TestClock();
    const lifetime = new AbortController();
    const log = capturingLog();
    const pause = new WakeableWait({ clock, signal: lifetime.signal });
    const kept: HomebridgePluginLogging[] = [];

    await runManualAddress({ address: ADDRESS, dial: async (attemptLog): Promise<DialOutcome> => {

      kept.push(attemptLog);

      return { ok: true };
    }, isServed: (): boolean => false, log, pause, retrySeconds: RETRY_SECONDS });

    expectAt(kept, 0, "the log the one attempt was handed").warn("The connection reported a fault after its attempt ended.");

    assert.ok(loggedAt(log.entries, "warn", "The connection reported a fault after its attempt ended."),
      "a line written after the attempt answered is recorded at warn rather than held back with nothing left to release it");
  });

  test("a wake ends the pause at once and the loop re-reads whether the address is served", async () => {

    // The window the wakeable pause exists to close: something configures this device a moment after a failed attempt started the pause between attempts.
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

    await runManualAddress({ address: ADDRESS, dial: async (): Promise<DialOutcome> => {

      dials++;
      lifetime.abort(new Error("shutdown"));

      return { ok: false, reason: "shutdown" };
    }, isServed: (): boolean => false, log, pause, retrySeconds: RETRY_SECONDS });

    assert.equal(dials, 1, "the loop ends on a shutdown rather than pausing to try again");
    assert.equal(clock.requested.length, 0, "and registers no pause on the way out");
    assert.equal(log.entries.filter((entry) => entry.level === "error").length, 0, "shutdown says nothing, because the platform is going away on purpose");
  });
});

describe("runRetryLoop", () => {

  /* A loop that pauses before its first attempt, as a redial does, over a dial answering from a script and a readiness test the row controls. The pause is the one
   * the row wakes, on a TestClock, so the wait before the first attempt is asserted in virtual time.
   */
  const pausingFirst = (script: DialOutcome[], served: () => boolean = (): boolean => false): { clock: TestClock; dialed: () => number; loop: Promise<void>;
    pause: WakeableWait; } => {

    const clock = new TestClock();
    const pause = new WakeableWait({ clock, signal: new AbortController().signal });
    let dials = 0;
    const loop = runRetryLoop({ dial: async (): Promise<DialOutcome> => script[dials++] ?? { ok: false, reason: "timeout" }, isServed: served, log: capturingLog(),
      pause, pauseFirst: true, retrySeconds: RETRY_SECONDS });

    return { clock, dialed: (): number => dials, loop, pause };
  };

  test("a loop that pauses first dials only once the retry interval has passed", async () => {

    const rig = pausingFirst([{ ok: true }]);

    await settle();

    assert.equal(rig.dialed(), 0, "nothing is dialed before the first pause ends, so the release that started the loop is not answered by an immediate repeat");
    assert.deepEqual(rig.clock.requested, [300000], "the first pause asks for the retry interval");

    rig.clock.advance(300000);

    await rig.loop;

    assert.equal(rig.dialed(), 1, "crossing the interval produces the first attempt, and an attempt that lands ends the loop");
  });

  test("a wake during the first pause dials at once, and a loop something served meanwhile ends without dialing", async () => {

    const woken = pausingFirst([{ ok: true }]);

    await settle();
    woken.pause.wake("advertised");

    await woken.loop;

    assert.equal(woken.dialed(), 1, "a wake ends the first pause early, so the opener speaking for itself is dialed at once");

    let served = false;
    const standing = pausingFirst([{ ok: true }], (): boolean => served);

    await settle();
    served = true;
    standing.pause.wake("released");

    await standing.loop;

    assert.equal(standing.dialed(), 0, "the readiness test is read after the first pause too, so an opener another path connected is not dialed again");
  });
});
