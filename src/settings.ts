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

/* Recognized ESPHome project-name patterns and the device variant each one identifies. Filtering and classification are the same operation: discovery iterates this
 * list once with `Array.find`, returning both the gate (the device is one of ours) and the classifier (which variant it is) in a single pass. Keeping the pattern
 * and the variant adjacent here means a future variant addition is a one-line edit instead of a coordinated change at the filter site plus the classifier site.
 */
export const RATGDO_AUTODISCOVERY_PROJECTS: readonly MdnsProject[] = [

  { pattern: /^ratgdo\..*$/i, variant: RatgdoVariant.RATGDO },
  { pattern: /^konnected\.garage-door-gdov2.*$/i, variant: RatgdoVariant.KONNECTED }
];

// Duration, in seconds, to wait for the ESPHome client's LatestStateCache to populate with initial state for every stateful entity. ESPHome pushes a state event
// per entity in response to the SUBSCRIBE_STATES_REQUEST that ends the handshake; the burst typically completes within tens of milliseconds on a healthy LAN. This is
// the safety net for slow devices and pathological networks: if the budget elapses, the discovery attempt fails and the next mDNS refresh retries. Construction of
// RatgdoAccessory is gated on a complete snapshot so the accessory is born with real state rather than placeholder defaults.
export const RATGDO_INITIAL_STATE_TIMEOUT = 5;

// Duration, in seconds, that the Konnected pre-close warning switch stays "on" before auto-reverting. The switch is a momentary control: the warning audio plays for
// this long, then the HomeKit toggle flips back to off so the user can trigger it again. Matches the audio length the Konnected firmware emits.
export const RATGDO_KONNECTED_PCW_DURATION = 5;

// Duration, in seconds, between connect attempts against a listed device address that has not answered. This is the family's cadence: the PowerView plugin retries
// its manually configured gateways once per discovery cycle, POWERVIEW_DISCOVERY_INTERVAL, which is this same five minutes. A listed address is a device the user
// says is there, so the retry is patient by design - it covers a device that is powered down, rebooting, or briefly off the network, and a user who wants an answer
// now reaches for the settings page's own connection test rather than waiting on this.
export const RATGDO_MANUAL_RETRY_INTERVAL = 300;

// The DNS-SD service type every ESPHome device advertises under, spelled as the fully qualified type name the library's browser takes. Both discovery consumers -
// the platform and the webUI status feed - browse this one type, so the spelling lives here rather than in either of them.
export const RATGDO_MDNS_SERVICE_TYPE = "_esphomelib._tcp.local";

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

// Duration, in seconds, of the per-device budget between a mac entering the webUI status warm set and its mDNS discovery. When the budget elapses with the device still
// undiscovered, the pool classifies that device not-found and surfaces the verdict to the panel. The settings modal is a foreground, user-initiated context, so a bounded
// wait keeps the panel responsive rather than waiting indefinitely on a device that is powered down or off the network.
export const RATGDO_WEBUI_DISCOVERY_TIMEOUT = 10;

// Duration, in seconds, the settings page's Add Device probe waits for a typed address to answer before it calls the attempt a timeout. A user who just typed an
// address is watching the card, so the budget is short enough to answer them promptly and long enough to cover a device waking on a busy network. The page arms a
// longer bound of its own around the request, so what a slow device produces is this classified answer rather than the browser giving up first.
export const RATGDO_WEBUI_PROBE_TIMEOUT = 10;
