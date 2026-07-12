/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-ratgdo.
 */
import type { MdnsProject } from "./types.ts";
import { RatgdoVariant } from "./types.ts";

// The platform the plugin creates.
export const PLATFORM_NAME = "Ratgdo";

// The name of our plugin.
export const PLUGIN_NAME = "homebridge-ratgdo";

// Interval, in seconds, to initiate mDNS discovery requests for new Ratgdo devices.
export const RATGDO_AUTODISCOVERY_INTERVAL = 10;

/* Recognized ESPHome project-name patterns and the device variant each one identifies. Filtering and classification are the same operation: discovery iterates this
 * list once with `Array.find`, returning both the gate (the device is one of ours) and the classifier (which variant it is) in a single pass. Keeping the pattern
 * and the variant adjacent here means a future variant addition is a one-line edit instead of a coordinated change at the filter site plus the classifier site.
 */
export const RATGDO_AUTODISCOVERY_PROJECTS: readonly MdnsProject[] = [

  { pattern: /^ratgdo\..*$/i, variant: RatgdoVariant.RATGDO },
  { pattern: /^konnected\.garage-door-gdov2.*$/i, variant: RatgdoVariant.KONNECTED }
];

// mDNS service types associated with a Ratgdo device.
export const RATGDO_AUTODISCOVERY_TYPES = ["esphomelib"];

/* Cumulative seconds, measured from the start of `runDiscoverySchedule()`, at which mDNS queries fire during the bootstrap-discovery window. The doubling pattern
 * follows RFC 6762 §5.2: an initial query at t=0 followed by a doubling-backoff burst of follow-ups (the schedule below) catches devices whose mDNS responders
 * missed the first packet, before the schedule settles to the steady-state interval. After the last warmup query lands, the schedule transitions to the steady-state
 * `RATGDO_AUTODISCOVERY_INTERVAL` for the rest of the platform's lifetime. This list is the single source of truth for every query the bootstrap phase fires -
 * `configureRatgdo()` does not call `update()` directly.
 */
export const RATGDO_AUTODISCOVERY_WARMUP_OFFSETS: readonly number[] = [ 0, 1, 2, 4, 8 ];

// Duration, in seconds, to wait for the ESPHome client's LatestStateCache to populate with initial state for every stateful entity. ESPHome pushes a state event
// per entity in response to the SUBSCRIBE_STATES_REQUEST that ends the handshake; the burst typically completes within tens of milliseconds on a healthy LAN. This is
// the safety net for slow devices and pathological networks: if the budget elapses, the discovery attempt fails and the next mDNS refresh retries. Construction of
// RatgdoAccessory is gated on a complete snapshot so the accessory is born with real state rather than placeholder defaults.
export const RATGDO_INITIAL_STATE_TIMEOUT = 5;

// Duration, in seconds, that the Konnected pre-close warning switch stays "on" before auto-reverting. The switch is a momentary control: the warning audio plays for
// this long, then the HomeKit toggle flips back to off so the user can trigger it again. Matches the audio length the Konnected firmware emits.
export const RATGDO_KONNECTED_PCW_DURATION = 5;

// Duration, in seconds, of a motion sensor event.
export const RATGDO_MOTION_DURATION = 5;

// Default MQTT topic to use when publishing events. The published topic is of the form ratgdo/<mac>/<event>, where <mac> is the device's colon-free MAC address.
export const RATGDO_MQTT_TOPIC = "ratgdo";

// Default duration, in seconds, before triggering occupancy on an opener in the open state.
export const RATGDO_OCCUPANCY_DURATION = 300;

// Delay, in milliseconds, before reverting a HomeKit characteristic after a failed onSet. HomeKit drops characteristic updates issued synchronously inside an onSet
// handler, so the revert must defer past the current tick. 50ms is the empirically-chosen budget: short enough to feel instantaneous, long enough to clear HomeKit's
// onSet acknowledgment.
export const RATGDO_UI_REVERT_DELAY = 50;

