/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.ts: Ratgdo device accessory for HomeKit.
 */
import type { API, Characteristic, CharacteristicValue, HAP, PlatformAccessory, Service, WithUUID } from "homebridge";
import type { AcquireServiceTarget, HomebridgePluginLogging, MqttAvailabilityPayload, Nullable } from "homebridge-plugin-utils";
import type { EntityId, TelemetryEvent } from "esphome-client";
import type { EspHomeEvent, RatgdoDevice } from "./types.ts";
import { LockCommand, LockState, isConnectionLive } from "esphome-client";
import { MQTT_AVAILABILITY_OFFLINE, MQTT_AVAILABILITY_ONLINE, TimerRegistry, acquireService, debugGatedLog, displayedName, mqttTopic, notResponding, ownedName,
  prefixedLog, resolveNameOverride, setAccessoryName, setServiceName, validCharacteristic, validService, watchServiceName } from "homebridge-plugin-utils";
import { RATGDO_ENTITIES, idFor } from "./entities.ts";
import { RATGDO_KONNECTED_PCW_DURATION, RATGDO_OCCUPANCY_DURATION, RATGDO_UI_REVERT_DELAY } from "./settings.ts";
import { RATGDO_LOG_EVENTS_OPTION, RATGDO_MOTION_DURATION, RATGDO_NAME_OPTION } from "./webui/settings.ts";
import { RatgdoService, RatgdoVariant } from "./types.ts";
import { RATGDO_LOG_EVENTS } from "./webui/log-events.ts";
import { RATGDO_VARIANT_LABELS } from "./webui/variants.ts";
import type { RatgdoEntityRef } from "./entities.ts";
import type { RatgdoLogEvent } from "./webui/log-events.ts";
import type { RatgdoPlatform } from "./platform.ts";
import { mqttTopics } from "./mqtt.ts";
import { optionFitsVariant } from "./options.ts";

/* Command topics dispatched to the ESPHome client by command(). Each topic accepts a different payload shape:
 *
 *   - "door":              "open" | "closed" | "stop" | "set" (with an optional position from 0 to 100 when payload is "set").
 *   - "light":             "on" | "off".
 *   - "lock":              "lock" | "unlock".
 *   - "disco-laser":       "on" | "off".
 *   - "disco-led":         "on" | "off".
 *   - "konnected-strobe":  "on" | "off".
 *   - "konnected-pcw":     no payload, the command issues a momentary button press.
 */
type CommandTopic = "disco-laser" | "disco-led" | "door" | "konnected-pcw" | "konnected-strobe" | "light" | "lock";

/* Device-specific options and settings. Resolved once at configuration time by buildHints() and never reassigned for the lifetime of the accessory; the readonly
 * surface here mirrors that contract.
 *
 * `nameOverride` and `syncName` are what HBPU's family naming rule decides the owner of the opener's HomeKit name from. Options change only at a restart, so whether
 * the plugin owns the name is fixed for the accessory's life, and only the opener's own name, which a session can refresh, moves the name it owns. All other hint
 * fields follow the same read-once-cache-forever pattern.
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
  readonly logObstruction: boolean;
  readonly logOpener: boolean;
  readonly logVehiclePresence: boolean;
  // Expressed in seconds; multiplied by 1000 at its setTimeout call site.
  readonly motionOccupancyDuration: number;
  readonly motionOccupancySensor: boolean;
  readonly motionSensor: boolean;
  // The custom HomeKit name the user set for this opener, trimmed, or null when they set none HomeKit can carry, as HBPU's custom-name rule decides.
  readonly nameOverride: Nullable<string>;
  readonly readOnly: boolean;
  // Whether the opener's own name, the one its ESPHome firmware gives it, is synchronized with HomeKit.
  readonly syncName: boolean;
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

// A catalog key naming one of the opener's state topics: every topic in the MQTT catalog except the availability statement, which the opener publishes on its own.
type StateTopic = Exclude<keyof typeof mqttTopics, "availability">;

/* Whether each state topic reports held state rather than a momentary event. A topic reporting held state is restated when a broker session begins, while a topic
 * reporting a momentary event never is, because a replayed event would be the event happening a second time. The record names every state topic, so a topic added to
 * the catalog fails compilation here until its kind is decided. The session restatement in configureMqtt() is its one reader.
 */
const HELD_STATE: Readonly<Record<StateTopic, boolean>> = {

  doorOpenOccupancy: true,
  garageDoor: true,
  laser: true,
  led: true,
  light: true,
  lock: true,
  motion: false,
  obstruction: true,
  occupancy: true,
  strobe: true,
  vehicleArriving: false,
  vehicleLeaving: false,
  vehiclePresence: true
};

/* Wiring for every timer-derived occupancy indicator. Each kind maps to its RatgdoStatus field, its HomeKit OccupancySensor subtype, the key of its topic in the MQTT
 * catalog, and its log label, so the shared setOccupancy() writer stays generic across both paths. Adding a future occupancy kind is a single descriptor entry plus
 * its trigger wiring - the write (status, characteristic, log, MQTT) lives in one place and cannot drift. This mirrors the RATGDO_ENTITIES registry in entities.ts.
 */
const RATGDO_OCCUPANCY = {

  doorOpen: { field: "doorOpenOccupancy", label: "Garage door open occupancy", service: RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN, topicKey: "doorOpenOccupancy" },
  motion: { field: "motionOccupancy", label: "Occupancy", service: RatgdoService.OCCUPANCY_SENSOR_MOTION, topicKey: "occupancy" }
} as const;

type OccupancyKind = keyof typeof RATGDO_OCCUPANCY;

/* The suffix each part adds to the opener's name in HomeKit. A new part is created with the opener's displayed name followed by its suffix, and while the plugin owns
 * the opener's name, construction's re-state, a session's re-state, and the part's watch each hold it to the owned name followed by the same suffix, so no two of them
 * can name a part differently. The record names every part, so a part added to RatgdoService fails compilation here until its suffix is decided.
 */
const PART_SUFFIXES: Readonly<Record<RatgdoService, string>> = {

  [RatgdoService.BATTERY]: "",
  [RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING]: " Vehicle Arriving",
  [RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING]: " Vehicle Leaving",
  [RatgdoService.DIMMER_OPENER_AUTOMATION]: " Automation Door Position",
  [RatgdoService.GARAGE_DOOR]: "",
  [RatgdoService.LIGHT]: "",
  [RatgdoService.MOTION_SENSOR]: "",
  [RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE]: " Vehicle Presence",
  [RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN]: " Open",
  [RatgdoService.OCCUPANCY_SENSOR_MOTION]: "",
  [RatgdoService.SWITCH_DISCO_LASER]: " Laser",
  [RatgdoService.SWITCH_DISCO_LED]: " LED",
  [RatgdoService.SWITCH_KONNECTED_PCW]: " Pre Close Warning",
  [RatgdoService.SWITCH_KONNECTED_STROBE]: " Strobe",
  [RatgdoService.SWITCH_LOCKOUT]: " Lockout",
  [RatgdoService.SWITCH_OPENER_AUTOMATION]: " Automation Opener"
};

/* The resolved cover-operation domain the door-state resolution switch operates over. The cover handler derives one of these from the wire event's current_operation and
 * state, having already validated both, so everything downstream of that validation works with a closed set rather than an open string. This is deliberately distinct
 * from esphome-client's own CoverOperation, which names the wire vocabulary rather than this resolved one.
 */
type DoorOperation = "closed" | "closing" | "open" | "opening" | "stopped";

/* The per-accessory HomeKit projection for a single garage door opener. Owns HomeKit service configuration, the RatgdoStatus single-source-of-truth, updateState()
 * telemetry-event routing, command dispatch to the ESPHome client, and MQTT publishing.
 */
export class RatgdoAccessory implements Disposable {

  private readonly accessory: PlatformAccessory;
  // The one place that decides whether the opener answers HomeKit at all. It is bound once over the status record's availability field, and every read and write
  // handler this accessory binds is wired through it. The field is read fresh on every handler call, so a loss of contact refuses the very next read or write and a
  // return answers it, with no rewiring.
  private readonly answering: ReturnType<typeof notResponding>;
  private readonly api: API;
  public readonly device: RatgdoDevice;
  private readonly enabled: Readonly<Record<StateTopic, boolean>>;
  private readonly hap: HAP;
  public readonly hints: RatgdoHints;
  // The accessory's lifetime. Every registration this accessory makes on something that outlives it carries this controller's signal: each MQTT subscription and the
  // final word on the shared MqttClient, and each watch holding a service to the name the plugin owns. Aborting it at disposal releases all of them in lockstep with
  // the accessory's teardown, so none outlives the accessory.
  private readonly lifetime: AbortController;
  public readonly log: HomebridgePluginLogging;
  /* The name the opener is shown under: its custom Name where HomeKit can carry one, and its own name otherwise, by HBPU's display-name rule. It prefixes every log line
   * and names every part construction creates, so it is stored rather than composed on each read, and it is composed afresh only where the opener's own name can move,
   * a session's refreshName(). A rename in the Home app never moves it, so a log line names the opener as the plugin does whoever owns its HomeKit name.
   */
  private name: string;
  private readonly platform: RatgdoPlatform;
  private readonly services: Partial<Record<RatgdoService, Service>>;
  private readonly status: RatgdoStatus;
  // The timer registry for this accessory: every deferred callback (the motion and occupancy resets, the Konnected pulse, the UI revert) arms through it, keyed for the
  // timers whose newest intent should replace the prior one and anonymous for the fire-and-forget ones. Its dispose drains every pending timer in lockstep with the
  // accessory's teardown. No lifetime signal is passed - the accessory's own [Symbol.dispose] is the only lifetime bound. Every deadline this accessory arms reads the
  // platform's clock, so a device timer and a platform timer share one timeline rather than each finding their own.
  private readonly timers: TimerRegistry;

