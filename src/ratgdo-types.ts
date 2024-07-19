/* Copyright(C) 2020-2024, HJD (https://github.com/hjdhjd). All rights reserved.
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

  // Manage our dimmer types.
  DIMMER_OPENER_AUTOMATION = "Dimmer.Opener.Automation",

  // Manage our occupancy sensor types.
  OCCUPANCY_SENSOR_DOOR_OPEN = "OccupancySensor.DoorOpen",
  OCCUPANCY_SENSOR_MOTION = "OccupancySensor.Motion",

  // Manage our switch types.
  SWITCH_LOCKOUT = "Switch.Lockout",
  SWITCH_OPENER_AUTOMATION = "Switch.Opener.Automation"
}

// Ratgdo device variants.
export enum RatgdoVariant {

  KONNECTED = "konnected.garage-door-gdov2-q",
  RATGDO = "ratgdo.esphome"
}
