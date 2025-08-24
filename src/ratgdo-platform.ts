/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-platform.ts: homebridge-ratgdo platform class.
 */
import type { API, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { Bonjour, type Service } from "bonjour-service";
import { type DeviceInfo, EspHomeClient, type LogEventData, LogLevel, type TelemetryEvent } from "esphome-client";
import { type EspHomeEvent, RatgdoAccessory } from "./ratgdo-device.js";
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
  private listeners:{ [index: string]: { [index: string]: (() => NodeJS.Timeout | void) | ((event: Event) => void) | ((logEntry: LogEventData) => void) }};
  public readonly espHomeApi: { [index: string]: EspHomeClient };
  private readonly heartbeatTimers: { [index: string]: NodeJS.Timeout };
  public featureOptions: FeatureOptions;
  public config: RatgdoOptions;
  public readonly configOptions: string[];
  public readonly configuredDevices: { [index: string]: RatgdoAccessory | undefined };
  public readonly hap: HAP;
  public readonly log: Logging;
  public readonly mqtt: Nullable<MqttClient>;

  constructor(log: Logging, config: PlatformConfig | undefined, api: API) {

    this.accessories = [];
    this.api = api;
    this.config = {};
    this.configOptions = [];
    this.configuredDevices = {};
    this.discoveredDevices = {};
    this.espHomeApi = {};
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

      // Cleanup and close our API connection.
      Object.keys(this.listeners).map(mac => {

        Object.keys(this.listeners[mac]).map(event => {

          this.espHomeApi[mac].off(event, this.listeners[mac][event]);
          delete this.listeners[mac][event];

        });

        this.espHomeApi[mac].disconnect();

        delete this.espHomeApi[mac];
      });

      // Inform our accessories we're going offline.
      Object.values(this.configuredDevices).map(device => device?.updateState({ id: "availability", state: "offline" }));
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

    // We're only interested in ESPHome Ratgdo devices (and compatible variants) with valid MAC and IP addresses. Otherwise, we're done.
    if((!service.txt?.esphome_version && !service.txt?.version) || !service.txt?.mac || !service.addresses ||
      !RATGDO_AUTODISCOVERY_PROJECT_NAMES.some(project => (service.txt as Partial<Record<string, string>>).project_name?.match(project))) {

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

    this.espHomeApi[ratgdo.device.mac] = new EspHomeClient({

      clientId: "homebridge-ratgdo",
      host: address,
      logger: ratgdo.log,
      psk: this.featureOptions.value("Device.Encryption.Key", ratgdo.device.mac)
    });

    // Kickoff our heartbeats only the very first time we connect.
    this.espHomeApi[ratgdo.device.mac].once("deviceInfo", (info: DeviceInfo) => {

      this.beat(ratgdo, { encrypted: this.espHomeApi[ratgdo.device.mac].isEncrypted, info });

      // Heartbeat our Ratgdo.
      this.espHomeApi[ratgdo.device.mac].on("message", this.listeners[ratgdo.device.mac].message = (): void => this.beat(ratgdo));
    });

    // Reconnect on disconnect.
    this.espHomeApi[ratgdo.device.mac].on("disconnect", this.listeners[ratgdo.device.mac].disconnect = (reason?: string): void => {

      switch(reason) {

        case "encryption key invalid":
        case "encryption key missing":

          ratgdo.updateState({ id: "availability", state: "offline" });

          ratgdo.log.error("%s encryption key. Please ensure you configure HBR with the correct base64-encoded encryption key for this device.",
            (reason === "encryption key invalid") ? "Invalid" : "Missing");

          break;

        default:

          this.beat(ratgdo, { reconnecting: true, updateState: false});

          break;
      }
    });

    // Process telemetry from the Ratgdo.
    this.espHomeApi[ratgdo.device.mac].on("telemetry", (data: TelemetryEvent) => {

      const payload: EspHomeEvent = { id: (data.type + "-" + data.entity).replace(/ /g, "_").toLowerCase(), state: "" };

      ratgdo.log.debug("%s", util.inspect(data, { colors: true, depth: null, sorted: true}));

      switch(data.type) {

        case "binary_sensor":
        case "switch":

          payload.state = data.state ? "ON" : "OFF";

          break;

        case "cover":
        // @ts-expect-error For Konnected devices, they use door_cover instead of cover. We capture it here, but it doesn't really comply with ESPHome's client protocol.
        // eslint-disable-next-line no-fallthrough
        case "door_cover":

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

        case "light":

          payload.state = data.state ? "ON" : "OFF";

          break;

        case "lock":

          switch(data.state) {

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

          payload.state = data.pressed ? "PRESSED" : "";

          break;

        case "sensor":

          payload.state = (typeof data.state === "number") ? data.state.toString() : "";

          break;

        default:

          break;
      }

      ratgdo.updateState(payload);
    });

    // Battery status is only available to us through log entries made by the Ratgdo.
    if(ratgdo.hints.discoBattery) {

      // Subscribe to our logs when we connect.
      this.espHomeApi[ratgdo.device.mac].on("connect",
        this.listeners[ratgdo.device.mac].logSubscribe = (): void => this.espHomeApi[ratgdo.device.mac].subscribeToLogs(LogLevel.VERBOSE));

      // Process log events from the Ratgdo.
      this.espHomeApi[ratgdo.device.mac].on("log", this.listeners[ratgdo.device.mac].log = (logEntry: LogEventData): void => {

        ratgdo.log.debug("Log event received: %s", util.inspect(logEntry, { sorted: true }));

        // Ratgdo occasionally sends empty status updates - we ignore them.
        if(!logEntry.message.length) {

          return;
        }

        // Grab the battery state, when logged.
        const batteryState = logEntry.message.match(/\bBattery state=(.+?)\b/);

        // We've got a battery state update, inform the Ratgdo.
        if(batteryState) {

          let actualState;

          // Unfortunately, the current Ratgdo firmwares seems to conflate charging and full status. We workaround that here.
          switch(batteryState[1]) {

            case "CHARGING":

              actualState = "FULL";

              break;

            case "FULL":

              actualState = "CHARGING";

              break;

            default:

              actualState = batteryState[1];

              break;
          }

          ratgdo.log.debug("Battery state update: \"%s\" mapping it to: %s", batteryState[1], actualState);
          ratgdo.updateState({ id: "battery", state: actualState });
        }
      });
    }

    this.espHomeApi[ratgdo.device.mac].connect();
  }

  // Configure a discovered garage door opener.
  private configureGdo(address: string, mac: string, deviceInfo: Partial<Record<string, string>>): Nullable<RatgdoAccessory> {

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
      firmwareVersion: deviceInfo.version ?? deviceInfo.esphome_version ?? "0.0.0",
      mac: mac.replace(/:/g, ""),
      model: deviceInfo.project_version,
      name: this.featureOptions.value("Device.LogName", mac.replace(/:/g, "")) ?? deviceInfo.friendly_name ?? "Ratgdo",
      variant: (deviceInfo.project_name === "ratgdo.esphome") ? RatgdoVariant.RATGDO : RatgdoVariant.KONNECTED
    };

    // Inform the user that we've discovered a device.
    this.log.info("Discovered: %s (address: %s mac: %s firmware: v%s variant: %s%s).", device.name, device.address, device.mac, device.firmwareVersion,
      device.variant, device.model ? (" [" + device.model + "]") : "");

    // Mark it as discovered.
    this.discoveredDevices[mac] = true;

    // Check to see if the user has disabled the device.
    if(!this.featureOptions.test("Device", device.mac)) {

      // If the accessory already exists, let's remove it.
      if(accessory) {

        // Inform the user.
        this.log.info("%s: Removing device from HomeKit.", accessory.displayName);

        // Unregister the accessory and delete it's remnants from HomeKit.
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
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
    this.log.info("Configuring: %s (address: %s mac: %s firmware: v%s variant: %s%s).", device.name, device.address, device.mac, device.firmwareVersion,
      device.variant, device.model ? (" [" + device.model + "]") : "");

    // Add it to our list of configured devices.
    this.configuredDevices[uuid] = new RatgdoAccessory(this, accessory, device);

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories([accessory]);

    return this.configuredDevices[uuid];
  }

  // Heartbeat the Ratgdo.
  private beat(ratgdo: RatgdoAccessory, options: Partial<{ encrypted: boolean, info: DeviceInfo, reconnecting: boolean, updateState: boolean }> = {}): void {

    options.reconnecting ??= false;
    options.updateState ??= true;

    if(options.info) {

      ratgdo.device.model = options.info.projectVersion;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(this.heartbeatTimers[ratgdo.device.mac]) {

      clearTimeout(this.heartbeatTimers[ratgdo.device.mac]);
      clearTimeout(this.heartbeatTimers[ratgdo.device.mac + ".reconnect"]);

      delete this.heartbeatTimers[ratgdo.device.mac];
      delete this.heartbeatTimers[ratgdo.device.mac + ".reconnect"];
    }

    if(options.updateState) {

      ratgdo.updateState({ id: "availability", state: "online", ...(options.encrypted !== undefined && { value: options.encrypted ? "encrypted" : "unencrypted" }) });
    } else if(options.reconnecting) {

      ratgdo.updateState({ id: "availability", state: "offline" });
    }

    // Reset our timer.
    this.heartbeatTimers[ratgdo.device.mac] = setTimeout(() => {

      // The API instance is no longer available due to plugin shutdown. We're done.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
