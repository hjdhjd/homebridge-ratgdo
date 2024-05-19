/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-platform.ts: homebridge-ratgdo platform class.
 */
import { API, APIEvent, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { Bonjour, Service } from "bonjour-service";
import { FeatureOptions, MqttClient } from "homebridge-plugin-utils";
import { PLATFORM_NAME, PLUGIN_NAME, RATGDO_AUTODISCOVERY_INTERVAL, RATGDO_HEARTBEAT_DURATION, RATGDO_HEARTBEAT_INTERVAL,
  RATGDO_MQTT_TOPIC } from "./settings.js";
import { RatgdoOptions, featureOptionCategories, featureOptions } from "./ratgdo-options.js";
import EventSource from "eventsource";
import { RatgdoAccessory } from "./ratgdo-device.js";
import http from "node:http";
import net from "node:net";
import util from "node:util";

export class RatgdoPlatform implements DynamicPlatformPlugin {

  private readonly accessories: PlatformAccessory[];
  public readonly api: API;
  private discoveredDevices: { [index: string]: boolean };
  private espHomeEvents: { [index: string]: EventSource };
  public featureOptions: FeatureOptions;
  public config: RatgdoOptions;
  public readonly configOptions: string[];
  public readonly configuredDevices: { [index: string]: RatgdoAccessory };
  public readonly hap: HAP;
  public readonly log: Logging;
  public readonly mqtt: MqttClient | null;

  constructor(log: Logging, config: PlatformConfig, api: API) {

    this.accessories = [];
    this.api = api;
    this.config = {};
    this.configOptions = [];
    this.configuredDevices = {};
    this.discoveredDevices = {};
    this.espHomeEvents = {};
    this.hap = api.hap;
    this.log = log;
    this.log.debug = this.debug.bind(this);
    this.mqtt = null;

    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, config.options as string[]);

    // We can't start without being configured.
    if(!config) {

      return;
    }

    this.config = {

      debug: config.debug === true,
      mqttTopic: config.mqttTopic as string,
      mqttUrl: config.mqttUrl as string,
      options: config.options as string[]
    };

    // Initialize MQTT, if needed.
    if(this.config.mqttUrl) {

      this.mqtt = new MqttClient(this.config.mqttUrl, this.config.mqttTopic ?? RATGDO_MQTT_TOPIC, this.log);
    }

    this.log.debug("Debug logging on. Expect a lot of data.");

    // Fire up the Ratgdo API once Homebridge has loaded all the cached accessories it knows about and called configureAccessory() on each.
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => this.configureRatgdo());
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save all that logic for device
  // discovery.
  public configureAccessory(accessory: PlatformAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Configure and connect to Ratgdo ESPHome clients.
  private configureRatgdo(): void {

    // Instantiate our mDNS stack.
    const mdns = new Bonjour();

    // Make sure we cleanup our mDNS client on shutdown.
    this.api.on(APIEvent.SHUTDOWN, () => mdns.destroy());

    // Start ESPHome device discovery.
    const mdnsBrowser = mdns.find({type: "esphomelib"}, this.discoverRatgdoDevice.bind(this));

    // Trigger an initial update of our discovery.
    mdnsBrowser.update();

    // Refresh device discovery regular intervals.
    setInterval(() => mdnsBrowser.update(), RATGDO_AUTODISCOVERY_INTERVAL * 1000);
  }

  // Ratgdo ESPHome device discovery.
  private discoverRatgdoDevice(service: Service): void {

    // Define the EventSource error message type.
    interface ESError {

      message?: string,
      status?: number,
      type: string
    }

    // Define the EventSource state message type.
    interface ESMessage {

      current_operation?: string,
      id: string,
      name: string,
      position?: number,
      state: string,
      value?: string
    }

    // We're only interested in Ratgdo devices with valid IP addresses. Otherwise, we're done.
    if(((service.txt as Record<string, string>).project_name !== "ratgdo.esphome") || !service.addresses) {

      return;
    }

    // We grab the first address provided for the ESPHome device.
    const address = service.addresses[0];

    // Grab the MAC address. We uppercase it and put it in the familiar colon notation first.
    const mac = (service.txt as Record<string, string>).mac.toUpperCase().replace(/(.{2})(?=.)/g, "$1:");

    // Configure the device.
    const ratgdoAccessory = this.configureGdo(address, mac, (service.txt as Record<string, string>).friendly_name, (service.txt as Record<string, string>).version);

    // If we've already configured this one, we're done.
    if(!ratgdoAccessory) {

      return;
    }

    // Node 18 requires this because it doesn't default to keeping the underlying socket alive by default. We need this to ensure that socket keepalives are enabled so
    // that we can reconnect gracefully when connection issues occur. I'll remove this once Homebridge shifts to Node 20 as the lowest LTS version supported.
    http.globalAgent = new http.Agent({ keepAlive: true, timeout: 5000 });

    try {

      // Connect to the Ratgdo ESPHome events API.
      this.espHomeEvents[mac] = new EventSource("http://" + address + "/events");

      // Handle errors in the events API.
      this.espHomeEvents[mac].addEventListener("error", (payload: ESError) => {

        let errorMessage;

        switch(payload.message) {

          case payload.message?.startsWith("connect ECONNREFUSED "):

            errorMessage = "Connection to the Ratgdo controller refused";

            break;

          case payload.message?.startsWith("connect ETIMEDOUT "):

            errorMessage = "Connection to the Ratgdo controller has timed out";

            break;

          case "read ECONNRESET":

            errorMessage = "Connection to the Ratgdo controller has been reset";

            break;

          case "read ETIMEDOUT":

            errorMessage = "Connection to the Ratgdo controller has timed out while listening for events";

            break;

          case "unknown error.":
          case undefined:

            errorMessage = "An unknown error on the Ratgdo controller has occurred. This will happen occasionally and can generally be ignored";

            break;

          default:

            errorMessage = "Unrecognized error: " + util.inspect(payload, { sorted: true });

            break;
        }

        ratgdoAccessory.log.error("%s.", errorMessage);
      });

      // Inform the user when we've successfully connected.
      this.espHomeEvents[mac].addEventListener("open", () => {

        ratgdoAccessory.updateState("availability", "online");
      });

      // Capture state updates from the controller.
      this.espHomeEvents[mac].addEventListener("state", (message: MessageEvent<string>) => {

        let event;

        ratgdoAccessory.log.debug("State event received: ", util.inspect(message.data, { sorted: true }));

        // Ratgdo occasionally sends empty status updates - we ignore them.
        if(!message.data.length) {

          return;
        }

        try {

          event = JSON.parse(message.data) as ESMessage;
        } catch(error) {

          ratgdoAccessory.log.error("Unable to parse state message: \"%s\". Invalid JSON.", message.data);
          return;
        }

        let state;

        switch(event.id) {

          case "binary_sensor-motion":

            ratgdoAccessory.updateState("motion", (event.state === "OFF") ? "clear" : "detected");
            break;

          case "binary_sensor-obstruction":

            ratgdoAccessory.updateState("obstruction", (event.state === "OFF") ? "clear" : "obstructed");
            break;

          case "cover-door":

            switch(event.current_operation) {

              case "CLOSING":
              case "OPENING":

                state = event.current_operation.toLowerCase();

                break;

              case "IDLE":

                // We're stopped, rather than open, if the door is in a position greater than 0.
                state = ((event.state === "OPEN") && (event.position !== undefined) && (event.position > 0) && (event.position < 1)) ? "stopped" :
                  event.state.toLowerCase();

                break;

              default:

                ratgdoAccessory.log.error("Unknown door operation detected: %s.", event.current_operation);
                return;
            }

            ratgdoAccessory.updateState("door", state, (event.position !== undefined) ? event.position * 100 : undefined);

            break;

          case "light-light":

            ratgdoAccessory.updateState("light", event.state === "OFF" ? "off" : "on");

            break;

          case "lock-lock_remotes":

            ratgdoAccessory.updateState("lock", event.state === "LOCKED" ? "locked" : "unlocked");

            break;

          default:

            break;
        }
      });

      // Heartbeat the Ratgdo controller at regular intervals. We need to do this because the ESPHome firmware for Ratgdo has a failsafe that will autoreboot the
      // Ratgdo every 15 minutes if it doesn't receive a native API connection. Fortunately, the failsafe only looks for an open connection to the API, allowing us the
      // opportunity to heartbeat it with a connection we periodically reopen.
      const heartbeat = (): void => {

        // Connect to the Ratgdo, and setup our heartbeat to close after a configured duration.
        const socket = net.createConnection({ host: address, port: 6053 }, () => setTimeout(() => {

          socket.destroy();
        }, RATGDO_HEARTBEAT_DURATION * 1000));

        // Handle heartbeat errors.
        socket.on("error", (err) => ratgdoAccessory.log.debug("Heartbeat error: %s.", util.inspect(err, { sorted: true })));

        // Perpetually restart our heartbeat when it ends.
        socket.on("close", () => setTimeout(() => heartbeat(), RATGDO_HEARTBEAT_INTERVAL * 1000));
      };

      heartbeat();
    } catch(error) {

      if(error instanceof Error) {

        ratgdoAccessory.log.error("Ratgdo API error: %s", error.message);
      }
    }

  }

  // Configure a discovered garage door opener.
  private configureGdo(address: string, mac: string, name: string, firmwareVersion: string): RatgdoAccessory | null {

    // If we've already discovered this device, we're done.
    if(this.discoveredDevices[mac]) {

      return null;
    }

    // Generate this device's unique identifier.
    const uuid = this.hap.uuid.generate(mac);

    // See if we already know about this accessory or if it's truly new.
    let accessory = this.accessories.find(x => x.UUID === uuid);

    // Our device details.
    const device = {

      address: address,
      firmwareVersion: firmwareVersion,
      mac: mac.replace(/:/g, ""),
      name: name
    };

    // Inform the user that we've discovered a device.
    this.log.info("Discovered: %s (address: %s mac: %s ESPHome firmware: v%s).", device.name, device.address, device.mac, device.firmwareVersion);

    // Mark it as discovered.
    this.discoveredDevices[mac] = true;

    // Check to see if the user has disabled the device.
    if(!this.featureOptions.test("Device", device.mac)) {

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
      return null;
    }

    // If we've already configured this device before, we're done.
    if(this.configuredDevices[uuid]) {

      return null;
    }

    // It's a new device - let's add it to HomeKit.
    if(!accessory) {

      accessory = new this.api.platformAccessory(device.name, uuid);

      // Register this accessory with Homebridge and add it to the accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    // Inform the user.
    this.log.info("Configuring: %s (address: %s mac: %s ESPHome firmware: v%s).", device.name, device.address, device.mac, device.firmwareVersion);

    // Add it to our list of configured devices.
    this.configuredDevices[uuid] = new RatgdoAccessory(this, accessory, device);

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories([accessory]);

    return this.configuredDevices[uuid];
  }

  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debug) {

      this.log.error(util.format(message, ...parameters));
    }
  }
}
