/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-platform.ts: homebridge-ratgdo platform class.
 */
import { API, APIEvent, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { Bonjour, Service } from "bonjour-service";
import { PLATFORM_NAME, PLUGIN_NAME, RATGDO_API_PORT, RATGDO_AUTODISCOVERY_INTERVAL, RATGDO_HEARTBEAT_DURATION, RATGDO_HEARTBEAT_INTERVAL,
  RATGDO_MQTT_TOPIC } from "./settings.js";
import { RatgdoOptions, featureOptionCategories, featureOptions, isOptionEnabled } from "./ratgdo-options.js";
import { Server, createServer } from "node:net";
import Aedes from "aedes";
import EventSource from "eventsource";
import { Firmware } from "./ratgdo-types.js";
import { RatgdoAccessory } from "./ratgdo-device.js";
import { RatgdoMqtt } from "./ratgdo-mqtt.js";
import { URL } from "node:url";
import net from "node:net";
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
  private mqttNameMac: { [index: string]: string };
  private espHomeEvents: { [index: string]: EventSource };
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
    this.mqttNameMac = {};
    this.espHomeEvents = {};
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
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => this.configureRatgdo());
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save all that logic for broker
  // configuration and startup.
  public configureAccessory(accessory: PlatformAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Connect to the Ratgdo device types we know about.
  private configureRatgdo(): void {

    this.configureBroker();
    this.configureEspHome();
  }

  // Configure and start our MQTT broker.
  private configureBroker(): void {

    // Lockdown any attempts to send commands. We reserve those privileges for ourselves.
    this.broker.authorizePublish = (client, packet, callback): void => {

      // Match any strings that end in a command.
      const commandRegex = new RegExp("/command/[^/]+/?$", "gi");

      return callback(commandRegex.test(packet.topic) ? new Error("Command topics are reserved.") : null);
    };

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

        const deviceInfo = JSON.parse(payload) as haConfigJson;
        const mac = deviceInfo.unique_id.split("_")[1].toUpperCase();

        // Map the device name to the MAC address for future reference.
        this.mqttNameMac[deviceInfo["~"]] = mac;

        this.configureGdo(new URL(deviceInfo.device.configuration_url)?.hostname ?? "unknown", mac, deviceInfo["~"], deviceInfo.device.sw_version, Firmware.MQTT);
        return;
      }

      // Communicate garage door-related state changes.
      const topicMatch = statusRegex.exec(packet.topic);

      if(topicMatch) {

        const mac = this.mqttNameMac[topicMatch[1]];

        if(!mac) {

          this.log.error("No garage door has been configured in HomeKit for %s.", topicMatch[1]);
          return;
        }

        const garageDoor = this.configuredDevices[this.hap.uuid.generate(mac)];

        // If we can't find the garage door opener, we're done.
        if(!garageDoor) {

          return;
        }

        this.log.debug("Status update detected: %s (%s): %s - %s", topicMatch[1], this.mqttNameMac[topicMatch[1]], topicMatch[2], payload);

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

  // Configure and connect to Ratgdo ESPHome clients.
  private configureEspHome(): void {

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

    // Instantiate our mDNS stack.
    const mdns = new Bonjour();

    // Make sure we cleanup our mDNS client on shutdown.
    this.api.on(APIEvent.SHUTDOWN, () => {

      mdns.destroy();
    });

    // ESPHome device discovery.
    const mdnsBrowser = mdns.find({type: "esphomelib"});

    // Add an ESPHome device.
    mdnsBrowser.on("up", (service: Service) => {

      // We're only interested in Ratgdo devices with valid IP addresses. Otherwise, we're done.
      if(((service.txt as Record<string, string>).project_name !== "ratgdo.esphome") || !service.addresses) {

        return;
      }

      // We grab the first address provided for the ESPHome device.
      const address = service.addresses[0];

      // Grab the MAC address. We uppercase it and put it in the familiar colon notation first.
      const mac = (service.txt as Record<string, string>).mac.toUpperCase().replace(/(.{2})(?=.)/g, "$1:");

      // Configure the device.
      const ratgdoAccessory = this.configureGdo(address, mac, (service.txt as Record<string, string>).friendly_name, (service.txt as Record<string, string>).version,
        Firmware.ESPHOME);

      // If we've already configured this one, we're done.
      if(!ratgdoAccessory) {

        return;
      }

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

                  break;
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

          ratgdoAccessory.log.error("Ratgdo API: Error: %s", error.message);
        }
      }
    });

    // Refresh device detection, just in case we missed it in setting up the listener.
    mdnsBrowser.update();

    // Refresh device discovery regular intervals.
    setInterval(() => mdnsBrowser.update(), RATGDO_AUTODISCOVERY_INTERVAL * 1000);
  }

  // Configure a discovered garage door opener.
  private configureGdo(address: string, mac: string, name: string, firmwareVersion: string, type: Firmware): RatgdoAccessory | null {

    // Generate this device's unique identifier.
    const uuid = this.hap.uuid.generate(mac);

    // See if we already know about this accessory or if it's truly new.
    let accessory = this.accessories.find(x => x.UUID === uuid);

    // Our device details.
    const device = {

      address: address,
      firmwareVersion: firmwareVersion,
      mac: mac.replace(/:/g, ""),
      name: name,
      type: type
    };

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
      return null;
    }

    // If we've already configured this device before, we're done.
    if(this.configuredDevices[uuid]) {

      return null;
    }

    // Inform the user.
    this.log.info("Discovered: %s (address: %s mac: %s firmware: v%s).", device.name, device.address, device.mac, device.firmwareVersion);

    // It's a new device - let's add it to HomeKit.
    if(!accessory) {

      accessory = new this.api.platformAccessory(device.name, uuid);

      // Register this accessory with Homebridge and add it to the accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    // Add it to our list of configured devices.
    this.configuredDevices[uuid] = new RatgdoAccessory(this, accessory, device);

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories([accessory]);

    return this.configuredDevices[uuid];
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
