/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-ratgdo.
 */

// The platform the plugin creates.
export const PLATFORM_NAME = "Ratgdo";

// The name of our plugin.
export const PLUGIN_NAME = "homebridge-ratgdo";

// Duration, in seconds, of a motion sensor event.
export const RATGDO_MOTION_DURATION = 5;

// Default duration, in seconds, before triggering occupancy on an opener in the open state.
export const RATGDO_OCCUPANCY_DURATION = 300;

export const RATGDO_API_PORT = 18830;
