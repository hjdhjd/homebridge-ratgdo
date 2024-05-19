/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-featureoptions.mjs: Device feature option webUI.
 */
"use strict";

import { FeatureOptions} from "./featureoptions.js";

export class webUiFeatureOptions {

  // The current plugin configuration.
  currentConfig;

  // Table containing the currently displayed feature options.
  #configTable;

  // The current controller context.
  #controller;

  // Current list of devices from the Homebridge accessory cache.
  #devices;

  // Feature options instance.
  #featureOptions;

  // Device sidebar category name.
  #sidebar;

  // Enable the use of controllers.
  #useControllers;

  // Current list of devices on a given controller, for webUI elements.
  #webuiDeviceList;

  constructor({ sidebar = "Devices", useControllers = true } = {}) {

    this.configTable = document.getElementById("configTable");
    this.controller = null;
    this.currentConfig = [];
    this.devices = [];
    this.featureOptions = null;
    this.sidebarName = sidebar;
    this.useControllers = useControllers;
    this.webuiDeviceList = [];
  }

  // Render the feature option webUI.
  async showUI() {

    // Show the beachball while we setup.
    homebridge.showSpinner();
    homebridge.hideSchemaForm();

    // Make sure we have the refreshed configuration.
    this.currentConfig = await homebridge.getPluginConfig();

    // Retrieve the set of feature options available to us.
    const features = (await homebridge.request("/getOptions")) ?? [];

    // Initialize our feature option configuration.
    this.featureOptions = new FeatureOptions(features.categories, features.options, this.currentConfig[0].options ?? []);

    // Create our custom UI.
    document.getElementById("menuHome").classList.remove("btn-elegant");
    document.getElementById("menuHome").classList.add("btn-primary");
    document.getElementById("menuFeatureOptions").classList.add("btn-elegant");
    document.getElementById("menuFeatureOptions").classList.remove("btn-primary");
    document.getElementById("menuSettings").classList.remove("btn-elegant");
    document.getElementById("menuSettings").classList.add("btn-primary");

    // Hide the legacy UI.
    document.getElementById("pageSupport").style.display = "none";
    document.getElementById("pageFeatureOptions").style.display = "block";

    // What we're going to do is display our global options, followed by the list of devices from the Homebridge accessory cache.
    // We pre-select our global options by default for the user as a starting point.

    // Retrieve the table for the our list of controllers and global options.
    const controllersTable = document.getElementById("controllersTable");

    // Start with a clean slate.
    controllersTable.innerHTML = "";
    document.getElementById("devicesTable").innerHTML = "";
    this.configTable.innerHTML = "";
    this.webuiDeviceList = [];

    // Hide the UI until we're ready.
    document.getElementById("sidebar").style.display = "none";
    document.getElementById("headerInfo").style.display = "none";
    document.getElementById("deviceStatsTable").style.display = "none";

    // Initialize our informational header.
    document.getElementById("headerInfo").innerHTML = "Feature options are applied in prioritized order, from global to device-specific options:" +
      "<br><i class=\"text-warning\">Global options</i> (lowest priority) &rarr; " +
      (this.useControllers ? "<i class=\"text-success\">Controller options</i> &rarr; " : "") +
      "<i class=\"text-info\">Device options</i> (highest priority)";

    // Enumerate our global options.
    const trGlobal = document.createElement("tr");

    // Create the cell for our global options.
    const tdGlobal = document.createElement("td");
    tdGlobal.classList.add("m-0", "p-0");

    // Create our label target.
    const globalLabel = document.createElement("label");

    globalLabel.name = "Global Options";
    globalLabel.appendChild(document.createTextNode("Global Options"));
    globalLabel.style.cursor = "pointer";
    globalLabel.classList.add("mx-2", "my-0", "p-0", "w-100");

    globalLabel.addEventListener("click", () => this.#showDevices(true));

    // Add the global options label.
    tdGlobal.appendChild(globalLabel);
    tdGlobal.style.fontWeight = "bold";

    // Add the global cell to the table.
    trGlobal.appendChild(tdGlobal);

    // Now add it to the overall controllers table.
    controllersTable.appendChild(trGlobal);

    // Add it as another device, for UI purposes.
    this.webuiDeviceList.push(globalLabel);

    // All done. Let the user interact with us.
    homebridge.hideSpinner();

    // Default the user on our global settings.
    this.#showDevices(true);
  }

  // Show the device list.
  async #showDevices(isGlobal) {

    // Show the beachball while we setup.
    homebridge.showSpinner();

    const devicesTable = document.getElementById("devicesTable");
    this.devices = [];

    // If we're not accessing global options, pull the list of devices this plugin knows about from Homebridge.
    this.devices = (await homebridge.getCachedAccessories()).map(x => ({
      firmwareVersion: (x.services.find(service => service.constructorName ===
        "AccessoryInformation")?.characteristics.find(characteristic => characteristic.constructorName === "FirmwareRevision")?.value ?? ""),
      name: x.displayName,
      serial: (x.services.find(service => service.constructorName ===
        "AccessoryInformation")?.characteristics.find(characteristic => characteristic.constructorName === "SerialNumber")?.value ?? "")
    }));

    // Sort it for posterity.
    this.devices?.sort((a, b) => {

      const aCase = (a.name ?? "").toLowerCase();
      const bCase = (b.name ?? "").toLowerCase();

      return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
    });

    // Make the UI visible.
    document.getElementById("sidebar").style.display = "";
    document.getElementById("headerInfo").style.display = "";

    // Wipe out the device list, except for our global entry.
    this.webuiDeviceList.splice(1, this.webuiDeviceList.length);

    // Start with a clean slate.
    devicesTable.innerHTML = "";

    // Show the devices list only if we have actual devices to show.
    if(this.devices?.length) {

      // Create a row for this device category.
      const trCategory = document.createElement("tr");

      // Create the cell for our device category row.
      const tdCategory = document.createElement("td");
      tdCategory.classList.add("m-0", "p-0");

      // Add the category name, with appropriate casing.
      tdCategory.appendChild(document.createTextNode(this.sidebarName));
      tdCategory.style.fontWeight = "bold";

      // Add the cell to the table row.
      trCategory.appendChild(tdCategory);

      // Add the table row to the table.
      devicesTable.appendChild(trCategory);

      for(const device of this.devices) {

        // Create a row for this device.
        const trDevice = document.createElement("tr");
        trDevice.classList.add("m-0", "p-0");

        // Create a cell for our device.
        const tdDevice = document.createElement("td");
        tdDevice.classList.add("m-0", "p-0", "w-100");

        const label = document.createElement("label");

        label.name = device.serial;
        label.appendChild(document.createTextNode(device.name ?? "Unknown"));
        label.style.cursor = "pointer";
        label.classList.add("mx-2", "my-0", "p-0", "w-100");

        label.addEventListener("click", () => this.#showDeviceInfo(device.serial));

        // Add the device label to our cell.
        tdDevice.appendChild(label);

        // Add the cell to the table row.
        trDevice.appendChild(tdDevice);

        // Add the table row to the table.
        devicesTable.appendChild(trDevice);

        this.webuiDeviceList.push(label);
      }
    }

    // Display the feature options to the user.
    this.#showDeviceInfo(isGlobal ? "Global Options" : this.devices[0].serial);

    // All done. Let the user interact with us.
    homebridge.hideSpinner();
  }

  // Show feature option information for a specific device, controller, or globally.
  async #showDeviceInfo(deviceId) {

    homebridge.showSpinner();

    // Update the selected device for visibility.
    this.webuiDeviceList.map(x => (x.name === deviceId) ?
      x.parentElement.classList.add("bg-info", "text-white") : x.parentElement.classList.remove("bg-info", "text-white"));

    // Populate the device information info pane.
    const currentDevice = this.devices.find(x => x.serial === deviceId);
    this.controller = currentDevice?.serial;

    // Ensure we have a controller or device. The only time this won't be the case is when we're looking at global options.
    if(currentDevice) {

      document.getElementById("device_firmware").innerHTML = currentDevice.firmwareVersion;
      document.getElementById("device_serial").innerHTML = currentDevice.serial;
      document.getElementById("deviceStatsTable").style.display = "";
    } else {

      document.getElementById("deviceStatsTable").style.display = "none";
      document.getElementById("device_firmware").innerHTML = "N/A";
      document.getElementById("device_serial").innerHTML = "N/A";
    }

    // Start with a clean slate.
    this.configTable.innerHTML = "";

    for(const category of this.featureOptions.categories) {

      const optionTable = document.createElement("table");
      const thead = document.createElement("thead");
      const tbody = document.createElement("tbody");
      const trFirst = document.createElement("tr");
      const th = document.createElement("th");

      // Set our table options.
      optionTable.classList.add("table", "table-borderless", "table-sm", "table-hover");
      th.classList.add("p-0");
      th.style.fontWeight = "bold";
      th.colSpan = 3;
      tbody.classList.add("table-bordered");

      // Add the feature option category description.
      th.appendChild(document.createTextNode(category.description + (!currentDevice ? " (Global)" : " (Device-specific)")));

      // Add the table header to the row.
      trFirst.appendChild(th);

      // Add the table row to the table head.
      thead.appendChild(trFirst);

      // Finally, add the table head to the table.
      optionTable.appendChild(thead);

      // Keep track of the number of options we have made available in a given category.
      let optionsVisibleCount = 0;

      // Now enumerate all the feature options for a given device.
      for(const option of this.featureOptions.options[category.name]) {

        // Expand the full feature option.
        const featureOption = this.featureOptions.expandOption(category, option);

        // Create the next table row.
        const trX = document.createElement("tr");
        trX.classList.add("align-top");
        trX.id = "row-" + featureOption;

        // Create a checkbox for the option.
        const tdCheckbox = document.createElement("td");

        // Create the actual checkbox for the option.
        const checkbox = document.createElement("input");

        checkbox.type = "checkbox";
        checkbox.readOnly = false;
        checkbox.id = featureOption;
        checkbox.name = featureOption;
        checkbox.value = featureOption + (!currentDevice ? "" : ("." + currentDevice.serial));

        let initialValue = undefined;
        let initialScope;

        // Determine our initial option scope to show the user what's been set.
        switch(initialScope = this.featureOptions.scope(featureOption, currentDevice?.serial)) {

          case "global":
          case "controller":

            // If we're looking at the global scope, show the option value. Otherwise, we show that we're inheriting a value from the scope above.
            if(!currentDevice) {

              if(this.featureOptions.isValue(featureOption)) {

                checkbox.checked = this.featureOptions.exists(featureOption);
                initialValue = this.featureOptions.value(checkbox.id);
              } else {

                checkbox.checked = this.featureOptions.test(featureOption);
              }

              if(checkbox.checked) {

                checkbox.indeterminate = false;
              }

            } else {

              if(this.featureOptions.isValue(featureOption)) {

                initialValue = this.featureOptions.value(checkbox.id, (initialScope === "controller") ? this.controller : undefined);
              }

              checkbox.readOnly = checkbox.indeterminate = true;
            }

            break;

          case "device":
          case "none":
          default:

            if(this.featureOptions.isValue(featureOption)) {

              checkbox.checked = this.featureOptions.exists(featureOption, currentDevice?.serial);
              initialValue = this.featureOptions.value(checkbox.id, currentDevice?.serial);
            } else {

              checkbox.checked = this.featureOptions.test(featureOption, currentDevice?.serial);
            }

            break;
        }

        checkbox.defaultChecked = option.default;
        checkbox.classList.add("mx-2");

        // Add the checkbox to the table cell.
        tdCheckbox.appendChild(checkbox);

        // Add the checkbox to the table row.
        trX.appendChild(tdCheckbox);

        const tdLabel = document.createElement("td");
        tdLabel.classList.add("w-100");
        tdLabel.colSpan = 2;

        let inputValue = null;

        // Add an input field if we have a value-centric feature option.
        if(this.featureOptions.isValue(featureOption)) {

          const tdInput = document.createElement("td");
          tdInput.classList.add("mr-2");
          tdInput.style.width = "10%";

          inputValue = document.createElement("input");
          inputValue.type = "text";
          inputValue.value = initialValue ?? option.defaultValue;
          inputValue.size = 5;
          inputValue.readOnly = !checkbox.checked;

          // Add or remove the setting from our configuration when we've changed our state.
          inputValue.addEventListener("change", async () => {

            // Find the option in our list and delete it if it exists.
            const optionRegex = new RegExp("^(?:Enable|Disable)\\." + checkbox.id + (!currentDevice ? "" : ("\\." + currentDevice.serial)) + "\\.[^\\.]+$", "gi");
            const newOptions = this.featureOptions.configuredOptions.filter(x => !optionRegex.test(x));

            if(checkbox.checked) {

              newOptions.push("Enable." + checkbox.value + "." + inputValue.value);
            } else if(checkbox.indeterminate) {

              // If we're in an indeterminate state, we need to traverse the tree to get the upstream value we're inheriting.
              inputValue.value = (currentDevice?.serial !== this.controller) ?
                (this.featureOptions.value(checkbox.id, this.controller) ?? this.featureOptions.value(checkbox.id)) :
                (this.featureOptions.value(checkbox.id) ?? option.defaultValue);
            } else {

              inputValue.value = option.defaultValue;
            }

            // Update our configuration in Homebridge.
            this.currentConfig[0].options = newOptions;
            this.featureOptions.configuredOptions = newOptions;
            await homebridge.updatePluginConfig(this.currentConfig);
          });

          tdInput.appendChild(inputValue);
          trX.appendChild(tdInput);
        }

        // Create a label for the checkbox with our option description.
        const labelDescription = document.createElement("label");
        labelDescription.for = checkbox.id;
        labelDescription.style.cursor = "pointer";
        labelDescription.classList.add("user-select-none", "my-0", "py-0");

        // Highlight options for the user that are different than our defaults.
        const scopeColor = this.featureOptions.color(featureOption, currentDevice?.serial);

        if(scopeColor) {

          labelDescription.classList.add(scopeColor);
        }

        // Add or remove the setting from our configuration when we've changed our state.
        checkbox.addEventListener("change", async () => {

          // Find the option in our list and delete it if it exists.
          const optionRegex = new RegExp("^(?:Enable|Disable)\\." + checkbox.id + (!currentDevice ? "" : ("\\." + currentDevice.serial)) + "$", "gi");
          const newOptions = this.featureOptions.configuredOptions.filter(x => !optionRegex.test(x));

          // Figure out if we've got the option set upstream.
          let upstreamOption = false;

          // We explicitly want to check for the scope of the feature option above where we are now, so we can appropriately determine what we should show.
          switch(this.featureOptions.scope(checkbox.id, (currentDevice && (currentDevice.serial !== this.controller)) ? this.controller : undefined)) {

            case "device":
            case "controller":

              if(currentDevice.serial !== this.controller) {

                upstreamOption = true;
              }

              break;

            case "global":

              if(currentDevice) {

                upstreamOption = true;
              }

              break;

            default:

              break;
          }

          // For value-centric feature options, if there's an upstream value assigned above us, we don't allow for an unchecked state as it doesn't make sense in this
          // context.
          if(checkbox.readOnly && (!this.featureOptions.isValue(featureOption) || (this.featureOptions.isValue(featureOption) && inputValue && !upstreamOption))) {

            // We're truly unchecked. We need this because a checkbox can be in both an unchecked and indeterminate simultaneously,
            // so we use the readOnly property to let us know that we've just cycled from an indeterminate state.
            checkbox.checked = checkbox.readOnly = false;
          } else if(!checkbox.checked) {

            // If we have an upstream option configured, we reveal a third state to show inheritance of that option and allow the user to select it.
            if(upstreamOption) {

              // We want to set the readOnly property as well, since it will survive a user interaction when they click the checkbox to clear out the
              // indeterminate state. This allows us to effectively cycle between three states.
              checkbox.readOnly = checkbox.indeterminate = true;
            }

            if(this.featureOptions.isValue(featureOption) && inputValue) {

              inputValue.readOnly = true;
            }
          } else if(checkbox.checked) {

            // We've explicitly checked this option.
            checkbox.readOnly = checkbox.indeterminate = false;

            if(this.featureOptions.isValue(featureOption) && inputValue) {

              inputValue.readOnly = false;
            }
          }

          // The setting is different from the default, highlight it for the user, accounting for upstream scope, and add it to our configuration.
          if(!checkbox.indeterminate && ((checkbox.checked !== option.default) || upstreamOption)) {

            labelDescription.classList.add("text-info");
            newOptions.push((checkbox.checked ? "Enable." : "Disable.") + checkbox.value);
          } else {

            // We've reset to the defaults, remove our highlighting.
            labelDescription.classList.remove("text-info");
          }

          // Update our Homebridge configuration.
          if(this.featureOptions.isValue(featureOption) && inputValue) {

            // Inform our value-centric feature option to update Homebridge.
            const changeEvent = new Event("change");

            inputValue.dispatchEvent(changeEvent);
          } else {

            // Update our configuration in Homebridge.
            this.currentConfig[0].options = newOptions;
            this.featureOptions.configuredOptions = newOptions;
            await homebridge.updatePluginConfig(this.currentConfig);
          }

          // If we've reset to defaults, make sure our color coding for scope is reflected.
          if((checkbox.checked === option.default) || checkbox.indeterminate) {

            const scopeColor = this.featureOptions.color(featureOption, currentDevice?.serial);

            if(scopeColor) {

              labelDescription.classList.add(scopeColor);
            }
          }

          // Adjust visibility of other feature options that depend on us.
          if(this.featureOptions.groups[checkbox.id]) {

            const entryVisibility = this.featureOptions.test(featureOption, currentDevice?.serial) ? "" : "none";

            // Lookup each feature option setting and set the visibility accordingly.
            for(const entry of this.featureOptions.groups[checkbox.id]) {

              document.getElementById("row-" + entry).style.display = entryVisibility;
            }
          }
        });

        // Add the actual description for the option after the checkbox.
        labelDescription.appendChild(document.createTextNode(option.description));

        // Add the label to the table cell.
        tdLabel.appendChild(labelDescription);

        // Provide a cell-wide target to click on options.
        tdLabel.addEventListener("click", () => checkbox.click());

        // Add the label table cell to the table row.
        trX.appendChild(tdLabel);

        // Adjust the visibility of the feature option, if it's logically grouped.
        if((option.group !== undefined) && !this.featureOptions.test(category.name + (option.group.length ? ("." + option.group) : ""), currentDevice?.serial)) {

          trX.style.display = "none";
        } else {

          // Increment the visible option count.
          optionsVisibleCount++;
        }

        // Add the table row to the table body.
        tbody.appendChild(trX);
      }

      // Add the table body to the table.
      optionTable.appendChild(tbody);

      // If we have no options visible in a given category, then hide the entire category.
      if(!optionsVisibleCount) {

        optionTable.style.display = "none";
      }

      // Add the table to the page.
      this.configTable.appendChild(optionTable);
    }

    homebridge.hideSpinner();
  }
}
