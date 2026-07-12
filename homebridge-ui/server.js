/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * server.js: homebridge-ratgdo webUI server API.
 */
import { featureOptionCategories, featureOptions } from "../dist/options.js";
import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";

class PluginUiServer extends HomebridgePluginUiServer {

  constructor() {

    super();

    // Register the /getOptions request handler with the Homebridge server API.
    this.onRequest("/getOptions", () => ({ categories: featureOptionCategories, options: featureOptions }));

    this.ready();
  }
}

// We construct the server at module load purely for its side effects: the constructor registers the request handler and calls ready(). The void operator marks the
// construction as a deliberate statement-position expression whose return value we intentionally discard.
void new PluginUiServer();
