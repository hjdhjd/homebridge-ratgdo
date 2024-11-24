/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge Ratgdo webUI.
 */

"use strict";

import { webUi } from "./lib/webUi.mjs";

// Show the details for this device.
const showRatgdoDetails = (device) => {

  // No device specified, we must be in a global context.
  if(!device) {

    document.getElementById("device_model").innerHTML = "N/A";
    document.getElementById("device_mac").innerHTML = "N/A";
    document.getElementById("device_firmware").innerHTML = "N/A";

    return;
  }

  // Populate the device details.
  document.getElementById("device_model").innerHTML = device.model;
  document.getElementById("device_mac").innerHTML = device.serialNumber;
  document.getElementById("device_firmware").innerHTML = device.firmwareRevision;
};

// Parameters for our feature options webUI.
const featureOptionsParams = { hasControllers: false, infoPanel: showRatgdoDetails, sidebar: { deviceLabel: "Ratgdo Devices" } };

// Instantiate the webUI.
const ui = new webUi({ featureOptions: featureOptionsParams, name: "Ratgdo" });

// Display the webUI.
ui.show();
