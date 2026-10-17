/* Copyright(C) 2020-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * types.ts: Interface and type definitions for Ratgdo.
 */

// Ratgdo device settings. The mac, name, and variant are written once at discovery time and never reassigned, so they carry readonly. Three fields stay mutable
// because the platform rewrites them after construction: address, once a reconnect to an advertised change has actually connected, and firmwareVersion and model,
// from the connected client's device info on every connect.
export interface RatgdoDevice {

  address: string;
  firmwareVersion: string;
  readonly mac: string;
  model?: string;
  readonly name: string;
  readonly variant: RatgdoVariant;
}

/* Ratgdo service identifiers. Core services use these as cache keys only. Subtyped services also pass these as HomeKit service subtypes. We model these as a
 * const-object plus a same-named string-literal union rather than a TypeScript enum because enums are non-erasable and do not compose well with the
 * "erasableSyntaxOnly" tsconfig flag. The call-site shape is identical to an enum (RatgdoService.GARAGE_DOOR resolves to "GarageDoor"), but the emitted JavaScript is
 * a plain object instead of a runtime IIFE. Keys are sorted alphabetically to satisfy sort-keys; the natural CATEGORY_* prefix on every name keeps related services
 * adjacent in the listing anyway.
 */
export const RatgdoService = {

  BATTERY: "Battery",
  CONTACT_DISCO_VEHICLE_ARRIVING: "ContactSensor.Disco.Vehicle.Arriving",
  CONTACT_DISCO_VEHICLE_LEAVING: "ContactSensor.Disco.Vehicle.Leaving",
  DIMMER_OPENER_AUTOMATION: "Dimmer.Opener.Automation",
  GARAGE_DOOR: "GarageDoor",
  LIGHT: "Light",
  MOTION_SENSOR: "MotionSensor",
  OCCUPANCY_DISCO_VEHICLE_PRESENCE: "OccupancySensor.Disco.Vehicle.Presence",
  OCCUPANCY_SENSOR_DOOR_OPEN: "OccupancySensor.DoorOpen",
  OCCUPANCY_SENSOR_MOTION: "OccupancySensor.Motion",
  SWITCH_DISCO_LASER: "Switch.Disco.Laser",
  SWITCH_DISCO_LED: "Switch.Disco.Led",
  SWITCH_KONNECTED_PCW: "Switch.Konnected.PCW",
  SWITCH_KONNECTED_STROBE: "Switch.Konnected.Strobe",
  SWITCH_LOCKOUT: "Switch.Lockout",
  SWITCH_OPENER_AUTOMATION: "Switch.Opener.Automation"
} as const;

export type RatgdoService = typeof RatgdoService[keyof typeof RatgdoService];

// Ratgdo device variants. Same const-object idiom as RatgdoService - see the rationale above.
export const RatgdoVariant = {

  KONNECTED: "konnected",
  RATGDO: "ratgdo"
} as const;

export type RatgdoVariant = typeof RatgdoVariant[keyof typeof RatgdoVariant];

/* The family word each variant's devices are known by. It is the word HomeKit's Model characteristic opens with, which device.ts composes from this table, and it is
 * also the heading the settings sidebar groups a device under - the page derives the group from the leading word of the Model it reads back. Declaring it once beside
 * the variant is what keeps those two readings one vocabulary: a variant added without a label fails to compile here rather than rendering an unlabelled group.
 */
export const RATGDO_VARIANT_LABELS = {

  konnected: "Konnected",
  ratgdo: "Ratgdo"
} as const satisfies Record<RatgdoVariant, string>;

/* Matched entry from RATGDO_AUTODISCOVERY_PROJECTS. The discovery boundary returns one of these whenever a TXT-advertised project_name matches a known pattern, so
 * the variant classification rides through the same .find() call that gates the device into the configuration path.
 */
export interface MdnsProject {

  readonly pattern: RegExp;
  readonly variant: RatgdoVariant;
}

/* Telemetry event payload dispatched into RatgdoAccessory.updateState(). The platform's protocol/telemetry translator maps each native ESPHome telemetry event into
 * this accessory-facing shape, so the device class consumes one stable contract and never sees the wire format. The snake_case current_operation mirrors the ESPHome
 * field name it carries across the boundary. The optional name and value fields are declared for completeness but are not currently populated by translateTelemetry or
 * read by updateState() - the active dispatch path uses only id, state, position, and current_operation.
 */
export interface EspHomeEvent {

  current_operation?: string;
  id: string;
  name?: string;
  position?: number;
  state: string;
  value?: string;
}
