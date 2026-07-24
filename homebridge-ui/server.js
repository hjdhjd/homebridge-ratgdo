/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * server.js: homebridge-ratgdo webUI server API.
 */
import { STATUS_ADDRESSES_ROUTE, STATUS_WARM_ROUTE, StatusFeed, narrowStatusWarmRequest } from "../dist/webui-status.js";
import { STATUS_EVENT, STATUS_VIEW_ROUTE, narrowStatusViewRequest } from "homebridge-plugin-utils";
import { featureOptionCategories, featureOptions } from "../dist/options.js";
import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";

// The adapter's process generation: an opaque per-process value whose only requirement is uniqueness across this plugin's helper processes, so a panel that outlived a
// helper restart can tell a fresh helper from the one it was talking to. The boot-time millisecond timestamp serves - the frontend compares generations by equality
// alone and claims no ordering.
const generation = Date.now();

class PluginUiServer extends HomebridgePluginUiServer {

  constructor() {

    super();

    /* The console-backed logging adapter the status feed and its connection layer log through. Config UI X captures the child process's console output into the
     * Homebridge UI log, prefixed by the plugin name, so a device-side connection diagnostic reaches the same place as the plugin's own logs. console is the sanctioned
     * logging transport at this boundary - HomebridgePluginUiServer exposes no logger - so no-console is disabled for the adapter.
     *
     * The debug channel is deliberately a no-op. The connection layer's wire-level diagnostics (per-frame decrypts, state updates, keepalive pings) log at debug and
     * would fill every user's UI log for as long as the settings panel sits open, and this child process has no debug switch to gate them behind. The panel itself is
     * the status surface; the log carries only what a user acts on - failures at error and warn, and connection lifecycle at info.
     */
    /* eslint-disable no-console */
    const log = {

      debug: () => {},
      error: (message, ...parameters) => console.error(message, ...parameters),
      info: (message, ...parameters) => console.info(message, ...parameters),
      warn: (message, ...parameters) => console.warn(message, ...parameters)
    };
    /* eslint-enable no-console */

    // One status feed for the lifetime of this custom-UI child process. push routes every status event to the iframe over the sanctioned plugin-ui-utils channel.
    const feed = new StatusFeed({ log, push: (payload) => this.pushEvent(STATUS_EVENT, payload) });

    // Start mDNS discovery immediately - it runs while the settings page is still in front of the user, so the first device selection resolves from a warm address map
    // instead of paying the discovery wait.
    feed.startDiscovery();

    // Register the /getOptions request handler with the Homebridge server API.
    this.onRequest("/getOptions", () => ({ categories: featureOptionCategories, options: featureOptions }));

    // Apply a warm set - every device the sidebar knows plus each device's effective encryption key. We narrow the untrusted body in the tested module and drop a
    // malformed body without dispatching. feed.warm is synchronous and total by the feed's contract, so we call it and return null; connection progress flows over push
    // events.
    this.onRequest(STATUS_WARM_ROUTE, (body) => {

      const request = narrowStatusWarmRequest(body);

      if(request === null) {

        return null;
      }

      feed.warm(request);

      return null;
    });

    // Switch the panel's view to one selected device. We narrow the untrusted body through the shared homebridge-plugin-utils narrowing and drop a malformed body without
    // dispatching. feed.view is synchronous and total by the feed's contract, so we call it and return null; the view result flows over push events.
    this.onRequest(STATUS_VIEW_ROUTE, (body) => {

      const request = narrowStatusViewRequest(body);

      if(request === null) {

        return null;
      }

      feed.view(request.serialNumber);

      return null;
    });

    // Answer the panel's address request with the feed's live discovery projection - each device's mac mapped to the address the status connection dials. As with the
    // /getOptions handler the request carries no body, so it needs no narrowing; feed.addresses() is a pure synchronous read, so we return its projection directly.
    this.onRequest(STATUS_ADDRESSES_ROUTE, () => feed.addresses());

    this.ready();

    // Introduce this fresh adapter process to any surviving panel: a hello carrying this process's generation lets a page that outlived a helper restart clear its stale
    // token floors and re-elicit its warm set. Delivery is advisory - it rides the same push relay every status event does, and the frontend's visibility belt covers a
    // hello lost to a restart's timing. Placed after ready() so the bridge channel is as established as the adapter can make it before the introduction goes out.
    this.pushEvent(STATUS_EVENT, { generation, kind: "hello" });
  }
}

// We construct the server at module load purely for its side effects: the constructor registers the request handlers and calls ready(). The void operator marks the
// construction as a deliberate statement-position expression whose return value we intentionally discard.
void new PluginUiServer();
