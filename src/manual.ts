/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * manual.ts: The slow loop that dials an opener the plugin cannot reach on its own, the listed-address connect built on it, and the pure rules that decide what
 * each does.
 *
 * Autodiscovery finds an opener by listening; a listed address finds one by asking. The two paths are deliberately unalike underneath, because the reconciliation
 * pass discovery drives is single-flight over every device it knows - one dead address dialed inside that pass would hold every later discovery event behind its
 * connect timeout. A listed address therefore runs its own supervised loop, one per address, and the two paths meet only at the platform's synchronous admit
 * chokepoint after a connect has resolved. The same loop redials an opener whose connection was refused for good, one per opener, so every opener this plugin keeps
 * dialing on its own is dialed on one cadence and reported by one rule.
 *
 * Everything here is a free function over its inputs, and the loop takes its connect, its readiness test, and its pause as ports. The platform composes those ports
 * out of instance state; this module owns the policy - which failures the settings page dials again, which of two listed addresses governs a device both reach, and
 * how loudly a failure that repeats forever should be reported. What counts as one canonical address is the rule src/webui/manual-address.ts states once for the
 * plugin and the settings page alike, and the list function here applies it.
 */
import type { HomebridgePluginLogging, RepeatDemotedLog, WakeableWait } from "homebridge-plugin-utils";
import type { ManualConnectionFailureReason } from "./connection.ts";
import { canonicalManualAddress } from "./webui/manual-address.ts";
import { repeatDemotedLog } from "homebridge-plugin-utils";

/* What a dial attempt answers the loop. Deliberately not the connection outcome: by the time the loop sees an attempt, the platform's closure has already admitted,
 * installed or refused the device and disposed whatever it is not keeping, so there is no client here and nothing for the loop to clean up. Every outcome that leaves
 * the loop nothing to dial - configured, adopted, yielded to another address, refused as a disabled device, installed - is `ok: true`.
 */
export type DialOutcome = { ok: true } | { ok: false; reason: ManualConnectionFailureReason };

/* The ports `runRetryLoop` runs on, apart from where its attempts report.
 *
 * @property dial         - Dial once and hand what answers to the platform, resolving what became of the attempt. The log it is given is the one the loop's
 *                          repeat-demoting adapter hands each attempt.
 * @property isServed     - Whether the loop has nothing left to dial, read before every attempt: a configured device holding the listed address, or a connection held
 *                          for the opener a redial is for.
 * @property pause        - The wait between attempts, which the platform wakes when something changes what the next attempt would find.
 * @property pauseFirst   - Whether the loop pauses before its first attempt too. A redial does, because whatever released its opener has just reported why. Defaults
 *                          to false.
 * @property retrySeconds - How long to wait between attempts.
 */
interface RetryLoopPorts {

  dial: (log: HomebridgePluginLogging) => Promise<DialOutcome>;
  isServed: () => boolean;
  pause: WakeableWait;
  pauseFirst?: boolean;
  retrySeconds: number;
}

/* The ports `runRetryLoop` runs on, with one source for where its attempts report: the repeat-demoting adapter they run through, or else the log the loop opens
 * that adapter on. An adapter carries the log it writes to, so a log handed in beside one would state a second time where the attempts report, and nothing would
 * keep the second statement agreeing with the first.
 *
 * @property failures - The adapter of an episode that began before the loop did, which the loop continues, so its first attempt is weighed against what the caller
 *                      already reported: a redial continues the episode its release opened.
 * @property log      - The log a loop that begins its own episode reports through. The loop opens a fresh adapter on it, which starts out knowing nothing.
 */
export type RunRetryLoopOptions = RetryLoopPorts & ({ failures: RepeatDemotedLog<ManualConnectionFailureReason>; log?: never } |
  { failures?: never; log: HomebridgePluginLogging });

/* The ports `runManualAddress` runs on: the slow loop's own, with the listed address the loop keeps connected, already in its canonical form (see
 * manualAddressList), without the pause before the first attempt, since a listed address is dialed as soon as the platform starts, and with the log rather than an
 * adapter, since a listed address's episode begins with its own first dial.
 */
