/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-device.ts: Base class for all Ratgdo devices.
 */
import { API, CharacteristicValue, HAP, PlatformAccessory } from "homebridge";
import { FetchError, fetch } from "@adobe/fetch";
import { HomebridgePluginLogging, acquireService, validService, validateName } from "homebridge-plugin-utils";
import { RATGDO_MOTION_DURATION, RATGDO_OCCUPANCY_DURATION } from "./settings.js";
import { RatgdoDevice, RatgdoReservedNames, RatgdoVariant } from "./ratgdo-types.js";
import { RatgdoOptions } from "./ratgdo-options.js";
import { RatgdoPlatform } from "./ratgdo-platform.js";
import util from "node:util";

// Device-specific options and settings.
interface RatgdoHints {

  automationDimmer: boolean,
  automationSwitch: boolean,
  doorOpenOccupancyDuration: number,
  doorOpenOccupancySensor: boolean,
  light: boolean,
  lockoutSwitch: boolean,
  logLight: boolean,
  logMotion: boolean,
  logObstruction: boolean,
  logOpener: boolean,
  motionOccupancyDuration: number,
  motionOccupancySensor: boolean,
  motionSensor: boolean,
  readOnly: boolean,
  showBatteryInfo: boolean
}

// Ratgdo status information.
interface RatgdoStatus {

