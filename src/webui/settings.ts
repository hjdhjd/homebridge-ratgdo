/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: The platform name, the option names, and the durations the settings page and the plugin both read, defined once here for each of them to import.
 *
 * A value lives here rather than in the plugin's own settings module when the page needs it too. The page loads the copy the build places beside it, and the plugin
 * and the settings page's UI server load the same module from the plugin's build, so a name or a duration the two sides share is written once and cannot drift.
 */

// The platform name. The plugin registers its platform with Homebridge under it, and the settings page seeds an empty configuration's entry with it.
export const PLATFORM_NAME = "Ratgdo";

// The feature option a manually addressed device's address is listed under. The platform launches a loop for each address it lists, the status feed dials each one,
// and the Add Device card appends to it.
export const RATGDO_ADDRESS_OPTION = "Device.Address";

// The feature option the plugin's debug logging is set by, which the platform resolves and the legacy-settings migration moves the debug property into.
export const RATGDO_DEBUG_OPTION = "Log.Debug";

// The feature option an encryption key is stored under, globally or at a device's MAC. Every connection reads its key here, and the Add Device card writes one here.
export const RATGDO_ENCRYPTION_KEY_OPTION = "Device.Encryption.Key";

// Duration, in seconds, of a motion sensor event. The accessory clears its motion state after this long, and the settings panel's motion row clears back to its
// placeholder on the same duration.
export const RATGDO_MOTION_DURATION = 5;

// Duration, in seconds, the settings page's Add Device probe waits for a typed address to answer before it calls the attempt a timeout. A user who just typed an
// address is watching the card, so the budget is short enough to answer them promptly and long enough to cover a device waking on a busy network.
export const RATGDO_WEBUI_PROBE_TIMEOUT = 10;

/* The bound, in seconds, the settings page puts on one Test Connection round trip. It is derived from the server's own probe budget and sits above it, so what a slow
 * device produces is the server's classified answer - a timeout the card can explain - rather than the page's bound firing first and leaving the card to guess which of
 * the two happened. The margin is room for the server to settle its own attempt and relay the answer across the bridge.
 */
export const RATGDO_WEBUI_PAGE_PROBE_SECONDS = RATGDO_WEBUI_PROBE_TIMEOUT + 5;
