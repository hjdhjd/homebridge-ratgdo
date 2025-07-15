/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-device.ts: Base class for all Ratgdo devices.
 */
import type { API, CharacteristicValue, HAP, PlatformAccessory } from "homebridge";
import { type HomebridgePluginLogging, type Nullable, acquireService, sanitizeName, validService } from "homebridge-plugin-utils";
import { RATGDO_MOTION_DURATION, RATGDO_OCCUPANCY_DURATION } from "./settings.js";
import { type RatgdoDevice, RatgdoReservedNames, RatgdoVariant } from "./ratgdo-types.js";
import type { RatgdoOptions } from "./ratgdo-options.js";
import type { RatgdoPlatform } from "./ratgdo-platform.js";
import util from "node:util";

// ESPHome EventSource state messages.
export interface EspHomeEvent {

  current_operation?: string,
  id: string,
  name?: string,
  position?: number,
  state: string,
  value?: string
}

// Device-specific options and settings.
interface RatgdoHints {

  automationDimmer: boolean,
  automationSwitch: boolean,
  discoBattery: boolean,
  discoLaserSwitch: boolean,
  discoLedSwitch: boolean,
  discoVehicleArriving: boolean,
  discoVehicleLeaving: boolean,
  discoVehiclePresence: boolean,
  doorOpenOccupancyDuration: number,
  doorOpenOccupancySensor: boolean,
  konnectedPcwSwitch: boolean,
  konnectedStrobeSwitch: boolean,
  light: boolean,
  lock: boolean,
  lockoutSwitch: boolean,
  logLight: boolean,
  logMotion: boolean,
  logObstruction: boolean,
  logOpener: boolean,
  logVehiclePresence: boolean,
  motionOccupancyDuration: number,
  motionOccupancySensor: boolean,
  motionSensor: boolean,
  readOnly: boolean,
  showBatteryInfo: boolean
}

// Ratgdo status information.
interface RatgdoStatus {

  availability: boolean,
  discoLaser: boolean,
  discoLed: boolean,
  discoBatteryState: CharacteristicValue,
  discoVehicleArriving: boolean,
  discoVehicleLeaving: boolean,
  discoVehiclePresence: boolean,
  door: CharacteristicValue,
  doorPosition: number,
  konnectedStrobe: boolean,
  light: boolean,
  lock: CharacteristicValue,
  motion: boolean,
  obstruction: boolean
}

export class RatgdoAccessory {

  private readonly accessory: PlatformAccessory;
  private readonly api: API;
  private readonly config: RatgdoOptions;
  public readonly device: RatgdoDevice;
  private doorOccupancyTimer: Nullable<NodeJS.Timeout>;
  private readonly hap: HAP;
  public readonly hints: RatgdoHints;
  public readonly log: HomebridgePluginLogging;
  private motionOccupancyTimer: Nullable<NodeJS.Timeout>;
  private motionTimer: Nullable<NodeJS.Timeout>;
  private obstructionTimer: Nullable<NodeJS.Timeout>;
  private readonly platform: RatgdoPlatform;
  private readonly status: RatgdoStatus;

