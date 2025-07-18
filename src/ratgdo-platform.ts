/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-platform.ts: homebridge-ratgdo platform class.
 */
import type { API, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { Bonjour, type Service } from "bonjour-service";
import { type DeviceInfo, EspHomeClient } from "./ratgdo-api.js";
import { type EspHomeEvent, RatgdoAccessory } from "./ratgdo-device.js";
import { EventSource, type MessageEvent } from "undici";
import { FeatureOptions, MqttClient, type Nullable, sanitizeName } from "homebridge-plugin-utils";
import { PLATFORM_NAME, PLUGIN_NAME, RATGDO_API_HEARTBEAT_DURATION, RATGDO_AUTODISCOVERY_INTERVAL, RATGDO_AUTODISCOVERY_PROJECT_NAMES, RATGDO_AUTODISCOVERY_TYPES,
  RATGDO_MQTT_TOPIC } from "./settings.js";
import { type RatgdoOptions, featureOptionCategories, featureOptions } from "./ratgdo-options.js";
import { APIEvent } from "homebridge";
import { RatgdoVariant } from "./ratgdo-types.js";
import util from "node:util";

export class RatgdoPlatform implements DynamicPlatformPlugin {

  private readonly accessories: PlatformAccessory[];
  public readonly api: API;
  private discoveredDevices: { [index: string]: boolean };
  private listeners:{ [index: string]: { [index: string]: (() => NodeJS.Timeout | void) | ((event: Event) => void) }};
  public readonly espHomeApi: { [index: string]: EspHomeClient };
  private readonly espHomeEvents: { [index: string]: EventSource };
  private readonly heartbeatTimers: { [index: string]: NodeJS.Timeout };
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
    this.espHomeApi = {};
    this.espHomeEvents = {};
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, config?.options);
    this.hap = api.hap;
    this.listeners = {};
    this.log = log;
    this.log.debug = this.debug.bind(this);
    this.mqtt = null;
    this.heartbeatTimers = {};

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

      // Stop any open heartbeat timers.
      Object.values(this.heartbeatTimers).map(timer => clearTimeout(timer));

      // Cleanup and close our events connection.
      Object.keys(this.espHomeEvents).map(mac => {

        this.espHomeEvents[mac].removeEventListener("log", this.listeners[mac].log);
        delete this.listeners[mac].log;

        this.espHomeEvents[mac].close();
      });

      // Cleanup and close our API connection.
      Object.keys(this.listeners).map(mac => {

        Object.keys(this.listeners[mac]).map(event => {

          this.espHomeApi[mac].off(event, this.listeners[mac][event]);
          delete this.listeners[mac][event];

        });

        this.espHomeApi[mac]?.disconnect();

        delete this.espHomeApi[mac];
      });

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

    // The EventSource API client is currently flagged as experimental in undici, though it's quite stable and solid already. We work around this issue by forcibly
    // filtering out the warning.
    process.removeAllListeners("warning").on("warning", (warning: NodeJS.ErrnoException) => {

      if((warning.code === "UNDICI-ES") && (warning.message === "EventSource is experimental, expect them to change at any time.")) {

        return;
      }

      // eslint-disable-next-line no-console
      console.warn(warning);
    });

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

    // We're only interested in ESPHome Ratgdo devices (and compatible variants) with valid MAC and IP addresses. Otherwise, we're done.
    if((!service.txt?.esphome_version && !service.txt?.version) || !service.txt?.mac || !service.addresses ||
      !RATGDO_AUTODISCOVERY_PROJECT_NAMES.some(project => (service.txt as Record<string, string>)?.project_name?.match(project))) {

      return;
    }

    // We grab the first address provided for the ESPHome device.
    const address = service.addresses[0];

    // Configure the device.
    const ratgdo = this.configureGdo(address, (service.txt as Record<string, string>).mac, service.txt);

    // If we've already configured this one, we're done.
    if(!ratgdo) {

      return;
    }

    this.listeners[ratgdo.device.mac] = {};

    // Battery status is only available to us through log entries made by the SSE/EventSource API. The native API doesn't expose battery state yet.
    if(ratgdo.hints.discoBattery) {

      // Connect to the Ratgdo ESPHome events API.
      this.espHomeEvents[ratgdo.device.mac] = new EventSource("http://" + address + "/events");

      // Capture log updates from the controller.
      this.espHomeEvents[ratgdo.device.mac].addEventListener("log", this.listeners[ratgdo.device.mac].log = (event: Event): void => {

        const message = event as MessageEvent<string>;

        ratgdo.log.debug("Log event received: %s", util.inspect(message.data, { sorted: true }));

        // Ratgdo occasionally sends empty status updates - we ignore them.
        if(!message.data.length) {

          return;
        }

        // Grab the battery state, when logged.
        const batteryState = message.data.match(/\bBattery state=(.+?)\b/);

        // We've got a battery state update, inform the Ratgdo.
        if(batteryState) {

          ratgdo.log.debug("BATTERY STATE UPDATE: \"%s\"", batteryState[1]);

          ratgdo.updateState({ id: "battery", state: batteryState[1] });
        }
      });
    }

    this.espHomeApi[ratgdo.device.mac] = new EspHomeClient(ratgdo.log, address);

    // Kickoff our heartbeats only the very first time we connect.
    this.espHomeApi[ratgdo.device.mac].once("connect", (info: DeviceInfo) => this.beat(ratgdo, { info }));

    // Reconnect on disconnect.
    this.espHomeApi[ratgdo.device.mac].on("disconnect", this.listeners[ratgdo.device.mac].disconnect = (reason?: string): void => {

      if(reason === "encryption unsupported") {

        ratgdo.updateState({ id: "availability", state: "offline" });

        this.log.error("Encrypted API communication is not currently supported. Please disable it in your Ratgdo firmware configuration.");

        return;
      }

      this.beat(ratgdo, { reconnecting: true, updateState: false});
    });

    // Heartbeat our Ratgdo.
    this.espHomeApi[ratgdo.device.mac].on("message", this.listeners[ratgdo.device.mac].message = (): void => this.beat(ratgdo));

    // Process telemetry from the Ratgdo.
    this.espHomeApi[ratgdo.device.mac].on("telemetry", (data: { type: string, currentOperation?: number, entity: string, position?: number, value: string | number }) => {

      const payload: EspHomeEvent = { id: (data.type + "-" + data.entity).replace(/ /g, "_").toLowerCase(), state: "" };

      switch(data.type) {

        case "binary_sensor":
        case "light":
        case "switch":

          payload.state = data.value ? "ON" : "OFF";

          break;

        case "cover":
        case "door_cover":

          // data: {"id":"cover-door","value":0,"state":"CLOSED","current_operation":"IDLE","position":0}
          payload.state = data.position ? "OPEN" : "CLOSED";

          switch(data.currentOperation) {

            case 1:

              // eslint-disable-next-line camelcase
              payload.current_operation = "OPENING";

              break;

            case 2:

              // eslint-disable-next-line camelcase
              payload.current_operation = "CLOSING";

              break;

            case undefined:
            case 0:
            default:

              // eslint-disable-next-line camelcase
              payload.current_operation = "IDLE";

              break;

          }

          payload.position = data.position;

          break;

        case "lock":

          switch(data.value) {

            case 1:

              payload.state = "LOCKED";

              break;

            case 2:

              payload.state = "UNLOCKED";

              break;

            default:

              payload.state = "UNKNOWN";

              break;
          }

          break;

        case "button":
        case "sensor":
        case "text_sensor":
        default:

          payload.state = (typeof data.value === "number") ? data.value.toString() : data.value;

          break;
      }

      ratgdo.updateState(payload);
    });


    this.espHomeApi[ratgdo.device.mac].connect();
  }

  // Configure a discovered garage door opener.
  private configureGdo(address: string, mac: string, deviceInfo: Record<string, string>): Nullable<RatgdoAccessory> {

    // We uppercase the MAC and normalize it to the familiar colon notation before we do anything else.
    mac = mac.toUpperCase().replace(/(.{2})(?=.)/g, "$1:");

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

      accessory = new this.api.platformAccessory(sanitizeName(device.name), uuid);

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

  // Heartbeat the Ratgdo.
  private beat(ratgdo: RatgdoAccessory, options: Partial<{ info: DeviceInfo, reconnecting: boolean, updateState: boolean }> = {}): void {

    options.reconnecting ??= false;
    options.updateState ??= true;

    if(options.info) {

      ratgdo.device.model = options.info.projectVersion;
    }

    if(this.heartbeatTimers[ratgdo.device.mac]) {

      clearTimeout(this.heartbeatTimers[ratgdo.device.mac]);
      clearTimeout(this.heartbeatTimers[ratgdo.device.mac + ".reconnect"]);

      delete this.heartbeatTimers[ratgdo.device.mac];
      delete this.heartbeatTimers[ratgdo.device.mac + ".reconnect"];
    }

    if(options.updateState) {

      ratgdo.updateState({ id: "availability", state: "online" });
    } else if(options.reconnecting) {

      ratgdo.updateState({ id: "availability", state: "offline" });
    }

    // Reset our timer.
    this.heartbeatTimers[ratgdo.device.mac] = setTimeout(() => {

      // The API instance is no longer available due to plugin shutdown. We're done.
      if(!this.espHomeApi[ratgdo.device.mac]) {

        return;
      }

      // No heartbeat detected. Let's attempt to reconnect, unless we already have one inflight.
      if(!options.reconnecting) {

        this.espHomeApi[ratgdo.device.mac].disconnect();
      }

      this.heartbeatTimers[ratgdo.device.mac + ".reconnect"] = setTimeout(() => {

        this.espHomeApi[ratgdo.device.mac].connect();
        this.beat(ratgdo, { updateState: false });
      }, 2000);
    }, (options.reconnecting ? 0.5 : RATGDO_API_HEARTBEAT_DURATION) * 1000);
  }

  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debug) {

      this.log.warn(util.format(message, ...parameters));
    }
  }
}