  availability: boolean,
  door: CharacteristicValue,
  doorPosition: number,
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
  private doorOccupancyTimer: NodeJS.Timeout | null;
  private readonly hap: HAP;
  private readonly hints: RatgdoHints;
  public readonly log: HomebridgePluginLogging;
  private motionOccupancyTimer: NodeJS.Timeout | null;
  private motionTimer: NodeJS.Timeout | null;
  private obstructionTimer: NodeJS.Timeout | null;
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
    this.status.door = this.hap.Characteristic.CurrentDoorState.CLOSED;
    this.status.doorPosition = 0;
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
    this.configureDoorOpenOccupancySensor();
    this.configureLight();
    this.configureAutomationLockoutSwitch();
    this.configureMotionSensor();
    this.configureMotionOccupancySensor();
  }

  // Configure device-specific settings.
  private configureHints(): boolean {

    this.hints.automationDimmer = this.hasFeature("Opener.Dimmer");
    this.hints.automationSwitch = this.hasFeature("Opener.Switch");
    this.hints.doorOpenOccupancySensor = this.hasFeature("Opener.OccupancySensor");
    this.hints.doorOpenOccupancyDuration = this.platform.featureOptions.getInteger("Opener.OccupancySensor.Duration", this.device.mac) ?? RATGDO_OCCUPANCY_DURATION;
    this.hints.light = this.hasFeature("Light");
    this.hints.logLight = this.hasFeature("Log.Light");
    this.hints.logMotion = this.hasFeature("Log.Motion");
    this.hints.logObstruction = this.hasFeature("Log.Obstruction");
    this.hints.logOpener = this.hasFeature("Log.Opener");
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
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Model, "Ratgdo");

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
    const service = acquireService(this.hap, this.accessory, this.hap.Service.GarageDoorOpener, this.name);

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

    // Configure the lock garage door lock current and target state characteristics.
    service.getCharacteristic(this.hap.Characteristic.LockTargetState).onSet(async (value: CharacteristicValue) => {

      if(!(await this.command("lock", (value === this.hap.Characteristic.LockTargetState.SECURED) ? "lock" : "unlock"))) {

        // Something went wrong. Let's make sure we revert the lock to it's prior state.
        setTimeout(() => {

          service?.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.lockTargetStateBias(this.status.lock));
          service?.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);
        }, 50);
      }
    });

    service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);
    service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.lockTargetStateBias(this.status.lock));

    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.status.availability);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);

    // Let HomeKit know that this is the primary service on this accessory.
    service.setPrimaryService(true);

    return true;
  }

  // Configure the light for HomeKit.
  private configureLight(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Lightbulb, () => {

      // Have we disabled the light?
      if(!this.hints.light) {

        this.log.info("Disabling the light.");

        return false;
      }

      return true;
    })) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.hap, this.accessory, this.hap.Service.Lightbulb, this.name, undefined, () => this.log.info("Enabling light."));

    if(!service) {

      this.log.error("Unable to add the light.");

      return false;
    }

    // Initialize the light.
    service.updateCharacteristic(this.hap.Characteristic.On, this.status.light);

    // Turn the light on or off.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.status.light);
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => void this.command("light", value === true ? "on" : "off"));

    return true;
  }

  // Configure the motion sensor for HomeKit.
  private configureMotionSensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.MotionSensor, () => {

      // Have we disabled the motion sensor?
      if(!this.hints.motionSensor) {

        this.log.info("Disabling the motion sensor.");

        return false;
      }

      return true;
    })) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.hap, this.accessory, this.hap.Service.MotionSensor, this.name, undefined, () => this.log.info("Enabling motion sensor."));

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
    if(!validService(this.accessory, this.hap.Service.Lightbulb, () => {

      // The door position dimmer is disabled by default and primarily exists for automation purposes.
      if(!this.hints.automationDimmer) {

        return false;
      }

      return true;
    }, RatgdoReservedNames.DIMMER_OPENER_AUTOMATION)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.hap, this.accessory, this.hap.Service.Lightbulb, this.name + " Automation Door Position",
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
    if(!validService(this.accessory, this.hap.Service.Switch, () => {

      // Have we disabled the automation switch?
      if(!this.hints.automationSwitch) {

        return false;
      }

      return true;
    }, RatgdoReservedNames.SWITCH_OPENER_AUTOMATION)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.hap, this.accessory, this.hap.Service.Switch, this.name + " Automation Opener", RatgdoReservedNames.SWITCH_OPENER_AUTOMATION);

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

  // Configure a switch to control the ability to lockout all wireless remotes for the garage door opener, if the feature exists.
  private configureAutomationLockoutSwitch(): boolean {

    // Validate whether we should have this service enabled.
    if(!validService(this.accessory, this.hap.Service.Switch, () => {

      // The wireless lockout switch is disabled by default and primarily exists for automation purposes.
      if(!this.hints.lockoutSwitch) {

        return false;
      }

      return true;
    }, RatgdoReservedNames.SWITCH_LOCKOUT)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.hap, this.accessory, this.hap.Service.Switch, this.name + " Lockout", RatgdoReservedNames.SWITCH_LOCKOUT);

    if(!service) {

      this.log.error("Unable to add the automation wireless remote lockout switch.");

      return false;
    }

    // Return the current state of the opener. We're on if we are in any state other than locked.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.status.lock === this.hap.Characteristic.LockCurrentState.SECURED);

    // Lock or unlock the wireless remotes.
    service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

      // Inform the user.
      this.log.info("Automation wireless remote lockout switch: remotes are %s.", value ? "locked out" : "permitted");

      // Send the command.
      if(!(await this.command("lock", value ? "lock" : "unlock"))) {

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
    if(!validService(this.accessory, this.hap.Service.OccupancySensor, () => {

      // The occupancy sensor is disabled by default and primarily exists for automation purposes.
      if(!this.hints.doorOpenOccupancySensor) {

        return false;
      }

      return true;
    }, RatgdoReservedNames.OCCUPANCY_SENSOR_DOOR_OPEN)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.hap, this.accessory, this.hap.Service.OccupancySensor, this.name + " Open", RatgdoReservedNames.OCCUPANCY_SENSOR_DOOR_OPEN);

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
    if(!validService(this.accessory, this.hap.Service.OccupancySensor, () => {

      // The occupancy sensor is disabled by default and primarily exists for automation purposes.
      if(!this.hints.motionOccupancySensor) {

        return false;
      }

      return true;
    }, RatgdoReservedNames.OCCUPANCY_SENSOR_MOTION)) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.hap, this.accessory, this.hap.Service.OccupancySensor, this.name, RatgdoReservedNames.OCCUPANCY_SENSOR_MOTION);

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
      void this.command("door", "stop");

      return true;
    }

    // Set the door state, assuming we're not already there.
    if(this.status.door !== value) {

      this.log.debug("User-initiated door state change: %s%s.", this.translateTargetDoorState(value), (position !== undefined) ? " (" + position.toString() + "%)" : "");

      // Execute the command.
      void this.command("door", targetAction, position);
    }

    return true;
  }

  // Update the state of the accessory.
  public updateState(event: string, payload: string, position?: number): void {

    const camelCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
    const dimmerService = this.accessory.getServiceById(this.hap.Service.Lightbulb, RatgdoReservedNames.DIMMER_OPENER_AUTOMATION);
    const doorOccupancyService = this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_DOOR_OPEN);
    const garageDoorService = this.accessory.getService(this.hap.Service.GarageDoorOpener);
    const lightBulbService = this.accessory.getService(this.hap.Service.Lightbulb);
    const lockoutService = this.accessory.getServiceById(this.hap.Service.Switch, RatgdoReservedNames.SWITCH_LOCKOUT);
    const motionOccupancyService = this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_MOTION);
    const motionService = this.accessory.getService(this.hap.Service.MotionSensor);
    const switchService = this.accessory.getServiceById(this.hap.Service.Switch, RatgdoReservedNames.SWITCH_OPENER_AUTOMATION);

    switch(event) {

      case "availability":

        this.status.availability = payload === "online";

        // Update our availability.
        garageDoorService?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);
        doorOccupancyService?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);
        motionOccupancyService?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);
        motionService?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);

        // Inform the user:
        this.log.info("Ratgdo %s.", this.status.availability ? "connected" : "disconnected");

        break;

      case "door":

        // Update our door position automation dimmer.
        if(position !== undefined) {

          this.status.doorPosition = position;

          dimmerService?.updateCharacteristic(this.hap.Characteristic.Brightness, this.status.doorPosition);
          dimmerService?.updateCharacteristic(this.hap.Characteristic.On, this.status.doorPosition > 0);
          this.log.debug("Door state: %s% open.", this.status.doorPosition.toFixed(0));
        }

        // If we're already in the state we're updating to, we're done.
        if(this.translateCurrentDoorState(this.status.door) === payload) {

          break;
        }

        switch(payload) {

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

          this.log.info("%s.", camelCase(payload));
        }

        // If we have an open occupancy sensor configured and our door state is anything other than open, clear our occupancy state.
        if(this.hints.doorOpenOccupancySensor && this.doorOccupancyTimer && (payload !== "open")) {

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
        this.platform.mqtt?.publish(this.device.mac, "garagedoor", payload);

        break;

      case "light":

        // Only act if we're not already at the state we're updating to.
        if(this.status.light !== (payload === "on")) {

          this.status.light = payload === "on";
          lightBulbService?.updateCharacteristic(this.hap.Characteristic.On, this.status.light);

          // Inform the user:
          if(this.hints.logLight) {

            this.log.info("Light %s.", payload);
          }

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "light", this.status.light.toString());
        }

        break;

      case "lock":

        // If we're already in the state we're updating to, we're done.
        if(this.status.lock === (payload === "locked" ? this.hap.Characteristic.LockCurrentState.SECURED : this.hap.Characteristic.LockCurrentState.UNSECURED)) {

          break;
        }

        // Determine our lock state.
        this.status.lock = payload === "locked" ? this.hap.Characteristic.LockCurrentState.SECURED : this.hap.Characteristic.LockCurrentState.UNSECURED;

        // Update our lock state.
        garageDoorService?.updateCharacteristic(this.hap.Characteristic.LockTargetState, payload === "locked" ?
          this.hap.Characteristic.LockTargetState.SECURED : this.hap.Characteristic.LockTargetState.UNSECURED);
        garageDoorService?.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);
        lockoutService?.updateCharacteristic(this.hap.Characteristic.On, this.status.lock === this.hap.Characteristic.LockCurrentState.SECURED);

        // Inform the user:
        this.log.info("Wireless remotes are %s.", payload === "locked" ? "locked out" : "permitted");

        // Publish to MQTT, if the user has configured it.
        this.platform.mqtt?.publish(this.device.mac, "lock", this.status.lock.toString());

        break;

      case "motion":

        // We only want motion detected events. We timeout the motion event on our own to allow for automations and a more holistic user experience.
        if(payload !== "detected") {

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

      case "obstruction":

        garageDoorService?.updateCharacteristic(this.hap.Characteristic.ObstructionDetected, payload === "obstructed");

        // Only act if we're not already at the state we're updating to.
        if(this.status.obstruction !== (payload === "obstructed")) {

          this.status.obstruction = payload === "obstructed";

          if(this.hints.logObstruction) {

            this.log.info("Obstruction %sdetected.", this.status.obstruction ? "" : "no longer ");
          }

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this.device.mac, "obstruction", this.status.obstruction.toString());
        }

        break;

      case "default":

        break;
    }
  }

  // Utility function to transmit a command to Ratgdo.
  private async command(topic: string, payload = "", position?: number): Promise<boolean> {

    // Now we handle ESPHome firmware commands.
    let endpoint;
    let action;

    switch(topic) {

      case "door":

        endpoint = (this.device.variant === RatgdoVariant.KONNECTED) ? "cover/garage_door" : "cover/door";

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

            action = "set?position=" + (position / 100).toString();

            break;

          default:

            this.log.error("Unknown door command received: %s.", payload);

            return false;
        }

        break;

      case "light":

        endpoint = (this.device.variant === RatgdoVariant.KONNECTED) ? "light/garage_light" : "light/light";
        action = (payload === "on") ? "turn_on" : "turn_off";

        break;

      case "lock":

        endpoint = (this.device.variant === RatgdoVariant.KONNECTED) ? "lock/lock" : "lock/lock_remotes";
        action = (payload === "lock") ? "lock" : "unlock";

        break;

      case "refresh":

        endpoint = "button/query_status";
        action = "press";

        break;

      default:

        this.log.error("Unknown command received: %s - %s.", topic, payload);

        return false;
    }

    try {

      // Execute the action.
      const response = await fetch("http://" + this.device.address + "/" + endpoint + "/" + action, { body: JSON.stringify({}), method: "POST"});

      if(!response?.ok) {

        this.log.error("Unable to execute command: %s - %s.", topic, action);

        return false;
      }
    } catch(error) {

      if(error instanceof FetchError) {

        let errorMessage;

        switch(error.code) {

          case "ECONNRESET":

            errorMessage = "Connection to the Ratgdo controller has been reset";

            break;

          case "EHOSTDOWN":

            errorMessage = "Connection to the Ratgdo controller has been reset";

            break;

          case "ETIMEDOUT":

            errorMessage = "Connection to the Ratgdo controller has timed out";

            break;

          default:

            errorMessage = error.code + " - " + error.message;

            break;
        }

        this.log.error("Ratgdo API error sending command: %s.", errorMessage);

        return false;
      }

      this.log.error("Ratgdo API unknown error sending command: %s", error);

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
    let name = this.accessory.getService(this.hap.Service.GarageDoorOpener)?.getCharacteristic(this.hap.Characteristic.ConfiguredName).value as string;

    if(name?.length) {

      return name;
    }

    name = this.accessory.getService(this.hap.Service.GarageDoorOpener)?.getCharacteristic(this.hap.Characteristic.Name).value as string;

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

    const cleanedName = validateName(name);

    // Set all the internally managed names within Homebridge to the new accessory name.
    this.accessory.displayName = cleanedName;
    this.accessory._associatedHAPAccessory.displayName = cleanedName;

    // Set all the HomeKit-visible names.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Name, cleanedName);
  }
}
