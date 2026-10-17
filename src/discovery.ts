/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * discovery.ts: Pure parsing and classification of a wire record into a recognized Ratgdo device identity.
 *
 * Two wire records name a device to this plugin, and this module owns the pure derivation for both. The library's discovery stream hands it every service it resolves
 * for the ESPHome service type, and a connection opened against an address the user typed hands it the device-info record the connected client read. Each reader
 * validates what its own record carries and then composes the identity through one rule: classify the project name against the known-variant registry, normalize the
 * MAC into the two representations downstream code needs, and answer null for anything that is not a Ratgdo (or compatible variant) we configure - which is exactly
 * what the discovery stream reads as "not a device" and what the manual dial reads as "not an opener". The same policy layer answers the one question both connection
 * owners ask of an identity afterward - whether the address a connection was opened at is still one the device advertises - so the rule that decides when a connection
 * has gone stale is stated once here beside the pick rather than at each owner. The platform-state half - UUID generation, the per-run dedup gates, the resolved log
 * name - stays in the platform because it depends on instance state (hap, feature options, the device maps). Keeping the wire-derivation here makes the validity
 * guards, the address pick, the membership test, the project classification, and the MAC normalization unit-testable against arbitrary wire input without a live
 * network or a Homebridge harness.
 */
import { BlockList, isIPv4, isIPv6 } from "node:net";
import type { MdnsService, Nullable } from "homebridge-plugin-utils";
import type { DeviceInfo } from "esphome-client";
import { RATGDO_AUTODISCOVERY_PROJECTS } from "./settings.ts";
import type { RatgdoVariant } from "./types.ts";
import { txtEntries } from "homebridge-plugin-utils";

/* The closed vocabulary of ESPHome TXT keys this plugin reads. The classify below and the suite's service fixture share this one list, so a misspelled key is a
 * compile error at either site rather than a field that silently reads as absent against a live device.
 */
export const RATGDO_TXT_KEYS = [ "esphome_version", "friendly_name", "mac", "project_name", "project_version", "version" ] as const;

export type RatgdoTxtKey = typeof RATGDO_TXT_KEYS[number];

/* A recognized Ratgdo identity, derived entirely from one wire record - everything a reader here can determine without platform state. A resolved mDNS service and a
 * connected client's device-info record each derive one, which is why nothing below names the source it came from. The platform layers UUID generation, the dedup
 * gates, and the resolved device name on top of this.
 *
 * @property address         - The address to dial. For a service that is the pick out of everything the device advertises: its IPv6 address where it has a routable
 *                             one, otherwise its IPv4 address. For a device-info record it is the address the connection was opened at, since that is the one address
 *                             the device is known to answer on.
 * @property addresses       - Every address the record accounts for. For a service that is what the device advertised, exactly as the browser listed them and
 *                             including any the pick would refuse, because this is the advertisement rather than a list of dial targets. For a device-info record it
 *                             is the single address that answered. isAdvertisedAt reads it.
 * @property firmwareVersion - The device firmware version (the version key, falling back to esphome_version; the guard guarantees one of them is present).
 * @property friendlyName    - The mDNS-advertised friendly name, the fallback for the device's display name before the "Ratgdo" default.
 * @property macColon        - The uppercased colon-delimited MAC (AA:BB:...), the form HomeKit's UUID generator and the discovered-device dedup set consume.
 * @property model           - The advertised project version, used as the initial device model before the connected client's deviceInfo refreshes it.
 * @property strippedMac     - The bare-hex MAC (AABB...), the form device.mac, feature-option lookup keys, and MQTT topics consume.
 * @property variant         - The device variant the matched project pattern classifies this device as.
 */
export interface DiscoveredRatgdo {

  readonly address: string;
  readonly addresses: readonly string[];
  readonly firmwareVersion: string;
  readonly friendlyName: string | undefined;
  readonly macColon: string;
  readonly model: string | undefined;
  readonly strippedMac: string;
  readonly variant: RatgdoVariant;
}

