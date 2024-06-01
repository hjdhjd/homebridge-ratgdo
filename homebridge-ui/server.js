/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * server.js: homebridge-ratgdo webUI server API.
 */
"use strict";

import { featureOptionCategories, featureOptions } from "../dist/ratgdo-options.js";
import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";

class PluginUiServer extends HomebridgePluginUiServer {

  constructor() {

    super();

    // Register getOptions() with the Homebridge server API.
    this.onRequest("/getOptions", () => ({ categories: featureOptionCategories, options: featureOptions }));

    this.ready();
  }
}

(() => new PluginUiServer())();
