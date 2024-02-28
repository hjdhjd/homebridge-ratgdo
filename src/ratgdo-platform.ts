/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-platform.ts: homebridge-ratgdo platform class.
 */
import { API, APIEvent, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME, RATGDO_API_PORT, RATGDO_MQTT_TOPIC } from "./settings.js";
import { RatgdoOptions, featureOptionCategories, featureOptions, isOptionEnabled } from "./ratgdo-options.js";
import { Server, createServer } from "node:net";
import Aedes from "aedes";
import { RatgdoAccessory } from "./ratgdo-device.js";
import { RatgdoMqtt } from "./ratgdo-mqtt.js";
import { URL } from "node:url";
import util from "node:util";

interface haConfigJson {

  "~": string,
  device: {

    configuration_url: string,
    identifiers: string,
    manufacturer: string,
    model: string,
    sw_version: string
  }

  name: string,
  unique_id: string,
}

export class RatgdoPlatform implements DynamicPlatformPlugin {

  private readonly accessories: PlatformAccessory[];
  public readonly api: API;
  public broker: Aedes;
  private deviceMac: { [index: string]: string };
  private featureOptionDefaults: { [index: string]: boolean };
  public config!: RatgdoOptions;
  public readonly configOptions: string[];
  public readonly configuredDevices: { [index: string]: RatgdoAccessory };
  public readonly hap: HAP;
  public readonly log: Logging;
  public readonly mqtt: RatgdoMqtt | null;
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
    this.mqtt = null;
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
      mqttTopic: (config.mqttTopic as string) ?? RATGDO_MQTT_TOPIC,
      mqttUrl: config.mqttUrl as string,
      options: config.options as string[],
      port: "port" in config ? parseInt(config.port as string) : RATGDO_API_PORT
    };

    // If we have feature options, put them into their own array, upper-cased for future reference.
    if(this.config.options) {

      for(const featureOption of this.config.options) {

        this.configOptions.push(featureOption.toLowerCase());
      }
    }

    // Initialize MQTT, if needed.
    if(this.config.mqttUrl) {

      this.mqtt = new RatgdoMqtt(this);
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

    // See if we already know about this accessory or if it's truly new.
    let accessory = this.accessories.find(x => x.UUID === uuid);

    // Our device details.
    const device = {

      address: new URL(deviceInfo.device.configuration_url)?.hostname ?? "unknown",
      firmwareVersion: deviceInfo.device.sw_version,
      mac: mac.replace(/:/g, ""),
      name: deviceInfo["~"]
    };

    // Inform the user.
    this.log.info("Discovered: %s (address: %s mac: %s firmware: v%s).", device.name, device.address, device.mac, device.firmwareVersion);

    // Check to see if the user has disabled the device.
    if(!isOptionEnabled(this.configOptions, device, "Device", this.featureOptionDefault("Device"))) {

      // If the accessory already exists, let's remove it.
      if(accessory) {

        // Inform the user.
        this.log.info("%s: Removing device from HomeKit.", accessory.displayName);

        // Unregister the accessory and delete it's remnants from HomeKit.
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [ accessory ]);
        this.accessories.splice(this.accessories.indexOf(accessory), 1);
        this.api.updatePlatformAccessories(this.accessories);
      }

      // We're done.
      return;
    }

    // It's a new device - let's add it to HomeKit.
    if(!accessory) {

      accessory = new this.api.platformAccessory(device.name, uuid);

      // Register this accessory with Homebridge and add it to the accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    // Add it to our list of configured devices.
    this.configuredDevices[accessory.UUID] = new RatgdoAccessory(this, accessory, device);

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories([accessory]);
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
