/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi.mjs: Plugin webUI.
 */
"use strict";

export class webUi {

  // Feature options class instance.
  #featureOptions;

  // Homebridge class instance.
  #homebridge;

  // Plugin name.
  #name;

  constructor({ name, featureOptions, homebridge } = {}) {

    this.homebridge = homebridge;
    this.featureOptions = featureOptions;
    this.name = name;

    // Fire off our UI, catching errors along the way.
    try {

      this.#launchWebUI();
    } catch(err) {

      // If we had an error instantiating or updating the UI, notify the user.
      this.homebridge.toast.error(err.message, "Error");
    } finally {

      // Always leave the UI in a usable place for the end user.
      this.homebridge.hideSpinner();
    }
  }

  // Show the first run user experience if we don't have valid login credentials.
  async #showFirstRun() {

    const buttonFirstRun = document.getElementById("firstRun");

    // First run user experience.
    buttonFirstRun.addEventListener("click", async () => {

      // Show the beachball while we setup.
      this.homebridge.showSpinner();

      // Get the list of devices the plugin knows about.
      const devices = await this.homebridge.getCachedAccessories();

      // Sort it for posterity.
      devices?.sort((a, b) => {

        const aCase = (a.displayName ?? "").toLowerCase();
        const bCase = (b.displayName ?? "").toLowerCase();

        return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
      });

      // Create our UI.
      document.getElementById("pageFirstRun").style.display = "none";
      document.getElementById("menuWrapper").style.display = "inline-flex";
      this.featureOptions.showUI();

      // All done. Let the user interact with us, although in practice, we shouldn't get here.
      // this.homebridge.hideSpinner();
    });

    document.getElementById("pageFirstRun").style.display = "block";
  }

  // Show the main plugin configuration tab.
  #showSettings() {

    // Show the beachball while we setup.
    this.homebridge.showSpinner();

    // Create our UI.
    document.getElementById("menuHome").classList.remove("btn-elegant");
    document.getElementById("menuHome").classList.add("btn-primary");
    document.getElementById("menuFeatureOptions").classList.remove("btn-elegant");
    document.getElementById("menuFeatureOptions").classList.add("btn-primary");
    document.getElementById("menuSettings").classList.add("btn-elegant");
    document.getElementById("menuSettings").classList.remove("btn-primary");

    document.getElementById("pageSupport").style.display = "none";
    document.getElementById("pageFeatureOptions").style.display = "none";

    this.homebridge.showSchemaForm();

    // All done. Let the user interact with us.
    this.homebridge.hideSpinner();
  }

  // Show the support tab.
  #showSupport() {

    // Show the beachball while we setup.
    this.homebridge.showSpinner();
    this.homebridge.hideSchemaForm();

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
    this.homebridge.hideSpinner();
  }

  // Launch our webUI.
  async #launchWebUI() {

    // Retrieve the current plugin configuration.
    this.featureOptions.currentConfig = await this.homebridge.getPluginConfig();

    // Add our event listeners to animate the UI.
    document.getElementById("menuHome").addEventListener("click", () => this.#showSupport());
    document.getElementById("menuFeatureOptions").addEventListener("click", () => this.featureOptions.showUI());
    document.getElementById("menuSettings").addEventListener("click", () => this.#showSettings());

    // Get the list of devices the plugin knows about.
    const devices = await this.homebridge.getCachedAccessories();

    // If we've got devices detected, we launch our feature option UI. Otherwise, we launch our first run UI.
    if(this.featureOptions.currentConfig.length && devices?.length) {

      document.getElementById("menuWrapper").style.display = "inline-flex";
      this.featureOptions.showUI();
      return;
    }

    // If we have no configuration, let's create one.
    if(!this.featureOptions.currentConfig.length) {

      this.featureOptions.currentConfig.push({ name: this.name });
    } else if(!("name" in this.featureOptions.currentConfig[0])) {

      // If we haven't set the name, let's do so now.
      this.featureOptions.currentConfig[0].name = this.name;
    }

    // Update the plugin configuration and launch the first run UI.
    await this.homebridge.updatePluginConfig(this.featureOptions.currentConfig);
    this.#showFirstRun();
  }
}
