/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Ratgdo webUI.
 */
"use strict";

import { ratgdoFeatureOptions } from "./ratgdo-featureoptions.mjs";

// Keep a list of all the feature options and option groups.
const featureOptions = new ratgdoFeatureOptions();

// Show the first run user experience if we don't have valid login credentials.
async function showFirstRun () {

  const buttonFirstRun = document.getElementById("firstRun");
  const serverPortInfo = document.getElementById("serverPortInfo");

  serverPortInfo.innerHTML = (featureOptions.currentConfig[0].port ?? "18830");

  // First run user experience.
  buttonFirstRun.addEventListener("click", async () => {

    // Show the beachball while we setup.
    homebridge.showSpinner();

    // Get the list of devices the plugin knows about.
    const ratgdoDevices = await homebridge.getCachedAccessories();

    // Sort it for posterity.
    ratgdoDevices?.sort((a, b) => {

      const aCase = (a.displayName ?? "").toLowerCase();
      const bCase = (b.displayName ?? "").toLowerCase();

      return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
    });

    // Create our UI.
    document.getElementById("pageFirstRun").style.display = "none";
    document.getElementById("menuWrapper").style.display = "inline-flex";
    featureOptions.showUI();

    // All done. Let the user interact with us, although in practice, we shouldn't get here.
    // homebridge.hideSpinner();
  });

  document.getElementById("pageFirstRun").style.display = "block";
}

// Show the main plugin configuration tab.
function showSettings () {

  // Show the beachball while we setup.
  homebridge.showSpinner();

  // Create our UI.
  document.getElementById("menuHome").classList.remove("btn-elegant");
  document.getElementById("menuHome").classList.add("btn-primary");
  document.getElementById("menuFeatureOptions").classList.remove("btn-elegant");
  document.getElementById("menuFeatureOptions").classList.add("btn-primary");
  document.getElementById("menuSettings").classList.add("btn-elegant");
  document.getElementById("menuSettings").classList.remove("btn-primary");

  document.getElementById("pageSupport").style.display = "none";
  document.getElementById("pageFeatureOptions").style.display = "none";

  homebridge.showSchemaForm();

  // All done. Let the user interact with us.
  homebridge.hideSpinner();
}

// Show the support tab.
function showSupport() {

  // Show the beachball while we setup.
  homebridge.showSpinner();
  homebridge.hideSchemaForm();

  // Create our UI.
  document.getElementById("menuHome").classList.add("btn-elegant");
  document.getElementById("menuHome").classList.remove("btn-primary");
  document.getElementById("menuFeatureOptions").classList.remove("btn-elegant");
  document.getElementById("menuFeatureOptions").classList.add("btn-primary");
  document.getElementById("menuSettings").classList.remove("btn-elegant");
  document.getElementById("menuSettings").classList.add("btn-primary");

  document.getElementById("pageSupport").style.display = "block";
  document.getElementById("pageFeatureOptions").style.display = "none";

  // All done. Let the user interact with us.
  homebridge.hideSpinner();
}

// Launch our webUI.
async function launchWebUI() {

  // Retrieve the current plugin configuration.
  featureOptions.currentConfig = await homebridge.getPluginConfig();

  // Add our event listeners to animate the UI.
  menuHome.addEventListener("click", () => showSupport());
  menuFeatureOptions.addEventListener("click", () => featureOptions.showUI());
  menuSettings.addEventListener("click", () => showSettings());

  // Get the list of devices the plugin knows about.
  const ratgdoDevices = await homebridge.getCachedAccessories();

  // If we've got Ratgdo devices detected, we launch our feature option UI. Otherwise, we launch our first run UI.
  if(featureOptions.currentConfig.length && ratgdoDevices?.length) {

    document.getElementById("menuWrapper").style.display = "inline-flex";
    featureOptions.showUI();
    return;
  }

  // If we have no configuration, let's create one.
  if(!featureOptions.currentConfig.length) {

    featureOptions.currentConfig.push({ name: "Ratgdo" });
  } else if(!("name" in featureOptions.currentConfig[0])) {

    // If we haven't set the name, let's do so now.
    featureOptions.currentConfig[0].name = "Ratgdo";
  }

  // Update the plugin configuration and launch the first run UI.
  await homebridge.updatePluginConfig(featureOptions.currentConfig);
  showFirstRun();
}

// Fire off our UI, catching errors along the way.
try {

  launchWebUI();
} catch(err) {

  // If we had an error instantiating or updating the UI, notify the user.
  homebridge.toast.error(err.message, "Error");
} finally {

  // Always leave the UI in a usable place for the end user.
  homebridge.hideSpinner();
}