export interface RunManualAddressOptions extends Omit<RetryLoopPorts, "pauseFirst"> {

  address: string;
  log: HomebridgePluginLogging;
}

/* Reduce the addresses a user listed to their canonical forms, dropping duplicates and preserving the user's order.
 *
 * Two spellings of one address must not become two loops dialing one device, which is what the canonical form settles; and the list's order is what decides
 * which of two addresses governs a device they both reach, so the order the user wrote is the order that survives.
 *
 * @param values - The addresses as the feature-option engine read them, already trimmed with empties dropped.
 *
 * @returns The canonical list.
 */
export function manualAddressList(values: readonly string[]): readonly string[] {

  return [...new Set(values.map((value) => canonicalManualAddress(value)))];
}

/* Whether a failed dial of a listed address could succeed on a later attempt without anyone acting, which is what the settings page's live-status feed asks before a
 * warm dials a failed address again.
 *
 * Unreachable is such a failure: a device is powered down, rebooting, or briefly off the network, and it will come back without anyone doing anything. `permanent`
 * and `unknown` are both that same class of answer - the connect layer's own documentation treats them as one, and every existing consumer acts on them together -
 * so this predicate keeps them together rather than splitting a distinction no caller makes. A budget the device blew through is the same story from a slower device.
 *
 * Nothing else changes without a person acting. A key the device refuses, an API version this plugin cannot speak, a device that is not an opener at all, and a
 * device answering as a MAC other than the one the connection is for all stay exactly as wrong on the next attempt as on this one; shutdown means the feed is going
 * away. A warm resends an unchanged configuration at foreground cadence, so redialing one of those on every warm would only re-flash the panel. The runtime's slow
 * loop reads none of this: it retries every reason but shutdown on its own patient interval, because a person can fix a refusal on the device's side without
 * touching the plugin, and that loop reports each reason once.
 *
 * @param reason - The classified reason the dial failed.
 *
 * @returns true when another attempt could succeed without the user acting.
 */
export function isRetryableFailure(reason: ManualConnectionFailureReason): boolean {

  switch(reason) {

    case "permanent":
    case "timeout":
    case "unknown":

      return true;

    case "encryption-invalid":
    case "encryption-missing":
    case "identity-mismatch":
    case "shutdown":
    case "unrecognized":
    case "unsupported":

      return false;

    default:

      // Compile-time exhaustiveness: a reason added to the connect layer's union fails to type-check here until it has been classified as retryable or not.
      reason satisfies never;

      return false;
  }
}

/* Decide which of the addresses that reach one device governs its dial.
 *
 * Two listed addresses can name one device - its IPv4 address and its hostname, say - and which of them connects first varies run to run, because two independent
 * loops race over a network. Letting arrival decide would hand the device a different address on every restart, and the address a connection is opened at is what its
 * reconnect supervisor uses forever after. So the list's own order decides instead: the earlier-listed address governs, on every run, and the user can change which
 * one by reordering the list.
 *
 * An address the list does not carry ranks after every address it does, so a device governed by an address the user has since removed yields to any listed address
 * that reaches it.
 *
 * @param current   - The address governing this device now, or undefined when nothing governs it yet.
 * @param candidate - The address asking to govern it.
 * @param order     - The canonical list, in the user's order.
 *
 * @returns Whichever of the two governs.
 */
export function governingAddress(current: string | undefined, candidate: string, order: readonly string[]): string {

  if(current === undefined) {

    return candidate;
  }

  const rank = (address: string): number => {

    const index = order.indexOf(address);

    return (index === -1) ? order.length : index;
  };

  return (rank(candidate) < rank(current)) ? candidate : current;
}

