/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * status-routes.ts: The status-protocol routes ratgdo's settings page and its UI server both address, defined once here for each of them to import.
 */

/* The single home for ratgdo's own additions to the shared status protocol. Both halves of the settings surface address the bridge through these constants: the page
 * running in the browser loads the copy the build places beside it, and the UI server running in the Config UI X child process loads the same module from the plugin's
 * build, so the page and the server read the same characters.
 *
 * The push-event name and the view route belong to homebridge-plugin-utils and are imported from the package root by both adapters, so what lives here is ratgdo's
 * own additions to the protocol and nothing else.
 */

// The onRequest route the warm extension registers. It carries the whole warm set - the sidebar's devices and the edited configuration, from which the pool resolves
// every key, name, and listed address - so the connection pool connects ahead of selection rather than waiting for the user to click a device.
export const STATUS_WARM_ROUTE = "/statusWarm";

// The onRequest route the address projection registers, beside the warm route. It carries no request body and answers with the feed's live discovery map: each
// discovered device's mac to the address the status connection dials, the same truth the identity strip renders. The address is ratgdo-owned identity data, so it
// travels this ratgdo route rather than the shared homebridge-plugin-utils push wire.
export const STATUS_ADDRESSES_ROUTE = "/statusAddresses";

// The onRequest route the Add Device card tests an address through. It carries one address and the key the user typed beside it, and answers what is there - or the
// classified reason nothing usable is. It stands apart from the warm route because a probe is a user's one deliberate act rather than the pool's own housekeeping:
// it opens a connection of its own, tells the card what answered, and closes it again without touching a single live session.
export const STATUS_PROBE_ROUTE = "/statusProbe";
