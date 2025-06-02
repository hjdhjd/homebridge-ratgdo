/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-platform.ts: homebridge-ratgdo platform class.
 */
import type { API, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { Bonjour, type Service } from "bonjour-service";
import { FeatureOptions, MqttClient, type Nullable, validateName } from "homebridge-plugin-utils";
import { PLATFORM_NAME, PLUGIN_NAME, RATGDO_AUTODISCOVERY_INTERVAL, RATGDO_AUTODISCOVERY_PROJECT_NAMES, RATGDO_AUTODISCOVERY_TYPES, RATGDO_EVENT_API_HEARTBEAT_DURATION,
  RATGDO_HEARTBEAT_DURATION, RATGDO_HEARTBEAT_INTERVAL, RATGDO_MQTT_TOPIC } from "./settings.js";
import { type RatgdoOptions, featureOptionCategories, featureOptions } from "./ratgdo-options.js";
import { APIEvent } from "homebridge";
import { EventSource } from "eventsource";
import { RatgdoAccessory } from "./ratgdo-device.js";
import { RatgdoVariant } from "./ratgdo-types.js";
import net from "node:net";
import util from "node:util";

export class RatgdoPlatform implements DynamicPlatformPlugin {

  private readonly accessories: PlatformAccessory[];
  public readonly api: API;
  private discoveredDevices: { [index: string]: boolean };
  private readonly espHomeEvents: { [index: string]: EventSource };
  private readonly pingTimers: { [index: string]: NodeJS.Timeout };
  public featureOptions: FeatureOptions;
  public config: RatgdoOptions;
  public readonly configOptions: string[];
  public readonly configuredDevices: { [index: string]: RatgdoAccessory };
  public readonly hap: HAP;
  public readonly log: Logging;
  public readonly mqtt: Nullable<MqttClient>;

  constructor(log: Logging, config: PlatformConfig, api: API) {

    this.accessories = [];
    this.api = api;
    this.config = {};
    this.configOptions = [];
    this.configuredDevices = {};
    this.discoveredDevices = {};
    this.espHomeEvents = {};
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, config?.options);
    this.hap = api.hap;
    this.log = log;
    this.log.debug = this.debug.bind(this);
    this.mqtt = null;
    this.pingTimers = {};

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

    // Make sure we take ourselves offline when we shutdown.
    api.on(APIEvent.SHUTDOWN, () => {

      // Close our events connection.
      Object.values(this.espHomeEvents).map(deviceEvents => deviceEvents.close());

      // Clear any open ping timers.
      Object.values(this.pingTimers).map(timer => clearTimeout(timer));

      // Inform our accessories we're going offline.
      Object.values(this.configuredDevices).map(device => device.updateState({ id: "availability", state: "offline" }));
    });
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
    for(const mdnsType of RATGDO_AUTODISCOVERY_TYPES) {

      const mdnsBrowser = mdns.find({ type: mdnsType }, this.discoverRatgdoDevice.bind(this));

      // Trigger an initial update of our discovery.
      mdnsBrowser.update();

      // Refresh device discovery regular intervals.
      setInterval(() => mdnsBrowser.update(), RATGDO_AUTODISCOVERY_INTERVAL * 1000);
    }
  }

  // Ratgdo ESPHome device discovery.
  private discoverRatgdoDevice(service: Service): void {

    // Define the EventSource error message type.
    interface ESError {

      message?: string,
      status?: number,
      type: string
    }

    // We're only interested in ESPHome Ratgdo devices (and compatible variants) with valid MAC and IP addresses. Otherwise, we're done.
    if((!service.txt?.esphome_version && !service.txt?.version) || !service.txt?.mac || !service.addresses ||
      !RATGDO_AUTODISCOVERY_PROJECT_NAMES.some(project => (service.txt as Record<string, string>)?.project_name?.match(project))) {

      return;
    }

    // We grab the first address provided for the ESPHome device.
    const address = service.addresses[0];

    // Grab the MAC address. We uppercase it and put it in the familiar colon notation first.
    const mac = (service.txt as Record<string, string>).mac.toUpperCase().replace(/(.{2})(?=.)/g, "$1:");

    // Configure the device.
    const ratgdoAccessory = this.configureGdo(address, mac, service.txt);

    // If we've already configured this one, we're done.
    if(!ratgdoAccessory) {

      return;
    }

    try {

      // Connect to the Ratgdo ESPHome events API.
      this.espHomeEvents[mac] = new EventSource("http://" + address + "/events");

      // Handle errors in the events API.
      this.espHomeEvents[mac].addEventListener("error", (payload: ESError) => {

        // The eventsource library returns unknown network errors at times. We ignore them.
        if(typeof payload.message === "undefined") {

          return;
        }

        const getErrorMessage = (payload: ESError): string => {

          const { message } = payload;
          const errorMessage = "Unrecognized error: " + util.inspect(payload, { sorted: true });

          if(typeof message !== "string") {

            return errorMessage;
          }

          if(message.startsWith("connect ECONNREFUSED ")) {

            return "Connection to the Ratgdo controller refused";
          }

          if(message.startsWith("connect ETIMEDOUT ")) {

            return "Connection to the Ratgdo controller has timed out";
          }

          if(message.startsWith("connect EHOSTDOWN ")) {

            return "Unable to connect to the Ratgdo controller. The host appears to be down";
          }

          const errorMessages: { [index: string]: string } = {

            "read ECONNRESET": "Connection to the Ratgdo controller has been reset",
            "read ETIMEDOUT": "Connection to the Ratgdo controller has timed out while listening for events",
            "unknown error.": "An unknown error on the Ratgdo controller has occurred. This will happen occasionally and can generally be ignored"
          };

          return errorMessages[message] ?? errorMessage;
        };

        ratgdoAccessory.log.error("%s.", getErrorMessage(payload));
      });

      // Inform the user when we've successfully connected.
      this.espHomeEvents[mac].addEventListener("open", () => {

        ratgdoAccessory.updateState({ id: "availability", state: "online" });
      });

      // Inform the user about the availability of the events API.
      this.espHomeEvents[mac].addEventListener("ping", () => {

        if(this.pingTimers[mac]) {

          clearTimeout(this.pingTimers[mac]);
          delete this.pingTimers[mac];
        }

        ratgdoAccessory.updateState({ id: "availability", state: "online" });

        this.pingTimers[mac] = setTimeout(() => ratgdoAccessory.updateState({ id: "availability", state: "offline" }), RATGDO_EVENT_API_HEARTBEAT_DURATION * 1000);
      });

      // Capture log updates from the controller.
      this.espHomeEvents[mac].addEventListener("log", (message: MessageEvent<string>) => {

        ratgdoAccessory.log.debug("Log event received: %s", util.inspect(message.data, { sorted: true }));

        // Ratgdo occasionally sends empty status updates - we ignore them.
        if(!message.data.length) {

          return;
        }

        // Grab the battery state, when logged.
        const batteryState = message.data.match(/\bBattery state=(.+?)\b/);

        // We've got a battery state update, inform the Ratgdo.
        if(batteryState) {

          ratgdoAccessory.updateState({ id: "battery", state: batteryState[1] });
        }
      });

      // Capture state updates from the controller.
      this.espHomeEvents[mac].addEventListener("state", (message: MessageEvent<string>) => {

        let event;

        ratgdoAccessory.log.debug("State event received: %s", util.inspect(message.data, { sorted: true }));

        // Ratgdo occasionally sends empty status updates - we ignore them.
        if(!message.data.length) {

          return;
        }

        try {

          event = JSON.parse(message.data);
        } catch(error) {

          ratgdoAccessory.log.error("Unable to parse state message: \"%s\". Invalid JSON.", message.data);

          return;
        }

        ratgdoAccessory.updateState(event);
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
  private configureGdo(address: string, mac: string, deviceInfo: Record<string, string>): Nullable<RatgdoAccessory> {

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
      firmwareVersion: deviceInfo.version ?? deviceInfo.esphome_version,
      mac: mac.replace(/:/g, ""),
      name: deviceInfo.friendly_name ?? "Ratgdo",
      variant: (deviceInfo.project_name === "ratgdo.esphome") ? RatgdoVariant.RATGDO : RatgdoVariant.KONNECTED
    };

    // Inform the user that we've discovered a device.
    this.log.info("Discovered: %s (address: %s mac: %s ESPHome firmware: v%s variant: %s).", device.name, device.address, device.mac, device.firmwareVersion,
      device.variant);

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

      accessory = new this.api.platformAccessory(validateName(device.name), uuid);

      // Register this accessory with Homebridge and add it to the accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    // Inform the user.
    this.log.info("Configuring: %s (address: %s mac: %s ESPHome firmware: v%s variant: %s).", device.name, device.address, device.mac, device.firmwareVersion,
      device.variant);

    // Add it to our list of configured devices.
    this.configuredDevices[uuid] = new RatgdoAccessory(this, accessory, device);

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories([accessory]);

    return this.configuredDevices[uuid];
  }

  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debug) {

      this.log.warn(util.format(message, ...parameters));
    }
  }
}