/* The two IPv6 ranges the pick below tells apart, built once at module scope because a BlockList parses its subnets when they are added rather than on every check.
 * fe80::/10 is the link-local range, and the mask is the library's own test for one, so this module and the browser that stamps a zone onto a link-local address
 * always agree about which addresses those are. fc00::/7 is the unique-local range - the addresses a site assigns itself, which do not change when an ISP hands out
 * a new global prefix.
 */
const IPV6_LINK_LOCAL = new BlockList();
const IPV6_UNIQUE_LOCAL = new BlockList();

IPV6_LINK_LOCAL.addSubnet("fe80::", 10, "ipv6");
IPV6_UNIQUE_LOCAL.addSubnet("fc00::", 7, "ipv6");

// The lowest member of a candidate class by plain string comparison, or nothing when the class is empty. One answer for one set, whatever order the set arrived in.
function lowest(candidates: readonly string[]): string | undefined {

  return candidates.length ? candidates.reduce((best, candidate) => (candidate < best) ? candidate : best) : undefined;
}

/* Choose the address this plugin dials out of everything a device advertises. The device is dialed over IPv6 where it offers a routable IPv6 address, over IPv4
 * otherwise, and over an unzoned link-local address only when it advertises nothing else.
 *
 * The answer is a function of the whole set of advertised addresses and never of their order, which is the property worth the extra lines here. The browser lists a
 * host's addresses in the order they arrived in its cache, a record that lapses and returns re-enters at the end, and both consumers of this address read any textual
 * change as the device having moved and tear a healthy connection down. Picking "the first IPv6 address" would therefore flip a dual-addressed device between its
 * unique-local and global addresses on ordinary packet loss; ranking the candidates does not. Unique-local leads the ranking because it is the address that survives
 * an ISP prefix rotation, and within one class the lowest string wins - a comparison over the library's one canonical spelling per address, textual rather than
 * numeric because its only job is to give one answer for one set.
 *
 * A zoned address is dropped before anything else looks at it: a link-local address means nothing without the link it was heard on, and the zone the library stamps on
 * it is this module's signal that the address is one of those.
 */
function dialAddress(addresses: readonly string[]): string | undefined {

  // A zone cannot be part of a connection target, so a zoned candidate leaves before anything is classified.
  const unzoned = addresses.filter((candidate) => !candidate.includes("%"));
  const ipv6 = unzoned.filter((candidate) => isIPv6(candidate));
  const linkLocal = ipv6.filter((candidate) => IPV6_LINK_LOCAL.check(candidate, "ipv6"));
  const routable = ipv6.filter((candidate) => !IPV6_LINK_LOCAL.check(candidate, "ipv6"));
  const uniqueLocal = routable.filter((candidate) => IPV6_UNIQUE_LOCAL.check(candidate, "ipv6"));

  /* The ranking, best to last resort. Only the IPv4 arm reads positionally, and it is the one place where order cannot change the answer: a device advertises a
   * single address of that family, so the first one is the only one.
   */
  return lowest(uniqueLocal) ?? lowest(routable) ?? unzoned.find((candidate) => isIPv4(candidate)) ?? lowest(linkLocal);
}

/* Whether a connection opened at one address is still a connection to this device, which is the question a connection owner means to ask of a fresh advertisement -
 * deliberately not the question the pick above answers. The browser re-derives a host's address list every time one of its records lapses or returns, so the ranked
 * pick moves between a device's own addresses on nothing more than ordinary packet loss; a connection is stale only when the address it was opened at is gone from
 * the advertisement altogether. Comparing a held address against the current pick therefore tears healthy connections down, and a membership test over the advertised
 * list does not.
 *
 * The list is read as the browser gave it, zoned entries and all, because an address this plugin would never dial is still the device saying it answers there. The
 * one case this cannot tell apart is the record of the held address itself lapsing while the socket is healthy: the advertisement alone cannot distinguish that from
 * a device that moved, and the connection is reopened once.
 *
 * @param discovered - The identity derived from the advertisement being reconciled.
 * @param address    - The address the caller's connection was opened at.
 *
 * @returns true when the device still advertises that address.
 */
