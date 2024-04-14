/* Copyright(C) 2020-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-types.ts: Interface and type definitions for Ratgdo.
 */

export enum Firmware {

  ESPHOME = 1,
  MQTT
}

// Ratgdo device settings.
export interface RatgdoDevice {

  address: string,
  firmwareVersion: string,
  mac: string,
  name: string,
  type: Firmware
}

// Define Ratgdo logging conventions.
export interface RatgdoLogging {

  debug: (message: string, ...parameters: unknown[]) => void,
  error: (message: string, ...parameters: unknown[]) => void,
  info: (message: string, ...parameters: unknown[]) => void,
  warn: (message: string, ...parameters: unknown[]) => void
}

// Ratgdo reserved names.
export enum RatgdoReservedNames {

  // Manage our dimmer types.
  DIMMER_OPENER_AUTOMATION = "Dimmer.Opener.Automation",

  // Manage our occupancy sensor types.
  OCCUPANCY_SENSOR_DOOR_OPEN = "OccupancySensor.DoorOpen",
  OCCUPANCY_SENSOR_MOTION = "OccupancySensor.Motion",

  // Manage our switch types.
  SWITCH_OPENER_AUTOMATION = "Switch.Opener.Automation"
}
