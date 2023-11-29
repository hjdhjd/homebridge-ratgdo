/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-device.ts: Base class for all Ratgdo devices.
 */
import { API, CharacteristicValue, HAP, PlatformAccessory } from "homebridge";
import { RATGDO_MOTION_DURATION, RATGDO_TRANSITION_DURATION } from "./settings.js";
import { getOptionFloat, getOptionNumber, getOptionValue, isOptionEnabled, ratgdoOptions } from "./ratgdo-options.js";
import { ratgdoPlatform } from "./ratgdo-platform.js";
import util from "node:util";

// Ratgdo device settings.
export interface ratgdoDevice {

  firmwareVersion: string,
  mac: string,
  name: string,
}

// Device-specific options and settings.
interface ratgdoHints {

  automationSwitch: boolean,
  occupancyDuration: number,
  occupancySensor: boolean,
  readOnly: boolean,
  showBatteryInfo: boolean,
  syncNames: boolean
}

// Define ratgdo logging conventions.
interface ratgdoLogging {

  debug: (message: string, ...parameters: unknown[]) => void,
  error: (message: string, ...parameters: unknown[]) => void,
  info: (message: string, ...parameters: unknown[]) => void,
  warn: (message: string, ...parameters: unknown[]) => void
}

// Ratgdo status information.
interface ratgdoStatus {

  availability: boolean,
  door: CharacteristicValue,
  light: boolean,
  lock: CharacteristicValue,
  obstruction: boolean,
  motion: boolean
}

export class ratgdoAccessory {

  private readonly accessory: PlatformAccessory;
  private readonly api: API;
  private readonly config: ratgdoOptions;
  private device: ratgdoDevice;
  private doorTimer: NodeJS.Timeout | null;
  private readonly hap: HAP;
  private readonly hints: ratgdoHints;
  public readonly log: ratgdoLogging;
  private motionTimer: NodeJS.Timeout | null;
  private obstructionTimer: NodeJS.Timeout | null;
  private occupancyTimer: NodeJS.Timeout | null;
  private readonly platform: ratgdoPlatform;
  private readonly status: ratgdoStatus;

  // The constructor initializes key variables and calls configureDevice().
  constructor(platform: ratgdoPlatform, accessory: PlatformAccessory, device: ratgdoDevice) {

    this.accessory = accessory;
    this.api = platform.api;
    this.status = {} as ratgdoStatus;
    this.config = platform.config;
    this.doorTimer = null;
    this.hap = this.api.hap;
    this.hints = {} as ratgdoHints;
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
    this.status.light = false;
    this.status.lock = this.hap.Characteristic.LockCurrentState.UNSECURED;
    this.status.motion = false;
    this.status.obstruction = false;
    this.motionTimer = null;
    this.obstructionTimer = null;
    this.occupancyTimer = null;

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
    this.configureLight();
    this.configureMotionSensor();
    // this.configureSwitch();
    // this.configureOccupancySensor();
  }

  // Configure device-specific settings.
  private configureHints(): boolean {

    this.hints.automationSwitch = this.hasFeature("Opener.Switch");
    this.hints.occupancySensor = this.hasFeature("Opener.OccupancySensor");
    // this.hints.occupancyDuration = this.getFeatureNumber("Opener.OccupancySensor.Duration") ?? RATGDO_OCCUPANCY_DURATION;
    this.hints.readOnly = this.hasFeature("Opener.ReadOnly");
    this.hints.syncNames = this.hasFeature("Device.SyncNames");

    return true;
  }

  // Configure the device information for HomeKit.
  private configureInfo(): boolean {

    // Update the manufacturer information for this device.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Liftmaster");

    // Update the model information for this device.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Model, "Ratgdo");

    // Update the serial number for this device.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.device.mac.replace(/:/g, ""));

    // Update the firmware information for this device.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision,
      this.device.firmwareVersion);

