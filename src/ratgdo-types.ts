/* Copyright(C) 2020-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-types.ts: Interface and type definitions for Ratgdo.
 */

// Ratgdo device settings.
export interface RatgdoDevice {

  address: string,
  firmwareVersion: string,
  mac: string,
  name: string,
  variant: string
}

// Ratgdo reserved names.
export enum RatgdoReservedNames {

  // Manage our contact sensor types.
  CONTACT_DISCO_VEHICLE_ARRIVING = "ContactSensor.Disco.Vehicle.Arriving",
  CONTACT_DISCO_VEHICLE_LEAVING = "ContactSensor.Disco.Vehicle.Leaving",

  // Manage our dimmer types.
  DIMMER_OPENER_AUTOMATION = "Dimmer.Opener.Automation",

  // Ratgdo (ESP32) Disco-related capabilities.
  SWITCH_DISCO_LASER = "Switch.Disco.Laser",
  SWITCH_DISCO_LED = "Switch.Disco.Led",

  // Konnected-related capabilities.
  SWITCH_KONNECTED_PCW = "Switch.Konnected.PCW",
  SWITCH_KONNECTED_STROBE = "Switch.Konnected.Strobe",

  // Manage our occupancy sensor types.
  OCCUPANCY_DISCO_VEHICLE_PRESENCE = "OccupancySensor.Disco.Vehicle.Presence",
  OCCUPANCY_SENSOR_DOOR_OPEN = "OccupancySensor.DoorOpen",
  OCCUPANCY_SENSOR_MOTION = "OccupancySensor.Motion",

  // Manage our switch types.
  SWITCH_LOCKOUT = "Switch.Lockout",
  SWITCH_OPENER_AUTOMATION = "Switch.Opener.Automation"
}

// Ratgdo device variants.
export enum RatgdoVariant {

  KONNECTED = "konnected",
  RATGDO = "ratgdo"
}
