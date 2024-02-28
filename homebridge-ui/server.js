/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * server.js: homebridge-ratgdo webUI server API.
 *
 * This module is heavily inspired by the homebridge-config-ui-x source code and borrows from both.
 * Thank you oznu for your contributions to the HomeKit world.
 */
"use strict";

import { featureOptionCategories, featureOptions, isOptionEnabled } from "../dist/ratgdo-options.js";
import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";
import util from "node:util";

class PluginUiServer extends HomebridgePluginUiServer {

  constructor () {
    super();

    // Register getOptions() with the Homebridge server API.
    this.#registerGetOptions();

    this.ready();
  }

  // Register the getOptions() webUI server API endpoint.
  #registerGetOptions() {

    // Return the list of options configured for a given Ratgdo device.
    this.onRequest("/getOptions", async(request) => {

      try {

        const optionSet = {};

        // Loop through all the feature option categories.
        for(const category of featureOptionCategories) {

          optionSet[category.name] = [];

          for(const options of featureOptions[category.name]) {

            options.value = isOptionEnabled(request.configOptions, request.ratgdoDevice, category.name + "." + options.name, options.default);
            optionSet[category.name].push(options);
          }
        }

        return { categories: featureOptionCategories, options: optionSet };

      } catch(err) {

        // Return nothing if we error out for some reason.
        return {};
      }
    });
  }
}

(() => new PluginUiServer())();