  constructor(platform: RatgdoPlatform, accessory: PlatformAccessory, device: RatgdoDevice, initialState: ReadonlyMap<EntityId, TelemetryEvent>) {

    this.accessory = accessory;
    this.api = platform.api;
    this.hap = this.api.hap;
    this.device = device;
    this.platform = platform;
    this.services = {};
    this.timers = new TimerRegistry({ clock: platform.clock });

    /* Compose this accessory's logger from the library's two wrappers over the platform's own logger. The prefix is a supplier rather than a captured string, so a
     * device the user renames carries the new name on the very next line. The debug gate sits outermost, which is what keeps a suppressed debug line to a single
     * predicate call: the prefix concatenation and the format work behind it never run, and the platform's own gate below is never consulted either.
     */
    this.log = debugGatedLog(prefixedLog(platform.log, () => this.name), (): boolean => platform.config.debug);

    /* Build status from the captured initial telemetry. `initialState` carries one event per stateful entity the device exposed - the platform's discovery path
     * already waited for ESPHome's per-entity SUBSCRIBE_STATES burst to land before constructing us. Status fields are therefore initialized to real device state,
     * not placeholder defaults; configureXxx writes the populated values straight into HAP so HomeKit sees the device's actual current state from frame zero.
     */
    this.status = this.buildInitialStatus(initialState);
    this.answering = notResponding({ errorClass: this.hap.HapStatusError, unavailable: () => !this.status.availability });

    this.hints = this.buildHints();
    this.name = this.composeName();
    this.enabled = this.buildEnabled();

    /* The deviation logs run AFTER `this.hints` and `this.name` are assigned. `this.name` is the prefix behind every log line and is composed from the hints, so a line
     * logged ahead of them would carry no name. Keeping the calls here - and out of `buildHints()` - means the cache contract (hints and the name fully resolved before
     * any log call that depends on them) is enforced by program order, not by reviewer discipline.
     */
    this.logFeature("Opener.ReadOnly", "Read-only mode");
    this.logFeature(RATGDO_LOG_EVENTS_OPTION, "Event logging");
    this.logNaming();

    this.lifetime = new AbortController();
    this.configureDevice();
  }

  /* Public reachability accessor. Surfaces the one field of the status record the platform has to read, without opening the record itself: the accessory owns every
   * observable piece of device state, and a second copy of this flag kept outside it would be a second answer to a question with one answer. The platform reads it
   * where a device's advertisement and its configured address disagree, to tell a device that has genuinely moved from one that simply answers at more addresses
   * than the one it is dialed at, and when a session begins, to tell a drop the client healed on its first attempt from a reconnect after an outage.
   */
  public get isOnline(): boolean {

    return this.status.availability;
  }

  // Public identity accessor. Surfaces the accessory's HAP UUID without exposing the full PlatformAccessory, so internal accessory mutations stay inside the class.
  public get uuid(): string {

    return this.accessory.UUID;
  }

  /* Synchronous disposal hook. Tears down every resource this accessory owns: the pending timers in the registry, and every registration made on the lifetime signal,
   * the MQTT registrations and their final word among them, and each name watch. The platform invokes this at shutdown, once the final words have been stated, so no
   * pending timer, MQTT registration, or name watch outlives the accessory.
   */
  public [Symbol.dispose](): void {

    this.lifetime.abort();
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

    // The light (a Lightbulb without a subtype) is acquired ahead of the dimmer (a subtyped Lightbulb) so a fresh accessory takes the library's plain add, and the
    // library detaches and re-adds the dimmer to make room for the light only on a cached accessory that carries the dimmer but not the light.
    this.configureLight();
    this.configureAutomationDoorPositionDimmer();
    this.configureAutomationDoorSwitch();
    this.configureAutomationLockoutSwitch();
    this.configureDoorOpenOccupancySensor();
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

    /* The name watches and MQTT come last. Both register on the lifetime signal and are released only through it, which a constructor that throws never hands to
     * anyone, so both wait until every step that can throw has run...a failed construction registers nothing. The watches wait for every service acquisition as well:
     * a watch is a listener on its service, HAP's removeService clears every listener on a service it detaches, and HBPU's room-making step detaches and re-adds the
     * subtyped siblings of a service it adds, so a watch made ahead of any acquisition could be silently lost.
     */
    this.holdNames();
    this.configureMqtt();
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
   * caching contract is structural: any reader (the opener's names, the configureXxx methods, the updateState hot path) reads from `this.hints.X` instead of re-issuing
   * the underlying featureOptions lookup. The catalog's variant declarations fold here too, through hasFeature(), so configureXxx() methods can treat a single hint
   * boolean as the source of truth for whether a feature applies to this device. Motion is declared for the same hardware as the disco features: Konnected firmware
   * advertises no motion entity, so both motion hints resolve false on that variant and the accessory carries neither the motion sensor nor the occupancy sensor its
   * activity would drive.
   *
   * No side effects: this function returns a value and does not touch `this.hints`, `this.log`, or any other field that depends on construction order. Side effects
   * that depend on the resolved hints (e.g., the read-only announcement) belong in the constructor, after `this.hints` is assigned.
   */
  private buildHints(): RatgdoHints {

    const featureOptions = this.platform.featureOptions;

    // The event categories this opener logs, read once from the one list against every category the plugin logs. A list enabled with nothing stored reads as its
    // default, every category, and vehicle presence is logged only on the hardware that reports it.
    const loggedEvents = featureOptions.valueList({ defaultWhenUnset: true, device: this.device.mac, domain: RATGDO_LOG_EVENTS.map(({ value }) => value),
      option: RATGDO_LOG_EVENTS_OPTION });
    const logs = (event: RatgdoLogEvent): boolean => loggedEvents.includes(event);

    return {

      automationDimmer: this.hasFeature("Opener.Dimmer"),
      automationSwitch: this.hasFeature("Opener.Switch"),
      discoBattery: this.hasFeature("Disco.Battery"),
      discoLaserSwitch: this.hasFeature("Disco.Switch.Laser"),
      discoLedSwitch: this.hasFeature("Disco.Switch.Led"),
      discoVehicleArriving: this.hasFeature("Disco.ContactSensor.Vehicle.Arriving"),
      discoVehicleLeaving: this.hasFeature("Disco.ContactSensor.Vehicle.Leaving"),
      discoVehiclePresence: this.hasFeature("Disco.OccupancySensor.Vehicle.Presence"),
      doorOpenOccupancyDuration: featureOptions.getInteger("Opener.OccupancySensor.Duration", this.device.mac) ?? RATGDO_OCCUPANCY_DURATION,
      doorOpenOccupancySensor: this.hasFeature("Opener.OccupancySensor"),
      konnectedPcwSwitch: this.hasFeature("Konnected.Switch.Pcw"),
      konnectedStrobeSwitch: this.hasFeature("Konnected.Switch.Strobe"),
      light: this.hasFeature("Light"),
      lock: this.hasFeature("Opener.Lock"),
      lockoutSwitch: this.hasFeature("Opener.Switch.RemoteLockout"),
      logLight: logs("Light"),
      logMotion: logs("Motion"),
      logObstruction: logs("Obstruction"),
      logOpener: logs("Opener"),
      logVehiclePresence: (this.device.variant === RatgdoVariant.RATGDO) && logs("VehiclePresence"),
      motionOccupancyDuration: featureOptions.getInteger("Motion.OccupancySensor.Duration", this.device.mac) ?? RATGDO_OCCUPANCY_DURATION,
      motionOccupancySensor: this.hasFeature("Motion.OccupancySensor"),
      motionSensor: this.hasFeature("Motion"),
      nameOverride: resolveNameOverride(featureOptions.value(RATGDO_NAME_OPTION, this.device.mac)),
      readOnly: this.hasFeature("Opener.ReadOnly"),
      syncName: this.hasFeature("Device.SyncName")
    };
  }

  /* Build the MQTT enablement table. A state topic has an MQTT counterpart, its publishes and its get, only while the HomeKit control it reports on exists. The door
   * and the obstruction report the opener service, which is always present, and every other entry is the hint that creates its control. The publish helper, the
   * session restatement and the get subscriptions in configureMqtt() are the table's readers. The record names every state topic, so a topic added to the catalog
   * fails compilation here until its enablement is decided, and the table is resolved once because hints are fixed for the accessory's life.
   */
  private buildEnabled(): Record<StateTopic, boolean> {

    return {

      doorOpenOccupancy: this.hints.doorOpenOccupancySensor,
      garageDoor: true,
      laser: this.hints.discoLaserSwitch,
      led: this.hints.discoLedSwitch,
      light: this.hints.light,
      lock: this.hints.lock,
      motion: this.hints.motionSensor,
      obstruction: true,
      occupancy: this.hints.motionOccupancySensor,
      strobe: this.hints.konnectedStrobeSwitch,
      vehicleArriving: this.hints.discoVehicleArriving,
      vehicleLeaving: this.hints.discoVehicleLeaving,
      vehiclePresence: this.hints.discoVehiclePresence
    };
  }

  /* Configure the device information for HomeKit. The Manufacturer and SerialNumber characteristics never mutate over the lifetime of this accessory (they derive
   * from immutable RatgdoDevice fields populated at discovery time), so we write them exactly once here. The Model and FirmwareRevision characteristics route
   * through refreshInfo(), which the platform also calls on every session the opener's client begins.
   *
   * The accessory itself is named through HBPU's name helper, which holds its display names to the opener's displayed name whoever owns the HomeKit name, so the
   * accessory cache and the settings sidebar name the opener as the log does. While the plugin owns the name, the helper also writes the information service's
   * ConfiguredName where it differs, so a restored accessory takes the owned name and a fresh one gains the ConfiguredName it is born without. With the user owning the
   * name, the information service keeps the name it carries. The platform's save after construction carries any write. A Home app rename of the opener's own tile
   * lands on the door service's ConfiguredName rather than here, so the door is named and watched as a part.
   */
  private configureInfo(): void {

    const info = this.accessory.getService(this.hap.Service.AccessoryInformation);

    info?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "github.com/hjdhjd");
    info?.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.device.mac);

    this.restateAccessory();
    this.refreshInfo();
  }

