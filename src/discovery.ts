/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * discovery.ts: Pure parsing and classification of a bonjour-service mDNS service into a recognized Ratgdo device identity.
 *
 * The platform's discovery callback fires for every mDNS service on the network. This module owns the pure wire-derivation half of that path: validate the TXT record,
 * classify the project_name against the known-variant registry, and normalize the MAC into the two representations downstream code needs. It returns null for any
 * service that is not a Ratgdo (or compatible variant) we configure. The platform-state half - UUID generation, the per-run dedup gates, the resolved log name - stays
 * in the platform because it depends on instance state (hap, feature options, the device maps). Keeping the wire-derivation here makes the validity guard, the project
 * classification, and the MAC regex unit-testable against arbitrary mDNS input without a live network or a Homebridge harness.
 */
import type { Nullable } from "homebridge-plugin-utils";
import { RATGDO_AUTODISCOVERY_PROJECTS } from "./settings.ts";
import type { RatgdoVariant } from "./types.ts";
import type { Service } from "bonjour-service";
import { parseMdnsTxt } from "./protocol/mdns.ts";

/* A recognized Ratgdo identity, derived entirely from the mDNS service's wire data - everything parseRatgdoService can determine without platform state. The platform
 * layers UUID generation, the dedup gates, and the resolved device name on top of this.
 *
 * @property address         - The device's first advertised IP address.
 * @property firmwareVersion - The device firmware version (txt.version, falling back to txt.esphome_version; the guard guarantees at least one is present).
 * @property friendlyName    - The mDNS-advertised friendly name, the fallback for the device's display name before the "Ratgdo" default.
 * @property macColon        - The uppercased colon-delimited MAC (AA:BB:...), the form HomeKit's UUID generator and the discovered-device dedup set consume.
 * @property model           - The advertised project version, used as the initial device model before the connected client's deviceInfo refreshes it.
 * @property strippedMac     - The bare-hex MAC (AABB...), the form device.mac, feature-option lookup keys, and MQTT topics consume.
 * @property variant         - The device variant the matched project pattern classifies this device as.
 */
export interface DiscoveredRatgdo {

  readonly address: string;
  readonly firmwareVersion: string;
  readonly friendlyName: string | undefined;
  readonly macColon: string;
  readonly model: string | undefined;
  readonly strippedMac: string;
  readonly variant: RatgdoVariant;
}

/* Parse and classify a bonjour-service mDNS service into a recognized Ratgdo identity, or null when the service is not a device we configure. The validity guard
 * requires a parseable TXT record carrying a version (esphome_version or version), a MAC, a first IP address, and a project_name; the classification step matches that
 * project_name against RATGDO_AUTODISCOVERY_PROJECTS, which is both the recognition gate and the variant classifier in a single pass. Pure and I/O-free.
 */
export function parseRatgdoService(service: Service): Nullable<DiscoveredRatgdo> {

  const txt = parseMdnsTxt(service.txt);

  // We grab the first address the device advertised. With noUncheckedIndexedAccess on, this read is what surfaces the empty-addresses case to the type-checker.
  const address = service.addresses?.[0];

  // Reject any service that is not a fully-formed ESPHome Ratgdo advertisement. project_name is folded into this guard so the subsequent find() iterates a string
  // rather than a string-or-undefined, and the firmware-version fallback below is guaranteed at least one of esphome_version / version (so its "0.0.0" default is a
  // type-completing safety net, not a reachable runtime path).
  if(!txt || (!txt.esphome_version && !txt.version) || !txt.mac || !address || (txt.project_name === undefined)) {

    return null;
  }

  /* Single-pass filter-and-classify. RATGDO_AUTODISCOVERY_PROJECTS maps each project-name pattern to the device variant it identifies, so a successful match is both
   * the discovery gate (we recognize this device) and the classifier (we know what variant to construct). An unmatched project_name is some other ESPHome device, and
   * keeping the pattern and the variant adjacent in the registry means adding a variant is a single-line edit there rather than a coordinated change at two sites.
   */
  const projectName = txt.project_name;
  const project = RATGDO_AUTODISCOVERY_PROJECTS.find((entry) => entry.pattern.test(projectName));

  if(!project) {

    return null;
  }

  // Two MAC representations: macColon is the uppercased colon-delimited form HomeKit's UUID generator and the discovered-device dedup set use; strippedMac is the
  // bare-hex form everything downstream consumes (device.mac, feature-option lookup keys, MQTT topics). The (?=.) lookahead inserts a colon after every pair except the
  // final one, so AABBCCDDEEFF becomes AA:BB:CC:DD:EE:FF with no trailing colon.
  const macColon = txt.mac.toUpperCase().replace(/(.{2})(?=.)/g, "$1:");

  return {

    address: address,
    firmwareVersion: txt.version ?? txt.esphome_version ?? "0.0.0",
    friendlyName: txt.friendly_name,
    macColon: macColon,
    model: txt.project_version,
    strippedMac: macColon.replace(/:/g, ""),
    variant: project.variant
  };
}
