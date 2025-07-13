/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-ratgdo.
 */

// The platform the plugin creates.
export const PLATFORM_NAME = "Ratgdo";

// The name of our plugin.
export const PLUGIN_NAME = "homebridge-ratgdo";

// Duration, in seconds, to wait for a response from the ESPHome API. ESPHome will ping us about every 60 seconds or so by default, so we set this sufficiently high to
// account for dead connections.
export const RATGDO_API_HEARTBEAT_DURATION = 100;

// Interval, in seconds, to initiate mDNS discovery requests for new Ratgdo devices.
export const RATGDO_AUTODISCOVERY_INTERVAL = 10;

// mDNS TXT record project name associated with a Ratgdo device.
export const RATGDO_AUTODISCOVERY_PROJECT_NAMES: RegExp[] = [ /^ratgdo\.esphome$/i, /^konnected.garage-door-gdov2.*$/i ];

// mDNS service types associated with a Ratgdo device.
export const RATGDO_AUTODISCOVERY_TYPES = [ "esphomelib" ];

// Duration, in seconds, of a motion sensor event.
export const RATGDO_MOTION_DURATION = 5;

// Default MQTT topic to use when publishing events. This is in the form of: ratgdo/device/event
export const RATGDO_MQTT_TOPIC = "ratgdo";

// Default duration, in seconds, before triggering occupancy on an opener in the open state.
export const RATGDO_OCCUPANCY_DURATION = 300;

// Duration, in seconds, of our door state transition safety timer. This should be long enough that any reasonable state change message from Ratgdo would have had ample
// time to be delivered, but short enough to provide that responsive feeling to an end user.
export const RATGDO_TRANSITION_DURATION = 25;

