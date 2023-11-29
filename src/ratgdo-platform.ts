/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-platform.ts: homebridge-ratgdo platform class.
 */
import { API, APIEvent, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME, RATGDO_API_PORT } from "./settings.js";
import { Server, createServer } from "node:net";
import { featureOptionCategories, featureOptions, ratgdoOptions } from "./ratgdo-options.js";
import Aedes from "aedes";
import { ratgdoAccessory } from "./ratgdo-device.js";

import util from "node:util";

interface haConfigJson {
  "~": string,
  device: {

    identifiers: string,
    manufacturer: string,
    model: string,
    sw_version: string
  }

  name: string,
  unique_id: string,
}

export class ratgdoPlatform implements DynamicPlatformPlugin {

  private readonly accessories: PlatformAccessory[];
  public readonly api: API;
  public broker: Aedes;
  private deviceMac: { [index: string]: string };
  private featureOptionDefaults: { [index: string]: boolean };
  public config!: ratgdoOptions;
  public readonly configOptions: string[];
  public readonly configuredDevices: { [index: string]: ratgdoAccessory };
  public readonly hap: HAP;
  public readonly log: Logging;
  private server: Server;
  private unsupportedDevices: { [index: string]: boolean };

  constructor(log: Logging, config: PlatformConfig, api: API) {

    this.accessories = [];
    this.api = api;
    this.broker = new Aedes();
    this.configOptions = [];
    this.configuredDevices = {};
    this.deviceMac = {};
    this.featureOptionDefaults = {};
    this.hap = api.hap;
    this.log = log;
    this.log.debug = this.debug.bind(this);
    this.server = createServer(this.broker.handle);
    this.server.unref();
    this.unsupportedDevices = {};

    this.server.on("error", (error) => {

      this.log.error("MQTT broker error: %s", error);
      this.server.close();
    });

    // Make sure we cleanup our server when we shutdown.
    this.api.on(APIEvent.SHUTDOWN, () => {

      this.server.close();
    });

    // Build our list of default values for our feature options.
    for(const category of featureOptionCategories) {

      for(const options of featureOptions[category.name]) {

        this.featureOptionDefaults[(category.name + (options.name.length ? "." + options.name : "")).toLowerCase()] = options.default;
      }
    }

    // We can't start without being configured.
    if(!config) {

      return;
    }

    this.config = {

      debug: config.debug === true,
      options: config.options as string[],
      port: "port" in config ? parseInt(config.port as string) : RATGDO_API_PORT
    };

    // If we have feature options, put them into their own array, upper-cased for future reference.
    if(this.config.options) {

      for(const featureOption of this.config.options) {

        this.configOptions.push(featureOption.toLowerCase());
      }
    }

    this.log.debug("Debug logging on. Expect a lot of data.");

    // Fire up the Ratgdo API once Homebridge has loaded all the cached accessories it knows about and called configureAccessory() on each.
    api.on(APIEvent.DID_FINISH_LAUNCHING, this.configureBroker.bind(this));
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save all that logic for broker
  // configuration and startup.
  public configureAccessory(accessory: PlatformAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Configure and start our MQTT broker.
  private configureBroker(): void {

    // Capture any publish events to our MQTT broker for processing.
    this.broker.on("publish", (packet): void => {

      // Capture [homeassistant]/cover/GarageDoor/config device discovery events.
      const discoveryRegex = new RegExp("^[^/]+/cover/[^/]+/config$", "gi");

      // Capture door events in the form of:
      //
      //   [garage door name]/status/availability => offline, online.
      //   [garage door name]/status/door => closed, closing, open, opening, stopped, syncing.
      //   [garage door name]/status/light => off, on, unknown.
      //   [garage door name]/status/lock => locked, unknown, unlocked.
      //   [garage door name]/status/motion => detected.
      //   [garage door name]/status/obstruction => clear, obstructed, unknown.
      const statusRegex = new RegExp("^([^/]+)/status/(availability|door|light|lock|motion|obstruction)$", "gi");

      const payload = packet.payload.toString();

      // Let's see if we have a new garage door opener.
      if(discoveryRegex.test(packet.topic)) {

        this.configureGdo(JSON.parse(payload) as haConfigJson);
        return;
      }

      // Communicate garage door-related state changes.
      const topicMatch = statusRegex.exec(packet.topic);

      if(topicMatch) {

        const mac = this.deviceMac[topicMatch[1]];

        if(!mac) {

          this.log.error("No garage door has been configured in HomeKit for %s.", topicMatch[1]);
          return;
        }

        const garageDoor = this.configuredDevices[this.hap.uuid.generate(mac)];

        // If we can't find the garage door opener, we're done.
        if(!garageDoor) {

          return;
        }

        this.log.debug("Status update detected: %s (%s): %s - %s", topicMatch[1], this.deviceMac[topicMatch[1]], topicMatch[2], payload);

        // Update our state, based on the update we've received.
        garageDoor.updateState(topicMatch[2], payload);
        return;
      }

      // Filter out system-level MQTT messages.
      if(/^\$SYS\/.*$/.test(packet.topic)) {

        return;
      }

      // Filter out HomeAssistant-specific MQTT messages.
      if(/^homeassistant\/.*\/config$/.test(packet.topic)) {

        return;
      }

      // Filter out heartbeat messages.
      if(/^\$SYS\/.*\/heartbeat$/.test(packet.topic)) {

        return;
      }

      // Log unknown / unhandled messages.
      this.log.debug("Topic: " + packet.topic + " | Message: " + packet.payload.toString());
    });

    // Start the broker so we can receive connections from Ratgdo MQTT clients.
    try {

      this.server.listen(this.config.port, () => {

        this.log.info("Ratgdo MQTT broker started and listening on port %s.", this.config.port);
      });
    } catch(error) {

      if(error instanceof Error) {

        switch(error.message) {

          default:

            this.log.error("Ratgdo MQTT broker: Error: %s.", error.message);
            break;
        }
      }
    }
  }

  // Configure a discovered garage door opener.
  private configureGdo(deviceInfo: haConfigJson): void {

    // Retrieve the MAC address from the unique identifier generated by Ratgdo.
    const mac = deviceInfo.unique_id.split("_")[1];

    // Map the device name to the MAC address for future reference.
    this.deviceMac[deviceInfo["~"]] = mac;

    // Generate this device's unique identifier.
    const uuid = this.hap.uuid.generate(mac);

    // See if we already know about this accessory or if it's truly new. If it is new, add it to HomeKit.
    let accessory = this.accessories.find(x => x.UUID === uuid);

    if(!accessory) {

      accessory = new this.api.platformAccessory(deviceInfo["~"], uuid);

      // Register this accessory with Homebridge and add it to the accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    const garageDoor = this.configuredDevices[accessory.UUID] = new ratgdoAccessory(this, accessory, {

      firmwareVersion: deviceInfo.device.sw_version,
      mac: mac,
      name: deviceInfo["~"]
    });

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories([accessory]);

    // Inform the user.
    garageDoor.log.info("Device configured.");
  }

  // Utility to return the default value for a feature option.
  public featureOptionDefault(option: string): boolean {

    const defaultValue = this.featureOptionDefaults[option.toLowerCase()];

    // If it's unknown to us, assume it's true.
    if(defaultValue === undefined) {

      return true;
    }

    return defaultValue;
  }

  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debug) {

      this.log.error(util.format(message, ...parameters));
    }
  }
}