/* Keep dialing an opener the plugin cannot reach on its own until something serves it, for as long as this plugin runs: a listed address, one loop per address, and
 * an opener whose connection was refused for good, one loop per opener.
 *
 * One iteration: stand down if nothing is left to dial, dial, and act on what the dial answered. A success is the end of the loop's work - the device is connected
 * and its own ESPHome client owns every reconnect from there. Every failure but shutdown pauses and goes round again, a refusal a person must fix included: a key
 * corrected on the device, a firmware update, or an opener reclaiming an address another device held is picked up by a later attempt rather than by a restart, which
 * is the rule every plugin in the family follows for a refused sign-in. Shutdown ends the loop, because the plugin is going away.
 *
 * An opener that is simply not there fails the same way every retry interval for the life of the plugin, and the connect layer reports each failure in full, at
 * error or at warning, because from where it sits every failure is news. Repeating one line at every interval forever is not news, it is noise. So every attempt
 * runs through one repeat-demoting adapter: the first report of a reason reaches the user at the level the connect layer chose, and an unchanged reason after it
 * goes to debug, where a support request can still find it. One adapter serves the whole loop, because what it remembers from one attempt to the next is what
 * makes a repeat recognizable as one, and it is the caller's own when the caller's episode began before the loop did. A loop handed a log instead opens its own on
 * that log.
 *
 * The pause is wakeable, which is what closes the window this loop would otherwise sit in: something can serve this very opener a second after a failed attempt
 * starts the pause between attempts, and a plain delay would leave the loop dialing a device that is already connected. The platform wakes the pause when that
 * happens, and when the opener speaks for itself on the network, the loop re-reads isServed, and it ends or dials at once.
 *
 * The lifetime is the pause's, not this function's: `wait` rejects with the stopping signal's own reason, and that rejection unwinds the loop for the supervisor
 * above to swallow. There is nothing here to clean up on the way out, because the loop never holds a client - the dial hands every client it opens to the platform,
 * which keeps exactly one and disposes the rest.
 *
 * @param options - See RunRetryLoopOptions.
 */
export async function runRetryLoop({ dial, isServed, pause, pauseFirst = false, retrySeconds, ...reports }: RunRetryLoopOptions): Promise<void> {

  const failures = reports.failures ?? repeatDemotedLog<ManualConnectionFailureReason>(reports.log);

  if(pauseFirst) {

    await pause.wait(retrySeconds * 1000);
  }

  for(;;) {

    /* Nothing to dial once something serves the opener. This is checked before every attempt rather than once at the top, because the state it reads changes while
     * the loop is paused: discovery configures this device at this address, a sibling address that reaches the same device wins the governance, or another path
     * connects an opener a redial is for.
     */
    if(isServed()) {

      return;
    }

    // Sequential by definition: one attempt at a time against one device, and the next attempt's decisions are made from this one's verdict.
    // eslint-disable-next-line no-await-in-loop
    const outcome = await failures.attempt(dial, (result) => result.ok ? undefined : result.reason);

    if(outcome.ok || (outcome.reason === "shutdown")) {

      return;
    }

    // The pause between attempts, which is the loop's whole reason for being a loop.
    // eslint-disable-next-line no-await-in-loop
    await pause.wait(retrySeconds * 1000);
  }
}

/* Keep one listed address connected for as long as this plugin runs, on the slow loop, dialing at once.
 *
 * The key failures a user can fix from the settings page get a line naming where. A device that has never connected has no row in the sidebar yet, so there is
 * nowhere else to set its key; the Add Device card learns the device's MAC by testing this address, and stores the key at that MAC, where this address's connection
 * reads it. The line is written through the attempt's own log, so the loop quiets it with the failure it explains while that failure repeats.
 *
 * @param options - See RunManualAddressOptions.
 */
export async function runManualAddress({ address, dial, isServed, log, pause, retrySeconds }: RunManualAddressOptions): Promise<void> {

  const dialAddress = async (attemptLog: HomebridgePluginLogging): Promise<DialOutcome> => {

    const outcome = await dial(attemptLog);

    if(!outcome.ok && ((outcome.reason === "encryption-invalid") || (outcome.reason === "encryption-missing"))) {

      attemptLog.error("%s: the device refused the encryption key. Enter this device's key through Add Device in the plugin's settings.", address);
    }

    return outcome;
  };

  return runRetryLoop({ dial: dialAddress, isServed, log, pause, retrySeconds });
}