export function isAdvertisedAt(discovered: DiscoveredRatgdo, address: string): boolean {

  return discovered.addresses.includes(address);
}

/* One reading rule for a wire string field, shared by both readers below. Each source distinguishes absent from present-but-empty - `txtEntries` tells apart absent, a
 * bare flag (null), and a key written with nothing after its equals sign, and a device-info record simply omits a member or carries an empty one - and both sources
 * mean the same thing by all of them: the device offered nothing usable under that name. The logical or is what collapses them deliberately; a nullish coalesce would
 * carry the empty string through as though it were a value, and an empty friendly name would then become the device's display name.
 */
// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
const advertised = (value: Nullable<string> | undefined): string | undefined => value || undefined;

/* The already-read fields an identity is composed from, in the vocabulary this module derives rather than the vocabulary either wire format spells them in. A reader
 * validates its own record, translates it into this shape, and hands it over; the composer owns everything that follows.
 *
 * @property address        - The address to dial, already chosen by the reader. The composer never re-derives it, so the dial pick belongs to the service reader alone.
 * @property addresses       - Every address this record accounts for, carried onto the identity untouched.
 * @property firmwareVersion - The device firmware version.
 * @property friendlyName    - The device's advertised friendly name, or undefined when it offered none.
 * @property mac             - The MAC in whichever spelling the record used; the normalization below accepts either.
 * @property projectName     - The ESPHome project name, which is both the recognition gate and the variant classifier.
 * @property projectVersion  - The advertised project version, which becomes the initial device model.
 */
interface IdentityFields {

  readonly address: string;
  readonly addresses: readonly string[];
  readonly firmwareVersion: string;
  readonly friendlyName: string | undefined;
  readonly mac: string;
  readonly projectName: string;
  readonly projectVersion: string | undefined;
}

/* Compose a recognized identity out of already-validated fields, or null when the project name names no device we configure. This is the one rule both wire readers
 * share, which is what makes a device reached by address and the same device reached by advertisement indistinguishable to everything downstream: same variant
 * classification, same MAC normalization, same identity shape. Each reader owns only what its own record makes it responsible for - the dial pick and the TXT
 * vocabulary for a service, the device-info member names for a connected client - and neither owns what a recognized opener is.
 */
function composeIdentity({ address, addresses, firmwareVersion, friendlyName, mac, projectName, projectVersion }: IdentityFields): Nullable<DiscoveredRatgdo> {

  /* Single-pass filter-and-classify. RATGDO_AUTODISCOVERY_PROJECTS maps each project-name pattern to the device variant it identifies, so a successful match is both
   * the recognition gate (we recognize this device) and the classifier (we know what variant to construct). An unmatched project name is some other ESPHome device, and
   * keeping the pattern and the variant adjacent in the registry means adding a variant is a single-line edit there rather than a coordinated change at two sites.
   */
  const project = RATGDO_AUTODISCOVERY_PROJECTS.find((entry) => entry.pattern.test(projectName));

  if(!project) {

    return null;
  }

  /* Two MAC representations: macColon is the uppercased colon-delimited form HomeKit's UUID generator and the discovered-device dedup set use; strippedMac is the
   * bare-hex form everything downstream consumes (device.mac, feature-option lookup keys, MQTT topics). The two wire formats spell a MAC differently - a TXT record
   * carries bare hex and a device-info record carries the colon-delimited form - so every non-hex character comes out first and one spelling goes in. The (?=.)
   * lookahead then inserts a colon after every pair except the final one, so AABBCCDDEEFF becomes AA:BB:CC:DD:EE:FF with no trailing colon.
   */
  const macColon = mac.replace(/[^0-9a-f]/gi, "").toUpperCase().replace(/(.{2})(?=.)/g, "$1:");

  return {

    address: address,
    addresses: addresses,
    firmwareVersion: firmwareVersion,
    friendlyName: friendlyName,
    macColon: macColon,
    model: projectVersion,
    strippedMac: macColon.replace(/:/g, ""),
    variant: project.variant
  };
}

