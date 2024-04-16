/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-device.ts: Base class for all Ratgdo devices.
 */
import { API, CharacteristicValue, HAP, PlatformAccessory, Service } from "homebridge";
import { FetchError, fetch } from "@adobe/fetch";
import { Firmware, RatgdoDevice, RatgdoLogging, RatgdoReservedNames } from "./ratgdo-types.js";
import { RATGDO_MOTION_DURATION, RATGDO_OCCUPANCY_DURATION } from "./settings.js";
import { RatgdoOptions, getOptionFloat, getOptionNumber, getOptionValue, isOptionEnabled } from "./ratgdo-options.js";
import { RatgdoPlatform } from "./ratgdo-platform.js";
import util from "node:util";

// Device-specific options and settings.
interface RatgdoHints {

  automationDimmer: boolean,
  automationSwitch: boolean,
  doorOpenOccupancyDuration: number,
  doorOpenOccupancySensor: boolean,
  light: boolean,
  motionOccupancyDuration: number,
  motionOccupancySensor: boolean,
  motionSensor: boolean,
  readOnly: boolean,
  showBatteryInfo: boolean,
  syncName: boolean
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
  public readonly log: RatgdoLogging;
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
    this.configureAutomationDimmer();
    this.configureAutomationSwitch();
    this.configureDoorOpenOccupancySensor();
    this.configureLight();
    this.configureMotionSensor();
    this.configureMotionOccupancySensor();
  }

  // Configure device-specific settings.
  private configureHints(): boolean {

    this.hints.automationDimmer = this.hasFeature("Opener.Dimmer");
    this.hints.automationSwitch = this.hasFeature("Opener.Switch");
    this.hints.doorOpenOccupancySensor = this.hasFeature("Opener.OccupancySensor");
    this.hints.doorOpenOccupancyDuration = this.getFeatureNumber("Opener.OccupancySensor.Duration") ?? RATGDO_OCCUPANCY_DURATION;
    this.hints.light = this.hasFeature("Light");
    this.hints.motionOccupancySensor = this.hasFeature("Motion.OccupancySensor");
    this.hints.motionOccupancyDuration = this.getFeatureNumber("Motion.OccupancySensor.Duration") ?? RATGDO_OCCUPANCY_DURATION;
    this.hints.motionSensor = this.hasFeature("Motion");
    this.hints.readOnly = this.hasFeature("Opener.ReadOnly");
    this.hints.syncName = this.hasFeature("Device.SyncName");

    if(this.hints.automationDimmer && (this.device.type !== Firmware.ESPHOME)) {

      this.hints.automationDimmer = false;
      this.log.info("Automation dimmer support is only available on Ratgdo devices running on ESPHome firmware versions.");
    }

    if(this.hints.readOnly) {

      this.log.info("Garage door opener is read-only. The opener will not respond to open and close requests from HomeKit.");
    }

    if(this.hints.syncName) {

      if(this.device.type !== Firmware.MQTT) {

        this.hints.syncName = false;
        this.log.info("Syncing names is only available on Ratgdo devices running on MQTT firmware versions.");
      } else {

        this.log.info("Syncing Ratgdo device name to HomeKit.");
      }
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
    this.platform.mqtt?.subscribeGet(this, "garagedoor", "Garage Door", () => {

      // Return our current status using our HomeKit current state decoder ring.
      return this.translateCurrentDoorState(this.status.door);
    });

    // Set our garage door state.
    this.platform.mqtt?.subscribeSet(this, "garagedoor", "Garage Door", (value: string) => {

      let command;
      let position;

      const action = value.split(" ");

      switch(action[0]) {

        case "close":

          command = this.hap.Characteristic.TargetDoorState.CLOSED;
          break;

        case "open":

          command = this.hap.Characteristic.TargetDoorState.OPEN;

          // Parse the position information, if set.
          if(this.device.type === Firmware.ESPHOME) {

            position = parseFloat(action[1]);

            if(isNaN(position) || (position < 0) || (position > 100)) {

              position = undefined;
            }
          }

          break;

        default:

          this.log.error("Invalid command.");
          return;
          break;
      }

      // Set our door state accordingly.
      this.setDoorState(command, position);
    });

    // Return our obstruction state.
    this.platform.mqtt?.subscribeGet(this, "obstruction", "Obstruction", () => {

      return this.status.obstruction.toString();
    });

    // Return our door open occupancy state if configured to do so.
    if(this.hints.doorOpenOccupancySensor) {

      this.platform.mqtt?.subscribeGet(this, "dooropenoccupancy", "Door Open Indicator Occupancy", () => {

        return ((this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_DOOR_OPEN)
          ?.getCharacteristic(this.hap.Characteristic.OccupancyDetected).value ?? "false") as boolean).toString();
      });
    }

    // Return our light state if configured to do so.
    if(this.hints.light) {

      this.platform.mqtt?.subscribeGet(this, "light", "Light", () => {

        return this.status.light.toString();
      });
    }

    // Return our motion occupancy state if configured to do so.
    if(this.hints.motionOccupancySensor) {

      this.platform.mqtt?.subscribeGet(this, "occupancy", "Occupancy", () => {

        return ((this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_MOTION)
          ?.getCharacteristic(this.hap.Characteristic.OccupancyDetected).value ?? "false") as boolean).toString();
      });
    }

    // Return our motion state if configured to do so.
    if(this.hints.motionSensor) {

      this.platform.mqtt?.subscribeGet(this, "motion", "Motion", () => {

        return this.status.motion.toString();
      });
    }

    return true;
  }

  // Configure the garage door service for HomeKit.
  private configureGarageDoor(): boolean {

    let garageDoorService = this.accessory.getService(this.hap.Service.GarageDoorOpener);

    // Add the garage door opener service to the accessory, if needed.
    if(!garageDoorService) {

      garageDoorService = new this.hap.Service.GarageDoorOpener(this.name);
      garageDoorService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      this.accessory.addService(garageDoorService);
    }

    // Set the initial current and target door states to closed since ratgdo doesn't tell us initial state over MQTT on startup.
    garageDoorService.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.status.door);
    garageDoorService.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.doorTargetStateBias(this.status.door));

    // Handle HomeKit open and close events.
    garageDoorService.getCharacteristic(this.hap.Characteristic.TargetDoorState).onSet((value: CharacteristicValue) => {

      this.setDoorState(value);
    });

    // Inform HomeKit of our current state.
    garageDoorService.getCharacteristic(this.hap.Characteristic.CurrentDoorState).onGet(() => this.status.door);

    // Inform HomeKit of any obstructions.
    garageDoorService.getCharacteristic(this.hap.Characteristic.ObstructionDetected).onGet(() => this.status.obstruction === true);

    // Configure the lock garage door lock current and target state characteristics.
    garageDoorService.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);
    garageDoorService.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.lockTargetStateBias(this.status.lock));

    // Update our configured name, if requested.
    if(this.hints.syncName) {

      this.setServiceName(garageDoorService, this.device.name);

      if(this.hints.automationSwitch) {

        this.setServiceName(this.accessory.getServiceById(this.hap.Service.Switch, RatgdoReservedNames.SWITCH_OPENER_AUTOMATION),
          this.device.name + " Automation Switch");
      }

      if(this.hints.doorOpenOccupancySensor) {

        this.setServiceName(this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_DOOR_OPEN), this.device.name + " Open");
      }

      if(this.hints.light) {

        this.setServiceName(this.accessory.getService(this.hap.Service.Lightbulb), this.device.name);
      }

      if(this.hints.motionSensor) {

        this.setServiceName(this.accessory.getService(this.hap.Service.MotionSensor), this.device.name);
      }

      if(this.hints.motionOccupancySensor) {

        this.setServiceName(this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_MOTION), this.device.name);
      }

      // Finally, update the accessory name.
      this.accessoryName = this.device.name;
    }

    garageDoorService.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.status.availability);
    garageDoorService.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);

    // Let HomeKit know that this is the primary service on this accessory.
    garageDoorService.setPrimaryService(true);

    return true;
  }

  // Configure the light for HomeKit.
  private configureLight(): boolean {

    // Find the service, if it exists.
    let lightService = this.accessory.getService(this.hap.Service.Lightbulb);

    // Have we disabled the light?
    if(!this.hints.light) {

      if(lightService) {

        this.accessory.removeService(lightService);
        this.log.info("Disabling light.");
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!lightService) {

      lightService = new this.hap.Service.Lightbulb(this.name);

      if(!lightService) {

        this.log.error("Unable to add the light.");
        return false;
      }

      lightService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      lightService.updateCharacteristic(this.hap.Characteristic.Name, this.name);
      this.setServiceName(lightService, this.name);
      this.accessory.addService(lightService);
      this.log.info("Enabling light.");
    }

    // Initialize the light.
    lightService.updateCharacteristic(this.hap.Characteristic.On, this.status.light);

    // Turn the light on or off.
    lightService.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.status.light);
    lightService.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => {

      void this.command("light", value === true ? "on" : "off");
    });

    return true;
  }

  // Configure the motion sensor for HomeKit.
  private configureMotionSensor(): boolean {

    // Find the motion sensor service, if it exists.
    let motionService = this.accessory.getService(this.hap.Service.MotionSensor);

    // Have we disabled the motion sensor?
    if(!this.hints.motionSensor) {

      if(motionService) {

        this.accessory.removeService(motionService);
        this.log.info("Disabling motion sensor.");
      }

      return false;
    }

    // We don't have a motion sensor, let's add it to the device.
    if(!motionService) {

      // We don't have it, add the motion sensor to the device.
      motionService = new this.hap.Service.MotionSensor(this.name);

      if(!motionService) {

        this.log.error("Unable to add the motion sensor.");
        return false;
      }

      motionService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      motionService.updateCharacteristic(this.hap.Characteristic.Name, this.name);
      this.setServiceName(motionService, this.name);
      this.accessory.addService(motionService);
      this.log.info("Enabling motion sensor.");
    }

    // Initialize the state of the motion sensor.
    motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
    motionService.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);

    motionService.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.status.availability);

    return true;
  }

  // Configure a dimmer to automate open and close events in HomeKit beyond what HomeKit might allow for a garage opener service that gets treated as a secure service.
  private configureAutomationDimmer(): boolean {

    // Find the dimmer service, if it exists.
    let dimmerService = this.accessory.getServiceById(this.hap.Service.Lightbulb, RatgdoReservedNames.DIMMER_OPENER_AUTOMATION);

    // The switch is disabled by default and primarily exists for automation purposes.
    if(!this.hints.automationDimmer) {

      if(dimmerService) {

        this.accessory.removeService(dimmerService);
        this.log.info("Disabling automation dimmer.");
      }

      return false;
    }

    // Add the dimmer to the opener, if needed.
    if(!dimmerService) {

      dimmerService = new this.hap.Service.Lightbulb(this.name + " Automation Dimmer", RatgdoReservedNames.DIMMER_OPENER_AUTOMATION);

      if(!dimmerService) {

        this.log.error("Unable to add automation dimmer.");
        return false;
      }

      dimmerService.displayName = this.name + " Automation Dimmer";
      dimmerService.updateCharacteristic(this.hap.Characteristic.Name, this.name + " Automation Dimmer");
      this.accessory.addService(dimmerService);
    }

    // Return the current state of the opener.
    dimmerService.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

      // We're on if we are in any state other than closed (specifically open or stopped).
      return this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED;
    });

    // Close the opener. Opening is really handled in the brightness event.
    dimmerService.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => {

      // We really only want to act when the opener is open. Otherwise, it's handled by the brightness event.
      if(value) {

        return;
      }

      // Inform the user.
      this.log.info("Automation dimmer: closing.");

      // Send the command.
      if(!this.setDoorState(this.hap.Characteristic.TargetDoorState.CLOSED)) {

        // Something went wrong. Let's make sure we revert the dimmer to it's prior state.
        setTimeout(() => {

          dimmerService?.updateCharacteristic(this.hap.Characteristic.On, !value);
        }, 50);
      }
    });

    // Return the door position of the opener.
    dimmerService.getCharacteristic(this.hap.Characteristic.Brightness)?.onGet(() => {

      return this.status.doorPosition;
    });

    // Adjust the door position of the opener by adjusting brightness of the light.
    dimmerService.getCharacteristic(this.hap.Characteristic.Brightness)?.onSet((value: CharacteristicValue) => {

      this.log.info("Automation dimmer: moving opener to %s%.", (value as number).toFixed(0));

      this.setDoorState((value as number) > 0 ?
        this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED, value as number);
    });

    // Initialize the switch.
    dimmerService.updateCharacteristic(this.hap.Characteristic.On, this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED);
    dimmerService.updateCharacteristic(this.hap.Characteristic.Brightness, this.status.doorPosition);

    this.log.info("Enabling automation dimmer.");

    return true;
  }

  // Configure a switch to automate open and close events in HomeKit beyond what HomeKit might allow for a garage opener service that gets treated as a secure service.
  private configureAutomationSwitch(): boolean {

    // Find the switch service, if it exists.
    let switchService = this.accessory.getServiceById(this.hap.Service.Switch, RatgdoReservedNames.SWITCH_OPENER_AUTOMATION);

    // The switch is disabled by default and primarily exists for automation purposes.
    if(!this.hints.automationSwitch) {

      if(switchService) {

        this.accessory.removeService(switchService);
        this.log.info("Disabling automation switch.");
      }

      return false;
    }

    // Add the switch to the opener, if needed.
    if(!switchService) {

      switchService = new this.hap.Service.Switch(this.name + " Automation Switch", RatgdoReservedNames.SWITCH_OPENER_AUTOMATION);

      if(!switchService) {

        this.log.error("Unable to add automation switch.");
        return false;
      }

      switchService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      this.setServiceName(switchService, this.name + " Automation Switch");
      this.accessory.addService(switchService);
    }

    // Return the current state of the opener.
    switchService.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

      // We're on if we are in any state other than closed (specifically open or stopped).
      return this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED;
    });

    // Open or close the opener.
    switchService.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => {

      // Inform the user.
      this.log.info("Automation switch: %s.", value ? "open" : "close" );

      // Send the command.
      if(!this.setDoorState(value ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED)) {

        // Something went wrong. Let's make sure we revert the switch to it's prior state.
        setTimeout(() => {

          switchService?.updateCharacteristic(this.hap.Characteristic.On, !value);
        }, 50);
      }
    });

    // Initialize the switch.
    switchService.updateCharacteristic(this.hap.Characteristic.On, this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED);

    this.log.info("Enabling automation switch.");

    return true;
  }

  // Configure the door open occupancy sensor for HomeKit.
  private configureDoorOpenOccupancySensor(): boolean {

    // Find the occupancy sensor service, if it exists.
    let occupancyService = this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_DOOR_OPEN);

    // The occupancy sensor is disabled by default and primarily exists for automation purposes.
    if(!this.hints.doorOpenOccupancySensor) {

      if(occupancyService) {

        this.accessory.removeService(occupancyService);
        this.log.info("Disabling door open indicator occupancy sensor.");
      }

      return false;
    }

    // We don't have an occupancy sensor, let's add it to the device.
    if(!occupancyService) {

      // We don't have it, add the occupancy sensor to the device.
      occupancyService = new this.hap.Service.OccupancySensor(this.name + " Open", RatgdoReservedNames.OCCUPANCY_SENSOR_DOOR_OPEN);

      if(!occupancyService) {

        this.log.error("Unable to add door open occupancy sensor.");
        return false;
      }

      occupancyService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      this.setServiceName(occupancyService, this.name + " Open");
      this.accessory.addService(occupancyService);
    }

    // Initialize the state of the occupancy sensor.
    occupancyService.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);
    occupancyService.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);

    occupancyService.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => {

      return this.status.availability;
    });

    this.log.info("Enabling door open indicator occupancy sensor. Occupancy will be triggered when the opener has been continuously open for more than %s seconds.",
      this.hints.doorOpenOccupancyDuration);

    return true;
  }

  // Configure the motion occupancy sensor for HomeKit.
  private configureMotionOccupancySensor(): boolean {

    // Find the occupancy sensor service, if it exists.
    let occupancyService = this.accessory.getServiceById(this.hap.Service.OccupancySensor, RatgdoReservedNames.OCCUPANCY_SENSOR_MOTION);

    // The occupancy sensor is disabled by default and primarily exists for automation purposes.
    if(!this.hints.motionOccupancySensor) {

      if(occupancyService) {

        this.accessory.removeService(occupancyService);
        this.log.info("Disabling occupancy sensor.");
      }

      return false;
    }

    // We don't have an occupancy sensor, let's add it to the device.
    if(!occupancyService) {

      // We don't have it, add the occupancy sensor to the device.
      occupancyService = new this.hap.Service.OccupancySensor(this.name, RatgdoReservedNames.OCCUPANCY_SENSOR_MOTION);

      if(!occupancyService) {

        this.log.error("Unable to add occupancy sensor.");
        return false;
      }

      occupancyService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      this.setServiceName(occupancyService, this.name);
      this.accessory.addService(occupancyService);
    }

    // Initialize the state of the occupancy sensor.
    occupancyService.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);
    occupancyService.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);

    occupancyService.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => {

      return this.status.availability;
    });

    this.log.info("Enabling occupancy sensor. Occupancy event duration set to %s seconds.", this.hints.motionOccupancyDuration);

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
        this.log.info("Device %s (%s v%s).", this.status.availability ? "connected" : "disconnected", this.device.type === Firmware.MQTT ? "MQTT" : "ESPHome",
          this.device.firmwareVersion);
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
                this.log.info("Garage door open occupancy detected.");

                // Publish to MQTT, if the user has configured it.
                this.platform.mqtt?.publish(this, "dooropenoccupancy", "true");
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
        this.log.info("%s.", camelCase(payload));

        // If we have an open occupancy sensor configured and our door state is anything other than open, clear our occupancy state.
        if(this.hints.doorOpenOccupancySensor && this.doorOccupancyTimer && (payload !== "open")) {

          clearTimeout(this.doorOccupancyTimer);
          this.doorOccupancyTimer = null;

          if(doorOccupancyService?.getCharacteristic(this.hap.Characteristic.OccupancyDetected).value as boolean) {

            doorOccupancyService?.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);
            this.log.info("Garage door open occupancy no longer detected.");

            // Publish to MQTT, if the user has configured it.
            this.platform.mqtt?.publish(this, "dooropenoccupancy", "false");
          }
        }

        // Publish to MQTT, if the user has configured it.
        this.platform.mqtt?.publish(this, "garagedoor", payload);

        break;

      case "light":

        // Only act if we're not already at the state we're updating to.
        if(this.status.light !== (payload === "on")) {

          this.status.light = payload === "on";
          lightBulbService?.updateCharacteristic(this.hap.Characteristic.On, this.status.light);

          // Inform the user:
          this.log.info("Light %s.", payload);

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this, "light", this.status.light.toString());
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

        // Inform the user:
        this.log.info("%s.", camelCase(payload));

        // Publish to MQTT, if the user has configured it.
        this.platform.mqtt?.publish(this, "lock", this.status.lock.toString());

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

          this.log.info("Motion detected.");

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this, "motion", this.status.motion.toString());
        }

        // Set a timer for the motion event.
        this.motionTimer = setTimeout(() => {

          this.status.motion = false;
          motionService?.updateCharacteristic(this.hap.Characteristic.MotionDetected, this.status.motion);

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this, "motion", this.status.motion.toString());
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
          this.platform.mqtt?.publish(this, "occupancy", "true");

          // Log the event.
          this.log.info("Occupancy detected.");
        }

        // Reset our occupancy state after occupancyDuration.
        this.motionOccupancyTimer = setTimeout(() => {

          // Reset the occupancy sensor.
          motionOccupancyService?.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this, "occupancy", "false");

          // Log the event.
          this.log.info("Occupancy no longer detected.");

          // Delete the timer.
          this.motionOccupancyTimer = null;
        }, this.hints.motionOccupancyDuration * 1000);

        break;

      case "obstruction":

        garageDoorService?.updateCharacteristic(this.hap.Characteristic.ObstructionDetected, payload === "obstructed");

        // Only act if we're not already at the state we're updating to.
        if(this.status.obstruction !== (payload === "obstructed")) {

          this.status.obstruction = payload === "obstructed";
          this.log.info("Obstruction %sdetected.", this.status.obstruction ? "" : "no longer ");

          // Publish to MQTT, if the user has configured it.
          this.platform.mqtt?.publish(this, "obstruction", this.status.obstruction.toString());
        }

        break;

      case "default":

        break;
    }
  }

  // Utility function to transmit a command to Ratgdo.
  private async command(topic: string, payload: string, position?: number): Promise<void> {

    if(this.device.type === Firmware.MQTT) {

      this.platform.broker.publish({ cmd: "publish", dup: false, payload: payload, qos: 2, retain: false, topic: this.device.name + "/command/" + topic },
        (error?: Error) => {

          if(error) {

            this.log.error("Publish error:");
            this.log.error(util.inspect(error), { colors: true, depth: null, sorted: true });
          }
        }
      );

      return;
    }

    // Now we handle ESPHome firmware commands.
    let endpoint;
    let action;

    switch(topic) {

      case "door":

        endpoint = "cover/door";

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
              return;
            }

            action = "set?position=" + (position / 100).toString();
            break;

          default:

            this.log.error("Unknown door command received: %s.", payload);
            return;
            break;
        }

        break;

      case "light":

        endpoint = "light/light";
        action = (payload === "on") ? "turn_on" : "turn_off";
        break;

      default:

        this.log.error("Unknown command received: %s - %s.", topic, payload);
        return;
        break;
    }

    try {

      // Execute the action.
      const response = await fetch("http://" + this.device.address + "/" + endpoint + "/" + action, { body: JSON.stringify({}), method: "POST"});

      if(!response?.ok) {

        this.log.error("Unable to execute command: %s - %s.", event, payload);
        return;
      }
    } catch(error) {

      if(error instanceof FetchError) {

        switch(error.code) {

          case "ECONNRESET":

            this.log.error("Connection to the Ratgdo controller has been reset.");
            break;

          default:

            this.log.error("Error sending command: %s %s.", error.code, error.message);
            break;
        }

        return;
      }

      this.log.error("Error sending command: %s", error);
    }
  }

  // Utility function to translate HomeKit's current door state values into human-readable form.
  private translateCurrentDoorState(value: CharacteristicValue): string {

    // HomeKit state decoder ring.
    switch(value) {

      case this.hap.Characteristic.CurrentDoorState.CLOSED:

        return "closed";
        break;

      case this.hap.Characteristic.CurrentDoorState.CLOSING:

        return "closing";
        break;

      case this.hap.Characteristic.CurrentDoorState.OPEN:

        return "open";
        break;

      case this.hap.Characteristic.CurrentDoorState.OPENING:

        return "opening";
        break;

      case this.hap.Characteristic.CurrentDoorState.STOPPED:

        return "stopped";
        break;

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
        break;

      case this.hap.Characteristic.TargetDoorState.OPEN:

        return "open";
        break;

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
        break;

      case this.hap.Characteristic.CurrentDoorState.STOPPED:

        return this.hap.Characteristic.CurrentDoorState.STOPPED;
        break;

      case this.hap.Characteristic.CurrentDoorState.CLOSED:
      case this.hap.Characteristic.CurrentDoorState.CLOSING:
      default:

        return this.hap.Characteristic.CurrentDoorState.CLOSED;
        break;
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
        break;

      case this.hap.Characteristic.CurrentDoorState.CLOSED:
      case this.hap.Characteristic.CurrentDoorState.CLOSING:
      default:

        return this.hap.Characteristic.TargetDoorState.CLOSED;
        break;
    }
  }

  // Utility function to return our bias for what the target door state should be.
  private lockTargetStateBias(state: CharacteristicValue): CharacteristicValue {

    switch(state) {

      case this.hap.Characteristic.LockCurrentState.SECURED:

        return this.hap.Characteristic.LockTargetState.SECURED;
        break;

      case this.hap.Characteristic.LockCurrentState.UNSECURED:
      case this.hap.Characteristic.LockCurrentState.JAMMED:
      case this.hap.Characteristic.LockCurrentState.UNKNOWN:
      default:

        return this.hap.Characteristic.LockTargetState.UNSECURED;
        break;
    }
  }

  // Utility function to return a floating point configuration parameter on a device.
  private getFeatureFloat(option: string): number | undefined {

    return getOptionFloat(getOptionValue(this.platform.configOptions, this.device, option));
  }

  // Utility function to return an integer configuration parameter on a device.
  private getFeatureNumber(option: string): number | undefined {

    return getOptionNumber(getOptionValue(this.platform.configOptions, this.device, option));
  }

  // Utility for checking feature options on a device.
  private hasFeature(option: string): boolean {

    return isOptionEnabled(this.platform.configOptions, this.device, option, this.platform.featureOptionDefault(option));
  }

  // Utility function to set the name of a service.
  private setServiceName(service: Service | undefined, name: string): void {

    if(!service) {

      return;
    }

    service.displayName = name;
    service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, name);
  }

  // Utility function to return the name of this device.
  private get name(): string {

    // We use the garage door service as the natural proxy for the name.
    const configuredName = this.accessory.getService(this.hap.Service.GarageDoorOpener)?.getCharacteristic(this.hap.Characteristic.ConfiguredName).value as string;

    // If we don't have a name for the garage door service, return the device name from Ratgdo.
    return configuredName?.length ? configuredName : this.device.name;
  }

  // Utility function to return the current accessory name of this device.
  private get accessoryName(): string {

    return (this.accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.Name).value as string) ?? this.device.name;
  }

  // Utility function to set the current accessory name of this device.
  private set accessoryName(name: string) {

    // Set all the internally managed names within Homebridge to the new accessory name.
    this.accessory.displayName = name;
    this.accessory._associatedHAPAccessory.displayName = name;

    // Set all the HomeKit-visible names.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Name, name);
  }
}
