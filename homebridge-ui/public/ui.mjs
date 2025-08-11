/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge Ratgdo webUI.
 */

"use strict";

import { webUi } from "./lib/webUi.mjs";

// Show the details for this device.
const showRatgdoDetails = (device) => {

  const deviceStatsContainer = document.getElementById("deviceStatsContainer");

  // No device specified, we must be in a global context.
  if(!device) {

    deviceStatsContainer.textContent = "";

    return;
  }

  // Populate the device details.
  deviceStatsContainer.innerHTML =
    "<div class=\"device-stats-grid\">" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">Model</span>" +
        "<span class=\"stat-value\">" + device.model + "</span>" +
      "</div>" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">MAC Address</span>" +
        "<span class=\"stat-value font-monospace\">" + device.serialNumber + "</span>" +
      "</div>" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">Firmware</span>" +
        "<span class=\"stat-value\">" +  device.firmwareRevision + "</span>" +
      "</div>" +
    "</div>";
};

// Parameters for our feature options webUI.
const featureOptionsParams = { hasControllers: false, infoPanel: showRatgdoDetails, sidebar: { deviceLabel: "Ratgdo Devices" } };

// Instantiate the webUI.
const ui = new webUi({ featureOptions: featureOptionsParams, name: "Ratgdo" });

// Display the webUI.
ui.show();