    return true;
  }

  // Configure the garage door service for HomeKit.
  private configureGarageDoor(): boolean {

    let garageDoorService = this.accessory.getService(this.hap.Service.GarageDoorOpener);

    // Add the garage door opener service to the accessory, if needed.
    if(!garageDoorService) {

      garageDoorService = new this.hap.Service.GarageDoorOpener(this.name);
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

    // Add the lock garage door lock current and target state characteristics.
    garageDoorService.addOptionalCharacteristic(this.hap.Characteristic.LockCurrentState);
    garageDoorService.addOptionalCharacteristic(this.hap.Characteristic.LockTargetState);
    garageDoorService.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);
    garageDoorService.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.lockTargetStateBias(this.status.lock));

    // Add the configured name for this device.
    garageDoorService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
    // switchService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, switchName);

    // Update our configured name, if requested.
    if(this.hints.syncNames) {

      garageDoorService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.device.name);

      if(this.hints.occupancySensor) {

        this.accessory.getService(this.hap.Service.OccupancySensor)?.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.device.name + " Open");
      }
    }

    // Add our status active characteristic.
    garageDoorService.addOptionalCharacteristic(this.hap.Characteristic.StatusActive);
    garageDoorService.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.status.availability);
    garageDoorService.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);

    // Let HomeKit know that this is the primary service on this accessory.
    garageDoorService.setPrimaryService(true);

    return true;
  }

  // Configure the light for HomeKit.
  protected configureLight(): boolean {

    // Find the service, if it exists.
    let lightService = this.accessory.getService(this.hap.Service.Lightbulb);

    // Add the service to the accessory, if needed.
    if(!lightService) {

      lightService = new this.hap.Service.Lightbulb(this.name);

      if(!lightService) {

        this.log.error("Unable to add the light.");
        return false;
      }

      this.accessory.addService(lightService);
      this.log.info("Enabling light.");
    }

    // Turn the light on or off.
    lightService.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.status.light);
    lightService.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => {

      this.command("light", value === true ? "on" : "off");
    });

    // Initialize the light.
    lightService.displayName = this.name;
    lightService.updateCharacteristic(this.hap.Characteristic.Name, this.name);
    lightService.updateCharacteristic(this.hap.Characteristic.On, this.status.light);

    return true;
  }

  // Configure the motion sensor for HomeKit.
  protected configureMotionSensor(): boolean {

    // Find the motion sensor service, if it exists.
    let motionService = this.accessory.getService(this.hap.Service.MotionSensor);

    // We don't have a motion sensor, let's add it to the device.
    if(!motionService) {

      // We don't have it, add the motion sensor to the device.
      motionService = new this.hap.Service.MotionSensor(this.name);

      if(!motionService) {

        this.log.error("Unable to add the motion sensor.");
        return false;
      }

      this.accessory.addService(motionService);
      this.log.info("Enabling motion sensor.");
    }

    // Initialize the state of the motion sensor.
    motionService.displayName = this.name;
    motionService.updateCharacteristic(this.hap.Characteristic.Name, this.name);
    motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
    motionService.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);

    motionService.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.status.availability);

    return true;
  }

  // Open or close the garage door.
  private setDoorState(value: CharacteristicValue): boolean {

    const actionExisting = this.status.door === this.hap.Characteristic.CurrentDoorState.OPENING ? "opening" : "closing";
    const actionAttempt = value === this.hap.Characteristic.TargetDoorState.CLOSED ? "close" : "open";

    // If this garage door is read-only, we won't process any requests to set state.
    if(this.hints.readOnly) {

      this.log.info("Unable to %s door. The door has been configured to be read only.", actionAttempt);

      // Tell HomeKit that we haven't in fact changed our state so we don't end up in an inadvertent opening or closing state.
      setImmediate(() => {

        this.accessory.getService(this.hap.Service.GarageDoorOpener)?.updateCharacteristic(this.hap.Characteristic.TargetDoorState,
          value === this.hap.Characteristic.TargetDoorState.CLOSED ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED);
      });

      return false;
    }

    // If we are already opening or closing the garage door, we error out. As a precaution, we ensure we complete the current action before allowing a new one. This behavior may
    // change in the future, but for now, we manage this edge case by eliminating the possibility of doing so.
    if((this.status.door === this.hap.Characteristic.CurrentDoorState.OPENING) || (this.status.door === this.hap.Characteristic.CurrentDoorState.CLOSING)) {

      this.log.error("Unable to %s door while currently attempting to complete %s. The existing action must be allowed to complete before attempting a new one.",
        actionAttempt, actionExisting);

      return false;
    }

    // Close the garage door.
    if(value === this.hap.Characteristic.TargetDoorState.CLOSED) {

      // HomeKit is asking us to close the garage door, but let's make sure it's not already closed first.
      if(this.status.door !== this.hap.Characteristic.CurrentDoorState.CLOSED) {

        // Execute the command.
        this.command("door", "close", "closing");
      }

      return true;
    }

    // Open the garage door.
    if(value === this.hap.Characteristic.TargetDoorState.OPEN) {

      // HomeKit is informing us to open the door, but we don't want to act if it's already open.
      if(this.status.door !== this.hap.Characteristic.CurrentDoorState.OPEN) {

        // Execute the command.
        this.command("door", "open", "opening");
      }

      return true;
    }

    // HomeKit has told us something that we don't know how to handle.
    this.log.error("Unknown HomeKit set event received: %s.", value);

    return false;
  }

  // Update the state of the accessory.
  public updateState(event: string, payload: string): void {

    const camelCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

    switch(event) {

      case "availability":

        this.status.availability = payload === "online";

        // Update our availability.
        this.accessory.getService(this.hap.Service.GarageDoorOpener)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);
        this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);

        // Inform the user:
        this.log.info("Device %s.", this.status.availability ? "connected" : "disconnected");
        break;

      case "door":

        // Clear out our door transition timer, if we have one.
        if(this.doorTimer) {

          clearTimeout(this.doorTimer);
          this.doorTimer = null;
        }

        switch(payload) {

          case "closed":

            this.status.door = this.hap.Characteristic.CurrentDoorState.CLOSED;
            break;

          case "closing":

            this.status.door = this.hap.Characteristic.CurrentDoorState.CLOSING;

            // As a safety measure for occasionally unreliable MQTT message delivery, let's ensure we generate a closed state after a reasonable transition period. If we receive
            // an actual state update before this, this safety measure won't be triggered.
            this.doorTimer = setTimeout(() => {

              // Mark the door as closed.
              this.log.debug("Generating a close event to complete the state transition.");
              this.updateState("door", "closed");
              this.doorTimer = null;
            }, RATGDO_TRANSITION_DURATION * 1000);

            break;

          case "open":

            this.status.door = this.hap.Characteristic.CurrentDoorState.OPEN;
            break;

          case "opening":

            this.status.door = this.hap.Characteristic.CurrentDoorState.OPENING;

            // As a safety measure for occasionally unreliable MQTT message delivery, let's ensure we generate an open state after a reasonable transition period. If we receive
            // an actual state update before this, this safety measure won't be triggered.
            this.doorTimer = setTimeout(() => {

              // Mark the door as open.
              this.log.debug("Generating an open event to complete the state transition.");
              this.updateState("door", "open");
              this.doorTimer = null;
            }, RATGDO_TRANSITION_DURATION * 1000);

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

          this.accessory.getService(this.hap.Service.GarageDoorOpener)?.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.doorTargetStateBias(this.status.door));
        }

        this.accessory.getService(this.hap.Service.GarageDoorOpener)?.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.status.door);

        // Inform the user:
        this.log.info("%s.", camelCase(payload));
        break;

      case "light":

        this.status.light = payload === "on";
        this.accessory.getService(this.hap.Service.Lightbulb)?.updateCharacteristic(this.hap.Characteristic.On, this.status.light);

        // Inform the user:
        this.log.info("Light %s.", payload);
        break;

      case "lock":

        // Determine our current and target lock states.
        this.status.lock = payload === "locked" ? this.hap.Characteristic.LockCurrentState.SECURED : this.hap.Characteristic.LockCurrentState.UNSECURED;

        // Update our lock state.
        this.accessory.getService(this.hap.Service.GarageDoorOpener)?.updateCharacteristic(this.hap.Characteristic.LockTargetState,
          payload === "locked" ? this.hap.Characteristic.LockTargetState.SECURED : this.hap.Characteristic.LockTargetState.UNSECURED);
        this.accessory.getService(this.hap.Service.GarageDoorOpener)?.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);

        // Inform the user:
        this.log.info("%s.", camelCase(payload));
        break;

      case "motion":

        this.status.motion = payload === "detected";

        // Motion no longer detected, clear out the motion sensor timer, and we're done.
        if(!this.status.motion && this.motionTimer) {

          clearTimeout(this.motionTimer);
          this.motionTimer = null;
          break;
        }

        // Update the motion sensor state.
        this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.MotionDetected, this.status.motion);

        // If we already have an inflight motion sensor timer, clear it out since we're restarting the timer. Also, if it's our first time detecting motion for this event cycle,
        // let the user know.
        this.motionTimer ? clearTimeout(this.motionTimer) : this.log.info("Motion detected.");

        // Set a timer for the motion event.
        this.motionTimer = setTimeout(() => {

          this.status.motion = false;
          this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.MotionDetected, this.status.motion);
        }, RATGDO_MOTION_DURATION * 1000);

        break;

      case "obstruction":

        this.status.obstruction = payload === "obstructed";
        this.accessory.getService(this.hap.Service.GarageDoorOpener)?.updateCharacteristic(this.hap.Characteristic.ObstructionDetected, this.status.obstruction);
        this.log.info("Obstruction %sdetected.", this.status.obstruction ? "" : "no longer ");
        break;

      case "default":

        break;
    }
  }

  // Utility function to return our bias for what the current door state should be. This is primarily used for our initial bias on startup.
  private doorCurrentStateBias(state: CharacteristicValue): CharacteristicValue {

    // Our current door state reflects our opinion on what open or closed means in HomeKit terms. For the obvious states, this is easy. For some of the edge cases, it can be
    // less so. Our north star is that if we are in an obstructed state, we are open.
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

    // We need to be careful with respect to the target state and we need to make some reasonable assumptions about where we intend to end up. If we are opening or closing, our
    // target state needs to be the completion of those actions. If we're stopped or obstructed, we're going to assume the desired target state is to be open, since that is the
    // typical opener behavior, and it's impossible for us to know with reasonable certainty what the original intention of the action was.
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

  // Utility function to transmit a command to Ratgdo.
  private command(topic: string, payload: string, updatePayload?: string): void {

    this.platform.broker.publish({ cmd: "publish", dup: false, payload: payload, qos: 2, retain: false, topic: this.device.name + "/command/" + topic }, () => {});

    // Update our internal state as well.
    if(updatePayload) {

      this.updateState(topic, updatePayload);
    }
  }

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: string): number | undefined {

    return getOptionFloat(getOptionValue(this.platform.configOptions, this.device, option));
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): number | undefined {

    return getOptionNumber(getOptionValue(this.platform.configOptions, this.device, option));
  }

  // Utility for checking feature options on a device.
  public hasFeature(option: string): boolean {

    return isOptionEnabled(this.platform.configOptions, this.device, option, this.platform.featureOptionDefault(option));
  }

  // Name utility function.
  public get name(): string {

    const configuredName = this.accessory.getService(this.hap.Service.GarageDoorOpener)?.getCharacteristic(this.hap.Characteristic.ConfiguredName).value as string;

    return configuredName?.length ? configuredName : this.device.name;
  }
}
