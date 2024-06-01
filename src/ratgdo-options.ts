/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-options.ts: Feature option and type definitions for Ratgdo.
 */
import { FeatureOptionEntry } from "homebridge-plugin-utils";
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
  { description: "Opener feature options.", name: "Opener" },
  { description: "Opener light feature options.", name: "Light" },
  { description: "Opener motion feature options.", name: "Motion" }
];

/* eslint-disable @stylistic/max-len */
// Individual feature options, broken out by category.
export const featureOptions: { [index: string]: FeatureOptionEntry[] } = {

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" }
  ],

  // Light options.
  "Light": [

    { default: true, description: "Make the light on the opener available in HomeKit.", name: "" }
  ],

  // Motion options.
  "Motion": [

    { default: true, description: "Make the motion sensor on the opener available in HomeKit.", name: "" },
    { default: false, description: "Add an occupancy sensor accessory using motion sensor activity to determine occupancy.", name: "OccupancySensor" },
    { default: false, defaultValue: RATGDO_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait without receiving a motion event to determine when occupancy is no longer detected.", group: "OccupancySensor", name: "OccupancySensor.Duration" }
  ],

  // Opener options.
  "Opener": [

    { default: false, description: "Make this opener read-only by ignoring open and close requests from HomeKit.", name: "ReadOnly" },
    { default: false, description: "Add a dimmer accessory to control the opener. This can be useful in automation scenarios where you want to set the door to a specific percentage.", name: "Dimmer" },
    { default: false, description: "Add a switch accessory to control the opener. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling garage door openers.", name: "Switch" },
    { default: false, description: "Add an occupancy sensor accessory using the open state of the opener to determine occupancy. This can be useful in automation scenarios where you want to trigger an action based on the opener being open for an extended period of time.", name: "OccupancySensor" },
    { default: false, defaultValue: RATGDO_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait once the opener has reached the open state before indicating occupancy.", group: "OccupancySensor", name: "OccupancySensor.Duration" },
    { default: false, description: "Add a switch accessory to control the wireless remote lockout feature (if present) on your opener. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling the lock state of garage door openers.", name: "Switch.RemoteLockout" }
  ]
};
/* eslint-enable @stylistic/max-len */
