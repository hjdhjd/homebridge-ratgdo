/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * manual.ts: The supervised connect loop for a device the user named by address, and the pure rules that decide what it does.
 *
 * Autodiscovery finds an opener by listening; a listed address finds one by asking. The two paths are deliberately unalike underneath, because the reconciliation
 * pass discovery drives is single-flight over every device it knows - one dead address dialed inside that pass would hold every later discovery event behind its
 * connect timeout. A listed address therefore runs its own supervised loop, one per address, and the two paths meet only at the platform's synchronous admit
 * chokepoint after a connect has resolved.
 *
 * Everything here is a free function over its inputs, and the loop takes its connect, its readiness test, and its pause as ports. The platform composes those ports
 * out of instance state; this module owns the policy - what counts as one canonical address, which failures are worth retrying, which of two listed addresses
 * governs a device both reach, and how loudly a failure that repeats forever should be reported.
 */
import type { HomebridgePluginLogging, WakeableWait } from "homebridge-plugin-utils";
import type { ManualConnectionFailureReason } from "./connection.ts";
import { repeatDemotedLog } from "homebridge-plugin-utils";

/* What a dial attempt answers the loop. Deliberately not the connection outcome: by the time the loop sees an attempt, the platform's closure has already admitted
 * or refused the device and disposed whatever it is not keeping, so there is no client here and nothing for the loop to clean up. Every admitted outcome - configured,
 * adopted, yielded to another address, refused as a disabled device - is `ok: true`, because in each of them this address needs no further dial.
 */
export type ManualDialOutcome = { ok: true } | { ok: false; reason: ManualConnectionFailureReason };

/* The ports `runManualAddress` runs on.
 *
 * @property address      - The listed address, already in its canonical form (see manualAddressList).
 * @property dial         - Open a connection to this address and hand what answers to the platform, resolving what became of it. The log it is given is the one
 *                          the loop's repeat-demoting adapter hands each attempt.
 * @property isServed     - Whether some configured device already holds this address, which is the one condition under which the loop has nothing left to do.
 * @property log          - This address's log.
 * @property pause        - The wait between attempts, which the platform wakes when something configures this address.
 * @property retrySeconds - How long to wait between attempts.
 */
export interface RunManualAddressOptions {

  address: string;
  dial: (log: HomebridgePluginLogging) => Promise<ManualDialOutcome>;
  isServed: () => boolean;
  log: HomebridgePluginLogging;
  pause: WakeableWait;
  retrySeconds: number;
}

/* Reduce one address a user typed to the canonical form everything downstream uses: trimmed, lower-cased, and with one enclosing pair of square brackets removed.
 *
 * This is the ONE place an address takes its canonical form in the runtime. A hostname is case-insensitive by definition and an IPv6 literal is case-insensitive in
 * its hex digits, so two spellings of one address must not become two entries naming one device. The brackets matter for a different reason: a user typing an IPv6
 * literal reasonably reaches for the URL spelling, and the bracketed form is not an address at all to anything downstream - Node's own parser does not read it as an
 * IP literal, so a dial would resolve it as a hostname and fail forever. Every key, comparison, dial, and log line after this point reads this form.
 *
 * The rule is deliberately this short. No port is parsed off the end, and no IPv6 literal is compressed or expanded: both would mean interpreting an address rather
 * than spelling it one way, and the page has to mirror this rule character for character in a module that cannot import this one.
 *
 * @param address - The address as the user wrote it.
 *
 * @returns The canonical spelling of that address.
 */
export function canonicalManualAddress(address: string): string {

  const trimmed = address.trim();

  // Only an ENCLOSING pair goes. A stray bracket on one end is left exactly where the user put it, because removing half a pair would quietly change an address into
  // a different one rather than leaving a wrong entry visibly wrong.
  const bare = (trimmed.startsWith("[") && trimmed.endsWith("]")) ? trimmed.slice(1, -1) : trimmed;

  return bare.toLowerCase();
}

/* Whether a canonical address carries an IPv6 zone identifier, which is the one shape this plugin refuses to dial.
 *
 * A zone identifier names the interface a link-local address was heard on, and it means nothing without that link. Autodiscovery already drops a zoned candidate
 * before anything can choose it, for exactly this reason; an address a user types deserves the same answer rather than a dial that cannot work and a retry that
 * repeats forever. The user is told, and told what to list instead.
 *
 * @param address - A canonical address.
 *
 * @returns true when the address cannot be dialed because it names a zone.
 */
export function isZonedAddress(address: string): boolean {

  return address.includes("%");
}

