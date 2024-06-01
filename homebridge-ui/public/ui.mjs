/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge Ratgdo webUI.
 */

"use strict";

import { webUi } from "./lib/webUi.mjs";

// Parameters for our feature options webUI.
const featureOptionsParams = { hasControllers: false, sidebar: { deviceLabel: "Ratgdo Devices" } };

// Instantiate the webUI.
const ui = new webUi({ featureOptions: featureOptionsParams, name: "Ratgdo" });

// Display the webUI.
ui.show();
