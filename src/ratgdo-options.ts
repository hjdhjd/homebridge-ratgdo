/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-options.ts: Feature option and type definitions for Ratgdo.
 */
import type { FeatureOptionEntry } from "homebridge-plugin-utils";
import { RATGDO_OCCUPANCY_DURATION } from "./settings.js";

// Plugin configuration options.
export type RatgdoOptions = Partial<{

  debug: boolean,
  mqttTopic: string,
  mqttUrl: string,
  options: string[]
}>;

// Feature option categories.
export const featureOptionCategories = [

  { description: "Device feature options.", name: "Device" },
  { description: "Logging feature options.", name: "Log" },
  { description: "Opener feature options.", name: "Opener" },
  { description: "Opener light feature options.", name: "Light" },
  { description: "Opener motion feature options.", name: "Motion" },
  { description: "Ratgdo (ESP32) Disco device-specific feature options.", name: "Disco" },
  { description: "Konnected device-specific feature options.", name: "Konnected" }
];

/* eslint-disable @stylistic/max-len */
// Individual feature options, broken out by category.
export const featureOptions: { [index: string]: FeatureOptionEntry[] } = {

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" }
  ],

  // Ratgdo ESP32 Disco options.
  "Disco": [

    { default: false, description: "Show the state of the backup battery in HomeKit. This requires ensuring the Ratgdo (ESP32) Disco is connected directly to the backup battery.", name: "Battery" },
    { default: false, description: "Add an occupancy sensor accessory for vehicle presence detection.", name: "OccupancySensor.Vehicle.Presence" },
    { default: false, description: "Add a contact sensor accessory for vehicle arrival.", name: "ContactSensor.Vehicle.Arriving" },
    { default: false, description: "Add a contact sensor accessory for vehicle departure.", name: "ContactSensor.Vehicle.Leaving" },
    { default: false, description: "Add a switch accessory to control the park assistance laser feature.", name: "Switch.laser" },
    { default: false, description: "Add a switch accessory to control the LED setting.", name: "Switch.led" }
  ],

  // Konnected options.
  "Konnected": [

    { default: false, description: "Add a switch accessory to control the pre-close warning feature on Konnected openers. This can be useful in automation scenarios.", name: "Switch.PCW" },
    { default: false, description: "Add a switch accessory to control the strobe setting on Konnected openers.", name: "Switch.Strobe" }
  ],

  // Light options.
  "Light": [

    { default: true, description: "Make the light on the opener available in HomeKit.", name: "" }
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log opener events in Homebridge.", name: "Opener" },
    { default: true, description: "Log light events in Homebridge.", name: "Light" },
    { default: true, description: "Log motion-related events in Homebridge.", name: "Motion" },
    { default: true, description: "Log obstruction events in Homebridge.", name: "Obstruction" },
    { default: true, description: "Log vehicle presence-related events in Homebridge. This is only valid on Ratgdo (ESP32) Disco openers.", name: "VehiclePresence" }
  ],

  // Motion options.
  "Motion": [

    { default: true, description: "Make the motion sensor on the opener available in HomeKit.", name: "" },
    { default: false, description: "Add an occupancy sensor accessory using motion sensor activity to determine occupancy.", name: "OccupancySensor" },
    { default: true, defaultValue: RATGDO_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait without receiving a motion event to determine when occupancy is no longer detected.", group: "OccupancySensor", name: "OccupancySensor.Duration" }
  ],

  // Opener options.
  "Opener": [

    { default: true, description: "Make the wireless remote lock on the opener available in HomeKit.", name: "Lock" },
    { default: false, description: "Make this opener read-only by ignoring open and close requests from HomeKit.", name: "ReadOnly" },
    { default: false, description: "Add a dimmer accessory to control the opener. This can be useful in automation scenarios where you want to set the door to a specific percentage.", name: "Dimmer" },
    { default: false, description: "Add a switch accessory to control the opener. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling garage door openers.", name: "Switch" },
    { default: false, description: "Add an occupancy sensor accessory using the open state of the opener to determine occupancy. This can be useful in automation scenarios where you want to trigger an action based on the opener being open for an extended period of time.", name: "OccupancySensor" },
    { default: true, defaultValue: RATGDO_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait once the opener has reached the open state before indicating occupancy.", group: "OccupancySensor", name: "OccupancySensor.Duration" },
    { default: false, description: "Add a switch accessory to control the wireless remote lockout feature (if present) on your opener. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling the lock state of garage door openers.", name: "Switch.RemoteLockout" }
  ]
};
/* eslint-enable @stylistic/max-len */