/* Reduce the addresses a user listed to their canonical forms, dropping duplicates and preserving the user's order.
 *
 * Two spellings of one address must not become two loops dialing one device, which is what the canonical form above settles; and the list's order is what decides
 * which of two addresses governs a device they both reach, so the order the user wrote is the order that survives.
 *
 * @param values - The addresses as the feature-option engine read them, already trimmed with empties dropped.
 *
 * @returns The canonical list.
 */
export function manualAddressList(values: readonly string[]): readonly string[] {

  return [...new Set(values.map((value) => canonicalManualAddress(value)))];
}

/* Whether a failed dial of a listed address is worth trying again.
 *
 * Unreachable is worth retrying: a device is powered down, rebooting, or briefly off the network, and it will come back without anyone doing anything. `permanent`
 * and `unknown` are both that same class of answer - the connect layer's own documentation treats them as one, and every existing consumer acts on them together -
 * so this predicate keeps them together rather than splitting a distinction no caller makes. A budget the device blew through is the same story from a slower device.
 *
 * Nothing else changes without a person acting. A key the device refuses, an API version this plugin cannot speak, a device that is not an opener at all, and a
 * device answering as a MAC other than the one the connection is for all stay exactly as wrong on the thousandth attempt as on the first; shutdown means the plugin
 * is going away. Each of those ends the address's loop until the plugin restarts, which is what keeps a misconfigured address from dialing a device forever.
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

/* Keep one listed address connected for as long as this plugin runs.
 *
 * One iteration: stand down if something already configured this address, dial, and act on what the dial answered. A success is the end of the loop's work - the
 * device is configured and its own ESPHome client owns every reconnect from there, which is exactly what a discovered device gets. A failure nobody can retry their
 * way out of also ends the loop, after telling the user what to do about the two failures they can actually fix. Anything else pauses and goes round again.
 *
 * The pause is wakeable, which is what closes the window this loop would otherwise sit in: discovery can configure this very device, at this very address, a second
 * after a failed attempt starts the pause between attempts, and a plain delay would leave the loop dialing a device that is already connected. The platform wakes
 * the pause at its admit chokepoint, the loop re-reads isServed, and it ends.
 *
 * The lifetime is the pause's, not this function's: `wait` rejects with the shutdown signal's own reason, and that rejection unwinds the loop for the supervisor
 * above to swallow. There is nothing here to clean up on the way out, because the loop never holds a client - the dial hands every client it opens to the platform,
 * which keeps exactly one and disposes the rest.
 *
 * @param options - See RunManualAddressOptions.
 */
export async function runManualAddress({ address, dial, isServed, log, pause, retrySeconds }: RunManualAddressOptions): Promise<void> {

  /* A listed address that is simply not there fails the same way every retry interval for the life of the plugin, and the connect layer reports each failure at error
   * because from where it sits every failure is news. Repeating one line at every interval forever is not news, it is noise. So the first report of a reason reaches
   * the user at the level the connect layer chose, and an unchanged reason after it goes to debug, where a support request can still find it. The adapter is built
   * once, ahead of the loop, because what it remembers from one attempt to the next is what makes a repeat recognizable as one.
   */
  const failures = repeatDemotedLog<ManualConnectionFailureReason>(log);

  for(;;) {

    /* Nothing to do for an address a configured device already holds. This is checked before every attempt rather than once at the top, because the state it reads
     * changes while the loop is paused: discovery configures this device at this address, or a sibling address that reaches the same device wins the governance.
     */
    if(isServed()) {

      return;
    }

    // Sequential by definition: one attempt at a time against one device, and the next attempt's decisions are made from this one's verdict.
    // eslint-disable-next-line no-await-in-loop
    const outcome = await failures.attempt(dial, (result) => result.ok ? undefined : result.reason);

    if(outcome.ok) {

      return;
    }

    if(!isRetryableFailure(outcome.reason)) {

      /* The two failures a user can fix from the settings page get a line naming where. A device that has never connected has no row in the sidebar yet, so there is
       * nowhere else to set its key; the Add Device card learns the device's MAC by testing this address, and stores the key at that MAC, where this address's
       * connection reads it.
       */
      if((outcome.reason === "encryption-invalid") || (outcome.reason === "encryption-missing")) {

        log.error("%s: the device refused the encryption key. Enter this device's key through Add Device in the plugin's settings.", address);
      }

      return;
    }

    // The pause between attempts, which is the loop's whole reason for being a loop.
    // eslint-disable-next-line no-await-in-loop
    await pause.wait(retrySeconds * 1000);
  }
}
