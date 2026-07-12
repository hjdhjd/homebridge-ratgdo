/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.ts: Feature option and type definitions for Ratgdo.
 */
import type { FeatureOptionEntry } from "homebridge-plugin-utils";
import type { PlatformConfig } from "homebridge";
import { RATGDO_OCCUPANCY_DURATION } from "./settings.ts";

// Plugin configuration options.
export type RatgdoOptions = Partial<{

  debug: boolean;
  mqttTopic: string;
  mqttUrl: string;
  options: string[];
}>;

/* Normalize a Homebridge PlatformConfig into a typed RatgdoOptions. Homebridge passes plugin config through an open index-signature shape sourced from user JSON, so
 * without this boundary narrowing every consumer has to reach in with bracket notation - and downstream code would silently accept whatever shape the user supplied.
 * We perform the typeof-narrowing reads once here so the rest of the codebase consumes a typed result that actually reflects runtime guarantees, not just assertions.
 */
export function normalizeConfig(config: PlatformConfig | undefined): RatgdoOptions {

  if(!config) {

    return {};
  }

  // PlatformConfig has an index signature typed as `any`, which would silently propagate `any` through the rest of the function. We re-read each field as `unknown`
  // so the typeof / Array.isArray guards below are forced to do real narrowing rather than rubber-stamping a type assertion.
  const mqttTopic: unknown = config["mqttTopic"];
  const mqttUrl: unknown = config["mqttUrl"];
  const options: unknown = config["options"];

  return {

    debug: config["debug"] === true,
    mqttTopic: (typeof mqttTopic === "string") ? mqttTopic : undefined,
    mqttUrl: (typeof mqttUrl === "string") ? mqttUrl : undefined,
    options: (Array.isArray(options) && options.every((entry): entry is string => typeof entry === "string")) ? options : undefined
  };
}

// Feature option categories.
export const featureOptionCategories = [

  { description: "Device", name: "Device" },
  { description: "Logging", name: "Log" },
  { description: "Opener", name: "Opener" },
  { description: "Opener light", name: "Light" },
  { description: "Opener motion", name: "Motion" },
  { description: "Ratgdo (ESP32) Disco device-specific", name: "Disco" },
  { description: "Konnected device-specific", name: "Konnected" }
];

/* eslint-disable @stylistic/max-len */
// Individual feature options, broken out by category.
export const featureOptions: Record<string, FeatureOptionEntry[]> = {

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" },
    { default: false, defaultValue: "", description: "Name to use for logging purposes. Defaults to the name the Ratgdo device advertises.", inputSize: 15, name: "LogName" },
    { default: false, defaultValue: "", description: "Base64-encoded encryption key to use for the ESPHome API as specified in your YAML configuration.", inputSize: 44, name: "Encryption.Key" }
  ],

  // Ratgdo ESP32 Disco options.
  "Disco": [

    { default: false, description: "Show the state of the backup battery in HomeKit. This requires ensuring the Ratgdo (ESP32) Disco is connected directly to the backup battery.", name: "Battery" },
    { default: false, description: "Add an occupancy sensor accessory for vehicle presence detection.", name: "OccupancySensor.Vehicle.Presence" },
    { default: false, description: "Add a contact sensor accessory for vehicle arrival.", name: "ContactSensor.Vehicle.Arriving" },
    { default: false, description: "Add a contact sensor accessory for vehicle departure.", name: "ContactSensor.Vehicle.Leaving" },
    { default: false, description: "Add a switch accessory to control the park assistance laser feature.", name: "Switch.Laser" },
    { default: false, description: "Add a switch accessory to control the LED setting.", name: "Switch.Led" }
  ],

  // Konnected options.
  "Konnected": [

    { default: false, description: "Add a switch accessory to control the pre-close warning feature on Konnected openers. This can be useful in automation scenarios.", name: "Switch.Pcw" },
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