  /* Refresh the Model and FirmwareRevision characteristics. The platform rewrites `device.model` and `device.firmwareVersion` from the client's device info on every
   * session and calls this right after, so these two are the AccessoryInformation fields each session re-pushes to HomeKit, whether or not the opener was reported
   * unreachable before it.
   *
   * The Model string leads with the device's family word, taken from the variant table so this site and the table never disagree. That leading word is what the
   * settings sidebar groups a device under: the page reads the Model back off the cached accessory and heads each group with its first word, so every install groups
   * correctly the moment the page loads, with nothing persisted and nothing to migrate.
   */
  public refreshInfo(): void {

    const info = this.accessory.getService(this.hap.Service.AccessoryInformation);

    info?.updateCharacteristic(this.hap.Characteristic.Model,
      RATGDO_VARIANT_LABELS[this.device.variant] + (this.device.model ? " " + this.device.model : ""));
    info?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, this.device.firmwareVersion);
  }

  /* Refresh the opener's names once a session has refreshed its own name. The displayed name is composed afresh, so the log follows a device renamed in ESPHome, and
   * the accessory's display names follow it too, whoever owns the HomeKit name. While the plugin owns the name the information service and every part are re-stated
   * as well. With a custom Name the displayed name never moves with the device, so the re-state writes nothing; with the user owning the name, a rename on the device
   * moves the display names alone, and under Sync Name it moves every name. Every name is re-stated whatever the others answer, so the answers are collected before
   * they are read, and the answer is whether any wrote, which is what the platform saves the accessory on. Every watch reads the owned name afresh, so a rename in
   * the Home app after this one is put back to the refreshed name.
   *
   * The rename line is logged only when the plugin owns the name and the accessory's display name moved: the plugin alone writes that name and a Home app rename
   * never touches it, so a move under ownership is the device's own name changing under Sync Name, while a session that moves nothing, a re-state over a Home app
   * rename, or a move with the user owning the name, which changes nothing HomeKit shows, logs nothing. The line names the name HomeKit carries after the write, the
   * device's name as HomeKit's naming rule cleans it.
   *
   * @returns Whether the re-state wrote anything.
   */
  public refreshName(): boolean {

    const previousName = this.accessory.displayName;

    this.name = this.composeName();

    const wrote = [ this.restateAccessory(), ...this.parts().map(([ part, service ]) => this.restatePart(part, service)) ].includes(true);

    if((this.ownedHomeKitName !== null) && (this.accessory.displayName !== previousName)) {

      this.log.info("Detected a name change on the device; updating the HomeKit name to %s.", this.accessory.displayName);
    }

    return wrote;
  }

  /* The wire payload of a state topic, read from this.status alone: each topic answers from the status field its transition path writes. The transition publish, the
   * session restatement, and every /get reply read a payload here, so no topic can be encoded two ways. The switch is exhaustive over the state topics, so a topic
   * added to the catalog fails compilation here until it has a payload.
   */
  private topicPayload(key: StateTopic): string {

    switch(key) {

      case "doorOpenOccupancy":

        return this.status.doorOpenOccupancy.toString();

      case "garageDoor":

        return this.translateCurrentDoorState(this.status.door);

      case "laser":

        return this.status.discoLaser.toString();

      case "led":

        return this.status.discoLed.toString();

      case "light":

        return this.status.light.toString();

      case "lock":

        return this.status.lock.toString();

      case "motion":

        return this.status.motion.toString();

      case "obstruction":

        return this.status.obstruction.toString();

      case "occupancy":

        return this.status.motionOccupancy.toString();

      case "strobe":

        return this.status.konnectedStrobe.toString();

      case "vehicleArriving":

        return this.status.discoVehicleArriving.toString();

      case "vehicleLeaving":

        return this.status.discoVehicleLeaving.toString();

      case "vehiclePresence":

        return this.status.discoVehiclePresence.toString();
    }
  }

  // Publish a state topic's current payload to MQTT. The library's guarded publish owns the failure routing: a broker we are disconnected from and a shutdown abort
  // are both reported at debug level, while a genuine failure is reported at error. Publishing is fire-and-forget by design, so nothing here waits on delivery. This
  // helper is the one place every state topic passes, so every publish reads the enablement rule here; the session restatement reads the same table to choose
  // what it restates.
  private publishTopic(key: StateTopic): void {

    if(!this.enabled[key]) {

      return;
    }

    this.platform.mqtt?.publishGuarded(mqttTopic(this.device.mac, mqttTopics[key].topic), this.topicPayload(key));
  }

  /* Publish the opener's availability statement, read from the one status field the availability event writes, so the statement and the reachability the device
   * owns cannot disagree. It is retained, so a subscriber attaching mid-session reads the last statement without waiting for the next one, and it composes with the
   * plugin-level statement the MQTT client makes: the opener is available only when both read online.
   */
  private publishAvailability(): void {

    const payload: MqttAvailabilityPayload = this.status.availability ? MQTT_AVAILABILITY_ONLINE : MQTT_AVAILABILITY_OFFLINE;

    this.platform.mqtt?.publishGuarded(mqttTopic(this.device.mac, mqttTopics.availability.topic), payload, { retain: true });
  }

  // Configure MQTT services. Every registration below passes the accessory's lifetime signal, because the MQTT client is shared by every opener and outlives each
  // accessory: disposing this accessory aborts the signal, and that is what removes its handlers and its final word from the client, so none outlives it.
  private configureMqtt(): boolean {

    const signal = this.lifetime.signal;

    // Return our garage door state.
    this.platform.mqtt?.subscribeGet(mqttTopic(this.device.mac, mqttTopics.garageDoor.topic), mqttTopics.garageDoor.label, () => this.topicPayload("garageDoor"),
      { signal });

    // Set our garage door state.
    this.platform.mqtt?.subscribeSet(mqttTopic(this.device.mac, mqttTopics.garageDoor.topic), mqttTopics.garageDoor.label, (value: string) => {

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

    // Return our lock state if configured to do so.
    if(this.enabled.lock) {

      this.platform.mqtt?.subscribeGet(mqttTopic(this.device.mac, mqttTopics.lock.topic), mqttTopics.lock.label, () => this.topicPayload("lock"), { signal });
    }

    // Return our obstruction state.
    this.platform.mqtt?.subscribeGet(mqttTopic(this.device.mac, mqttTopics.obstruction.topic), mqttTopics.obstruction.label, () => this.topicPayload("obstruction"),
      { signal });

    // Return our door open occupancy state if configured to do so. We read from status rather than from the HAP characteristic so MQTT and HomeKit share the same
    // source of truth - the status field is updated atomically with the characteristic write at every transition site (the open-door timer fire and the door-closed
    // clear) so the two never drift.
    if(this.enabled.doorOpenOccupancy) {

      this.platform.mqtt?.subscribeGet(mqttTopic(this.device.mac, mqttTopics.doorOpenOccupancy.topic), mqttTopics.doorOpenOccupancy.label,
        () => this.topicPayload("doorOpenOccupancy"), { signal });
    }

    // Return our light state if configured to do so.
    if(this.enabled.light) {

      this.platform.mqtt?.subscribeGet(mqttTopic(this.device.mac, mqttTopics.light.topic), mqttTopics.light.label, () => this.topicPayload("light"), { signal });
    }

    // Return our motion occupancy state if configured to do so. See the doorOpenOccupancy reader above for the rationale on reading from status rather than HAP.
    if(this.enabled.occupancy) {

      this.platform.mqtt?.subscribeGet(mqttTopic(this.device.mac, mqttTopics.occupancy.topic), mqttTopics.occupancy.label, () => this.topicPayload("occupancy"),
        { signal });
    }

    // Return our motion state if configured to do so.
    if(this.enabled.motion) {

      this.platform.mqtt?.subscribeGet(mqttTopic(this.device.mac, mqttTopics.motion.topic), mqttTopics.motion.label, () => this.topicPayload("motion"), { signal });
    }

    /* The state topics this opener restates on each broker session: the enabled topics that report held state. The enablement table and HELD_STATE are fixed for the
     * accessory's life, so the set is resolved once here rather than on every session.
     */
    const restated = (Object.keys(this.enabled) as StateTopic[]).filter((key) => this.enabled[key] && HELD_STATE[key]);

    /* Restate what this opener holds each time the client establishes a broker session: its availability first, then every state topic above. Nothing published
     * during an outage is replayed later, so a subscriber that missed a statement hears the current one when the session begins. The registration carries the same
     * per-accessory signal as every subscription above, so disposing this accessory releases it.
     */
    this.platform.mqtt?.onConnect(() => {

      this.publishAvailability();

      for(const key of restated) {

        this.publishTopic(key);
      }
    }, { signal });

    /* The opener's final word as the plugin shuts down: its retained offline, stated by the client's graceful end while the broker session still holds. The
     * registration carries this accessory's signal, so disposing the accessory releases it, and the publish carries the end's window, so a word the broker never
     * takes comes back as a refusal rather than holding shutdown. The word carries no change gate, because a final word is stated whatever the topic last carried.
     */
    this.platform.mqtt?.onEnd((window: AbortSignal) => this.platform.mqtt?.publish(mqttTopic(this.device.mac, mqttTopics.availability.topic),
      MQTT_AVAILABILITY_OFFLINE, { retain: true, signal: window }), { signal });

    return true;
  }

  // Configure the garage door service for HomeKit.
  private configureGarageDoor(): boolean {

    const { service } = acquireService({ accessory: this.accessory, name: this.partName(RatgdoService.GARAGE_DOOR), serviceType: this.hap.Service.GarageDoorOpener });

    this.holdPart(RatgdoService.GARAGE_DOOR, service);

    service.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.status.door);
    service.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.doorTargetStateBias(this.status.door));
    service.updateCharacteristic(this.hap.Characteristic.ObstructionDetected, this.status.obstruction);

    // The door target handler answers nothing. HAP reads a set handler's answer as a write response, and TargetDoorState supports none, so an answer here would only
    // earn a characteristic warning on every write.
    service.getCharacteristic(this.hap.Characteristic.TargetDoorState).onSet(this.answering((value: CharacteristicValue) => {

      this.setDoorState(value);
    }));

    service.getCharacteristic(this.hap.Characteristic.CurrentDoorState).onGet(this.answering(() => this.status.door));
    service.getCharacteristic(this.hap.Characteristic.ObstructionDetected).onGet(this.answering(() => this.status.obstruction));

    this.logFeature("Opener.Lock", "Wireless remote lock");

    /* The wireless remote lock pair's presence follows the user's feature flag in both directions on every configure pass: each characteristic is attached where the
     * feature is on and taken off the service where the user turned it off, so a tile that once showed the lock stops showing it. Presence is read before anything is
     * attached, so a characteristic this service never carried is never materialized only to be removed again.
     */
    validCharacteristic({ characteristic: this.hap.Characteristic.LockCurrentState, service, validate: this.hints.lock });
    validCharacteristic({ characteristic: this.hap.Characteristic.LockTargetState, service, validate: this.hints.lock });

    /* Dress the pair whenever the feature is on, which is exactly when the calls above leave it present. The handler binds on every pass rather than only on the pass
     * that first attached the characteristic: an accessory Homebridge restored from its cache arrives here already carrying the pair, and a characteristic restored
     * that way has no handler bound in this process, so a bind conditioned on first attachment would leave the user's lock tile inert until the cache was cleared.
     */
    if(this.hints.lock) {

      service.getCharacteristic(this.hap.Characteristic.LockTargetState).onSet(this.answering((value: CharacteristicValue) => {

        if(!this.command("lock", (value === this.hap.Characteristic.LockTargetState.SECURED) ? "lock" : "unlock")) {

          // The command did not reach the device. Revert the UI to its prior state once HomeKit has acknowledged the onSet.
          this.scheduleUiRevert(() => {

            service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.lockTargetStateBias(this.status.lock));
            service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);
          });
        }
      }));

      service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.status.lock);
      service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.lockTargetStateBias(this.status.lock));
    }

    // The garage door is the primary affordance for this accessory, which controls how HomeKit surfaces it in the Home app.
    service.setPrimaryService(true);

    return true;
  }

  // Configure the light for HomeKit.
  private configureLight(): boolean {

    this.logFeature("Light", "Light");

    const { service } = validService({ accessory: this.accessory, name: this.partName(RatgdoService.LIGHT), serviceType: this.hap.Service.Lightbulb,
      validate: this.hints.light });

    if(!service) {

      return false;
    }

    this.holdPart(RatgdoService.LIGHT, service);

    service.updateCharacteristic(this.hap.Characteristic.On, this.status.light);
    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.status.light));
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering(this.toggleOnSet({ service, state: () => this.status.light, topic: "light" })));

    return true;
  }

  /* Shared configuration path for sensor services that follow the same shape: a binary state characteristic (motion / contact / occupancy) plus a StatusActive
   * characteristic held true. StatusActive answers whether a sensor is operating, and the opener reports no fact that would take any of these sensors out of operation,
   * so every sensor of this shape reads true and binds no read handler for it. Reachability is a separate question the accessory answers on its own: while the opener
   * cannot be reached, every handler refuses through `answering` and HomeKit shows the whole accessory as No Response, never through this characteristic. The state
   * characteristic is seeded from `initialValue` - HAP's value for the caller's corresponding RatgdoStatus field, which is the single source of truth - rather than
   * a hardcoded default, so the momentary-versus-persistent distinction lives entirely in buildInitialStatus: momentary sensors (motion, the vehicle arriving and
   * leaving contacts) resolve to false there and start clear, while a persistent sensor like vehicle presence carries the state captured at construction straight
   * onto its characteristic. Every sensor service of this shape shares this block, so a future sensor variant is a single declarative entry and any cross-cutting
   * change (a new StatusActive answer, an added characteristic) lands in exactly one place. Deviation logging is the caller's responsibility via `this.logFeature()`
   * at the top of the calling configureXxx, so this helper stays focused on service wiring and carries no logging concern of its own.
   */
  private configureSensor(opts: {

    cacheKey: RatgdoService;
    hint: boolean;
    initialCharacteristic: CharacteristicTarget;
    initialValue: CharacteristicValue;
    service: AcquireServiceTarget;
    subtype?: string;
  }): boolean {

    const { service } = validService({ accessory: this.accessory, name: this.partName(opts.cacheKey), serviceType: opts.service, subtype: opts.subtype,
      validate: opts.hint });

    if(!service) {

      return false;
    }

    this.holdPart(opts.cacheKey, service);

    service.updateCharacteristic(opts.initialCharacteristic, opts.initialValue);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, true);

    return true;
  }

  // Configure the motion sensor for HomeKit.
  private configureMotionSensor(): boolean {

    this.logFeature("Motion", "Motion sensor");

    return this.configureSensor({

      cacheKey: RatgdoService.MOTION_SENSOR,
      hint: this.hints.motionSensor,
      initialCharacteristic: this.hap.Characteristic.MotionDetected,
      initialValue: this.status.motion,
      service: this.hap.Service.MotionSensor
    });
  }

  // Configure a dimmer to automate open and close events in HomeKit beyond what HomeKit might allow for a garage opener service that gets treated as a secure service.
  private configureAutomationDoorPositionDimmer(): boolean {

    this.logFeature("Opener.Dimmer", "Automation door position dimmer");

    const { service } = validService({ accessory: this.accessory, name: this.partName(RatgdoService.DIMMER_OPENER_AUTOMATION), serviceType: this.hap.Service.Lightbulb,
      subtype: RatgdoService.DIMMER_OPENER_AUTOMATION, validate: this.hints.automationDimmer });

    if(!service) {

      return false;
    }

    this.holdPart(RatgdoService.DIMMER_OPENER_AUTOMATION, service);

    /* Put the dimmer back on the door once HomeKit has acknowledged the onSet, after a door write the dimmer made was refused. A refused write leaves the door where
     * it was, so Brightness and On are restored from the status record - the position the door is at, and On by the same rule its getter answers with - rather than
     * from the value the user wrote.
     */
    const revertToDoor = (): void => this.scheduleUiRevert(() => {

      service.updateCharacteristic(this.hap.Characteristic.Brightness, this.status.doorPosition);
      service.updateCharacteristic(this.hap.Characteristic.On, this.isDimmerOn());
    });

    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.isDimmerOn()));

    // The On characteristic only handles closing. Opening is driven by the Brightness onSet below, since HomeKit always sends a Brightness update alongside an On=true.
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering((value: CharacteristicValue) => {

      if(value) {

        return;
      }

      if(this.hints.logOpener) {

        this.log.info("Automation door position dimmer: closing.");
      }

      if(!this.setDoorState(this.hap.Characteristic.TargetDoorState.CLOSED)) {

        revertToDoor();
      }
    }));

    service.getCharacteristic(this.hap.Characteristic.Brightness).onGet(this.answering(() => this.status.doorPosition));

    // Adjust the door position by translating brightness into a target door state with a position payload.
    service.getCharacteristic(this.hap.Characteristic.Brightness).onSet(this.answering((value: CharacteristicValue) => {

      if(this.hints.logOpener) {

        // HomeKit's Brightness characteristic always delivers a numeric percentage, so this CharacteristicValue-to-number narrowing is safe by HAP convention.
        this.log.info("Automation door position dimmer: moving opener to %s%.", (value as number).toFixed(0));
      }

      if(!this.setDoorState((value as number) > 0 ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED,
        value as number)) {

        revertToDoor();
      }
    }));

    service.updateCharacteristic(this.hap.Characteristic.On, this.isDimmerOn());
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.status.doorPosition);

    return true;
  }

  // Configure a switch to automate open and close events in HomeKit beyond what HomeKit might allow for a garage opener service that gets treated as a secure service.
  private configureAutomationDoorSwitch(): boolean {

    this.logFeature("Opener.Switch", "Automation door opener switch");

    const { service } = validService({ accessory: this.accessory, name: this.partName(RatgdoService.SWITCH_OPENER_AUTOMATION), serviceType: this.hap.Service.Switch,
      subtype: RatgdoService.SWITCH_OPENER_AUTOMATION, validate: this.hints.automationSwitch });

    if(!service) {

      return false;
    }

    this.holdPart(RatgdoService.SWITCH_OPENER_AUTOMATION, service);

    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.isDoorOpen()));

    // A refused door write leaves the door where it was, so the switch goes back to what the door is doing rather than to the opposite of what the user wrote, which
    // would show a closed door when a scene turns an open door's switch on.
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering((value: CharacteristicValue) => {

      if(this.hints.logOpener) {

        this.log.info("Automation door opener switch: %s.", value ? "open" : "close");
      }

      if(!this.setDoorState(value ? this.hap.Characteristic.TargetDoorState.OPEN : this.hap.Characteristic.TargetDoorState.CLOSED)) {

        this.scheduleUiRevert(() => service.updateCharacteristic(this.hap.Characteristic.On, this.isDoorOpen()));
      }
    }));

    service.updateCharacteristic(this.hap.Characteristic.On, this.isDoorOpen());

    return true;
  }

  // Configure the Ratgdo (ESP32) Disco-specific backup battery service.
  private configureDiscoBattery(): boolean {

    this.logFeature("Disco.Battery", "Ratgdo (ESP32) backup battery status");

    const { service } = validService({ accessory: this.accessory, name: this.partName(RatgdoService.BATTERY), serviceType: this.hap.Service.Battery,
      validate: this.hints.discoBattery });

    if(!service) {

      return false;
    }

    this.holdPart(RatgdoService.BATTERY, service);

    service.getCharacteristic(this.hap.Characteristic.ChargingState).onGet(this.answering(() => this.status.discoBatteryState));
    service.updateCharacteristic(this.hap.Characteristic.ChargingState, this.status.discoBatteryState);

    return true;
  }

  // Configure the Ratgdo (ESP32) Disco-specific parking assistance laser switch.
  private configureDiscoLaserSwitch(): boolean {

    this.logFeature("Disco.Switch.Laser", "Ratgdo (ESP32) Disco parking assistance laser switch");

    const { service } = validService({ accessory: this.accessory, name: this.partName(RatgdoService.SWITCH_DISCO_LASER), serviceType: this.hap.Service.Switch,
      subtype: RatgdoService.SWITCH_DISCO_LASER, validate: this.hints.discoLaserSwitch });

    if(!service) {

      return false;
    }

    this.holdPart(RatgdoService.SWITCH_DISCO_LASER, service);

    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.status.discoLaser));
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering(this.toggleOnSet({ service, state: () => this.status.discoLaser, topic: "disco-laser" })));
    service.updateCharacteristic(this.hap.Characteristic.On, this.status.discoLaser);

    return true;
  }

  // Configure the Ratgdo (ESP32) Disco-specific LED switch.
  private configureDiscoLedSwitch(): boolean {

    this.logFeature("Disco.Switch.Led", "Ratgdo (ESP32) Disco LED switch");

    const { service } = validService({ accessory: this.accessory, name: this.partName(RatgdoService.SWITCH_DISCO_LED), serviceType: this.hap.Service.Switch,
      subtype: RatgdoService.SWITCH_DISCO_LED, validate: this.hints.discoLedSwitch });

    if(!service) {

      return false;
    }

    this.holdPart(RatgdoService.SWITCH_DISCO_LED, service);

    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.status.discoLed));
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering(this.toggleOnSet({ service, state: () => this.status.discoLed, topic: "disco-led" })));
    service.updateCharacteristic(this.hap.Characteristic.On, this.status.discoLed);

    return true;
  }

  // Configure the vehicle arriving contact sensor for HomeKit.
  private configureDiscoVehicleArrivingContactSensor(): boolean {

    this.logFeature("Disco.ContactSensor.Vehicle.Arriving", "Ratgdo (ESP32) Disco vehicle arriving contact sensor");

    return this.configureSensor({

      cacheKey: RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING,
      hint: this.hints.discoVehicleArriving,
      initialCharacteristic: this.hap.Characteristic.ContactSensorState,
      initialValue: this.contactSensorState(this.status.discoVehicleArriving),
      service: this.hap.Service.ContactSensor,
      subtype: RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING
    });
  }

  // Configure the vehicle leaving contact sensor for HomeKit.
  private configureDiscoVehicleLeavingContactSensor(): boolean {

    this.logFeature("Disco.ContactSensor.Vehicle.Leaving", "Ratgdo (ESP32) Disco vehicle leaving contact sensor");

    return this.configureSensor({

      cacheKey: RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING,
      hint: this.hints.discoVehicleLeaving,
      initialCharacteristic: this.hap.Characteristic.ContactSensorState,
      initialValue: this.contactSensorState(this.status.discoVehicleLeaving),
      service: this.hap.Service.ContactSensor,
      subtype: RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING
    });
  }

  // Configure the vehicle presence occupancy sensor for HomeKit.
  private configureDiscoVehiclePresenceOccupancySensor(): boolean {

    this.logFeature("Disco.OccupancySensor.Vehicle.Presence", "Ratgdo (ESP32) Disco vehicle presence occupancy sensor");

    return this.configureSensor({

      cacheKey: RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE,
      hint: this.hints.discoVehiclePresence,
      initialCharacteristic: this.hap.Characteristic.OccupancyDetected,
      initialValue: this.occupancyDetected(this.status.discoVehiclePresence),
      service: this.hap.Service.OccupancySensor,
      subtype: RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE
    });
  }

  // Configure the Konnected-specific pre-close warning switch.
  private configureKonnectedPcwSwitch(): boolean {

    this.logFeature("Konnected.Switch.Pcw", "Konnected pre-close warning switch");

    const { service } = validService({ accessory: this.accessory, name: this.partName(RatgdoService.SWITCH_KONNECTED_PCW), serviceType: this.hap.Service.Switch,
      subtype: RatgdoService.SWITCH_KONNECTED_PCW, validate: this.hints.konnectedPcwSwitch });

    if(!service) {

      return false;
    }

    this.holdPart(RatgdoService.SWITCH_KONNECTED_PCW, service);

    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => false));

    // The pre-close warning is a momentary action, not a persistent state. We auto-revert the switch back to off on two timelines: after the warning audio finishes
    // (success path) or as a standard UI revert when the command failed to dispatch (failure path). Routing the failure case through scheduleUiRevert() keeps it
    // aligned with every other onSet failure handler in this file, which all funnel through the same 50ms revert helper.
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering((value: CharacteristicValue) => {

      if(this.command("konnected-pcw")) {

        this.timers.schedule(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), RATGDO_KONNECTED_PCW_DURATION * 1000);

        return;
      }

      this.scheduleUiRevert(() => service.updateCharacteristic(this.hap.Characteristic.On, !value));
    }));

    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Configure the Konnected-specific strobe switch.
  private configureKonnectedStrobeSwitch(): boolean {

    this.logFeature("Konnected.Switch.Strobe", "Konnected strobe switch");

    const { service } = validService({ accessory: this.accessory, name: this.partName(RatgdoService.SWITCH_KONNECTED_STROBE), serviceType: this.hap.Service.Switch,
      subtype: RatgdoService.SWITCH_KONNECTED_STROBE, validate: this.hints.konnectedStrobeSwitch });

    if(!service) {

      return false;
    }

    this.holdPart(RatgdoService.SWITCH_KONNECTED_STROBE, service);

    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.status.konnectedStrobe));
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering(this.toggleOnSet({ service, state: () => this.status.konnectedStrobe,
      topic: "konnected-strobe" })));
    service.updateCharacteristic(this.hap.Characteristic.On, this.status.konnectedStrobe);

    return true;
  }

  // Configure a switch to control the ability to lockout all wireless remotes for the garage door opener, if the feature exists.
  private configureAutomationLockoutSwitch(): boolean {

    this.logFeature("Opener.Switch.RemoteLockout", "Automation wireless remote lockout switch");

    const { service } = validService({ accessory: this.accessory, name: this.partName(RatgdoService.SWITCH_LOCKOUT), serviceType: this.hap.Service.Switch,
      subtype: RatgdoService.SWITCH_LOCKOUT, validate: this.hints.lock && this.hints.lockoutSwitch });

    if(!service) {

      return false;
    }

    this.holdPart(RatgdoService.SWITCH_LOCKOUT, service);

    // The switch is on whenever the remote lockout is engaged, and a command that never reached the opener puts it back on the lockout the opener holds.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.remotesLockedOut()));
    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering((value: CharacteristicValue) => {

      this.log.info("Automation wireless remote lockout switch: remotes are %s.", value ? "locked out" : "permitted");

      if(!this.command("lock", value ? "lock" : "unlock")) {

        this.scheduleUiRevert(() => service.updateCharacteristic(this.hap.Characteristic.On, this.remotesLockedOut()));
      }
    }));

    service.updateCharacteristic(this.hap.Characteristic.On, this.remotesLockedOut());

    return true;
  }

  // Configure the door open occupancy sensor for HomeKit.
  private configureDoorOpenOccupancySensor(): boolean {

    this.logFeature("Opener.OccupancySensor", "Door open indicator occupancy sensor");

    // The duration configures the sensor, so an opener without the sensor has no duration to report.
    if(this.hints.doorOpenOccupancySensor) {

      this.logFeature("Opener.OccupancySensor.Duration", "Door open indicator occupancy sensor duration");
    }

    return this.configureSensor({

      cacheKey: RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN,
      hint: this.hints.doorOpenOccupancySensor,
      initialCharacteristic: this.hap.Characteristic.OccupancyDetected,
      initialValue: this.occupancyDetected(this.status.doorOpenOccupancy),
      service: this.hap.Service.OccupancySensor,
      subtype: RatgdoService.OCCUPANCY_SENSOR_DOOR_OPEN
    });
  }

  // Configure the motion occupancy sensor for HomeKit.
  private configureMotionOccupancySensor(): boolean {

    this.logFeature("Motion.OccupancySensor", "Motion occupancy sensor");

    // The duration configures the sensor, so an opener without the sensor has no duration to report.
    if(this.hints.motionOccupancySensor) {

      this.logFeature("Motion.OccupancySensor.Duration", "Motion occupancy sensor duration");
    }

    return this.configureSensor({

      cacheKey: RatgdoService.OCCUPANCY_SENSOR_MOTION,
      hint: this.hints.motionOccupancySensor,
      initialCharacteristic: this.hap.Characteristic.OccupancyDetected,
      initialValue: this.occupancyDetected(this.status.motionOccupancy),
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
      this.scheduleDoorRevert();

      return false;
    }

    // If we are already opening or closing the garage door, we assume the user wants to stop the garage door opener at its current location. A stop the client
    // cannot send leaves the door moving, so the target goes back to where the door is headed.
    if((this.status.door === this.hap.Characteristic.CurrentDoorState.OPENING) || (this.status.door === this.hap.Characteristic.CurrentDoorState.CLOSING)) {

      this.log.debug("User-initiated stop requested while transitioning between open and close states.");

      if(!this.command("door", "stop")) {

        this.scheduleDoorRevert();

        return false;
      }

      return true;
    }

    // Set the door state, assuming we're not already there. A command the client cannot send leaves the door where it was, so the target goes back to match it.
    if(this.status.door !== value) {

      this.log.debug("User-initiated door state change: %s%s.", this.translateTargetDoorState(value), (position !== undefined) ? " (" + position.toString() + "%)" : "");

      if(!this.command("door", targetAction, position)) {

        this.scheduleDoorRevert();

        return false;
      }
    }

    return true;
  }

  /* Put the door's target back on the door once HomeKit has acknowledged the onSet, after a door write was refused - in read-only mode, or because the command could
   * not be sent. A refused write leaves the door where it was, so the target is restored from the status record by the same bias every other target write uses, a
   * stopped door targeting open, rather than inferred from the value the user wrote.
   */
  private scheduleDoorRevert(): void {

    this.scheduleUiRevert(() => this.services[RatgdoService.GARAGE_DOOR]?.updateCharacteristic(this.hap.Characteristic.TargetDoorState,
      this.doorTargetStateBias(this.status.door)));
  }

  /* Lazy-evaluation debug log. The builder thunk only runs when the debug setting is on, so callers on hot paths (per-event telemetry, per-line verbose logs) can
   * construct expensive messages (util.inspect of large payloads, string concatenations) without paying the cost when debug is off. The guard here reads the same
   * setting the logger's own gate does; it earns its place by keeping the builder from running at all, which the gate downstream cannot do.
   */
  public debugLazy(builder: () => string): void {

    if(!this.platform.config.debug) {

      return;
    }

    this.log.debug(builder());
  }

  /* Central per-telemetry-event state router, invoked for every inbound ESPHome event (many times per second during a door transition). We alias every service we
   * might touch into locals at method entry so the hot path costs one map read per service rather than repeated getService() lookups, and dispatch on event.id. Most
   * branches guard the characteristic write on an actual state change; the obstruction and Disco vehicle-sensor branches instead write the sensor's own
   * characteristic unconditionally and gate everything else they do on the transition.
   */
  public updateState(event: EspHomeEvent): void {

    const dimmerService = this.services[RatgdoService.DIMMER_OPENER_AUTOMATION];
    const discoBatteryService = this.services[RatgdoService.BATTERY];
    const discoLaserSwitchService = this.services[RatgdoService.SWITCH_DISCO_LASER];
    const discoLedSwitchService = this.services[RatgdoService.SWITCH_DISCO_LED];
    const discoVehicleArrivingContactService = this.services[RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING];
    const discoVehicleLeavingContactService = this.services[RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING];
    const discoVehiclePresenceOccupancyService = this.services[RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE];
    const garageDoorService = this.services[RatgdoService.GARAGE_DOOR];
    const konnectedStrobeSwitchService = this.services[RatgdoService.SWITCH_KONNECTED_STROBE];
    const lightBulbService = this.services[RatgdoService.LIGHT];
    const lockoutService = this.services[RatgdoService.SWITCH_LOCKOUT];
    const motionService = this.services[RatgdoService.MOTION_SENSOR];

    switch(event.id) {

      case "availability": {

        const isOnline = event.state === "online";

        // The "Ratgdo connected." log lives in the platform's markOnline, the one online statement, made for a fresh client and on the client's recovered verdict
        // alike. Here we own only the disconnect transition log - the true-to-false flip is the user-visible signal that the device went away. The identity fields are
        // not this case's concern: the platform refreshes them on every session, which need not change availability at all.
        const wasOnline = this.status.availability;

        this.status.availability = isOnline;

        // We state the opener's reachability on every availability event rather than only on a change. Construction starts the field at true, so the online the
        // platform dispatches for a new connection changes nothing here, and it is exactly the statement that connection must make.
        this.publishAvailability();

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

          this.publishTopic("motion");
        }

        // Arm (or re-arm) the motion reset timer. Registering under "motion" clears any prior motion timer first, so a fresh motion event restarts the window from now.
        this.timers.setTimeout("motion", () => {

          this.status.motion = false;
          motionService?.updateCharacteristic(this.hap.Characteristic.MotionDetected, this.status.motion);

          this.publishTopic("motion");
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

          /* The door's target and the automation switch read the obstruction only through whether it holds the door open, so we re-state them only when this change
           * moves that answer for the door's current state, read before the status write and again after it. A fully closed door's answer does not depend on the
           * obstruction, so a beam break or its clearing there writes neither...re-stating them would put back what construction or the last door event wrote,
           * overwriting a command the user has given before the door's first movement event arrives.
           */
          const heldOpen = this.obstructionHoldsOpen(this.status.door);

          this.status.obstruction = event.state === "ON";

          if(this.obstructionHoldsOpen(this.status.door) !== heldOpen) {

            this.updateDoorTargetAndSwitch();
          }

          if(this.hints.logObstruction) {

            this.log.info("Obstruction %sdetected.", this.status.obstruction ? "" : "no longer ");
          }

          this.publishTopic("obstruction");
        }

        break;

      case "binary_sensor-vehicle_arriving":

        discoVehicleArrivingContactService?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.contactSensorState(event.state === "ON"));
        this.updateVehicleSensorState("discoVehicleArriving", event.state, "Vehicle arriving", "vehicleArriving");

        break;

      case "binary_sensor-vehicle_detected":

        discoVehiclePresenceOccupancyService?.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, this.occupancyDetected(event.state === "ON"));
        this.updateVehicleSensorState("discoVehiclePresence", event.state, "Vehicle", "vehiclePresence");

        break;

      case "binary_sensor-vehicle_leaving":

        discoVehicleLeavingContactService?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.contactSensorState(event.state === "ON"));
        this.updateVehicleSensorState("discoVehicleLeaving", event.state, "Vehicle leaving", "vehicleLeaving");

        break;

      case "cover-door":
      case "cover-garage_door": {

        // Local working buffer for the operation. We route the resolved operation through a local rather than mutating the inbound event, so the wire-faithful payload
        // stays immutable for any future cross-case consumer.
        let operation: DoorOperation;

        // Determine what action the opener is currently executing.
        switch(event.current_operation) {

          case "CLOSING":
          case "OPENING":

            operation = (event.current_operation === "CLOSING") ? "closing" : "opening";

            break;

          case "IDLE":

            /* An idle cover reports its position through state, so this is the one point in the handler that reads the wire value's content rather than a name we have
             * already classified. We validate it here and stand down on anything outside the two states the opener can report, leaving the last known door state and the
             * last known dimmer reading in place...a firmware anomaly deserves a line an installer can see, not a door state that quietly goes stale.
             */
            if((event.state !== "OPEN") && (event.state !== "CLOSED")) {

              this.log.error("Unknown door state detected: %s.", event.state);

              return;
            }

            // We treat an IDLE cover reported OPEN at a position strictly between 0 and 1 as stopped-at-partial rather than fully open; 0 collapses to closed, 1 to open.
            operation = ((event.state === "OPEN") && (event.position !== undefined) && (event.position > 0) && (event.position < 1)) ? "stopped" :
              (event.state === "OPEN") ? "open" : "closed";

            break;

          default:

            this.log.error("Unknown door operation detected: %s.", event.current_operation);

            return;
        }

        // Update our door position automation dimmer.
        if(event.position !== undefined) {

          this.status.doorPosition = event.position * 100;

          dimmerService?.updateCharacteristic(this.hap.Characteristic.Brightness, this.status.doorPosition);
          dimmerService?.updateCharacteristic(this.hap.Characteristic.On, this.isDimmerOn());
          this.log.debug("Door state: %s% open.", this.status.doorPosition.toFixed(0));
        }

        // If we're already in the state we're updating to, we're done.
        if(this.translateCurrentDoorState(this.status.door) === operation) {

          break;
        }

        this.status.door = this.resolveDoorState(operation);

        // Trigger our occupancy timer, if configured to do so and we don't have one yet, once the door has resolved to OPEN. The timer is what flips
        // status.doorOpenOccupancy true after the configured duration, so a transient open does not raise occupancy - only a continuously-open door for the full
        // duration does. The has() guard is defensive: the state short-circuit above already swallows a repeated open before it reaches here, so the guard matters only
        // if a future event path resolves to open again with the window already running - the dwell window must never restart partway.
        if((operation === "open") && this.hints.doorOpenOccupancySensor && !this.timers.has("doorOccupancy")) {

          this.timers.setTimeout("doorOccupancy", () => {

            // The timer firing raises occupancy; setOccupancy owns the status + characteristic + log + MQTT write.
            this.setOccupancy("doorOpen", true);
          }, this.hints.doorOpenOccupancyDuration * 1000);
        }

        // We always want to ensure we update TargetDoorState before updating CurrentDoorState in order to work around some notification sequencing quirks HomeKit
        // occasionally has, so the door's target and the automation switch are written first.
        this.updateDoorTargetAndSwitch();

        garageDoorService?.updateCharacteristic(this.hap.Characteristic.CurrentDoorState, this.status.door);

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

        this.publishTopic("garageDoor");

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

          this.publishTopic("light");
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
        lockoutService?.updateCharacteristic(this.hap.Characteristic.On, this.remotesLockedOut());

        this.log.info("Wireless remotes are %s.", (event.state === "LOCKED") ? "locked out" : "permitted");

        this.publishTopic("lock");

        break;

      case "switch-laser":

        this.updateSwitchState(discoLaserSwitchService, "discoLaser", event.state, "laser");

        break;

      case "switch-led":

        this.updateSwitchState(discoLedSwitchService, "discoLed", event.state, "led");

        break;

      case "switch-str_output":

        this.updateSwitchState(konnectedStrobeSwitchService, "konnectedStrobe", event.state, "strobe");

        break;

      default:

        break;
    }
  }

  /* Build an onSet handler for a HomeKit On characteristic. Maps the boolean value into the "on" / "off" payload command() expects, and on command failure routes the UI
   * back through scheduleUiRevert() to the state the opener reports, read from the status record the toggle's getter answers with. A refused write leaves the toggle
   * where it was, so restoring the opposite of the written value would be wrong whenever the user wrote the state it already had - a scene turning on a light that is
   * already on would show it off. Every toggle-style service shares this exact shape; centralizing it here means the on/off wire format AND the failure-revert
   * contract both live in one place.
   *
   * @param options.service - The service whose On characteristic the revert writes.
   * @param options.state   - The status record's answer for this toggle.
   * @param options.topic   - The command topic the write dispatches to.
   *
   * @returns The onSet handler.
   */
  private toggleOnSet({ service, state, topic }: { service: Service; state: () => boolean; topic: CommandTopic }): (value: CharacteristicValue) => void {

    return (value) => {

      if(!this.command(topic, (value === true) ? "on" : "off")) {

        this.scheduleUiRevert(() => service.updateCharacteristic(this.hap.Characteristic.On, state()));
      }
    };
  }

  /* Dispatch a command to the device's ESPHome client. Every entity reference resolves through `RATGDO_ENTITIES`, so this function holds no literal entity names - a
   * rename in the registry propagates here automatically. Cross-variant entities (cover, light, lock) are reached through the union-typed `entities` local;
   * variant-specific topics (`disco-*`, `konnected-*`) read the appropriate variant's required-field registry directly. No defensive optional-checks are needed
   * because each access site is statically guaranteed to address an entity that exists on its variant.
   */
  private command(topic: CommandTopic, payload = "", position?: number): boolean {

    /* Ensure the ESPHome API client can carry the command. The client is absent once its connection has been released, and a held client between sessions -
     * the patience window before its reachability verdict - drops a frame it has no session to send on, so a command is refused unless the session is live, and the
     * caller reverts its UI rather than showing a write that never reached the opener. An MQTT set has no UI to revert, so the refusal is noted at debug, naming the
     * topic, where a support request can find a command that went nowhere.
     */
    const client = this.platform.getEspHomeClient(this.device.mac);

    if(!client || !isConnectionLive(client.health())) {

      this.log.debug("The %s command was not sent, because the opener cannot be reached.", topic);

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

  /* Resolve a cover operation to its CurrentDoorState value. The switch is exhaustive over DoorOperation: adding a sixth operation fails compilation here until
   * handled, which is the architectural guarantee this resolution cannot fall out of sync with the type. The method stays a pure value computation, so the caller
   * owns every side effect the resolved state triggers.
   */
  private resolveDoorState(operation: DoorOperation): CharacteristicValue {

    switch(operation) {

      case "closed":

        return this.hap.Characteristic.CurrentDoorState.CLOSED;

      case "closing":

        return this.hap.Characteristic.CurrentDoorState.CLOSING;

      case "open":

        return this.hap.Characteristic.CurrentDoorState.OPEN;

      case "opening":

        return this.hap.Characteristic.CurrentDoorState.OPENING;

      case "stopped":

        return this.hap.Characteristic.CurrentDoorState.STOPPED;
    }
  }

  // Utility function to translate HomeKit's current door state values into human-readable form.
  private translateCurrentDoorState(value: CharacteristicValue): DoorOperation | "unknown" {

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

  /* Whether the door counts as open for the automation switch: open, opening or stopped, or any state but closed while an obstruction holds it open. The
   * switch's read, its write at startup, its writes as the door moves and as an obstruction starts or stops holding the door open, and its revert after a refused
   * write answer by this one rule, so the switch is never put back to a state its own read would contradict.
   */
  private isDoorOpen(): boolean {

    return this.doorCurrentStateBias(this.status.door) !== this.hap.Characteristic.CurrentDoorState.CLOSED;
  }

  /* Whether the automation dimmer reads on: whenever the door is not fully closed. The dimmer's Brightness is the door's position, so its On follows the position
   * too, and every On this rule writes agrees with the Brightness written beside it, a closing or an obstructed door included. The dimmer's read, its write at
   * startup, its writes as the door moves, and its revert after a refused write answer by this one rule.
   */
  private isDimmerOn(): boolean {

    return this.status.doorPosition > 0;
  }

  // Whether the opener's wireless remotes are locked out, the one answer the lockout switch's read, its writes and its revert after a refused write all give.
  private remotesLockedOut(): boolean {

    return this.status.lock === this.hap.Characteristic.LockCurrentState.SECURED;
  }

  /* Whether an obstruction holds the door open, the one condition the door's target and the automation switch each read, so their rules cannot disagree about an
   * obstructed door. It holds at a door in any state but fully closed: a moving or stopped door with its beam broken reverses or is held open, so it is open in
   * HomeKit's terms. A fully closed door with its beam broken has not moved, so it stays closed, and a beam break alone never shows Home a closed door as opening.
   */
  private obstructionHoldsOpen(state: CharacteristicValue): boolean {

    return this.status.obstruction && (state !== this.hap.Characteristic.CurrentDoorState.CLOSED);
  }

  // Utility function to return our bias for what the current door state should be. This backs the door-open rule the automation switch answers by.
  private doorCurrentStateBias(state: CharacteristicValue): CharacteristicValue {

    // Our current door state reflects our opinion on what open or closed means in HomeKit terms. For the obvious states, this is easy. For some of the edge cases, it can
    // be less so. Our north star is that if an obstruction holds the door open, we are open.
    if(this.obstructionHoldsOpen(state)) {

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
    // closing, our target state needs to be the completion of those actions. If we're stopped, or an obstruction holds the door open, we're going to assume the desired
    // target state is to be open, since that is the typical opener behavior, and it's impossible for us to know with reasonable certainty what the original intention of
    // the action was. A fully closed door with its beam broken has not moved, so it keeps targeting closed.
    if(this.obstructionHoldsOpen(state)) {

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

  /* Write the door's target and the automation switch from the door's state, the HomeKit values whose rules read the obstruction as well as the door. The door event
   * calls this on each change to the door, and the obstruction event on each change that moves whether an obstruction holds the door open, so each re-states them by
   * the same rules, and each call leaves the switch holding what its own read answers. We only update the target state if our current state is NOT stopped. If we are
   * stopped, we are at the target state by definition. When the user resumes the door operation, it will complete the action. Put another way, when we enter a
   * stopped state, HomeKit essentially is pausing the action. When we tell the opener to open/close, it will continue the action it had begun before stopping. A
   * caller that also writes CurrentDoorState writes it after this, so the target always reaches HomeKit first.
   */
  private updateDoorTargetAndSwitch(): void {

    if(this.status.door !== this.hap.Characteristic.CurrentDoorState.STOPPED) {

      this.services[RatgdoService.GARAGE_DOOR]?.updateCharacteristic(this.hap.Characteristic.TargetDoorState, this.doorTargetStateBias(this.status.door));
    }

    this.services[RatgdoService.SWITCH_OPENER_AUTOMATION]?.updateCharacteristic(this.hap.Characteristic.On, this.isDoorOpen());
  }

  /* Utility function to move a switch's status field, its characteristic, and its MQTT topic together on a state change. Used by the switch-* event handlers in
   * updateState() to avoid repeating the same state-change, characteristic-update, and MQTT-publish pattern. The status field is written before the publish, since
   * the publish reads its payload from status.
   */
  private updateSwitchState(service: Service | undefined, field: "discoLaser" | "discoLed" | "konnectedStrobe", eventState: string, topicKey: StateTopic): void {

    const newState = eventState === "ON";

    if(this.status[field] !== newState) {

      this.status[field] = newState;
      service?.updateCharacteristic(this.hap.Characteristic.On, newState);

      this.publishTopic(topicKey);
    }
  }

  /* Utility function to move a vehicle sensor's status field, its log line, and its MQTT topic together on a state change. Used by the binary_sensor-vehicle_* event
   * handlers in updateState() to avoid repeating the same state-change, logging, and MQTT-publish pattern. The status field is written before the publish, since the
   * publish reads its payload from status.
   */
  private updateVehicleSensorState(field: "discoVehicleArriving" | "discoVehicleLeaving" | "discoVehiclePresence", eventState: string, logPrefix: string,
    topicKey: StateTopic): void {

    const newState = eventState === "ON";

    if(this.status[field] !== newState) {

      this.status[field] = newState;

      if(this.hints.logVehiclePresence) {

        this.log.info("%s %sdetected.", logPrefix, newState ? "" : "no longer ");
      }

      this.publishTopic(topicKey);
    }
  }

  /* HAP's own value for a contact sensor's state. A Disco vehicle sensor is triggered while a vehicle is arriving or leaving, which HomeKit shows as an open contact,
   * the state that raises its alert, so a triggered sensor is CONTACT_NOT_DETECTED and a clear one CONTACT_DETECTED. The characteristic is a uint8 whose constants
   * HAP defines, so it is written those constants rather than a boolean HAP would have to coerce.
   */
  private contactSensorState(triggered: boolean): CharacteristicValue {

    return triggered ? this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  // HAP's own value for an occupancy sensor's state, written as the uint8 constants HAP defines rather than a boolean HAP would have to coerce.
  private occupancyDetected(detected: boolean): CharacteristicValue {

    return detected ? this.hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED : this.hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  /* Single source of truth for an occupancy-indicator transition. From the RATGDO_OCCUPANCY descriptor for the given kind, it writes the status field, the HomeKit
   * OccupancyDetected characteristic, the gated log line, and the MQTT publish - every piece that must move together. The caller owns the transition gate (when to
   * raise or clear); this method owns the write so the pieces can never drift out of sync.
   */
  private setOccupancy(kind: OccupancyKind, detected: boolean): void {

    const descriptor = RATGDO_OCCUPANCY[kind];

    this.status[descriptor.field] = detected;
    this.services[descriptor.service]?.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, this.occupancyDetected(detected));

    // Every occupancy kind shares the motion log gate: there is no dedicated door-open logging hint, so the door-open indicator's log goes through the Motion event
    // category by design.
    if(this.hints.logMotion) {

      this.log.info("%s %sdetected.", descriptor.label, detected ? "" : "no longer ");
    }

    this.publishTopic(descriptor.topicKey);
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

  // Utility for checking feature options on a device. An option the catalog declares for another variant is off on this opener, whatever the configuration says.
  private hasFeature(option: string): boolean {

    return optionFitsVariant(option, this.device.variant) && this.platform.featureOptions.test(option, this.device.mac);
  }

  /* Per-accessory wrapper for HBPU's logFeature primitive, naming this opener and the plugin's logger so call sites stay terse and uniform with `hasFeature()`. HBPU
   * decides whether a setting earns a line, at which level, and writes it once. The variant check is the one thing this wrapper adds...an opener without the hardware
   * has nothing to report, and calling through would announce a global setting on an install where no opener has the feature.
   */
  private logFeature(option: string, label: string): void {

    if(!optionFitsVariant(option, this.device.variant)) {

      return;
    }

    this.platform.featureOptions.logFeature({ device: { id: this.device.mac, log: this.log }, label, log: this.platform.log, option });
  }

  /* Tell the user, once per accessory, what the naming options do for this opener. The custom-name line names the name the plugin applies, the custom name as HomeKit's
   * naming rule cleans it. A value HomeKit can carry nothing of is refused by HBPU's rule, and a refusal the user would otherwise never see is said once, here, with the
   * value as the user set it. Sync Name is reported as every other option departing from its default is.
   */
  private logNaming(): void {

    const customName = this.platform.featureOptions.value(RATGDO_NAME_OPTION, this.device.mac);

    if(this.hints.nameOverride !== null) {

      this.log.info("Custom HomeKit name set to %s.", this.name);
    } else if(customName?.length) {

      this.log.warn("The custom name \"%s\" leaves nothing HomeKit can display, so it is not applied.", customName);
    }

    this.logFeature("Device.SyncName", "ESPHome name sync");
  }

  // Compose the opener's displayed name, the one the name field stores: its custom Name where HomeKit can carry one, and its own name otherwise.
  private composeName(): string {

    return displayedName({ fallback: this.device.name, override: this.hints.nameOverride });
  }

  /* The name the plugin owns for this opener's accessory under HBPU's family naming rule, or null while the user owns it: the custom Name where HomeKit can carry one,
   * else the opener's own name while Sync Name is on. Every holder of an owned name reads it afresh, so a session that moves the opener's own name under Sync Name
   * reaches the next re-state and the next restore alike.
   */
  private get ownedHomeKitName(): Nullable<string> {

    return ownedName({ fallback: this.device.name, override: this.hints.nameOverride, sync: this.hints.syncName });
  }

  // The name the plugin owns for one part, the owned name followed by the part's suffix, or null while the user owns the opener's name.
  private ownedPartName(part: RatgdoService): Nullable<string> {

    const owned = this.ownedHomeKitName;

    return (owned === null) ? null : (owned + PART_SUFFIXES[part]);
  }

  // The name a part is created with: the opener's displayed name followed by the part's suffix. A service HomeKit has never seen carries no name of the user's to
  // leave alone, so a new part takes this whoever owns the opener's name.
  private partName(part: RatgdoService): string {

    return this.name + PART_SUFFIXES[part];
  }

  /* Re-state the accessory's own names, answering whether it wrote. HBPU's name helper holds the display names to the opener's displayed name whoever owns the
   * HomeKit name, so the cache never keeps a custom Name the user has cleared, and while the plugin owns the name it writes the information service's names as well.
   * Each name is compared before it is written, so an accessory already carrying its names writes nothing.
   */
  private restateAccessory(): boolean {

    return setAccessoryName(this.accessory, this.name, { owned: this.ownedHomeKitName !== null });
  }

  // Re-state the name the plugin owns for one part, answering whether it wrote, by the same rule the accessory's re-state follows.
  private restatePart(part: RatgdoService, service: Service): boolean {

    const owned = this.ownedPartName(part);

    return (owned !== null) && setServiceName(service, owned);
  }

  /* Hold a part this construction configured: record it under its key, and re-state the name the plugin owns for it. A part already carrying the owned name, a new
   * one among them, writes nothing, while a restored part takes the owned name over whatever it carried. With the user owning the name, a restored part keeps the
   * name it carries, a Home app rename included. The platform's save after construction carries any write.
   */
  private holdPart(part: RatgdoService, service: Service): void {

    this.services[part] = service;
    this.restatePart(part, service);
  }

  // Every part this construction configured, with its key. The services map is partial, and each entry it holds is a configured part.
  private parts(): [RatgdoService, Service][] {

    return Object.entries(this.services) as [RatgdoService, Service][];
  }

  /* Watch the opener's names while the plugin owns them, so a rename in the Home app is put back the moment it lands. The door service carries the name of the opener's
   * own tile, each other part carrying ConfiguredName carries its own, and the information service carries the accessory's, so each of them is watched, and each watch
   * reads the owned name afresh on every rename. A part HomeKit names with Name alone, the battery, gives the Home app nothing to rename, so it is named and never
   * watched. Nothing is watched while the user owns the name, since a rename of theirs stands. Every watch ends with the lifetime signal at disposal, and no service is
   * removed after construction, so nothing has to end one sooner.
   */
  private holdNames(): void {

    if(this.ownedHomeKitName === null) {

      return;
    }

    const info = this.accessory.getService(this.hap.Service.AccessoryInformation);
    const signal = this.lifetime.signal;

    // Watch one service, where it carries the ConfiguredName a rename in the Home app writes.
    const hold = (service: Service, name: () => Nullable<string>): void => {

      if(service.testCharacteristic(this.hap.Characteristic.ConfiguredName)) {

        watchServiceName({ log: this.log, name, service, signal });
      }
    };

    if(info) {

      hold(info, () => this.ownedHomeKitName);
    }

    for(const [ part, service ] of this.parts()) {

      hold(service, () => this.ownedPartName(part));
    }
  }
}
