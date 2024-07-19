/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-ratgdo.
 */
import { RatgdoVariant } from "./ratgdo-types.js";

// The platform the plugin creates.
export const PLATFORM_NAME = "Ratgdo";

// The name of our plugin.
export const PLUGIN_NAME = "homebridge-ratgdo";

// Interval, in seconds, to initiate mDNS discovery requests for new Ratgdo devices.
export const RATGDO_AUTODISCOVERY_INTERVAL = 60;

// mDNS TXT record project name associated with a Ratgdo device.
export const RATGDO_AUTODISCOVERY_PROJECT_NAMES: string[] = [ RatgdoVariant.KONNECTED, RatgdoVariant.RATGDO ];

// mDNS service types associated with a Ratgdo device.
export const RATGDO_AUTODISCOVERY_TYPES = [ "esphomelib", "konnected" ];

// Duration, in seconds, for a single heartbeat to ensure the Ratgdo doesn't autoreboot.
export const RATGDO_HEARTBEAT_DURATION = 120;

// Interval, in seconds, for heartbeat requests to ensure the Ratgdo doesn't autoreboot.
export const RATGDO_HEARTBEAT_INTERVAL = 300;

// Duration, in seconds, of a motion sensor event.
export const RATGDO_MOTION_DURATION = 5;

// How often, in seconds, should we try to reconnect with an MQTT broker, if we have one configured.
export const RATGDO_MQTT_RECONNECT_INTERVAL = 60;

// Default MQTT topic to use when publishing events. This is in the form of: ratgdo/device/event
export const RATGDO_MQTT_TOPIC = "ratgdo";

// Default duration, in seconds, before triggering occupancy on an opener in the open state.
export const RATGDO_OCCUPANCY_DURATION = 300;

// Duration, in seconds, of our door state transition safety timer. This should be long enough that any reasonable state change message from Ratgdo would have had ample
// time to be delivered, but short enough to provide that responsive feeling to an end user.
export const RATGDO_TRANSITION_DURATION = 25;