/* Classify the device-info record a connected client read into a recognized Ratgdo identity, or null when whatever answered at that address is not a device we
 * configure. This is what makes a user-typed address usable: a device's MAC is unknowable until a connection to it has opened, so the identity a discovered device
 * gets from its advertisement is derived here from the record instead, after the connect.
 *
 * The validity guard requires a MAC, a project name, and a firmware version, because those are the three the identity cannot be composed without. An empty member
 * reads as an absent one, exactly as an empty TXT value does, and `friendlyName` falls back to the device's own name before it gives up - ESPHome populates one or
 * both depending on how the device's YAML is written.
 *
 * Pure and I/O-free: the caller does the reading and hands the record over.
 *
 * @param info    - The device-info record the connected client read, or null when the client has none.
 * @param address - The address the connection was opened at.
 *
 * @returns The recognized identity, or null when the record names no opener this plugin supports.
 */
export function classifyDeviceInfo(info: Nullable<DeviceInfo>, address: string): Nullable<DiscoveredRatgdo> {

  if(!info) {

    return null;
  }

  /* Every field is read once into a local before the guard. TypeScript narrows a local through a truthiness check but never a repeated member read, so the guard's
   * guarantee reaches the composer below only through these bindings.
   */
  const firmwareVersion = advertised(info.esphomeVersion);
  const friendlyName = advertised(info.friendlyName) ?? advertised(info.name);
  const mac = advertised(info.macAddress);
  const projectName = advertised(info.projectName);

  if(!firmwareVersion || !mac || (projectName === undefined)) {

    return null;
  }

  /* The dialed address stands in for the advertisement. A device-info record says nothing about where else the device answers, and the one address we know it answers
   * on is the one that just did - so the singleton list is the honest reading. An empty list would be the dishonest one: isAdvertisedAt would then answer false for
   * every address, and a connection owner reading that as a device that moved would replace a healthy connection on the next thing it heard about this device.
   */
  return composeIdentity({ address, addresses: [address], firmwareVersion, friendlyName, mac, projectName, projectVersion: advertised(info.projectVersion) });
}

/* Parse and classify a resolved mDNS service into a recognized Ratgdo identity, or null when the service is not a device we configure. The validity guard requires a
 * firmware version (version or esphome_version), a MAC, a dialable address, and a project_name; the composer then matches that project_name against
 * RATGDO_AUTODISCOVERY_PROJECTS, which is both the recognition gate and the variant classifier in a single pass. Pure and I/O-free.
 */
export function parseRatgdoService(service: MdnsService): Nullable<DiscoveredRatgdo> {

  const txt = txtEntries(service.txt);

  // One TXT field, as this plugin reads it, through the shared reading rule.
  const field = (key: RatgdoTxtKey): string | undefined => advertised(txt.get(key));

  /* Every field is read once into a local before the guard. TypeScript narrows a local through a truthiness check but never a repeated call, so the guard's
   * guarantee reaches the composer below only through these bindings.
   */
  const friendlyName = field("friendly_name");
  const mac = field("mac");
  const projectName = field("project_name");
  const projectVersion = field("project_version");
  const firmwareVersion = field("version") ?? field("esphome_version");

  const address = dialAddress(service.addresses);

  // Reject any service that is not a fully-formed ESPHome Ratgdo advertisement. project_name is folded into this guard so the composer's find() iterates a string
  // rather than a string-or-undefined.
  if(!firmwareVersion || !mac || !address || (projectName === undefined)) {

    return null;
  }

  return composeIdentity({ address, addresses: service.addresses, firmwareVersion, friendlyName, mac, projectName, projectVersion });
}
