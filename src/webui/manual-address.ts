/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * manual-address.ts: The canonical-address rule for an address a user lists, which the settings page and the plugin both import.
 *
 * This is the one place an address takes its canonical form. The plugin's runtime reads it through its listed-address loops and the settings page's status feed, and
 * the page reads the compiled copy the build places beside it, so the Add Device card, the feed, and the platform spell every address one way because there is one
 * rule to spell it.
 */

/* Reduce one address a user typed to the canonical form everything downstream uses: trimmed, lower-cased, and with one enclosing pair of square brackets removed.
 *
 * A hostname is case-insensitive by definition and an IPv6 literal is case-insensitive in its hex digits, so two spellings of one address must not become two entries
 * naming one device. The brackets matter for a different reason: a user typing an IPv6 literal reasonably reaches for the URL spelling, and the bracketed form is not an
 * address at all to anything downstream - Node's own parser does not read it as an IP literal, so a dial would resolve it as a hostname and fail forever. Every key,
 * comparison, dial, and log line after this point reads this form.
 *
 * The rule is deliberately this short. No port is parsed off the end, and no IPv6 literal is compressed or expanded: both would mean interpreting an address rather
 * than spelling it one way.
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
 * repeats forever. The runtime tells the user in its log, and the Add Device card tells them on the card, each naming what to list instead.
 *
 * @param address - A canonical address.
 *
 * @returns true when the address cannot be dialed because it names a zone.
 */
export function isZonedAddress(address: string): boolean {

  return address.includes("%");
}
