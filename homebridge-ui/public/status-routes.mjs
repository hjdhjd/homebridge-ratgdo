/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * status-routes.mjs: The status-protocol routes ratgdo's settings page and its UI server both address.
 */

/* The single home for ratgdo's own additions to the shared status protocol. Both halves of the settings surface address the bridge through these constants: the page
 * running in the browser and the UI server running in the Config UI X child process. This directory is the one place both halves can read a constant from - Config UI X
 * serves it to the page as static files, and the package ships it to Node alongside the server - while dist/ is a Node-only build output the browser is never served,
 * so a route declared there could only reach the page as a copied literal. Declaring the routes here instead makes the page and the server read the same characters.
 *
 * The push-event name and the view route belong to homebridge-plugin-utils and are imported from the package root by both adapters, so only ratgdo's own two routes
 * live here.
 */

// The onRequest route the warm extension registers. It carries the whole warm set - every device the sidebar knows plus that device's effective encryption key - so
// the connection pool connects ahead of selection rather than waiting for the user to click a device.
export const STATUS_WARM_ROUTE = "/statusWarm";

// The onRequest route the address projection registers, beside the warm route. It carries no request body and answers with the feed's live discovery map: each
// discovered device's mac to the address the status connection dials, the same truth the identity strip renders. The address is ratgdo-owned identity data, so it
// travels this ratgdo route rather than the shared homebridge-plugin-utils push wire.
export const STATUS_ADDRESSES_ROUTE = "/statusAddresses";
