/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-options.ts: Feature option and type definitions for Ratgdo.
 */
import { RATGDO_OCCUPANCY_DURATION } from "./settings.js";
import { RatgdoDevice } from "./ratgdo-types.js";

// Plugin configuration options.
export interface RatgdoOptions {

  debug: boolean,
  mqttTopic: string,
  mqttUrl: string,
  options: string[],
  port: number
}

// Feature option categories.
export const featureOptionCategories = [

  { description: "Device feature options.", name: "Device", validFor: [ "all" ] },
  { description: "Opener feature options.", name: "Opener", validFor: [ "opener" ] },
  { description: "Opener light feature options.", name: "Light", validFor: [ "opener" ] },
  { description: "Opener motion feature options.", name: "Motion", validFor: [ "opener" ] }
];

/* eslint-disable @stylistic/max-len */
// Individual feature options, broken out by category.
export const featureOptions: { [index: string]: FeatureOption[] } = {

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" },
    { default: false, description: "Synchronize the Ratgdo name of this device with HomeKit. Synchronization is one-way only, syncing the device name from Ratgdo to HomeKit.", name: "SyncName" }
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
    { default: false, description: "Add a switch accessory to control the opener. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling garage door openers.", name: "Switch" },
    { default: false, description: "Add an occupancy sensor accessory using the open state of the opener to determine occupancy. This can be useful in automation scenarios where you want to trigger an action based on the opener being open for an extended period of time.", name: "OccupancySensor" },
    { default: false, defaultValue: RATGDO_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait once the opener has reached the open state before indicating occupancy.", group: "OccupancySensor", name: "OccupancySensor.Duration" }
  ]
};
/* eslint-enable @stylistic/max-len */

export interface FeatureOption {

  default: boolean,           // Default feature option state.
  defaultValue?: number,      // Default value for value-based feature options.
  description: string,        // Description of the feature option.
  group?: string,             // Feature option grouping for related options.
  name: string                // Name of the feature option.
}

// Utility function to let us know whether a feature option should be enabled or not, traversing the scope hierarchy.
export function isOptionEnabled(configOptions: string[], device: RatgdoDevice | null, option = "", defaultReturnValue = true): boolean {

  // Nothing configured - we assume the default return value.
  if(!configOptions.length) {

    return defaultReturnValue;
  }

  const isOptionSet = (checkOption: string, checkMac: string | undefined = undefined): boolean | undefined => {

    // This regular expression is a bit more intricate than you might think it should be due to the need to ensure we capture values at the very end of the option.
    const optionRegex = new RegExp("^(Enable|Disable)\\." + checkOption + (!checkMac ? "" : "\\." + checkMac) + "$", "gi");

    // Get the option value, if we have one.
    for(const entry of configOptions) {

      const regexMatch = optionRegex.exec(entry);

      if(regexMatch) {

        return regexMatch[1].toLowerCase() === "enable";
      }
    }

    return undefined;
  };

  // Check to see if we have a device-level option first.
  if(device?.mac) {

    const value = isOptionSet(option, device.mac);

    if(value !== undefined) {

      return value;
    }
  }

  // Finally, we check for a global-level value.
  const value = isOptionSet(option);

  if(value !== undefined) {

    return value;
  }

  // The option hasn't been set at any scope, return our default value.
  return defaultReturnValue;
}

// Utility function to return a value-based feature option for a Ratgdo device.
export function getOptionValue(configOptions: string[], device: RatgdoDevice | null, option: string): string | undefined {

  // Nothing configured - we assume there's nothing.
  if(!configOptions.length || !option) {

    return undefined;
  }

  const getValue = (checkOption: string, checkMac: string | undefined = undefined): string | undefined => {

    // This regular expression is a bit more intricate than you might think it should be due to the need to ensure we capture values at the very end of the option.
    const optionRegex = new RegExp("^Enable\\." + checkOption + (!checkMac ? "" : "\\." + checkMac) + "\\.([^\\.]+)$", "gi");

    // Get the option value, if we have one.
    for(const entry of configOptions) {

      const regexMatch = optionRegex.exec(entry);

      if(regexMatch) {

        return regexMatch[1];
      }
    }

    return undefined;
  };

  // Check to see if we have a device-level value first.
  if(device?.mac) {

    const value = getValue(option, device.mac);

    if(value) {

      return value;
    }
  }

  // Finally, we check for a global-level value.
  return getValue(option);
}

// Utility function to parse and return a numeric configuration parameter.
function parseOptionNumeric(optionValue: string | undefined, convert: (value: string) => number): number | undefined {

  // We don't have the option configured -- we're done.
  if(optionValue === undefined) {

    return undefined;
  }

  // Convert it to a number, if needed.
  const convertedValue = convert(optionValue);

  // Let's validate to make sure it's really a number.
  if(isNaN(convertedValue) || (convertedValue < 0)) {

    return undefined;
  }

  // Return the value.
  return convertedValue;
}

// Utility function to return a floating point configuration parameter.
export function getOptionFloat(optionValue: string | undefined): number | undefined {

  return parseOptionNumeric(optionValue, (value: string) => {

    return parseFloat(value);
  });
}

// Utility function to return an integer configuration parameter on a device.
export function getOptionNumber(optionValue: string | undefined): number | undefined {

  return parseOptionNumeric(optionValue, (value: string) => {

    return parseInt(value);
  });
}