  // The constructor initializes key variables and calls configureDevice().
  constructor(platform: RatgdoPlatform, accessory: PlatformAccessory, device: RatgdoDevice) {

    this.accessory = accessory;
    this.api = platform.api;
    this.status = {} as RatgdoStatus;
    this.config = platform.config;
    this.hap = this.api.hap;
    this.hints = {} as RatgdoHints;
    this.device = device;
    this.platform = platform;

    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => platform.debug(util.format(this.name + ": " + message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => platform.log.error(util.format(this.name + ": " + message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => platform.log.info(util.format(this.name + ": " + message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => platform.log.warn(util.format(this.name + ": " + message, ...parameters))
    };

    // Initialize our internal state.
    this.status.availability = false;
    this.status.discoLaser = false;
    this.status.discoLed = false;
    this.status.discoBatteryState = false;
    this.status.discoVehicleArriving = false;
    this.status.discoVehicleLeaving = false;
    this.status.discoVehiclePresence = false;
    this.status.door = this.hap.Characteristic.CurrentDoorState.CLOSED;
    this.status.doorPosition = 0;
    this.status.konnectedStrobe = false;
    this.status.light = false;
    this.status.lock = this.hap.Characteristic.LockCurrentState.UNSECURED;
    this.status.motion = false;
    this.status.obstruction = false;
    this.doorOccupancyTimer = null;
    this.motionOccupancyTimer = null;
    this.motionTimer = null;
    this.obstructionTimer = null;

    this.configureDevice();
  }

  // Configure a garage door accessory for HomeKit.
  private configureDevice(): void {

    // Clean out the context object.
    this.accessory.context = {};

    // Configure ourselves.
    this.configureHints();
    this.configureInfo();
    this.configureGarageDoor();
    this.configureMqtt();
    this.configureAutomationDoorPositionDimmer();
    this.configureAutomationDoorSwitch();
    this.configureAutomationLockoutSwitch();
    this.configureDoorOpenOccupancySensor();
    this.configureLight();
    this.configureMotionSensor();
    this.configureMotionOccupancySensor();

    // Configure Ratgdo (ESP32) Disco-specific features.
    this.configureDiscoBattery();
    this.configureDiscoLaserSwitch();
    this.configureDiscoLedSwitch();
    this.configureDiscoVehicleArrivingContactSensor();
    this.configureDiscoVehicleLeavingContactSensor();
    this.configureDiscoVehiclePresenceOccupancySensor();

    // Configure Konnected-specific features.
    this.configureKonnectedPcwSwitch();
    this.configureKonnectedStrobeSwitch();
  }

  // Configure device-specific settings.
  private configureHints(): boolean {

    this.hints.automationDimmer = this.hasFeature("Opener.Dimmer");
    this.hints.automationSwitch = this.hasFeature("Opener.Switch");
    this.hints.discoBattery = this.hasFeature("Disco.Battery");
    this.hints.discoLaserSwitch = this.hasFeature("Disco.Switch.Laser");
    this.hints.discoLedSwitch = this.hasFeature("Disco.Switch.Led");
    this.hints.discoVehicleArriving = this.hasFeature("Disco.ContactSensor.Vehicle.Arriving");
    this.hints.discoVehicleLeaving = this.hasFeature("Disco.ContactSensor.Vehicle.Leaving");
    this.hints.discoVehiclePresence = this.hasFeature("Disco.OccupancySensor.Vehicle.Presence");
    this.hints.doorOpenOccupancySensor = this.hasFeature("Opener.OccupancySensor");
    this.hints.doorOpenOccupancyDuration = this.platform.featureOptions.getInteger("Opener.OccupancySensor.Duration", this.device.mac) ?? RATGDO_OCCUPANCY_DURATION;
    this.hints.konnectedPcwSwitch = this.hasFeature("Konnected.Switch.Pcw");
    this.hints.konnectedStrobeSwitch = this.hasFeature("Konnected.Switch.Strobe");
    this.hints.light = this.hasFeature("Light");
    this.hints.lock = this.hasFeature("Opener.Lock");
    this.hints.logLight = this.hasFeature("Log.Light");
    this.hints.logMotion = this.hasFeature("Log.Motion");
    this.hints.logObstruction = this.hasFeature("Log.Obstruction");
    this.hints.logOpener = this.hasFeature("Log.Opener");
    this.hints.logVehiclePresence = this.hasFeature("Log.VehiclePresence");
    this.hints.lockoutSwitch = this.hasFeature("Opener.Switch.RemoteLockout");
    this.hints.motionOccupancySensor = this.hasFeature("Motion.OccupancySensor");
    this.hints.motionOccupancyDuration = this.platform.featureOptions.getInteger("Motion.OccupancySensor.Duration", this.device.mac) ?? RATGDO_OCCUPANCY_DURATION;
    this.hints.motionSensor = this.hasFeature("Motion");
    this.hints.readOnly = this.hasFeature("Opener.ReadOnly");

    if(this.hints.readOnly) {

      this.log.info("Garage door opener is read-only. The opener will not respond to open and close requests from HomeKit.");
    }

    return true;
  }

  // Configure the device information for HomeKit.
  private configureInfo(): boolean {

    // Update the manufacturer information for this device.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "github.com/hjdhjd");

    // Update the model information for this device.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Model,
      ((this.device.variant === RatgdoVariant.KONNECTED) ? "Konnected" : "Ratgdo") + (this.device.model ? " " + this.device.model : ""));

    // Update the serial number for this device.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.device.mac);

    // Update the firmware information for this device.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision,
      this.device.firmwareVersion);

    return true;
  }

  // Configure MQTT services.
  private configureMqtt(): boolean {

    // Return our garage door state.
    this.platform.mqtt?.subscribeGet(this.device.mac, "garagedoor", "Garage Door", () => {

      // Return our current status using our HomeKit current state decoder ring.
      return this.translateCurrentDoorState(this.status.door);
    });

    // Set our garage door state.
    this.platform.mqtt?.subscribeSet(this.device.mac, "garagedoor", "Garage Door", (value: string) => {

      const action = value.split(" ");
      let command;
      let position;

      switch(action[0]) {

        case "close":

          command = this.hap.Characteristic.TargetDoorState.CLOSED;

          break;

        case "open":

          command = this.hap.Characteristic.TargetDoorState.OPEN;

          // Parse the position information.
          position = parseFloat(action[1]);

          if(isNaN(position) || (position < 0) || (position > 100)) {

            position = undefined;
          }

          break;

        default:

          this.log.error("Invalid command.");

          return;
      }

      // Set our door state accordingly.
      this.setDoorState(command, position);
    });

    // Return our lock state.
    this.platform.mqtt?.subscribeGet(this.device.mac, "lock", "Lock", () => {

      return this.status.lock.toString();
    });

    // Return our obstruction state.
    this.platform.mqtt?.subscribeGet(this.device.mac, "obstruction", "Obstruction", () => {

      return this.status.obstruction.toString();
    });

    // Return our door open occupancy state if configured to do so.
    if(this.hints.doorOpenOccupancySensor) {

      this.platform.mqtt?.subscribeGet(this.device.mac, "dooropenoccupancy", "Door Open Indicator Occupancy", () => {

        return ((this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_DOOR_OPEN)
          ?.getCharacteristic(this.hap.Characteristic.OccupancyDetected).value ?? "false") as boolean).toString();
      });
    }

    // Return our light state if configured to do so.
    if(this.hints.light) {

      this.platform.mqtt?.subscribeGet(this.device.mac, "light", "Light", () => {

        return this.status.light.toString();
      });
    }

    // Return our motion occupancy state if configured to do so.
    if(this.hints.motionOccupancySensor) {

      this.platform.mqtt?.subscribeGet(this.device.mac, "occupancy", "Occupancy", () => {

        return ((this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_MOTION)
          ?.getCharacteristic(this.hap.Characteristic.OccupancyDetected).value ?? "false") as boolean).toString();
      });
    }

    // Return our motion state if configured to do so.
    if(this.hints.motionSensor) {

      this.platform.mqtt?.subscribeGet(this.device.mac, "motion", "Motion", () => {

        return this.status.motion.toString();
      });
    }

    return true;
  }

  // Configure the garage door service for HomeKit.
  private configureGarageDoor(): boolean {

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.GarageDoorOpener, this.name);

    if(!service) {

      this.log.error("Unable to add the garage door.");

      return false;
    }

    // Set the initial current and target door states to closed since ratgdo doesn't tell us initial state over MQTT on startup.
    service.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.status.door);
    service.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.doorTargetStateBias(this.status.door));

    // Handle HomeKit open and close events.
    service.getCharacteristic(this.hap.Characteristic.TargetDoorState).onSet((value: CharacteristicValue) => {

      this.setDoorState(value);
    });

    // Inform HomeKit of our current state.
    service.getCharacteristic(this.hap.Characteristic.CurrentDoorState).onGet(() => this.status.door);

    // Inform HomeKit of any obstructions.
    service.getCharacteristic(this.hap.Characteristic.ObstructionDetected).onGet(() => this.status.obstruction === true);


    // Configure the lock garage door lock current and target state characteristics if the user has enabled it.
    if(this.hints.lock) {

      service.getCharacteristic(this.hap.Characteristic.LockTargetState).onSet((value: CharacteristicValue) => {

        if(!this.command("lock", (value === this.hap.Characteristic.LockTargetState.SECURED) ? "lock" : "unlock")) {

          // Something went wrong. Let's make sure we revert the lock to it's prior state.
          setTimeout(() => {

            service?.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.lockTargetStateBias(this.status.lock));
            service?.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);
          }, 50);
        }
      });

      service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);
      service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.lockTargetStateBias(this.status.lock));
    } else {

      // Remove any remnants of our locks.
      [ this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockTargetState ]
        .map(characteristic => service.removeCharacteristic(service.getCharacteristic(characteristic)));
    }

    // Let HomeKit know that this is the primary service on this accessory.
    service.setPrimaryService(true);

    return true;
  }

  // Configure the light for HomeKit.
  private configureLight(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Lightbulb, this.hints.light)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Lightbulb, this.name, undefined, () => this.log.info("Enabling light."));

    if(!service) {

      this.log.error("Unable to add the light.");

      return false;
    }

    // Initialize the light.
    service.updateCharacteristic(this.hap.Characteristic.On, this.status.light);

    // Turn the light on or off.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.status.light);
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => this.command("light", value === true ? "on" : "off"));

    return true;
  }

  // Configure the motion sensor for HomeKit.
  private configureMotionSensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.MotionSensor, this.hints.motionSensor)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.MotionSensor, this.name, undefined, () => this.log.info("Enabling motion sensor."));

    if(!service) {

      this.log.error("Unable to add the motion sensor.");

      return false;
    }

    // Initialize the state of the motion sensor.
    service.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.status.availability);

    return true;
  }

  // Configure a dimmer to automate open and close events in HomeKit beyond what HomeKit might allow for a garage opener service that gets treated as a secure service.
  private configureAutomationDoorPositionDimmer(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Lightbulb, this.hints.automationDimmer, RatgdoReservedNames.DIMMER_OPENER_AUTOMATION)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Lightbulb, this.name + " Automation Door Position",
      RatgdoReservedNames.DIMMER_OPENER_AUTOMATION);

    if(!service) {

      this.log.error("Unable to add the automation door position dimmer.");

      return false;
    }

    // Return the current state of the opener. We're on if we are in any state other than closed (specifically open or stopped).
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED);

    // Close the opener. Opening is really handled in the brightness event.
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => {

      // We really only want to act when the opener is open. Otherwise, it's handled by the brightness event.
      if(value) {

        return;
      }

      // Inform the user.
      if(this.hints.logOpener) {

        this.log.info("Automation door position dimmer: closing.");
      }

      // Send the command.
      if(!this.setDoorState(this.hap.Characteristic.TargetDoorState.CLOSED)) {

        // Something went wrong. Let's make sure we revert the dimmer to it's prior state.
        setTimeout(() => service?.updateCharacteristic(this.hap.Characteristic.On, !value), 50);
      }
    });

    // Return the door position of the opener.
    service.getCharacteristic(this.hap.Characteristic.Brightness)?.onGet(() => this.status.doorPosition);

    // Adjust the door position of the opener by adjusting brightness of the light.
    service.getCharacteristic(this.hap.Characteristic.Brightness)?.onSet((value: CharacteristicValue) => {

      if(this.hints.logOpener) {

        this.log.info("Automation door position dimmer: moving opener to %s%.", (value as number).toFixed(0));
      }

      this.setDoorState((value as number) > 0 ?
        this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED, value as number);
    });

    // Initialize the dimmer.
    service.updateCharacteristic(this.hap.Characteristic.On, this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.status.doorPosition);

    this.log.info("Enabling the automation door position dimmer.");

    return true;
  }

  // Configure a switch to automate open and close events in HomeKit beyond what HomeKit might allow for a garage opener service that gets treated as a secure service.
  private configureAutomationDoorSwitch(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, this.hints.automationSwitch, RatgdoReservedNames.SWITCH_OPENER_AUTOMATION)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch, this.name + " Automation Opener", RatgdoReservedNames.SWITCH_OPENER_AUTOMATION);

    if(!service) {

      this.log.error("Unable to add the automation door opener switch.");

      return false;
    }

    // Return the current state of the opener. We're on if we are in any state other than closed (specifically open or stopped).
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED);

    // Open or close the opener.
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => {

      // Inform the user.
      if(this.hints.logOpener) {

        this.log.info("Automation door opener switch: %s.", value ? "open" : "close");
      }

      // Send the command.
      if(!this.setDoorState(value ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED)) {

        // Something went wrong. Let's make sure we revert the switch to it's prior state.
        setTimeout(() => service?.updateCharacteristic(this.hap.Characteristic.On, !value), 50);
      }
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED);

    this.log.info("Enabling the automation door opener switch.");

    return true;
  }

  // Configure the Ratgdo (ESP32) Disco-specific backup battery service.
  private configureDiscoBattery(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Battery, (this.device.variant === RatgdoVariant.RATGDO) && this.hints.discoBattery)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Battery, this.name);

    if(!service) {

      this.log.error("Unable to add the Ratgdo (ESP32) Disco backup battery status.");

      return false;
    }

    // Return the current state of the charging state.
    service.getCharacteristic(this.hap.Characteristic.ChargingState)?.onGet(() => this.status.discoBatteryState);

    // Initialize the charging state.
    service.updateCharacteristic(this.hap.Characteristic.ChargingState, this.status.discoBatteryState);

    this.log.info("Enabling the Ratgdo (ESP32) Disco backup battery status.");

    return true;
  }

  // Configure the Ratgdo (ESP32) Disco-specific parking assistance laser switch.
  private configureDiscoLaserSwitch(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, (this.device.variant === RatgdoVariant.RATGDO) && this.hints.discoLaserSwitch,
      RatgdoReservedNames.SWITCH_DISCO_LASER)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch, this.name + " Laser", RatgdoReservedNames.SWITCH_DISCO_LASER);

    if(!service) {

      this.log.error("Unable to add the Ratgdo (ESP32) Disco laser switch.");

      return false;
    }

    // Return the current state of the switch.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.status.discoLaser);

    // Open or close the switch.
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => this.command("disco-laser", value === true ? "on" : "off"));

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, this.status.discoLaser);

    this.log.info("Enabling the Ratgdo (ESP32) Disco parking assistance laser switch.");

    return true;
  }

  // Configure the Ratgdo (ESP32) Disco-specific LED switch.
  private configureDiscoLedSwitch(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, (this.device.variant === RatgdoVariant.RATGDO) && this.hints.discoLedSwitch,
      RatgdoReservedNames.SWITCH_DISCO_LED)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch, this.name + " LED", RatgdoReservedNames.SWITCH_DISCO_LED);

    if(!service) {

      this.log.error("Unable to add the Ratgdo (ESP32) Disco LED switch.");

      return false;
    }

    // Return the current state of the switch.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.status.discoLed);

    // Open or close the switch.
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => this.command("disco-led", value === true ? "on" : "off"));

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, this.status.discoLed);

    this.log.info("Enabling the Ratgdo (ESP32) Disco LED switch.");

    return true;
  }

  // Configure the vehicle arriving contact sensor for HomeKit.
  private configureDiscoVehicleArrivingContactSensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.ContactSensor, (this.device.variant === RatgdoVariant.RATGDO) && this.hints.discoVehicleArriving,
      RatgdoReservedNames.CONTACT_DISCO_VEHICLE_ARRIVING)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.ContactSensor, this.name + " Vehicle Arriving",
      RatgdoReservedNames.CONTACT_DISCO_VEHICLE_ARRIVING);

    if(!service) {

      this.log.error("Unable to add the vehicle arriving contact sensor.");

      return false;
    }

    // Initialize the occupancy sensor.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, false);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.status.availability);

    this.log.info("Enabling the Ratgdo (ESP32) Disco vehicle arriving contact sensor.");

    return true;
  }

  // Configure the vehicle leaving contact sensor for HomeKit.
  private configureDiscoVehicleLeavingContactSensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.ContactSensor, (this.device.variant === RatgdoVariant.RATGDO) && this.hints.discoVehicleLeaving,
      RatgdoReservedNames.CONTACT_DISCO_VEHICLE_LEAVING)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.ContactSensor, this.name + " Vehicle Leaving",
      RatgdoReservedNames.CONTACT_DISCO_VEHICLE_LEAVING);

    if(!service) {

      this.log.error("Unable to add the vehicle leaving contact sensor.");

      return false;
    }

    // Initialize the occupancy sensor.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, false);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.status.availability);

    this.log.info("Enabling the Ratgdo (ESP32) Disco vehicle leaving contact sensor.");

    return true;
  }

  // Configure the vehicle presence occupancy sensor for HomeKit.
  private configureDiscoVehiclePresenceOccupancySensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.OccupancySensor, (this.device.variant === RatgdoVariant.RATGDO) && this.hints.discoVehiclePresence,
      RatgdoReservedNames.OCCUPANCY_DISCO_VEHICLE_PRESENCE)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.OccupancySensor, this.name + " Vehicle Presence",
      RatgdoReservedNames.OCCUPANCY_DISCO_VEHICLE_PRESENCE);

    if(!service) {

      this.log.error("Unable to add the vehicle presence occupancy sensor.");

      return false;
    }

    // Initialize the occupancy sensor.
    service.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.status.availability);

    this.log.info("Enabling the Ratgdo (ESP32) Disco vehicle presence occupancy sensor.");

    return true;
  }

  // Configure the Konnected-specific pre-close warning switch.
  private configureKonnectedPcwSwitch(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, (this.device.variant === RatgdoVariant.KONNECTED) && this.hints.konnectedPcwSwitch,
      RatgdoReservedNames.SWITCH_KONNECTED_PCW)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch, this.name + " Pre Close Warning", RatgdoReservedNames.SWITCH_KONNECTED_PCW);

    if(!service) {

      this.log.error("Unable to add the Konnected pre-close warning switch.");

      return false;
    }

    // Return the current state of the switch.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => false);

    // Open or close the switch.
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => {

      // Default to reseting our switch state after the pre-close warning has completed playing.
      let resetTimer = 5000;

      // Send the command.
      if(!this.command("konnected-pcw")) {

        // Something went wrong. Let's make sure we revert the switch to it's prior state immediately.
        resetTimer = 50;
      }

      // Reset the switch state.
      setTimeout(() => service?.updateCharacteristic(this.hap.Characteristic.On, !value), resetTimer);
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("Enabling the Konnected pre-close warning switch.");

    return true;
  }

  // Configure the Konnected-specific strobe switch.
  private configureKonnectedStrobeSwitch(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, (this.device.variant === RatgdoVariant.KONNECTED) && this.hints.konnectedStrobeSwitch,
      RatgdoReservedNames.SWITCH_KONNECTED_STROBE)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch, this.name + " Strobe", RatgdoReservedNames.SWITCH_KONNECTED_STROBE);

    if(!service) {

      this.log.error("Unable to add the Konnected strobe switch.");

      return false;
    }

    // Return the current state of the switch.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.status.konnectedStrobe);

    // Open or close the switch.
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => this.command("konnected-strobe", value === true ? "on" : "off"));

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, this.status.konnectedStrobe);

    this.log.info("Enabling the Konnected strobe switch.");

    return true;
  }

  // Configure a switch to control the ability to lockout all wireless remotes for the garage door opener, if the feature exists.
  private configureAutomationLockoutSwitch(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, this.hints.lock && this.hints.lockoutSwitch, RatgdoReservedNames.SWITCH_LOCKOUT)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.Switch, this.name + " Lockout", RatgdoReservedNames.SWITCH_LOCKOUT);

    if(!service) {

      this.log.error("Unable to add the automation wireless remote lockout switch.");

      return false;
    }

    // Return the current state of the opener. We're on if we are in any state other than locked.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.status.lock === this.hap.Characteristic.LockCurrentState.SECURED);

    // Lock or unlock the wireless remotes.
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => {

      // Inform the user.
      this.log.info("Automation wireless remote lockout switch: remotes are %s.", value ? "locked out" : "permitted");

      // Send the command.
      if(!this.command("lock", value ? "lock" : "unlock")) {

        // Something went wrong. Let's make sure we revert the switch to it's prior state.
        setTimeout(() => service?.updateCharacteristic(this.hap.Characteristic.On, !value), 50);
      }
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, this.status.lock === this.hap.Characteristic.LockCurrentState.SECURED);

    this.log.info("Enabling the automation wireless remote lockout switch.");

    return true;
  }

  // Configure the door open occupancy sensor for HomeKit.
  private configureDoorOpenOccupancySensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.OccupancySensor, this.hints.doorOpenOccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_DOOR_OPEN)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.OccupancySensor, this.name + " Open", RatgdoReservedNames.OCCUPANCY_SENSOR_DOOR_OPEN);

    if(!service) {

      this.log.error("Unable to add the door open occupancy sensor.");

      return false;
    }

    // Initialize the occupancy sensor.
    service.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);

    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.status.availability);

    this.log.info("Enabling the door open indicator occupancy sensor. Occupancy will be triggered when the opener has been continuously open for more than %s seconds.",
      this.hints.doorOpenOccupancyDuration);

    return true;
  }

  // Configure the motion occupancy sensor for HomeKit.
  private configureMotionOccupancySensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.OccupancySensor, this.hints.motionOccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_MOTION)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.OccupancySensor, this.name, RatgdoReservedNames.OCCUPANCY_SENSOR_MOTION);

    if(!service) {

      this.log.error("Unable to add the occupancy sensor.");

      return false;
    }

    // Initialize the occupancy sensor.
    service.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.status.availability);

    this.log.info("Enabling the occupancy sensor. Occupancy event duration set to %s seconds.", this.hints.motionOccupancyDuration);

    return true;
  }

  // Open or close the garage door.
  private setDoorState(value: CharacteristicValue, position?: number): boolean {

    // Understand what we're targeting.
    const targetAction = (position !== undefined) ? "set" : this.translateTargetDoorState(value);

    // If we have an invalid target state, we're done.
    if(targetAction === "unknown") {

      // HomeKit has told us something that we don't know how to handle.
      this.log.error("Unknown HomeKit set event received: %s.", value);

      return false;
    }

    // If this garage door is read-only, we won't process any requests to set state.
    if(this.hints.readOnly) {

      this.log.info("Unable to %s garage door: read-only mode enabled.", targetAction);

      // Tell HomeKit that we haven't in fact changed our state so we don't end up in an inadvertent opening or closing state.
      setImmediate(() => {

        this.accessory.getService(this.hap.Service.GarageDoorOpener)?.updateCharacteristic(this.hap.Characteristic.TargetDoorState,
          value === this.hap.Characteristic.TargetDoorState.CLOSED ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED);
      });

      return false;
    }

    // If we are already opening or closing the garage door, we assume the user wants to stop the garage door opener at it's current location.
    if((this.status.door === this.hap.Characteristic.CurrentDoorState.OPENING) || (this.status.door === this.hap.Characteristic.CurrentDoorState.CLOSING)) {

      this.log.debug("User-initiated stop requested while transitioning between open and close states.");

      // Execute the stop command.
      this.command("door", "stop");

      return true;
    }

    // Set the door state, assuming we're not already there.
    if(this.status.door !== value) {

      this.log.debug("User-initiated door state change: %s%s.", this.translateTargetDoorState(value), (position !== undefined) ? " (" + position.toString() + "%)" : "");

      // Execute the command.
      this.command("door", targetAction, position);
    }

    return true;
  }

  // Refresh our state.
  public refresh(): void {

    this.command("refresh");
  }

  // Update the state of the accessory.
  public updateState(event: EspHomeEvent): void {

    const camelCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
    const dimmerService = this.accessory.getServiceById(this.hap.Service.Lightbulb, RatgdoReservedNames.DIMMER_OPENER_AUTOMATION);
    const discoBatteryService = this.accessory.getService(this.hap.Service.Battery);
    const discoLaserSwitchService = this.accessory.getServiceById(this.hap.Service.Switch, RatgdoReservedNames.SWITCH_DISCO_LASER);
    const discoLedSwitchService = this.accessory.getServiceById(this.hap.Service.Switch, RatgdoReservedNames.SWITCH_DISCO_LED);
    const discoVehicleArrivingContactService = this.accessory.getServiceById(this.hap.Service.ContactSensor, RatgdoReservedNames.CONTACT_DISCO_VEHICLE_ARRIVING);
    const discoVehicleLeavingContactService = this.accessory.getServiceById(this.hap.Service.ContactSensor, RatgdoReservedNames.CONTACT_DISCO_VEHICLE_LEAVING);
    const discoVehiclePresenceOccupancyService = this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_DISCO_VEHICLE_PRESENCE);
    const doorOccupancyService = this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_DOOR_OPEN);
    const garageDoorService = this.accessory.getService(this.hap.Service.GarageDoorOpener);
    const konnectedStrobeSwitchService = this.accessory.getServiceById(this.hap.Service.Switch, RatgdoReservedNames.SWITCH_KONNECTED_STROBE);
    const lightBulbService = this.accessory.getService(this.hap.Service.Lightbulb);
    const lockoutService = this.accessory.getServiceById(this.hap.Service.Switch, RatgdoReservedNames.SWITCH_LOCKOUT);
    const motionOccupancyService = this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_MOTION);
    const motionService = this.accessory.getService(this.hap.Service.MotionSensor);
    const switchService = this.accessory.getServiceById(this.hap.Service.Switch, RatgdoReservedNames.SWITCH_OPENER_AUTOMATION);

    switch(event.id) {

      case "availability":

        // Update our information.
        this.configureInfo();

        // Update our availability.
        discoVehicleArrivingContactService?.updateCharacteristic(this.hap.Characteristic.StatusActive, event.state === "online");
        discoVehicleLeavingContactService?.updateCharacteristic(this.hap.Characteristic.StatusActive, event.state === "online");
        discoVehiclePresenceOccupancyService?.updateCharacteristic(this.hap.Characteristic.StatusActive, event.state === "online");
        doorOccupancyService?.updateCharacteristic(this.hap.Characteristic.StatusActive, event.state === "online");
        motionOccupancyService?.updateCharacteristic(this.hap.Characteristic.StatusActive, event.state === "online");
        motionService?.updateCharacteristic(this.hap.Characteristic.StatusActive, event.state === "online");

        // Inform the user if our availability state has changed.
        if(this.status.availability !== (event.state === "online")) {

          this.status.availability = event.state === "online";
          this.log.info("Ratgdo %s.", this.status.availability ? "connected" : "disconnected");
        }

        break;

      case "battery":

        switch(event.state) {

          case "CHARGING":

            this.status.discoBatteryState = this.hap.Characteristic.ChargingState.CHARGING;

            break;

          case "FULL":
          case "UNKNOWN":

            this.status.discoBatteryState = this.hap.Characteristic.ChargingState.NOT_CHARGING;

            break;

          default:

            this.log.error("Unknown battery state received: %s", event.state);

            return;
        }

        discoBatteryService?.updateCharacteristic(this.hap.Characteristic.ChargingState, this.status.discoBatteryState);

        break;

      case "binary_sensor-motion":

        // We only want motion detected events. We timeout the motion event on our own to allow for automations and a more holistic user experience.
        if(event.state !== "ON") {

          break;
        }

        this.status.motion = true;

        // Update the motion sensor state.
        motionService?.updateCharacteristic(this.hap.Characteristic.MotionDetected, this.status.motion);

        // If we already have an inflight motion sensor timer, clear it out since we're restarting the timer. Also, if it's our first time detecting motion for this event
        // cycle, let the user know.
        if(this.motionTimer) {

          clearTimeout(this.motionTimer);
        } else {

          if(this.hints.logMotion) {

            this.log.info("Motion detected.");
          }

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "motion", this.status.motion.toString());
        }

        // Set a timer for the motion event.
        this.motionTimer = setTimeout(() => {

          this.status.motion = false;
          motionService?.updateCharacteristic(this.hap.Characteristic.MotionDetected, this.status.motion);

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "motion", this.status.motion.toString());
        }, RATGDO_MOTION_DURATION * 1000);

        // If we don't have occupancy sensor support configured, we're done.
        if(!this.hints.motionOccupancySensor) {

          break;
        }

        // Kill any inflight occupancy sensor.
        if(this.motionOccupancyTimer) {

          clearTimeout(this.motionOccupancyTimer);
          this.motionOccupancyTimer = null;
        }

        // If the motion occupancy sensor isn't already triggered, let's do so now.
        if(motionOccupancyService?.getCharacteristic(this.hap.Characteristic.OccupancyDetected).value !== true) {

          // Trigger the occupancy event in HomeKit.
          motionOccupancyService?.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, true);

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "occupancy", "true");

          // Log the event.
          if(this.hints.logMotion) {

            this.log.info("Occupancy detected.");
          }
        }

        // Reset our occupancy state after occupancyDuration.
        this.motionOccupancyTimer = setTimeout(() => {

          // Reset the occupancy sensor.
          motionOccupancyService?.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "occupancy", "false");

          // Log the event.
          if(this.hints.logMotion) {

            this.log.info("Occupancy no longer detected.");
          }

          // Delete the timer.
          this.motionOccupancyTimer = null;
        }, this.hints.motionOccupancyDuration * 1000);

        break;

      case "binary_sensor-obstruction":

        garageDoorService?.updateCharacteristic(this.hap.Characteristic.ObstructionDetected, event.state === "ON");

        // Only act if we're not already at the state we're updating to.
        if(this.status.obstruction !== (event.state === "ON")) {

          this.status.obstruction = event.state === "ON";

          if(this.hints.logObstruction) {

            this.log.info("Obstruction %sdetected.", this.status.obstruction ? "" : "no longer ");
          }

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "obstruction", this.status.obstruction.toString());
        }

        break;

      case "binary_sensor-vehicle_arriving":

        discoVehicleArrivingContactService?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, event.state === "ON");

        // Only act if we're not already at the state we're updating to.
        if(this.status.discoVehicleArriving !== (event.state === "ON")) {

          this.status.discoVehicleArriving = event.state === "ON";

          if(this.hints.logVehiclePresence) {

            this.log.info("Vehicle arriving %sdetected.", this.status.discoVehicleArriving ? "" : "no longer ");
          }

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "vehiclearriving", this.status.discoVehicleArriving.toString());
        }

        break;

      case "binary_sensor-vehicle_detected":

        discoVehiclePresenceOccupancyService?.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, event.state === "ON");

        // Only act if we're not already at the state we're updating to.
        if(this.status.discoVehiclePresence !== (event.state === "ON")) {

          this.status.discoVehiclePresence = event.state === "ON";

          if(this.hints.logVehiclePresence) {

            this.log.info("Vehicle %sdetected.", this.status.discoVehiclePresence ? "" : "no longer ");
          }

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "vehiclepresence", this.status.discoVehiclePresence.toString());
        }

        break;

      case "binary_sensor-vehicle_leaving":

        discoVehicleLeavingContactService?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, event.state === "ON");

        // Only act if we're not already at the state we're updating to.
        if(this.status.discoVehicleLeaving !== (event.state === "ON")) {

          this.status.discoVehicleLeaving = event.state === "ON";

          if(this.hints.logVehiclePresence) {

            this.log.info("Vehicle leaving %sdetected.", this.status.discoVehicleLeaving ? "" : "no longer ");
          }

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "vehicleleaving", this.status.discoVehicleLeaving.toString());
        }

        break;

      case "cover-door":
      case "cover-garage_door":

        // Determine what action the opener is currently executing.
        switch(event.current_operation) {

          case "CLOSING":
          case "OPENING":

            // eslint-disable-next-line camelcase
            event.current_operation = event.current_operation.toLowerCase();

            break;

          case "IDLE":

            // We're in a stopped rather than open state if the door is in a position greater than 0.
            // eslint-disable-next-line camelcase
            event.current_operation = ((event.state === "OPEN") && (event.position !== undefined) && (event.position > 0) && (event.position < 1)) ? "stopped" :
              event.state.toLowerCase();

            break;

          default:

            this.log.error("Unknown door operation detected: %s.", event.current_operation);

            return;
        }

        // Update our door position automation dimmer.
        if(event.position !== undefined) {

          this.status.doorPosition = event.position * 100;

          dimmerService?.updateCharacteristic(this.hap.Characteristic.Brightness, this.status.doorPosition);
          dimmerService?.updateCharacteristic(this.hap.Characteristic.On, this.status.doorPosition > 0);
          this.log.debug("Door state: %s% open.", this.status.doorPosition.toFixed(0));
        }

        // If we're already in the state we're updating to, we're done.
        if(this.translateCurrentDoorState(this.status.door) === event.current_operation) {

          break;
        }

        switch(event.current_operation) {

          case "closed":

            this.status.door = this.hap.Characteristic.CurrentDoorState.CLOSED;

            break;

          case "closing":

            this.status.door = this.hap.Characteristic.CurrentDoorState.CLOSING;

            break;

          case "open":

            this.status.door = this.hap.Characteristic.CurrentDoorState.OPEN;

            // Trigger our occupancy timer, if configured to do so and we don't have one yet.
            if(this.hints.doorOpenOccupancySensor && !this.doorOccupancyTimer) {

              this.doorOccupancyTimer = setTimeout(() => {

                doorOccupancyService?.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, true);

                if(this.hints.logMotion) {

                  this.log.info("Garage door open occupancy detected.");
                }

                // Publish to MQTT, if the user has configured it.
                this.platform.mqtt?.publish(this.device.mac, "dooropenoccupancy", "true");
              }, this.hints.doorOpenOccupancyDuration * 1000);
            }

            break;

          case "opening":

            this.status.door = this.hap.Characteristic.CurrentDoorState.OPENING;

            break;

          case "stopped":

            this.status.door = this.hap.Characteristic.CurrentDoorState.STOPPED;

            break;

          default:

            this.status.door = this.hap.Characteristic.CurrentDoorState.CLOSED;

            break;
        }

        // We are only going to update the target state if our current state is NOT stopped. If we are stopped, we are at the target state by definition. We also want to
        // ensure we update TargetDoorState before updating CurrentDoorState in order to work around some notification quirks HomeKit occasionally has.
        if(this.status.door !== this.hap.Characteristic.CurrentDoorState.STOPPED) {

          garageDoorService?.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.doorTargetStateBias(this.status.door));
        }

        garageDoorService?.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.status.door);

        // Update our automation switch, if configured.
        switchService?.updateCharacteristic(this.hap.Characteristic.On, this.doorTargetStateBias(this.status.door) === this.hap.Characteristic.TargetDoorState.OPEN);

        // Inform the user:
        if(this.hints.logOpener) {

          this.log.info("%s.", camelCase(this.translateCurrentDoorState(this.status.door)));
        }

        // If we have an open occupancy sensor configured and our door state is anything other than open, clear our occupancy state.
        if(this.hints.doorOpenOccupancySensor && this.doorOccupancyTimer && (this.status.door !== this.hap.Characteristic.CurrentDoorState.OPEN)) {

          clearTimeout(this.doorOccupancyTimer);
          this.doorOccupancyTimer = null;

          if(doorOccupancyService?.getCharacteristic(this.hap.Characteristic.OccupancyDetected).value as boolean) {

            doorOccupancyService?.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);

            if(this.hints.logMotion) {

              this.log.info("Garage door open occupancy no longer detected.");
            }

            // Publish to MQTT, if the user has configured it.
            this.platform.mqtt?.publish(this.device.mac, "dooropenoccupancy", "false");
          }
        }

        // Publish to MQTT, if the user has configured it.
        this.platform.mqtt?.publish(this.device.mac, "garagedoor", this.translateCurrentDoorState(this.status.door));

        break;

      case "light-garage_light":
      case "light-light":

        // Only act if we're not already at the state we're updating to.
        if(this.status.light !== (event.state === "ON")) {

          this.status.light = event.state === "ON";
          lightBulbService?.updateCharacteristic(this.hap.Characteristic.On, this.status.light);

          // Inform the user:
          if(this.hints.logLight) {

            this.log.info("Light %s.", event.state.toLowerCase());
          }

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "light", this.status.light.toString());
        }

        break;

      case "lock-lock_remotes":

        // If we've disabled the feature, ignore lock updates.
        if(!this.hints.lock) {

          break;
        }

        // Sanity check.
        if(![ "LOCKED", "UNLOCKED" ].includes(event.state)) {

          this.log.warn("Unknown wireless remote lock state detected: %s.", event.state);

          break;
        }

        // If we're already in the state we're updating to, we're done.
        if(this.status.lock === (event.state === "LOCKED" ? this.hap.Characteristic.LockCurrentState.SECURED : this.hap.Characteristic.LockCurrentState.UNSECURED)) {

          break;
        }

        // Determine our lock state.
        this.status.lock = (event.state === "LOCKED") ? this.hap.Characteristic.LockCurrentState.SECURED : this.hap.Characteristic.LockCurrentState.UNSECURED;

        // Update our lock state.
        garageDoorService?.updateCharacteristic(this.hap.Characteristic.LockTargetState, (event.state === "LOCKED") ?
          this.hap.Characteristic.LockTargetState.SECURED : this.hap.Characteristic.LockTargetState.UNSECURED);
        garageDoorService?.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);
        lockoutService?.updateCharacteristic(this.hap.Characteristic.On, this.status.lock === this.hap.Characteristic.LockCurrentState.SECURED);

        // Inform the user:
        this.log.info("Wireless remotes are %s.", (event.state === "LOCKED") ? "locked out" : "permitted");

        // Publish to MQTT, if the user has configured it.
        this.platform.mqtt?.publish(this.device.mac, "lock", this.status.lock.toString());

        break;

      case "sensor-voltage":

        //ratgdoAccessory.updateState("voltage", event.state);

        break;

      case "switch-laser":

        // Only act if we're not already at the state we're updating to.
        if(this.status.discoLaser !== (event.state === "ON")) {

          this.status.discoLaser = event.state === "ON";
          discoLaserSwitchService?.updateCharacteristic(this.hap.Characteristic.On, this.status.discoLaser);

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "laser", this.status.discoLaser.toString());
        }

        break;

      case "switch-led":

        // Only act if we're not already at the state we're updating to.
        if(this.status.discoLed !== (event.state === "ON")) {

          this.status.discoLed = event.state === "ON";
          discoLedSwitchService?.updateCharacteristic(this.hap.Characteristic.On, this.status.discoLed);

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "led", this.status.discoLed.toString());
        }

        break;

      case "switch-str_output":

        // Only act if we're not already at the state we're updating to.
        if(this.status.konnectedStrobe !== (event.state === "ON")) {

          this.status.konnectedStrobe = event.state === "ON";
          konnectedStrobeSwitchService?.updateCharacteristic(this.hap.Characteristic.On, this.status.konnectedStrobe);

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "strobe", this.status.konnectedStrobe.toString());
        }

        break;

      case "default":

        break;
    }
  }

  // Utility function to transmit a command to Ratgdo.
  private command(topic: string, payload = "", position?: number): boolean {

    // Now we handle ESPHome firmware commands.
    let action;

    switch(topic) {

      case "disco-laser":

        this.platform.espHomeApi[this.device.mac].sendSwitchCommand("switch-laser", payload === "on");

        break;

      case "disco-led":

        this.platform.espHomeApi[this.device.mac].sendSwitchCommand("switch-led", payload === "on");

        break;

      case "door":

        switch(payload) {

          case "closed":

            action = "close";

            break;

          case "open":
          case "stop":

            action = payload;

            break;

          case "set":

            if(position === undefined) {

              this.log.error("Invalid door set command received: no position specified.");

              return false;
            }

            action = "set";

            break;

          default:

            this.log.error("Unknown door command received: %s.", payload);

            return false;
        }

        // Set the door position to the requested percentage.
        if(position !== undefined) {

          this.platform.espHomeApi[this.device.mac].sendCoverCommand("cover-" + ((this.device.variant === RatgdoVariant.KONNECTED) ? "garage_door" : "door"),
            { position: position / 100 });

          return true;
        }

        // Execute the command.
        this.platform.espHomeApi[this.device.mac].sendCoverCommand("cover-" + ((this.device.variant === RatgdoVariant.KONNECTED) ? "garage_door" : "door"),
          { command: (action as "open" | "close" | "stop") });

        break;

      case "konnected-pcw":

        this.platform.espHomeApi[this.device.mac].sendButtonCommand("button-pre-close_warning");

        break;

      case "konnected-strobe":

        this.platform.espHomeApi[this.device.mac].sendSwitchCommand("switch-str_output", payload === "on");

        break;

      case "light":

        this.platform.espHomeApi[this.device.mac].sendLightCommand("light-" + ((this.device.variant === RatgdoVariant.KONNECTED) ? "garage_light" : "light"),
          { state: payload === "on" });

        break;

      case "lock":

        this.platform.espHomeApi[this.device.mac].sendLockCommand("lock-" + ((this.device.variant === RatgdoVariant.KONNECTED) ? "lock" : "lock_remotes"),
          (payload === "lock") ? "lock" : "unlock");

        break;

      case "refresh":

        this.platform.espHomeApi[this.device.mac].sendButtonCommand("button-query_status");

        break;

      default:

        this.log.error("Unknown command received: %s - %s.", topic, payload);

        return false;
    }

    return true;
  }

  // Utility function to translate HomeKit's current door state values into human-readable form.
  private translateCurrentDoorState(value: CharacteristicValue): string {

    // HomeKit state decoder ring.
    switch(value) {

      case this.hap.Characteristic.CurrentDoorState.CLOSED:

        return "closed";

      case this.hap.Characteristic.CurrentDoorState.CLOSING:

        return "closing";

      case this.hap.Characteristic.CurrentDoorState.OPEN:

        return "open";

      case this.hap.Characteristic.CurrentDoorState.OPENING:

        return "opening";

      case this.hap.Characteristic.CurrentDoorState.STOPPED:

        return "stopped";

      default:

        break;
    }

    return "unknown";
  }

  // Utility function to translate HomeKit's target door state values into human-readable form.
  private translateTargetDoorState(value: CharacteristicValue): string {

    // HomeKit state decoder ring.
    switch(value) {

      case this.hap.Characteristic.TargetDoorState.CLOSED:

        return "closed";

      case this.hap.Characteristic.TargetDoorState.OPEN:

        return "open";

      default:

        break;
    }

    return "unknown";
  }

  // Utility function to return our bias for what the current door state should be. This is primarily used for our initial bias on startup.
  private doorCurrentStateBias(state: CharacteristicValue): CharacteristicValue {

    // Our current door state reflects our opinion on what open or closed means in HomeKit terms. For the obvious states, this is easy. For some of the edge cases, it can
    // be less so. Our north star is that if we are in an obstructed state, we are open.
    if(this.status.obstruction) {

      return this.hap.Characteristic.CurrentDoorState.OPEN;
    }

    switch(state) {

      case this.hap.Characteristic.CurrentDoorState.OPEN:
      case this.hap.Characteristic.CurrentDoorState.OPENING:

        return this.hap.Characteristic.CurrentDoorState.OPEN;

      case this.hap.Characteristic.CurrentDoorState.STOPPED:

        return this.hap.Characteristic.CurrentDoorState.STOPPED;

      case this.hap.Characteristic.CurrentDoorState.CLOSED:
      case this.hap.Characteristic.CurrentDoorState.CLOSING:
      default:

        return this.hap.Characteristic.CurrentDoorState.CLOSED;
    }
  }

  // Utility function to return our bias for what the target door state should be.
  private doorTargetStateBias(state: CharacteristicValue): CharacteristicValue {

    // We need to be careful with respect to the target state and we need to make some reasonable assumptions about where we intend to end up. If we are opening or
    // closing, our target state needs to be the completion of those actions. If we're stopped or obstructed, we're going to assume the desired target state is to be
    // open, since that is the typical opener behavior, and it's impossible for us to know with reasonable certainty what the original intention of the action was.
    if(this.status.obstruction) {

      return this.hap.Characteristic.TargetDoorState.OPEN;
    }

    switch(state) {

      case this.hap.Characteristic.CurrentDoorState.OPEN:
      case this.hap.Characteristic.CurrentDoorState.OPENING:
      case this.hap.Characteristic.CurrentDoorState.STOPPED:

        return this.hap.Characteristic.TargetDoorState.OPEN;

      case this.hap.Characteristic.CurrentDoorState.CLOSED:
      case this.hap.Characteristic.CurrentDoorState.CLOSING:
      default:

        return this.hap.Characteristic.TargetDoorState.CLOSED;
    }
  }

  // Utility function to return our bias for what the target door state should be.
  private lockTargetStateBias(state: CharacteristicValue): CharacteristicValue {

    switch(state) {

      case this.hap.Characteristic.LockCurrentState.SECURED:

        return this.hap.Characteristic.LockTargetState.SECURED;

      case this.hap.Characteristic.LockCurrentState.UNSECURED:
      case this.hap.Characteristic.LockCurrentState.JAMMED:
      case this.hap.Characteristic.LockCurrentState.UNKNOWN:
      default:

        return this.hap.Characteristic.LockTargetState.UNSECURED;
    }
  }

  // Utility for checking feature options on a device.
  private hasFeature(option: string): boolean {

    return this.platform.featureOptions.test(option, this.device.mac);
  }

  // Utility function to return the name of this device.
  private get name(): string {

    // We use the garage door service as the natural proxy for the name.
    let name = this.accessory.getService(this.hap.Service.GarageDoorOpener)?.getCharacteristic(this.hap.Characteristic.Name).value as string;

    if(name?.length) {

      return name;
    }

    name = this.accessory.displayName;

    if(name?.length) {

      return name;
    }

    // If we don't have a name for the garage door service, return the device name from Ratgdo.
    return this.device.name;
  }

  // Utility function to return the current accessory name of this device.
  private get accessoryName(): string {

    return (this.accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.Name).value as string) ?? this.device.name;
  }

  // Utility function to set the current accessory name of this device.
  private set accessoryName(name: string) {

    const cleanedName = sanitizeName(name);

    // Set all the internally managed names within Homebridge to the new accessory name.
    this.accessory.displayName = cleanedName;
    this.accessory._associatedHAPAccessory.displayName = cleanedName;

    // Set all the HomeKit-visible names.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Name, cleanedName);
  }
}
