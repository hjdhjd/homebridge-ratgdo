/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.ts: Ratgdo device accessory for HomeKit.
 */
import type { API, Characteristic, CharacteristicValue, HAP, PlatformAccessory, Service, WithUUID } from "homebridge";
import type { AcquireServiceTarget, HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import type { EntityId, TelemetryEvent } from "esphome-client";
import type { EspHomeEvent, RatgdoDevice } from "./types.ts";
import { LockCommand, LockState } from "esphome-client";
import { RATGDO_ENTITIES, idFor } from "./entities.ts";
import { RATGDO_KONNECTED_PCW_DURATION, RATGDO_MOTION_DURATION, RATGDO_OCCUPANCY_DURATION, RATGDO_UI_REVERT_DELAY } from "./settings.ts";
import { RatgdoService, RatgdoVariant } from "./types.ts";
import { TimerRegistry, acquireService, guardedDispatch, validService } from "homebridge-plugin-utils";
import type { RatgdoEntityRef } from "./entities.ts";
import type { RatgdoPlatform } from "./platform.ts";
import util from "node:util";

/* Command topics dispatched to the ESPHome client by command(). Each topic accepts a different payload shape:
 *
 *   - "door":              "open" | "closed" | "stop" | "set" (with an optional position from 0 to 100 when payload is "set").
 *   - "light":             "on" | "off".
 *   - "lock":              "lock" | "unlock".
 *   - "disco-laser":       "on" | "off".
 *   - "disco-led":         "on" | "off".
 *   - "konnected-strobe":  "on" | "off".
 *   - "konnected-pcw":     no payload, the command issues a momentary button press.
 *   - "refresh":           no payload, the command triggers a status query button.
 */
type CommandTopic = "disco-laser" | "disco-led" | "door" | "konnected-pcw" | "konnected-strobe" | "light" | "lock" | "refresh";

/* Device-specific options and settings. Resolved once at configuration time by buildHints() and never reassigned for the lifetime of the accessory; the readonly
 * surface here mirrors that contract.
 *
 * `logName` is the user-configured Device.LogName feature option captured at configure time. Caching it here avoids paying the featureOptions lookup cost on every
 * single log line emission (the `name` getter is called from `prefixed()`, which fronts every info / warn / error log). All other hint fields follow the same
 * read-once-cache-forever pattern.
 */
interface RatgdoHints {

  readonly automationDimmer: boolean;
  readonly automationSwitch: boolean;
  readonly discoBattery: boolean;
  readonly discoLaserSwitch: boolean;
  readonly discoLedSwitch: boolean;
  readonly discoVehicleArriving: boolean;
  readonly discoVehicleLeaving: boolean;
  readonly discoVehiclePresence: boolean;
  // Expressed in seconds; multiplied by 1000 at its setTimeout call site.
  readonly doorOpenOccupancyDuration: number;
  readonly doorOpenOccupancySensor: boolean;
  readonly konnectedPcwSwitch: boolean;
  readonly konnectedStrobeSwitch: boolean;
  readonly light: boolean;
  readonly lock: boolean;
  readonly lockoutSwitch: boolean;
  readonly logLight: boolean;
  readonly logMotion: boolean;
  readonly logName: string | undefined;
  readonly logObstruction: boolean;
  readonly logOpener: boolean;
  readonly logVehiclePresence: boolean;
  // Expressed in seconds; multiplied by 1000 at its setTimeout call site.
  readonly motionOccupancyDuration: number;
  readonly motionOccupancySensor: boolean;
  readonly motionSensor: boolean;
  readonly readOnly: boolean;
}

/* Ratgdo status information. Every observable piece of device state lives on this object so MQTT, log, and HomeKit reads share a single source of truth - the cached
 * services map is for hot-path lookup, not state. Occupancy flags (`doorOpenOccupancy`, `motionOccupancy`) live here so MQTT subscribeGet callbacks read them
 * directly rather than resolving HAP characteristic values.
 */
interface RatgdoStatus {

  availability: boolean;
  discoBatteryState: CharacteristicValue;
  discoLaser: boolean;
  discoLed: boolean;
  discoVehicleArriving: boolean;
  discoVehicleLeaving: boolean;
  discoVehiclePresence: boolean;
  door: CharacteristicValue;
  doorOpenOccupancy: boolean;
  doorPosition: number;
  konnectedStrobe: boolean;
  light: boolean;
  // Narrowed to number rather than CharacteristicValue: the only assignments in this file are hap.Characteristic.LockCurrentState.* enum members, which are numbers.
  // The tighter type lets MQTT publish and stringification sites consume the value directly without a cast.
  lock: number;
  motion: boolean;
  motionOccupancy: boolean;
  obstruction: boolean;
}

// Constructor target for a HAP Characteristic subclass. Mirrors AcquireServiceTarget from homebridge-plugin-utils but for characteristics, so the sensor-configuration
// helper below can declare its initial-state characteristic parameter with the same precision the rest of the codebase applies to services.
type CharacteristicTarget = WithUUID<new () => Characteristic>;

/* Wiring for every timer-derived occupancy indicator. Each kind maps to its RatgdoStatus field, its HomeKit OccupancySensor subtype, its MQTT topic suffix, and its
 * log label, so the shared setOccupancy() writer stays generic across both paths. Adding a future occupancy kind is a single descriptor entry plus its trigger wiring -
 * the write (status, characteristic, log, MQTT) lives in one place and cannot drift. This mirrors the RATGDO_ENTITIES registry in entities.ts.
 */
const RATGDO_OCCUPANCY = {

  doorOpen: { field: "doorOpenOccupancy", label: "Garage door open occupancy", service: RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN, topic: "dooropenoccupancy" },
  motion: { field: "motionOccupancy", label: "Occupancy", service: RatgdoService.OCCUPANCY_SENSOR_MOTION, topic: "occupancy" }
} as const;

type OccupancyKind = keyof typeof RATGDO_OCCUPANCY;

/* The per-accessory HomeKit projection for a single garage door opener. Owns HomeKit service configuration, the RatgdoStatus single-source-of-truth, updateState()
 * telemetry-event routing, command dispatch to the ESPHome client, and MQTT publishing.
 */
export class RatgdoAccessory {

  private readonly accessory: PlatformAccessory;
  private readonly api: API;
  public readonly device: RatgdoDevice;
  private readonly hap: HAP;
  public readonly hints: RatgdoHints;
  public readonly log: HomebridgePluginLogging;
  // The per-accessory abort controller composed into every MQTT subscription this accessory registers. Aborting it at disposal removes those subscriptions from the
  // shared MqttClient handler set in lockstep with the accessory's teardown, so no MQTT handler outlives the accessory.
  private readonly mqttAbort: AbortController;
  private readonly platform: RatgdoPlatform;
  private readonly services: Partial<Record<RatgdoService, Service>>;
  private readonly status: RatgdoStatus;
  // The timer registry for this accessory: every deferred callback (the motion and occupancy resets, the Konnected pulse, the UI revert) arms through it, keyed for the
  // timers whose newest intent should replace the prior one and anonymous for the fire-and-forget ones. Its dispose drains every pending timer in lockstep with the
  // accessory's teardown. No lifetime signal is passed - the accessory's own [Symbol.dispose] is the only lifetime bound.
  private readonly timers = new TimerRegistry();

  constructor(platform: RatgdoPlatform, accessory: PlatformAccessory, device: RatgdoDevice, initialState: ReadonlyMap<EntityId, TelemetryEvent>) {

    this.accessory = accessory;
    this.api = platform.api;
    this.hap = this.api.hap;
    this.device = device;
    this.platform = platform;
    this.services = {};

    this.log = {

      // Short-circuit before util.format runs when debug is off. Otherwise the format work would always execute even though platform.debug() would discard the
      // result. Saves the prefix concatenation, the format call, and the platform.debug indirection on every off-debug call.
      debug: (message: string, ...parameters: unknown[]): void => {

        if(!platform.config.debug) {

          return;
        }

        platform.debug(this.prefixed(message, ...parameters));
      },
      error: (message: string, ...parameters: unknown[]): void => platform.log.error(this.prefixed(message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => platform.log.info(this.prefixed(message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => platform.log.warn(this.prefixed(message, ...parameters))
    };

    /* Build status from the captured initial telemetry. `initialState` carries one event per stateful entity the device exposed - the platform's discovery path
     * already waited for ESPHome's per-entity SUBSCRIBE_STATES burst to land before constructing us. Status fields are therefore initialized to real device state,
     * not placeholder defaults; configureXxx writes the populated values straight into HAP so HomeKit sees the device's actual current state from frame zero.
     */
    this.status = this.buildInitialStatus(initialState);

    this.hints = this.buildHints();

    /* Read-only deviation log runs AFTER `this.hints` is assigned. The `name` getter (which fronts every log line via `prefixed()`) reads `this.hints.logName`, so any
     * logging that fires while `this.hints` is still undefined would crash with a TypeError. Keeping the call here - and out of `buildHints()` - means the cache
     * contract (hints fully resolved before any log call that depends on it) is enforced by program order, not by reviewer discipline.
     */
    this.logFeature("Opener.ReadOnly", "Read-only mode");

    this.mqttAbort = new AbortController();
    this.configureDevice();
  }

  // Public identity accessor. Surfaces the accessory's HAP UUID without exposing the full PlatformAccessory, so internal accessory mutations stay inside the class.
  public get uuid(): string {

    return this.accessory.UUID;
  }

  /* Synchronous disposal hook. Tears down every resource this accessory owns: the pending timers in the registry, and the per-accessory MQTT subscriptions composed onto
   * `mqttAbort`. The platform invokes this at shutdown so no pending timer or MQTT subscription outlives the accessory.
   */
  public [Symbol.dispose](): void {

    this.mqttAbort.abort();
    this.timers.dispose();
  }

  // Configure a garage door accessory for HomeKit.
  private configureDevice(): void {

    // Reset the accessory's persisted context. Homebridge persists accessory.context across restarts, but we treat every startup as a clean slate and rebuild state
    // from live telemetry, so we begin from a known-empty context.
    this.accessory.context = {};

    // Configure ourselves. Hints are already resolved by the constructor, so configureDevice only walks the HomeKit-facing services.
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

  /* Translate the captured initial telemetry into a fully-populated RatgdoStatus. Called exactly once from the constructor; the result becomes `this.status` and is
   * updated thereafter by the platform's telemetry handler on every wire-side state change. The cross-variant reads happen here against the base entity surface;
   * the variant-specific reads are delegated to `buildVariantSpecificInitialStatus`, where the variant narrows to its required-field registry and the readers can
   * accept guaranteed-defined refs.
   *
   * Status fields fall into the following categories:
   *
   *   - From telemetry: door, doorPosition, light, lock, obstruction, discoLaser, discoLed, discoVehiclePresence, konnectedStrobe. We populate from the corresponding
   *     entity's current state. Variant-specific fields default to `false` on the opposing variant (the entity simply does not exist there).
   *   - Always-default at construction: discoBatteryState (populated later by the platform's verbose-log subscription), motion / discoVehicleArriving /
   *     discoVehicleLeaving (momentary events - "currently triggered" is not a state we want to carry forward across construction), doorOpenOccupancy / motionOccupancy
   *     (timer-derived occupancy state, starts cleared).
   *   - Connection metadata: availability (true - the platform only invokes us after captureInitialState resolved, i.e., the device is connected and pushing state).
   */
  private buildInitialStatus(initialState: ReadonlyMap<EntityId, TelemetryEvent>): RatgdoStatus {

    const entities = RATGDO_ENTITIES[this.device.variant];
    const cover = this.readCoverState(initialState, entities.cover);

    return {

      availability: true,
      discoBatteryState: this.hap.Characteristic.ChargingState.NOT_CHARGING,
      discoVehicleArriving: false,
      discoVehicleLeaving: false,
      door: cover.door,
      doorOpenOccupancy: false,
      doorPosition: cover.position,
      light: this.readLightOn(initialState, entities.light),
      lock: this.readLockState(initialState, entities.lock),
      motion: false,
      motionOccupancy: false,
      obstruction: this.readBinarySensorOn(initialState, entities.obstruction),
      ...this.buildVariantSpecificInitialStatus(initialState)
    };
  }

  /* Variant-narrowed read of the entities only present on one variant. The switch is exhaustive so a future third variant fails compilation here until handled; each
   * branch resolves through the variant's required-field registry and the readers receive guaranteed-defined refs (the type system, not a runtime check, enforces
   * the rule that "variant X has variant-X-specific entities"). Returns a Pick over the status fields this helper owns so the spread at the caller is total.
   */
  private buildVariantSpecificInitialStatus(initialState: ReadonlyMap<EntityId, TelemetryEvent>):
  Pick<RatgdoStatus, "discoLaser" | "discoLed" | "discoVehiclePresence" | "konnectedStrobe"> {

    switch(this.device.variant) {

      case RatgdoVariant.KONNECTED: {

        const entities = RATGDO_ENTITIES[RatgdoVariant.KONNECTED];

        return {

          discoLaser: false,
          discoLed: false,
          discoVehiclePresence: false,
          konnectedStrobe: this.readSwitchOn(initialState, entities.strOutput)
        };
      }

      case RatgdoVariant.RATGDO: {

        const entities = RATGDO_ENTITIES[RatgdoVariant.RATGDO];

        return {

          discoLaser: this.readSwitchOn(initialState, entities.laser),
          discoLed: this.readSwitchOn(initialState, entities.led),
          discoVehiclePresence: this.readBinarySensorOn(initialState, entities.vehicleDetected),
          konnectedStrobe: false
        };
      }
    }
  }

  // Read a binary_sensor entity's current state. The ref is required because every caller has narrowed to a variant where the entity is statically known to exist -
  // no defensive optional handling needed.
  private readBinarySensorOn(initialState: ReadonlyMap<EntityId, TelemetryEvent>, ref: RatgdoEntityRef<"binary_sensor">): boolean {

    const event = initialState.get(idFor(ref));

    return ((event?.type === "binary_sensor") && Boolean(event.state));
  }

  // Read a switch entity's current state. Same required-ref contract as the binary_sensor reader.
  private readSwitchOn(initialState: ReadonlyMap<EntityId, TelemetryEvent>, ref: RatgdoEntityRef<"switch">): boolean {

    const event = initialState.get(idFor(ref));

    return ((event?.type === "switch") && Boolean(event.state));
  }

  // Read a light entity's current state. The light entity is cross-variant so the ref is required; the variant-keyed registry resolves "light" on Ratgdo and
  // "garage_light" on Konnected at construction time.
  private readLightOn(initialState: ReadonlyMap<EntityId, TelemetryEvent>, ref: RatgdoEntityRef<"light">): boolean {

    const event = initialState.get(idFor(ref));

    return ((event?.type === "light") && Boolean(event.state));
  }

  /* Read a cover entity and translate its position into HomeKit's CurrentDoorState plus the percent-position used by the automation dimmer. ESPHome reports cover
   * position as a float 0-1; we mirror updateState's "stopped at partial" semantics so initial state matches the device's actual physical position when the user has
   * stopped the door mid-travel.
   */
  private readCoverState(initialState: ReadonlyMap<EntityId, TelemetryEvent>, ref: RatgdoEntityRef<"cover">): { door: CharacteristicValue; position: number } {

    const event = initialState.get(idFor(ref));

    if(event?.type !== "cover") {

      return { door: this.hap.Characteristic.CurrentDoorState.CLOSED, position: 0 };
    }

    const rawPosition = event.position ?? 0;

    if(rawPosition <= 0) {

      return { door: this.hap.Characteristic.CurrentDoorState.CLOSED, position: 0 };
    }

    if(rawPosition >= 1) {

      return { door: this.hap.Characteristic.CurrentDoorState.OPEN, position: 100 };
    }

    // Strictly between 0 and 1: the door is parked at a partial-open position. updateState's "stopped" detection uses the same condition.
    return { door: this.hap.Characteristic.CurrentDoorState.STOPPED, position: rawPosition * 100 };
  }

  // Read a lock entity. Every non-LOCKED state (UNLOCKED, LOCKING, UNLOCKING, JAMMED, NONE, OPENING, OPEN) collapses to UNSECURED because HomeKit only acts on the binary
  // SECURED / UNSECURED cases - the same conservative mapping updateState uses for ongoing lock telemetry.
  private readLockState(initialState: ReadonlyMap<EntityId, TelemetryEvent>, ref: RatgdoEntityRef<"lock">): number {

    const event = initialState.get(idFor(ref));

    if(event?.type !== "lock") {

      return this.hap.Characteristic.LockCurrentState.UNSECURED;
    }

    return (event.state === LockState.LOCKED) ?
      this.hap.Characteristic.LockCurrentState.SECURED :
      this.hap.Characteristic.LockCurrentState.UNSECURED;
  }

  /* Build the hints record from feature-option configuration. Resolves every option exactly once at construction time and returns the populated structure. The
   * caching contract is structural: any reader (the `name` getter, the configureXxx methods, the updateState hot path) reads from `this.hints.X` instead of re-issuing
   * the underlying featureOptions lookup. The variant gates fold here too so configureXxx() methods can treat a single hint boolean as the source of truth for whether
   * a feature applies to this device.
   *
   * No side effects: this function returns a value and does not touch `this.hints`, `this.log`, or any other field that depends on construction order. Side effects
   * that depend on the resolved hints (e.g., the read-only announcement) belong in the constructor, after `this.hints` is assigned.
   */
  private buildHints(): RatgdoHints {

    const isRatgdo = this.device.variant === RatgdoVariant.RATGDO;
    const isKonnected = this.device.variant === RatgdoVariant.KONNECTED;
    const featureOptions = this.platform.featureOptions;

    return {

      automationDimmer: this.hasFeature("Opener.Dimmer"),
      automationSwitch: this.hasFeature("Opener.Switch"),
      discoBattery: isRatgdo && this.hasFeature("Disco.Battery"),
      discoLaserSwitch: isRatgdo && this.hasFeature("Disco.Switch.Laser"),
      discoLedSwitch: isRatgdo && this.hasFeature("Disco.Switch.Led"),
      discoVehicleArriving: isRatgdo && this.hasFeature("Disco.ContactSensor.Vehicle.Arriving"),
      discoVehicleLeaving: isRatgdo && this.hasFeature("Disco.ContactSensor.Vehicle.Leaving"),
      discoVehiclePresence: isRatgdo && this.hasFeature("Disco.OccupancySensor.Vehicle.Presence"),
      doorOpenOccupancyDuration: featureOptions.getInteger("Opener.OccupancySensor.Duration", this.device.mac) ?? RATGDO_OCCUPANCY_DURATION,
      doorOpenOccupancySensor: this.hasFeature("Opener.OccupancySensor"),
      konnectedPcwSwitch: isKonnected && this.hasFeature("Konnected.Switch.Pcw"),
      konnectedStrobeSwitch: isKonnected && this.hasFeature("Konnected.Switch.Strobe"),
      light: this.hasFeature("Light"),
      lock: this.hasFeature("Opener.Lock"),
      lockoutSwitch: this.hasFeature("Opener.Switch.RemoteLockout"),
      logLight: this.hasFeature("Log.Light"),
      logMotion: this.hasFeature("Log.Motion"),
      logName: this.platform.resolveLogName(this.device.mac),
      logObstruction: this.hasFeature("Log.Obstruction"),
      logOpener: this.hasFeature("Log.Opener"),
      logVehiclePresence: this.hasFeature("Log.VehiclePresence"),
      motionOccupancyDuration: featureOptions.getInteger("Motion.OccupancySensor.Duration", this.device.mac) ?? RATGDO_OCCUPANCY_DURATION,
      motionOccupancySensor: this.hasFeature("Motion.OccupancySensor"),
      motionSensor: this.hasFeature("Motion"),
      readOnly: this.hasFeature("Opener.ReadOnly")
    };
  }

  // Configure the device information for HomeKit. The Manufacturer, SerialNumber, and FirmwareRevision characteristics never mutate over the lifetime of this
  // accessory (they derive from immutable RatgdoDevice fields populated at discovery time), so we write them exactly once here. The mutable Model characteristic
  // routes through refreshModel(), which is what the availability event handler calls on each reconnect.
  private configureInfo(): void {

    const info = this.accessory.getService(this.hap.Service.AccessoryInformation);

    info?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "github.com/hjdhjd");
    info?.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.device.mac);
    info?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, this.device.firmwareVersion);

    this.refreshModel();
  }

  // Refresh the Model characteristic. The platform mutates `device.model` on reconnect (a firmware-side rename or hardware-variant disclosure can land between
  // connects), so this is the lone AccessoryInformation field that updateState's availability case re-pushes to HomeKit.
  private refreshModel(): void {

    const info = this.accessory.getService(this.hap.Service.AccessoryInformation);

    info?.updateCharacteristic(this.hap.Characteristic.Model,
      ((this.device.variant === RatgdoVariant.KONNECTED) ? "Konnected" : "Ratgdo") + (this.device.model ? " " + this.device.model : ""));
  }

  // Compose the wire-level MQTT topic for this device. Every publish and subscription on this accessory routes through this helper so the per-device prefix shape
  // ("<mac>/<suffix>") is defined in exactly one place. The platform's MqttClient prepends its own configured topicPrefix on top of whatever we return here.
  private mqttTopic(suffix: string): string {

    return this.device.mac + "/" + suffix;
  }

  // Publish a status update to MQTT through guardedDispatch, so a rejected publish - the broker vanishing mid-write, a teardown race - lands in the log instead of
  // floating as an unhandled rejection. Publishing is fire-and-forget by design; the guard is about making the rare failure visible, not about awaiting delivery.
  private publishStatus(topicSuffix: string, message: string): void {

    const label = "MQTT publish (" + topicSuffix + ")";

    guardedDispatch({ handler: async (): Promise<void> => { await this.platform.mqtt?.publish(this.mqttTopic(topicSuffix), message); }, label, log: this.log });
  }

  // Configure MQTT services. Every subscribe* call passes the per-accessory `mqttAbort.signal` so the MqttClient removes our handlers when this accessory disposes -
  // critical for the connect-retry recovery path, where an in-flight accessory would otherwise leak handlers into the next attempt's accessory instance.
  private configureMqtt(): boolean {

    const signal = this.mqttAbort.signal;

    // Return our garage door state.
    this.platform.mqtt?.subscribeGet(this.mqttTopic("garagedoor"), "Garage Door", () => {

      return this.translateCurrentDoorState(this.status.door);
    }, { signal });

    // Set our garage door state.
    this.platform.mqtt?.subscribeSet(this.mqttTopic("garagedoor"), "Garage Door", (value: string) => {

      const [ verb, positionText ] = value.split(" ");
      let command;
      let position: number | undefined;

      switch(verb) {

        case "close":

          command = this.hap.Characteristic.TargetDoorState.CLOSED;

          break;

        case "open":

          command = this.hap.Characteristic.TargetDoorState.OPEN;

          // Parse the position information.
          position = Number.parseFloat(positionText ?? "");

          if(!Number.isFinite(position) || (position < 0) || (position > 100)) {

            position = undefined;
          }

          break;

        default:

          this.log.error("Invalid garage door MQTT command received: %s.", value);

          return;
      }

      // Set our door state accordingly.
      this.setDoorState(command, position);
    }, { signal });

    // Return our lock state.
    this.platform.mqtt?.subscribeGet(this.mqttTopic("lock"), "Lock", () => String(this.status.lock), { signal });

    // Return our obstruction state.
    this.platform.mqtt?.subscribeGet(this.mqttTopic("obstruction"), "Obstruction", () => this.status.obstruction.toString(), { signal });

    // Return our door open occupancy state if configured to do so. We read from status rather than from the HAP characteristic so MQTT and HomeKit share the same
    // source of truth - the status field is updated atomically with the characteristic write at every transition site (the open-door timer fire and the door-closed
    // clear) so the two never drift.
    if(this.hints.doorOpenOccupancySensor) {

      this.platform.mqtt?.subscribeGet(this.mqttTopic("dooropenoccupancy"), "Door Open Indicator Occupancy",
        () => this.status.doorOpenOccupancy.toString(), { signal });
    }

    // Return our light state if configured to do so.
    if(this.hints.light) {

      this.platform.mqtt?.subscribeGet(this.mqttTopic("light"), "Light", () => this.status.light.toString(), { signal });
    }

    // Return our motion occupancy state if configured to do so. See the doorOpenOccupancy reader above for the rationale on reading from status rather than HAP.
    if(this.hints.motionOccupancySensor) {

      this.platform.mqtt?.subscribeGet(this.mqttTopic("occupancy"), "Occupancy", () => this.status.motionOccupancy.toString(), { signal });
    }

    // Return our motion state if configured to do so.
    if(this.hints.motionSensor) {

      this.platform.mqtt?.subscribeGet(this.mqttTopic("motion"), "Motion", () => this.status.motion.toString(), { signal });
    }

    return true;
  }

  // Configure the garage door service for HomeKit.
  private configureGarageDoor(): boolean {

    const service = acquireService(this.accessory, this.hap.Service.GarageDoorOpener, this.name);

    if(!service) {

      this.log.error("Unable to add the garage door.");

      return false;
    }

    this.services[RatgdoService.GARAGE_DOOR] = service;

    service.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.status.door);
    service.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.doorTargetStateBias(this.status.door));

    service.getCharacteristic(this.hap.Characteristic.TargetDoorState).onSet((value: CharacteristicValue) => this.setDoorState(value));
    service.getCharacteristic(this.hap.Characteristic.CurrentDoorState).onGet(() => this.status.door);
    service.getCharacteristic(this.hap.Characteristic.ObstructionDetected).onGet(() => this.status.obstruction);

    this.logFeature("Opener.Lock", "Wireless remote lock");

    // Configure the wireless remote lock current and target state characteristics if the user has enabled it.
    if(this.hints.lock) {

      service.getCharacteristic(this.hap.Characteristic.LockTargetState).onSet((value: CharacteristicValue) => {

        if(!this.command("lock", (value === this.hap.Characteristic.LockTargetState.SECURED) ? "lock" : "unlock")) {

          // The command did not reach the device. Revert the UI to its prior state once HomeKit has acknowledged the onSet.
          this.scheduleUiRevert(() => {

            service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.lockTargetStateBias(this.status.lock));
            service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);
          });
        }
      });

      service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);
      service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.lockTargetStateBias(this.status.lock));
    } else {

      // The user disabled the lock feature. Strip any leftover lock characteristics so HomeKit does not surface them on the garage door tile.
      for(const characteristic of [ this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockTargetState ]) {

        service.removeCharacteristic(service.getCharacteristic(characteristic));
      }
    }

    // The garage door is the primary affordance for this accessory, which controls how HomeKit surfaces it in the Home app.
    service.setPrimaryService(true);

    return true;
  }

  // Configure the light for HomeKit.
  private configureLight(): boolean {

    this.logFeature("Light", "Light");

    if(!validService(this.accessory, this.hap.Service.Lightbulb, this.hints.light)) {

      return false;
    }

    const service = acquireService(this.accessory, this.hap.Service.Lightbulb, this.name);

    if(!service) {

      this.log.error("Unable to add the light.");

      return false;
    }

    this.services[RatgdoService.LIGHT] = service;

    service.updateCharacteristic(this.hap.Characteristic.On, this.status.light);
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.status.light);
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.toggleOnSet("light", service));

    return true;
  }

  /* Shared configuration path for sensor services that follow the same shape: a binary state characteristic (motion / contact / occupancy) plus a StatusActive
   * characteristic backed by the accessory-wide availability flag. The binary characteristic is seeded from `initialState` - the caller's corresponding RatgdoStatus
   * field, which is the single source of truth - rather than a hardcoded default, so the momentary-versus-persistent distinction lives entirely in buildInitialStatus:
   * momentary sensors (motion, the vehicle arriving and leaving contacts) resolve to false there and start clear, while a persistent sensor like vehicle presence
   * carries the state captured at construction straight onto its characteristic. Every sensor service of this shape shares this block, so a future sensor variant is a
   * single declarative entry and any cross-cutting change (a new StatusActive default, an added characteristic) lands in exactly one place. Deviation logging is the
   * caller's responsibility via `this.logFeature()` at the top of the calling configureXxx, so this helper stays focused on service wiring and carries no logging
   * concern of its own.
   */
  private configureAvailabilitySensor(opts: {

    cacheKey: RatgdoService;
    errorMessage: string;
    hint: boolean;
    initialCharacteristic: CharacteristicTarget;
    initialState: boolean;
    nameSuffix?: string;
    service: AcquireServiceTarget;
    subtype?: string;
  }): boolean {

    if(!validService(this.accessory, opts.service, opts.hint, opts.subtype)) {

      return false;
    }

    const displayName = (opts.nameSuffix !== undefined) ? (this.name + opts.nameSuffix) : this.name;
    const service = acquireService(this.accessory, opts.service, displayName, opts.subtype);

    if(!service) {

      this.log.error(opts.errorMessage);

      return false;
    }

    this.services[opts.cacheKey] = service;

    service.updateCharacteristic(opts.initialCharacteristic, opts.initialState);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.status.availability);
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.status.availability);

    return true;
  }

  // Configure the motion sensor for HomeKit.
  private configureMotionSensor(): boolean {

    this.logFeature("Motion", "Motion sensor");

    return this.configureAvailabilitySensor({

      cacheKey: RatgdoService.MOTION_SENSOR,
      errorMessage: "Unable to add the motion sensor.",
      hint: this.hints.motionSensor,
      initialCharacteristic: this.hap.Characteristic.MotionDetected,
      initialState: this.status.motion,
      service: this.hap.Service.MotionSensor
    });
  }

  // Configure a dimmer to automate open and close events in HomeKit beyond what HomeKit might allow for a garage opener service that gets treated as a secure service.
  private configureAutomationDoorPositionDimmer(): boolean {

    this.logFeature("Opener.Dimmer", "Automation door position dimmer");

    if(!validService(this.accessory, this.hap.Service.Lightbulb, this.hints.automationDimmer, RatgdoService.DIMMER_OPENER_AUTOMATION)) {

      return false;
    }

    const service = acquireService(this.accessory, this.hap.Service.Lightbulb, this.name + " Automation Door Position",
      RatgdoService.DIMMER_OPENER_AUTOMATION);

    if(!service) {

      this.log.error("Unable to add the automation door position dimmer.");

      return false;
    }

    this.services[RatgdoService.DIMMER_OPENER_AUTOMATION] = service;

    // The dimmer is on whenever the opener is in any state other than closed, which covers open and stopped.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED);

    // The On characteristic only handles closing. Opening is driven by the Brightness onSet below, since HomeKit always sends a Brightness update alongside an On=true.
    service.getCharacteristic(this.hap.Characteristic.On).onSet((value: CharacteristicValue) => {

      if(value) {

        return;
      }

      if(this.hints.logOpener) {

        this.log.info("Automation door position dimmer: closing.");
      }

      if(!this.setDoorState(this.hap.Characteristic.TargetDoorState.CLOSED)) {

        this.scheduleUiRevert(() => service.updateCharacteristic(this.hap.Characteristic.On, !value));
      }
    });

    service.getCharacteristic(this.hap.Characteristic.Brightness).onGet(() => this.status.doorPosition);

    // Adjust the door position by translating brightness into a target door state with a position payload.
    service.getCharacteristic(this.hap.Characteristic.Brightness).onSet((value: CharacteristicValue) => {

      if(this.hints.logOpener) {

        // HomeKit's Brightness characteristic always delivers a numeric percentage, so this CharacteristicValue-to-number narrowing is safe by HAP convention.
        this.log.info("Automation door position dimmer: moving opener to %s%.", (value as number).toFixed(0));
      }

      this.setDoorState((value as number) > 0 ?
        this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED, value as number);
    });

    service.updateCharacteristic(this.hap.Characteristic.On, this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.status.doorPosition);

    return true;
  }

  // Configure a switch to automate open and close events in HomeKit beyond what HomeKit might allow for a garage opener service that gets treated as a secure service.
  private configureAutomationDoorSwitch(): boolean {

    this.logFeature("Opener.Switch", "Automation door opener switch");

    if(!validService(this.accessory, this.hap.Service.Switch, this.hints.automationSwitch, RatgdoService.SWITCH_OPENER_AUTOMATION)) {

      return false;
    }

    const service = acquireService(this.accessory, this.hap.Service.Switch, this.name + " Automation Opener", RatgdoService.SWITCH_OPENER_AUTOMATION);

    if(!service) {

      this.log.error("Unable to add the automation door opener switch.");

      return false;
    }

    this.services[RatgdoService.SWITCH_OPENER_AUTOMATION] = service;

    // The switch is on whenever the opener is in any state other than closed, which covers open and stopped.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED);
    service.getCharacteristic(this.hap.Characteristic.On).onSet((value: CharacteristicValue) => {

      if(this.hints.logOpener) {

        this.log.info("Automation door opener switch: %s.", value ? "open" : "close");
      }

      if(!this.setDoorState(value ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED)) {

        this.scheduleUiRevert(() => service.updateCharacteristic(this.hap.Characteristic.On, !value));
      }
    });

    service.updateCharacteristic(this.hap.Characteristic.On, this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED);

    return true;
  }

  // Configure the Ratgdo (ESP32) Disco-specific backup battery service.
  private configureDiscoBattery(): boolean {

    this.logFeature("Disco.Battery", "Ratgdo (ESP32) backup battery status");

    if(!validService(this.accessory, this.hap.Service.Battery, this.hints.discoBattery)) {

      return false;
    }

    const service = acquireService(this.accessory, this.hap.Service.Battery, this.name);

    if(!service) {

      this.log.error("Unable to add the Ratgdo (ESP32) backup battery status.");

      return false;
    }

    this.services[RatgdoService.BATTERY] = service;

    service.getCharacteristic(this.hap.Characteristic.ChargingState).onGet(() => this.status.discoBatteryState);
    service.updateCharacteristic(this.hap.Characteristic.ChargingState, this.status.discoBatteryState);

    return true;
  }

  // Configure the Ratgdo (ESP32) Disco-specific parking assistance laser switch.
  private configureDiscoLaserSwitch(): boolean {

    this.logFeature("Disco.Switch.Laser", "Ratgdo (ESP32) Disco parking assistance laser switch");

    if(!validService(this.accessory, this.hap.Service.Switch, this.hints.discoLaserSwitch, RatgdoService.SWITCH_DISCO_LASER)) {

      return false;
    }

    const service = acquireService(this.accessory, this.hap.Service.Switch, this.name + " Laser", RatgdoService.SWITCH_DISCO_LASER);

    if(!service) {

      this.log.error("Unable to add the Ratgdo (ESP32) Disco laser switch.");

      return false;
    }

    this.services[RatgdoService.SWITCH_DISCO_LASER] = service;

    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.status.discoLaser);
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.toggleOnSet("disco-laser", service));
    service.updateCharacteristic(this.hap.Characteristic.On, this.status.discoLaser);

    return true;
  }

  // Configure the Ratgdo (ESP32) Disco-specific LED switch.
  private configureDiscoLedSwitch(): boolean {

    this.logFeature("Disco.Switch.Led", "Ratgdo (ESP32) Disco LED switch");

    if(!validService(this.accessory, this.hap.Service.Switch, this.hints.discoLedSwitch, RatgdoService.SWITCH_DISCO_LED)) {

      return false;
    }

    const service = acquireService(this.accessory, this.hap.Service.Switch, this.name + " LED", RatgdoService.SWITCH_DISCO_LED);

    if(!service) {

      this.log.error("Unable to add the Ratgdo (ESP32) Disco LED switch.");

      return false;
    }

    this.services[RatgdoService.SWITCH_DISCO_LED] = service;

    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.status.discoLed);
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.toggleOnSet("disco-led", service));
    service.updateCharacteristic(this.hap.Characteristic.On, this.status.discoLed);

    return true;
  }

  // Configure the vehicle arriving contact sensor for HomeKit.
  private configureDiscoVehicleArrivingContactSensor(): boolean {

    this.logFeature("Disco.ContactSensor.Vehicle.Arriving", "Ratgdo (ESP32) Disco vehicle arriving contact sensor");

    return this.configureAvailabilitySensor({

      cacheKey: RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING,
      errorMessage: "Unable to add the vehicle arriving contact sensor.",
      hint: this.hints.discoVehicleArriving,
      initialCharacteristic: this.hap.Characteristic.ContactSensorState,
      initialState: this.status.discoVehicleArriving,
      nameSuffix: " Vehicle Arriving",
      service: this.hap.Service.ContactSensor,
      subtype: RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING
    });
  }

  // Configure the vehicle leaving contact sensor for HomeKit.
  private configureDiscoVehicleLeavingContactSensor(): boolean {

    this.logFeature("Disco.ContactSensor.Vehicle.Leaving", "Ratgdo (ESP32) Disco vehicle leaving contact sensor");

    return this.configureAvailabilitySensor({

      cacheKey: RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING,
      errorMessage: "Unable to add the vehicle leaving contact sensor.",
      hint: this.hints.discoVehicleLeaving,
      initialCharacteristic: this.hap.Characteristic.ContactSensorState,
      initialState: this.status.discoVehicleLeaving,
      nameSuffix: " Vehicle Leaving",
      service: this.hap.Service.ContactSensor,
      subtype: RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING
    });
  }

  // Configure the vehicle presence occupancy sensor for HomeKit.
  private configureDiscoVehiclePresenceOccupancySensor(): boolean {

    this.logFeature("Disco.OccupancySensor.Vehicle.Presence", "Ratgdo (ESP32) Disco vehicle presence occupancy sensor");

    return this.configureAvailabilitySensor({

      cacheKey: RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE,
      errorMessage: "Unable to add the vehicle presence occupancy sensor.",
      hint: this.hints.discoVehiclePresence,
      initialCharacteristic: this.hap.Characteristic.OccupancyDetected,
      initialState: this.status.discoVehiclePresence,
      nameSuffix: " Vehicle Presence",
      service: this.hap.Service.OccupancySensor,
      subtype: RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE
    });
  }

  // Configure the Konnected-specific pre-close warning switch.
  private configureKonnectedPcwSwitch(): boolean {

    this.logFeature("Konnected.Switch.Pcw", "Konnected pre-close warning switch");

    if(!validService(this.accessory, this.hap.Service.Switch, this.hints.konnectedPcwSwitch, RatgdoService.SWITCH_KONNECTED_PCW)) {

      return false;
    }

    const service = acquireService(this.accessory, this.hap.Service.Switch, this.name + " Pre Close Warning", RatgdoService.SWITCH_KONNECTED_PCW);

    if(!service) {

      this.log.error("Unable to add the Konnected pre-close warning switch.");

      return false;
    }

    this.services[RatgdoService.SWITCH_KONNECTED_PCW] = service;

    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => false);

    // The pre-close warning is a momentary action, not a persistent state. We auto-revert the switch back to off on two timelines: after the warning audio finishes
    // (success path) or as a standard UI revert when the command failed to dispatch (failure path). Routing the failure case through scheduleUiRevert() keeps it
    // aligned with every other onSet failure handler in this file, which all funnel through the same 50ms revert helper.
    service.getCharacteristic(this.hap.Characteristic.On).onSet((value: CharacteristicValue) => {

      if(this.command("konnected-pcw")) {

        this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), RATGDO_KONNECTED_PCW_DURATION * 1000);

        return;
      }

      this.scheduleUiRevert(() => service.updateCharacteristic(this.hap.Characteristic.On, !value));
    });

    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Configure the Konnected-specific strobe switch.
  private configureKonnectedStrobeSwitch(): boolean {

    this.logFeature("Konnected.Switch.Strobe", "Konnected strobe switch");

    if(!validService(this.accessory, this.hap.Service.Switch, this.hints.konnectedStrobeSwitch, RatgdoService.SWITCH_KONNECTED_STROBE)) {

      return false;
    }

    const service = acquireService(this.accessory, this.hap.Service.Switch, this.name + " Strobe", RatgdoService.SWITCH_KONNECTED_STROBE);

    if(!service) {

      this.log.error("Unable to add the Konnected strobe switch.");

      return false;
    }

    this.services[RatgdoService.SWITCH_KONNECTED_STROBE] = service;

    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.status.konnectedStrobe);
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.toggleOnSet("konnected-strobe", service));
    service.updateCharacteristic(this.hap.Characteristic.On, this.status.konnectedStrobe);

    return true;
  }

  // Configure a switch to control the ability to lockout all wireless remotes for the garage door opener, if the feature exists.
  private configureAutomationLockoutSwitch(): boolean {

    this.logFeature("Opener.Switch.RemoteLockout", "Automation wireless remote lockout switch");

    if(!validService(this.accessory, this.hap.Service.Switch, this.hints.lock && this.hints.lockoutSwitch, RatgdoService.SWITCH_LOCKOUT)) {

      return false;
    }

    const service = acquireService(this.accessory, this.hap.Service.Switch, this.name + " Lockout", RatgdoService.SWITCH_LOCKOUT);

    if(!service) {

      this.log.error("Unable to add the automation wireless remote lockout switch.");

      return false;
    }

    this.services[RatgdoService.SWITCH_LOCKOUT] = service;

    // The switch is on whenever the remote lockout is engaged.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.status.lock === this.hap.Characteristic.LockCurrentState.SECURED);
    service.getCharacteristic(this.hap.Characteristic.On).onSet((value: CharacteristicValue) => {

      this.log.info("Automation wireless remote lockout switch: remotes are %s.", value ? "locked out" : "permitted");

      if(!this.command("lock", value ? "lock" : "unlock")) {

        this.scheduleUiRevert(() => service.updateCharacteristic(this.hap.Characteristic.On, !value));
      }
    });

    service.updateCharacteristic(this.hap.Characteristic.On, this.status.lock === this.hap.Characteristic.LockCurrentState.SECURED);

    return true;
  }

  // Configure the door open occupancy sensor for HomeKit.
  private configureDoorOpenOccupancySensor(): boolean {

    this.logFeature("Opener.OccupancySensor", "Door open indicator occupancy sensor");

    return this.configureAvailabilitySensor({

      cacheKey: RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN,
      errorMessage: "Unable to add the door open occupancy sensor.",
      hint: this.hints.doorOpenOccupancySensor,
      initialCharacteristic: this.hap.Characteristic.OccupancyDetected,
      initialState: this.status.doorOpenOccupancy,
      nameSuffix: " Open",
      service: this.hap.Service.OccupancySensor,
      subtype: RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN
    });
  }

  // Configure the motion occupancy sensor for HomeKit.
  private configureMotionOccupancySensor(): boolean {

    this.logFeature("Motion.OccupancySensor", "Motion occupancy sensor");

    return this.configureAvailabilitySensor({

      cacheKey: RatgdoService.OCCUPANCY_SENSOR_MOTION,
      errorMessage: "Unable to add the occupancy sensor.",
      hint: this.hints.motionOccupancySensor,
      initialCharacteristic: this.hap.Characteristic.OccupancyDetected,
      initialState: this.status.motionOccupancy,
      service: this.hap.Service.OccupancySensor,
      subtype: RatgdoService.OCCUPANCY_SENSOR_MOTION
    });
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
      this.scheduleUiRevert(() => {

        this.services[RatgdoService.GARAGE_DOOR]?.updateCharacteristic(this.hap.Characteristic.TargetDoorState,
          value === this.hap.Characteristic.TargetDoorState.CLOSED ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED);
      });

      return false;
    }

    // If we are already opening or closing the garage door, we assume the user wants to stop the garage door opener at its current location.
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

  /* Lazy-evaluation debug log. The builder thunk only runs when platform.config.debug is enabled, so callers on hot paths (per-event telemetry, per-line verbose logs)
   * can construct expensive messages (util.inspect of large payloads, string concatenations) without paying the cost when debug is off. Routes through prefixed() and
   * platform.debug() so the prefix-decoration shape and the debug-channel choice each live in exactly one place rather than being duplicated in this method.
   */
  public debugLazy(builder: () => string): void {

    if(!this.platform.config.debug) {

      return;
    }

    this.platform.debug(this.prefixed(builder()));
  }

  /* Single source of truth for accessory log-line decoration. Every log channel (debug, error, info, warn) and the lazy debug path all forward through here so the
   * "<name>: <message>" prefix shape lives in one place. util.format substitution applies as it would for the underlying logger - callers pass printf-style format
   * strings and parameters directly. When called with just one argument (the lazy debug path's pre-built message), util.format returns it unchanged.
   */
  private prefixed(message: string, ...parameters: unknown[]): string {

    return this.name + ": " + util.format(message, ...parameters);
  }

  /* Central per-telemetry-event state router, invoked for every inbound ESPHome event (many times per second during a door transition). We alias every service we
   * might touch into locals at method entry so the hot path costs one map read per service rather than repeated getService() lookups, and dispatch on event.id. Most
   * branches guard the characteristic write on an actual state change; the obstruction and Disco vehicle-sensor branches instead write the characteristic
   * unconditionally and gate only the status, log, and MQTT side effects on the transition.
   */
  public updateState(event: EspHomeEvent): void {

    const dimmerService = this.services[RatgdoService.DIMMER_OPENER_AUTOMATION];
    const discoBatteryService = this.services[RatgdoService.BATTERY];
    const discoLaserSwitchService = this.services[RatgdoService.SWITCH_DISCO_LASER];
    const discoLedSwitchService = this.services[RatgdoService.SWITCH_DISCO_LED];
    const discoVehicleArrivingContactService = this.services[RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING];
    const discoVehicleLeavingContactService = this.services[RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING];
    const discoVehiclePresenceOccupancyService = this.services[RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE];
    const doorOccupancyService = this.services[RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN];
    const garageDoorService = this.services[RatgdoService.GARAGE_DOOR];
    const konnectedStrobeSwitchService = this.services[RatgdoService.SWITCH_KONNECTED_STROBE];
    const lightBulbService = this.services[RatgdoService.LIGHT];
    const lockoutService = this.services[RatgdoService.SWITCH_LOCKOUT];
    const motionOccupancyService = this.services[RatgdoService.OCCUPANCY_SENSOR_MOTION];
    const motionService = this.services[RatgdoService.MOTION_SENSOR];
    const switchService = this.services[RatgdoService.SWITCH_OPENER_AUTOMATION];

    switch(event.id) {

      case "availability": {

        // Refresh the Model characteristic (the only AccessoryInformation field that can change between connects). Manufacturer / SerialNumber / FirmwareRevision are
        // resolved once during configureInfo() and do not need re-pushing on every availability event.
        this.refreshModel();

        // Hoist the connect-state comparison once. Every StatusActive-carrying sensor service, plus the online/offline handling below, reads the same boolean, so
        // computing it once is clearer and avoids a repeated string comparison per read on every availability transition.
        const isOnline = event.state === "online";

        discoVehicleArrivingContactService?.updateCharacteristic(this.hap.Characteristic.StatusActive, isOnline);
        discoVehicleLeavingContactService?.updateCharacteristic(this.hap.Characteristic.StatusActive, isOnline);
        discoVehiclePresenceOccupancyService?.updateCharacteristic(this.hap.Characteristic.StatusActive, isOnline);
        doorOccupancyService?.updateCharacteristic(this.hap.Characteristic.StatusActive, isOnline);
        motionOccupancyService?.updateCharacteristic(this.hap.Characteristic.StatusActive, isOnline);
        motionService?.updateCharacteristic(this.hap.Characteristic.StatusActive, isOnline);

        // The "Ratgdo connected." log lives in the platform's markOnline (the SSOT for post-connect setup), so connected announcements ride through it on both initial
        // discovery and reconnect. Here we own only the disconnect transition log - the true-to-false flip is the user-visible signal that the device went away.
        const wasOnline = this.status.availability;

        this.status.availability = isOnline;

        if(wasOnline && !isOnline) {

          this.log.info("Ratgdo disconnected.");
        }

        break;
      }

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

        // Only re-push when state actually transitions. HAP.updateCharacteristic is a no-op on repeat, but repeated motion-ON broadcasts during an ongoing motion cycle
        // would otherwise re-assign the field and re-issue the HAP call on every wire event; gating on transitions matches the obstruction / light / vehicle patterns
        // that already follow this shape.
        if(!this.status.motion) {

          this.status.motion = true;
          motionService?.updateCharacteristic(this.hap.Characteristic.MotionDetected, this.status.motion);
        }

        // If it is our first time detecting motion for this event cycle - no motion timer is currently armed - let the user know and publish the leading edge. A second
        // motion event while the timer is still armed re-arms it below without re-announcing, so the leading-edge story fires exactly once per cycle.
        if(!this.timers.has("motion")) {

          if(this.hints.logMotion) {

            this.log.info("Motion detected.");
          }

          this.publishStatus("motion", this.status.motion.toString());
        }

        // Arm (or re-arm) the motion reset timer. Registering under "motion" clears any prior motion timer first, so a fresh motion event restarts the window from now.
        this.timers.setTimeout("motion", () => {

          this.status.motion = false;
          motionService?.updateCharacteristic(this.hap.Characteristic.MotionDetected, this.status.motion);

          this.publishStatus("motion", this.status.motion.toString());
        }, RATGDO_MOTION_DURATION * 1000);

        // If we don't have occupancy sensor support configured, we're done.
        if(!this.hints.motionOccupancySensor) {

          break;
        }

        // If the motion occupancy sensor isn't already triggered, raise it now. Status drives the gate so MQTT subscribeGet and HomeKit stay aligned through one boolean
        // instead of fanning out to a HAP characteristic read; setOccupancy owns the status + characteristic + log + MQTT write.
        if(!this.status.motionOccupancy) {

          this.setOccupancy("motion", true);
        }

        // Reset our occupancy state after occupancyDuration; setOccupancy owns the status + characteristic + log + MQTT write. Registering under "motionOccupancy" clears
        // any prior occupancy timer first, so a repeated motion event restarts the release window from now.
        this.timers.setTimeout("motionOccupancy", () => {

          this.setOccupancy("motion", false);
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

          this.publishStatus("obstruction", this.status.obstruction.toString());
        }

        break;

      case "binary_sensor-vehicle_arriving":

        discoVehicleArrivingContactService?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, event.state === "ON");
        this.status.discoVehicleArriving = this.updateVehicleSensorState(this.status.discoVehicleArriving, event.state, "Vehicle arriving", "vehiclearriving");

        break;

      case "binary_sensor-vehicle_detected":

        discoVehiclePresenceOccupancyService?.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, event.state === "ON");
        this.status.discoVehiclePresence = this.updateVehicleSensorState(this.status.discoVehiclePresence, event.state, "Vehicle", "vehiclepresence");

        break;

      case "binary_sensor-vehicle_leaving":

        discoVehicleLeavingContactService?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, event.state === "ON");
        this.status.discoVehicleLeaving = this.updateVehicleSensorState(this.status.discoVehicleLeaving, event.state, "Vehicle leaving", "vehicleleaving");

        break;

      case "cover-door":
      case "cover-garage_door": {

        // Local working buffer for the operation. We route the resolved operation through a local rather than mutating the inbound event, so the wire-faithful payload
        // stays immutable for any future cross-case consumer.
        let operation: string;

        // Determine what action the opener is currently executing.
        switch(event.current_operation) {

          case "CLOSING":
          case "OPENING":

            operation = event.current_operation.toLowerCase();

            break;

          case "IDLE":

            // We treat an IDLE cover reported OPEN at a position strictly between 0 and 1 as stopped-at-partial rather than fully open; 0 collapses to closed, 1 to open.
            operation = ((event.state === "OPEN") && (event.position !== undefined) && (event.position > 0) && (event.position < 1)) ? "stopped" :
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
        if(this.translateCurrentDoorState(this.status.door) === operation) {

          break;
        }

        switch(operation) {

          case "closed":

            this.status.door = this.hap.Characteristic.CurrentDoorState.CLOSED;

            break;

          case "closing":

            this.status.door = this.hap.Characteristic.CurrentDoorState.CLOSING;

            break;

          case "open":

            this.status.door = this.hap.Characteristic.CurrentDoorState.OPEN;

            // Trigger our occupancy timer, if configured to do so and we don't have one yet. The timer is what flips status.doorOpenOccupancy true after the configured
            // duration, so a transient open does not raise occupancy - only a continuously-open door for the full duration does. The has() guard is defensive: the state
            // short-circuit above already swallows a repeated open before it reaches this case, so the guard matters only if a future event path re-enters the open case
            // with the window already running - the dwell window must never restart partway.
            if(this.hints.doorOpenOccupancySensor && !this.timers.has("doorOccupancy")) {

              this.timers.setTimeout("doorOccupancy", () => {

                // The timer firing raises occupancy; setOccupancy owns the status + characteristic + log + MQTT write.
                this.setOccupancy("doorOpen", true);
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

        // We only update the target state if our current state is NOT stopped. If we are stopped, we are at the target state by definition. When the user resumes the
        // door operation, it will complete the action. Put another way, when we enter a stopped state, HomeKit essentially is pausing the action. When we tell the
        // opener to open/close, it will continue the action it had previously begun before stopping. Additionally, we always want to ensure we update TargetDoorState
        // before updating CurrentDoorState in order to work around some notification sequencing quirks HomeKit occasionally has.
        if(this.status.door !== this.hap.Characteristic.CurrentDoorState.STOPPED) {

          garageDoorService?.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.doorTargetStateBias(this.status.door));
        }

        garageDoorService?.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.status.door);

        // Update our automation switch, if configured.
        switchService?.updateCharacteristic(this.hap.Characteristic.On, this.doorTargetStateBias(this.status.door) === this.hap.Characteristic.TargetDoorState.OPEN);

        if(this.hints.logOpener) {

          this.log.info("%s.", this.capitalize(this.translateCurrentDoorState(this.status.door)));
        }

        /* When the door is no longer open, tear down door-open occupancy. The pending-timer clear and the raised-indicator clear are INDEPENDENT concerns: the occupancy
         * timer releases its own handle the instant it fires (and raises occupancy), so a clear gated on the timer handle would be unreachable exactly when occupancy is
         * raised - the stuck-on bug. We clear a still-pending timer (a no-op when none is armed) and clear an already-raised indicator separately, each on its own real
         * condition. We read occupancy from status rather than the HAP characteristic so MQTT and HomeKit stay aligned on one source of truth.
         */
        if(this.hints.doorOpenOccupancySensor && (this.status.door !== this.hap.Characteristic.CurrentDoorState.OPEN)) {

          this.timers.clear("doorOccupancy");

          if(this.status.doorOpenOccupancy) {

            this.setOccupancy("doorOpen", false);
          }
        }

        this.publishStatus("garagedoor", this.translateCurrentDoorState(this.status.door));

        break;
      }

      case "light-garage_light":
      case "light-light":

        // Only act if we're not already at the state we're updating to.
        if(this.status.light !== (event.state === "ON")) {

          this.status.light = event.state === "ON";
          lightBulbService?.updateCharacteristic(this.hap.Characteristic.On, this.status.light);

          if(this.hints.logLight) {

            this.log.info("Light %s.", event.state.toLowerCase());
          }

          this.publishStatus("light", this.status.light.toString());
        }

        break;

      case "lock-lock":
      case "lock-lock_remotes":

        // If we've disabled the feature, ignore lock updates.
        if(!this.hints.lock) {

          break;
        }

        // We only recognize LOCKED and UNLOCKED. Any other value indicates a device firmware change we have not handled yet, so we log and bail rather than guessing.
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

        this.log.info("Wireless remotes are %s.", (event.state === "LOCKED") ? "locked out" : "permitted");

        this.publishStatus("lock", this.status.lock.toString());

        break;

      case "switch-laser":

        this.status.discoLaser = this.updateSwitchState(discoLaserSwitchService, this.status.discoLaser, event.state, "laser");

        break;

      case "switch-led":

        this.status.discoLed = this.updateSwitchState(discoLedSwitchService, this.status.discoLed, event.state, "led");

        break;

      case "switch-str_output":

        this.status.konnectedStrobe = this.updateSwitchState(konnectedStrobeSwitchService, this.status.konnectedStrobe, event.state, "strobe");

        break;

      default:

        break;
    }
  }

  /* Build an onSet handler for a HomeKit On characteristic. Maps the boolean value into the "on" / "off" payload command() expects, and on command failure routes the UI
   * back to its prior state through scheduleUiRevert(). Every toggle-style service shares this exact shape; centralizing it here means the on/off wire format AND the
   * failure-revert contract both live in one place. Passing the service through the closure lets the failure path target the specific characteristic to revert without
   * burdening the caller with the boilerplate.
   */
  private toggleOnSet(topic: CommandTopic, service: Service): (value: CharacteristicValue) => void {

    return (value) => {

      if(!this.command(topic, (value === true) ? "on" : "off")) {

        this.scheduleUiRevert(() => service.updateCharacteristic(this.hap.Characteristic.On, !value));
      }
    };
  }

  /* Dispatch a command to the device's ESPHome client. Every entity reference resolves through `RATGDO_ENTITIES`, so this function holds no literal entity names - a
   * rename in the registry propagates here automatically. Cross-variant entities (cover, light, lock, refresh) are reached through the union-typed `entities` local;
   * variant-specific topics (`disco-*`, `konnected-*`) read the appropriate variant's required-field registry directly. No defensive optional-checks are needed
   * because each access site is statically guaranteed to address an entity that exists on its variant.
   */
  private command(topic: CommandTopic, payload = "", position?: number): boolean {

    // Ensure the ESPHome API client is available. It may have been destroyed during shutdown or be unavailable during a reconnect cycle.
    const client = this.platform.getEspHomeClient(this.device.mac);

    if(!client) {

      return false;
    }

    const entities = RATGDO_ENTITIES[this.device.variant];

    switch(topic) {

      case "disco-laser":

        client.command(idFor(RATGDO_ENTITIES[RatgdoVariant.RATGDO].laser), { state: payload === "on" });

        break;

      case "disco-led":

        client.command(idFor(RATGDO_ENTITIES[RatgdoVariant.RATGDO].led), { state: payload === "on" });

        break;

      case "door": {

        const action = this.buildDoorAction(payload, position);

        if(!action) {

          return false;
        }

        client.command(idFor(entities.cover), action);

        break;
      }

      case "konnected-pcw":

        client.command(idFor(RATGDO_ENTITIES[RatgdoVariant.KONNECTED].pcw), {});

        break;

      case "konnected-strobe":

        client.command(idFor(RATGDO_ENTITIES[RatgdoVariant.KONNECTED].strOutput), { state: payload === "on" });

        break;

      case "light":

        client.command(idFor(entities.light), { state: payload === "on" });

        break;

      case "lock":

        client.command(idFor(entities.lock), { command: (payload === "lock") ? LockCommand.LOCK : LockCommand.UNLOCK });

        break;

      case "refresh":

        client.command(idFor(entities.refresh), {});

        break;

      default:

        this.log.error("Unknown command received: %s - %s.", topic, payload);

        return false;
    }

    return true;
  }

  // Translate a door payload (and optional position) into the ESPHome cover-command shape. Returns null and logs when the payload is unrecognized or when "set" is used
  // without a position.
  private buildDoorAction(payload: string, position?: number): Nullable<{ position?: number; stop?: boolean }> {

    switch(payload) {

      case "closed":

        return { position: 0.0 };

      case "open":

        return { position: 1.0 };

      case "stop":

        return { stop: true };

      case "set":

        if(position === undefined) {

          this.log.error("Invalid door set command received: no position specified.");

          return null;
        }

        return { position: position / 100 };

      default:

        this.log.error("Unknown door command received: %s.", payload);

        return null;
    }
  }

  // Utility function to translate HomeKit's current door state values into human-readable form.
  private translateCurrentDoorState(value: CharacteristicValue): string {

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

  // Utility function to return our bias for what the current door state should be. This backs both the initial characteristic writes at startup and the live
  // onGet handlers for the automation door position dimmer and switch.
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

  // Utility function to return our bias for what the lock's target state should be.
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

  // Utility function to update a switch state, publish to MQTT, and return the new state. Used by the switch-* event handlers in updateState() to avoid repeating
  // the same state-change, characteristic-update, and MQTT-publish pattern.
  private updateSwitchState(service: Service | undefined, currentState: boolean, eventState: string, topicSuffix: string): boolean {

    const newState = eventState === "ON";

    if(currentState !== newState) {

      service?.updateCharacteristic(this.hap.Characteristic.On, newState);

      this.publishStatus(topicSuffix, newState.toString());
    }

    return newState;
  }

  // Utility function to update a vehicle sensor state, log the event, publish to MQTT, and return the new state. Used by the binary_sensor-vehicle_* event handlers in
  // updateState() to avoid repeating the same state-change, logging, and MQTT-publish pattern.
  private updateVehicleSensorState(currentState: boolean, eventState: string, logPrefix: string, topicSuffix: string): boolean {

    const newState = eventState === "ON";

    if(currentState !== newState) {

      if(this.hints.logVehiclePresence) {

        this.log.info("%s %sdetected.", logPrefix, newState ? "" : "no longer ");
      }

      this.publishStatus(topicSuffix, newState.toString());
    }

    return newState;
  }

  /* Single source of truth for an occupancy-indicator transition. From the RATGDO_OCCUPANCY descriptor for the given kind, it writes the status field, the HomeKit
   * OccupancyDetected characteristic, the gated log line, and the MQTT publish - every piece that must move together. The caller owns the transition gate (when to
   * raise or clear); this method owns the write so the pieces can never drift out of sync.
   */
  private setOccupancy(kind: OccupancyKind, detected: boolean): void {

    const descriptor = RATGDO_OCCUPANCY[kind];

    this.status[descriptor.field] = detected;
    this.services[descriptor.service]?.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, detected);

    // Both occupancy kinds share the motion log gate: there is no dedicated door-open logging hint, so the door-open indicator's log rides Log.Motion by design.
    if(this.hints.logMotion) {

      this.log.info("%s %sdetected.", descriptor.label, detected ? "" : "no longer ");
    }

    this.publishStatus(descriptor.topic, detected.toString());
  }

  // Utility function to capitalize the first character of a string. Indexed access returns string | undefined under noUncheckedIndexedAccess - the optional-chain
  // and nullish-coalesce reproduce charAt's empty-string-on-out-of-bounds behavior without the deprecated-in-spirit method call.
  private capitalize(text: string): string {

    return (text[0]?.toUpperCase() ?? "") + text.slice(1);
  }

  // Schedule a HomeKit UI revert that fires after the active onSet handler returns. HomeKit drops characteristic updates issued synchronously inside an onSet
  // handler, so we defer through the timer registry to let the handler acknowledge first. Used by command-failure paths that need to put the UI back where the user
  // found it. Routes through the registry so the pending revert is cancelled cleanly on shutdown rather than firing into a torn-down accessory.
  private scheduleUiRevert(revert: () => void): void {

    this.timers.schedule(revert, RATGDO_UI_REVERT_DELAY);
  }

  // Utility for checking feature options on a device.
  private hasFeature(option: string): boolean {

    return this.platform.featureOptions.test(option, this.device.mac);
  }

  // Per-accessory ergonomic wrapper for HBPU's logFeature primitive. Hides `this.log` and `this.device.mac` so call sites stay terse and uniform with `hasFeature()`.
  // The deviation-reporting convention itself lives upstream in `homebridge-plugin-utils/FeatureOptions.logFeature`; this wrapper carries no convention logic.
  private logFeature(option: string, label: string): void {

    this.platform.featureOptions.logFeature(option, label, this.log, this.device.mac);
  }

  // Resolve the device's display name. Precedence:
  //
  //   1. The user-configured Device.LogName feature option, when set. We read this from `hints.logName`, which buildHints() resolved exactly once at construction
  //      time. Reading the cache rather than the live feature-option store means we do not pay the featureOptions lookup cost on every log line (the getter fronts
  //      every info / warn / error log via prefixed()).
  //   2. The GarageDoorOpener service's Name characteristic. This reflects any rename the user has made in HomeKit, so logs follow what the user sees there.
  //   3. The accessory's displayName, which Homebridge manages and uses when the service Name has not been set.
  //   4. The mDNS-advertised device.name, as a final fallback.
  private get name(): string {

    if(this.hints.logName !== undefined) {

      return this.hints.logName;
    }

    // HomeKit's Name characteristic is always string-valued per the HAP specification, so this CharacteristicValue-to-string narrowing is safe.
    let name = this.services[RatgdoService.GARAGE_DOOR]?.getCharacteristic(this.hap.Characteristic.Name).value as string | undefined;

    if(name?.length) {

      return name;
    }

    name = this.accessory.displayName;

    if(name.length) {

      return name;
    }

    return this.device.name;
  }
}
