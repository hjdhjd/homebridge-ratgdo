/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge Ratgdo webUI.
 */
import { webUi } from "homebridge-plugin-utils/webUi.mjs";

/* Build one row of the device-stats grid. We construct DOM nodes directly via createElement / textContent rather than concatenating into innerHTML so any HTML
 * metacharacter in a device field (model, serial number, firmware revision) renders as text instead of being interpreted as markup. The discovery boundary is the
 * trust line, and treating mDNS-advertised strings as data rather than HTML is the cleanest place to enforce it.
 */
const buildStatRow = (label, value, valueClassName) => {

  const item = document.createElement("div");

  item.className = "stat-item";

  const labelSpan = document.createElement("span");

  labelSpan.className = "stat-label";
  labelSpan.textContent = label;

  const valueSpan = document.createElement("span");

  valueSpan.className = valueClassName;
  valueSpan.textContent = value ?? "";

  item.append(labelSpan, valueSpan);

  return item;
};

// Passed to webUi as the featureOptions infoPanel override, so it fires automatically whenever the sidebar selection changes to a specific device.
const showRatgdoDetails = (device) => {

  const deviceStatsContainer = document.getElementById("deviceStatsContainer");

  // No device specified, we must be in a global context.
  if(!device) {

    deviceStatsContainer.textContent = "";

    return;
  }

  // Populate the device details. Replace any prior content with a freshly-built grid so successive selections do not stack stale rows.
  const grid = document.createElement("div");

  grid.className = "device-stats-grid";
  grid.append(

    buildStatRow("Model", device.model, "stat-value"),
    buildStatRow("MAC Address", device.serialNumber, "stat-value font-monospace"),
    buildStatRow("Firmware", device.firmwareRevision, "stat-value")
  );

  deviceStatsContainer.replaceChildren(grid);
};

const featureOptionsParams = { hasControllers: false, infoPanel: showRatgdoDetails, sidebar: { deviceLabel: "Ratgdo Devices" } };

const ui = new webUi({ featureOptions: featureOptionsParams, name: "Ratgdo" });

ui.show();
