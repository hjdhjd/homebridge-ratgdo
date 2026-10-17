/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: Cross-cutting test helpers shared across every unit test in homebridge-ratgdo.
 *
 * The plugin's production code reads and writes through Homebridge's HAP shapes (Service, Characteristic, Accessory) on every per-accessory configure path, and it
 * drives the device over the esphome-client API. We never want a unit test to drag in a live HAP runtime or a real ESPHome connection, so this file owns the
 * following families of doubles:
 *
 *   - A hand-built HAP test-double (the Service / Characteristic marker namespaces, TestService, TestCharacteristic, TestAccessory) that mirrors only the surface the
 *     plugin actually touches. homebridge-plugin-utils' REAL acquireService / validService run unmodified against these doubles, so a REAL RatgdoAccessory is
 *     constructed end to end with no live HAP - the construction-boundary casts are confined to buildRatgdoAccessory.
 *   - A platform double (makeTestPlatform) carrying a REAL FeatureOptions engine (so userOptions thread through the production feature-option logic), a capturing log,
 *     an optional recording MQTT double, and a fake esphome-client.
 *   - A fake esphome-client (TestEspHomeClient) that records command dispatch and lets a test drive lifecycle / telemetry / log subscriptions, plus typed telemetry
 *     factories that build the initial-state snapshot the accessory is born from.
 *
 * The HAP surface is intentionally tight: the Service / Characteristic namespaces expand as production reaches for new kinds. Co-located under src/ so the broad
 * tsconfig.json type-checks this file alongside everything else; tsconfig.build.json excludes the *.helpers.ts pattern so it never reaches the published dist/.
 */
// The explicit-resource-management bridge, first here as it is first in the plugin's entry point: this file is the suite's composition root, so every test that
// constructs a feed or an accessory reads against globals that are guaranteed to exist.
import "homebridge-plugin-utils/polyfills";
import type { Clock, HomebridgePluginLogging, MdnsService, Nullable } from "homebridge-plugin-utils";
import { ConnectionError, CoverOperation, EncryptionKeyMissingError, EncryptionRequiredError, EspHomeError, LockState, entityId } from "esphome-client";
import type { DeviceInfo, EntityId, EspHomeClient, LifecycleEvent, LogEventData, NoiseServerHello, PskResolver, TelemetryEvent } from "esphome-client";
import { TestClock, TestMqttClient, capturingLog, makeService, makeTxtStrings } from "homebridge-plugin-utils/testing";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { FeatureOptions } from "homebridge-plugin-utils";
import type { OpenEspHomeClient } from "./connection.ts";
import { RATGDO_MDNS_SERVICE_TYPE } from "./settings.ts";
import { RatgdoAccessory } from "./device.ts";
import type { RatgdoDevice } from "./types.ts";
import type { RatgdoResolvedConfig } from "./options.ts";
import type { RatgdoTxtKey } from "./discovery.ts";
import { RatgdoVariant } from "./types.ts";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";

// Identity classes for the HAP Characteristic kinds the plugin touches. Each kind is its own marker class carrying a hapKind property (so failures surface the kind in
// inspect output) and, where production compares against named constants, the HAP integer constants as statics. Production passes the class itself as a key into
// getCharacteristic / updateCharacteristic.
class BrightnessCharacteristicType {

  public readonly hapKind = "Brightness" as const;
}

class ChargingStateCharacteristicType {

  public static readonly CHARGING = 1;
  public static readonly NOT_CHARGEABLE = 2;
  public static readonly NOT_CHARGING = 0;
  public readonly hapKind = "ChargingState" as const;
}

class ContactSensorStateCharacteristicType {

  public static readonly CONTACT_DETECTED = 0;
  public static readonly CONTACT_NOT_DETECTED = 1;
  public readonly hapKind = "ContactSensorState" as const;
}

class CurrentDoorStateCharacteristicType {

  public static readonly CLOSED = 1;
  public static readonly CLOSING = 3;
  public static readonly OPEN = 0;
  public static readonly OPENING = 2;
  public static readonly STOPPED = 4;
  public readonly hapKind = "CurrentDoorState" as const;
}

class FirmwareRevisionCharacteristicType {

  public readonly hapKind = "FirmwareRevision" as const;
}

class LockCurrentStateCharacteristicType {

  public static readonly JAMMED = 2;
  public static readonly SECURED = 1;
  public static readonly UNKNOWN = 3;
  public static readonly UNSECURED = 0;
  public readonly hapKind = "LockCurrentState" as const;
}

class LockTargetStateCharacteristicType {

  public static readonly SECURED = 1;
  public static readonly UNSECURED = 0;
  public readonly hapKind = "LockTargetState" as const;
}

class ManufacturerCharacteristicType {

  public readonly hapKind = "Manufacturer" as const;
}

class ModelCharacteristicType {

  public readonly hapKind = "Model" as const;
}

class MotionDetectedCharacteristicType {

  public readonly hapKind = "MotionDetected" as const;
}

class NameCharacteristicType {

  public readonly hapKind = "Name" as const;
}

class ObstructionDetectedCharacteristicType {

  public readonly hapKind = "ObstructionDetected" as const;
}

class OccupancyDetectedCharacteristicType {

  public static readonly OCCUPANCY_DETECTED = 1;
  public static readonly OCCUPANCY_NOT_DETECTED = 0;
  public readonly hapKind = "OccupancyDetected" as const;
}

class OnCharacteristicType {

  public readonly hapKind = "On" as const;
}

class SerialNumberCharacteristicType {

  public readonly hapKind = "SerialNumber" as const;
}

class StatusActiveCharacteristicType {

  public readonly hapKind = "StatusActive" as const;
}

class TargetDoorStateCharacteristicType {

  public static readonly CLOSED = 1;
  public static readonly OPEN = 0;
  public readonly hapKind = "TargetDoorState" as const;
}

// The HAP Characteristic namespace as the test-double exposes it. Alphabetical per the house property-order style. Add a kind here when production reaches for one.
export const Characteristic = {

  Brightness: BrightnessCharacteristicType,
  ChargingState: ChargingStateCharacteristicType,
  ContactSensorState: ContactSensorStateCharacteristicType,
  CurrentDoorState: CurrentDoorStateCharacteristicType,
  FirmwareRevision: FirmwareRevisionCharacteristicType,
  LockCurrentState: LockCurrentStateCharacteristicType,
  LockTargetState: LockTargetStateCharacteristicType,
  Manufacturer: ManufacturerCharacteristicType,
  Model: ModelCharacteristicType,
  MotionDetected: MotionDetectedCharacteristicType,
  Name: NameCharacteristicType,
  ObstructionDetected: ObstructionDetectedCharacteristicType,
  OccupancyDetected: OccupancyDetectedCharacteristicType,
  On: OnCharacteristicType,
  SerialNumber: SerialNumberCharacteristicType,
  StatusActive: StatusActiveCharacteristicType,
  TargetDoorState: TargetDoorStateCharacteristicType
} as const;

// The constructor-as-key shapes both namespaces expose. The argument list is intentionally permissive: the characteristic markers take no arguments, the service
// markers take HAP's (displayName?, subtype?) pair, and the alias must admit either when used as a Map key.
export type CharacteristicType = abstract new (...args: never[]) => object;
export type ServiceType = abstract new (...args: never[]) => object;

// One characteristic backing instance, owned by a TestService. Holds the last value written plus the optional onGet / onSet handlers production installs. triggerGet /
// triggerSet are the test-side knobs that exercise the bound handlers without a real HAP request path.
export class TestCharacteristic {

  public readonly type: CharacteristicType;
  private currentValue: unknown = null;
  private getHandler: (() => unknown) | undefined = undefined;
  private setHandler: ((value: unknown) => Promise<void> | void) | undefined = undefined;

  public constructor(type: CharacteristicType) {

    this.type = type;
  }

  // The most recently written value. Production reads this after updateCharacteristic to confirm its own write landed.
  public get value(): unknown {

    return this.currentValue;
  }

  // Write a value into the characteristic. Returns this so it chains in the production-typical service.updateCharacteristic pattern.
  public updateValue(value: unknown): this {

    this.currentValue = value;

    return this;
  }

  // Install the production read handler. Tests inspect what was bound via triggerGet.
  public onGet(handler: () => unknown): this {

    this.getHandler = handler;

    return this;
  }

  // Install the production write handler. Tests drive it via triggerSet; the production handler runs as if HomeKit invoked it.
  public onSet(handler: (value: unknown) => Promise<void> | void): this {

    this.setHandler = handler;

    return this;
  }

  // Test-side trigger for the installed onGet handler. Falls through to the last-written value when no handler is bound, matching HAP's read-from-cache semantics.
  public async triggerGet(): Promise<unknown> {

    if(!this.getHandler) {

      return this.currentValue;
    }

    return this.getHandler();
  }

  // Test-side trigger for the installed onSet handler. After the handler resolves, the supplied value becomes the cached value, mirroring HAP's set-then-cache behavior.
  public async triggerSet(value: unknown): Promise<void> {

    if(this.setHandler) {

      await this.setHandler(value);
    }

    this.currentValue = value;
  }
}

/* One service instance attached to a TestAccessory. Holds a Map of characteristic-kind -> TestCharacteristic so getCharacteristic returns the same instance across calls
 * (production binds onGet once and expects the binding to persist). This shape is dictated in several places by homebridge-plugin-utils' REAL service helpers, which run
 * unmodified against the double: characteristics is a PUBLIC ARRAY view (acquireService's getCharacteristicConstructor destructures the first element to recover the
 * Characteristic constructor, and throws when none exists - which is why the constructible service markers seed one characteristic), and displayName is MUTABLE
 * (setServiceName assigns it on every acquire). UUID mirrors the marker's static and is never empty, keeping the real helpers' name-set predicates honestly false against
 * markers that carry no name statics.
 */
export class TestService {

  public displayName: string;
  public isPrimary = false;
  public readonly subtype: string | undefined;
  public readonly type: ServiceType;
  private readonly characteristicsByType = new Map<CharacteristicType, TestCharacteristic>();

  public constructor(type: ServiceType, displayName: string, subtype: string | undefined) {

    this.displayName = displayName;
    this.subtype = subtype;
    this.type = type;
  }

  // The service kind's identity string, mirrored from the type's static. Real HAP identifies kinds by UUID; the double uses the kind string, which is unique within the
  // namespace and legible in failures. The fallback is a non-empty sentinel for a hand-rolled type outside the namespace, so the returned UUID is never empty.
  public get UUID(): string {

    return (this.type as { UUID?: string }).UUID ?? "unidentified-service-kind";
  }

  // The public array view of the materialized characteristics, mirroring HAP's Service.characteristics. Insertion order, so a marker's seed characteristic is always
  // first - exactly what the real getCharacteristicConstructor destructures.
  public get characteristics(): TestCharacteristic[] {

    return [...this.characteristicsByType.values()];
  }

  // Record whether production designated this the accessory's primary service, mirroring HAP's Service.setPrimaryService.
  public setPrimaryService(isPrimary = true): void {

    this.isPrimary = isPrimary;
  }

  // Fetch or lazily create the characteristic of the given kind. Lazy creation matches HAP, which instantiates required characteristics on first access.
  public getCharacteristic(charType: CharacteristicType): TestCharacteristic {

    let char = this.characteristicsByType.get(charType);

    if(!char) {

      char = new TestCharacteristic(charType);
      this.characteristicsByType.set(charType, char);
    }

    return char;
  }

  // Write a value to the characteristic of the given kind. Returns this so chained production updates compile.
  public updateCharacteristic(charType: CharacteristicType, value: unknown): this {

    this.getCharacteristic(charType).updateValue(value);

    return this;
  }

  // Mirror HAP's Service.setCharacteristic, which routes to setValue and FIRES the bound onSet handler. Fire-and-forget like HAP; a rejection is swallowed because HAP
  // does not surface a set-handler's failure to the setCharacteristic caller.
  public setCharacteristic(charType: CharacteristicType, value: unknown): this {

    // HAP does not surface the set-handler's rejection to the caller.
    void this.getCharacteristic(charType).triggerSet(value).catch((): void => { /* Intentional no-op. */ });

    return this;
  }

  // Declare an optional characteristic, mirroring HAP's Service.addOptionalCharacteristic. HAP lazily materializes a permitted characteristic on first access, so the
  // double materializes it now through getCharacteristic, keeping a later getCharacteristic / onGet bind against the SAME instance.
  public addOptionalCharacteristic(charType: CharacteristicType): void {

    this.getCharacteristic(charType);
  }

  // Report whether the characteristic of the given kind has already been created, mirroring HAP's Service.testCharacteristic. Unlike getCharacteristic, this never
  // lazily creates - it is a pure predicate over what has already been added.
  public testCharacteristic(charType: CharacteristicType): boolean {

    return this.characteristicsByType.has(charType);
  }

  // Remove a characteristic instance, mirroring HAP's Service.removeCharacteristic. The double keys one instance per kind, so removal by the instance's kind is exact.
  public removeCharacteristic(characteristic: TestCharacteristic): void {

    this.characteristicsByType.delete(characteristic.type);
  }
}

// The service marker classes. Each is a CONSTRUCTIBLE subclass of TestService carrying HAP's (displayName?, subtype?) constructor, because the real acquireService
// instantiates the namespace entry directly on its create branch and recovers the Characteristic constructor from the new service's first characteristic. Every marker
// therefore seeds exactly one characteristic at construction: the kind's primary required characteristic.
class AccessoryInformationServiceType extends TestService {

  public static readonly UUID = "AccessoryInformation";
  public readonly hapKind = "AccessoryInformation" as const;

  public constructor(displayName = "", subtype?: string) {

    super(AccessoryInformationServiceType, displayName, subtype);

    this.getCharacteristic(NameCharacteristicType);
  }
}

class BatteryServiceType extends TestService {

  public static readonly UUID = "Battery";
  public readonly hapKind = "Battery" as const;

  public constructor(displayName = "", subtype?: string) {

    super(BatteryServiceType, displayName, subtype);

    this.getCharacteristic(ChargingStateCharacteristicType);
  }
}

class ContactSensorServiceType extends TestService {

  public static readonly UUID = "ContactSensor";
  public readonly hapKind = "ContactSensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(ContactSensorServiceType, displayName, subtype);

    this.getCharacteristic(ContactSensorStateCharacteristicType);
  }
}

class GarageDoorOpenerServiceType extends TestService {

  public static readonly UUID = "GarageDoorOpener";
  public readonly hapKind = "GarageDoorOpener" as const;

  public constructor(displayName = "", subtype?: string) {

    super(GarageDoorOpenerServiceType, displayName, subtype);

    this.getCharacteristic(CurrentDoorStateCharacteristicType);
  }
}

class LightbulbServiceType extends TestService {

  public static readonly UUID = "Lightbulb";
  public readonly hapKind = "Lightbulb" as const;

  public constructor(displayName = "", subtype?: string) {

    super(LightbulbServiceType, displayName, subtype);

    this.getCharacteristic(OnCharacteristicType);
  }
}

class MotionSensorServiceType extends TestService {

  public static readonly UUID = "MotionSensor";
  public readonly hapKind = "MotionSensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(MotionSensorServiceType, displayName, subtype);

    this.getCharacteristic(MotionDetectedCharacteristicType);
  }
}

class OccupancySensorServiceType extends TestService {

  public static readonly UUID = "OccupancySensor";
  public readonly hapKind = "OccupancySensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(OccupancySensorServiceType, displayName, subtype);

    this.getCharacteristic(OccupancyDetectedCharacteristicType);
  }
}

class SwitchServiceType extends TestService {

  public static readonly UUID = "Switch";
  public readonly hapKind = "Switch" as const;

  public constructor(displayName = "", subtype?: string) {

    super(SwitchServiceType, displayName, subtype);

    this.getCharacteristic(OnCharacteristicType);
  }
}

// The HAP Service namespace as the test-double exposes it. Alphabetical per the house property-order style. Add a kind here when production touches one.
export const Service = {

  AccessoryInformation: AccessoryInformationServiceType,
  Battery: BatteryServiceType,
  ContactSensor: ContactSensorServiceType,
  GarageDoorOpener: GarageDoorOpenerServiceType,
  Lightbulb: LightbulbServiceType,
  MotionSensor: MotionSensorServiceType,
  OccupancySensor: OccupancySensorServiceType,
  Switch: SwitchServiceType
} as const;

/* One accessory. Carries an AccessoryInformation service from construction (every HomeKit accessory has one); subsequent addService calls append more. addService
 * and getService mirror HAP's own rule and HAP's own lookup: HAP refuses a service of a type the accessory already carries unless the new one has a subtype no
 * service of that type shares, and HAP's getService matches by type alone, whatever the subtype. The double carries both because the suite must see what the runtime
 * would do - a configure order that adds a service HAP refuses throws here as it throws in the field, and a lookup that leans on getService skipping a subtyped
 * sibling fails here as it would there. getServiceById is the lookup that matches type and subtype together. The mutable context and displayName are the fields the
 * production accessory path reads; the _associatedHAPAccessory mirror is retained for HAP-shape parity.
 */
export class TestAccessory {

  public context: Record<string, unknown> = {};
  public displayName: string;
  public readonly UUID: string;
  public readonly _associatedHAPAccessory: { displayName: string };
  public readonly services: TestService[] = [];

  public constructor(displayName: string, uuid: string) {

    this.displayName = displayName;
    this.UUID = uuid;
    this._associatedHAPAccessory = { displayName };
    this.services.push(new TestService(Service.AccessoryInformation, displayName, undefined));
  }

  /* Add a new service in either form HAP's real addService accepts: a service INSTANCE (what acquireService passes after constructing a namespace marker), or the
   * legacy (type, name?, subtype?) form. The instanceof check is sound because a marker CLASS is never an instance of TestService - only constructed services
   * are. Returns the service so production can immediately bind characteristics on it.
   *
   * Before it appends, the double refuses as HAP's addService does, in HAP's own words: a service of a type the accessory already carries is admitted only when it
   * has a subtype and no service of that type shares it. The suite must see an add order that would throw at runtime, and a double that appended anything would
   * let such an order pass here and fail only in the field.
   */
  public addService(service: TestService): TestService;
  public addService(type: ServiceType, name?: string, subtype?: string): TestService;
  public addService(typeOrService: ServiceType | TestService, name?: string, subtype?: string): TestService {

    const service = (typeOrService instanceof TestService) ? typeOrService : new TestService(typeOrService, name ?? this.displayName, subtype);

    for(const existing of this.services) {

      if(existing.type !== service.type) {

        continue;
      }

      if(!service.subtype) {

        throw new Error("Cannot add a Service with the same UUID '" + existing.UUID +
          "' as another Service in this Accessory without also defining a unique 'subtype' property.");
      }

      if(service.subtype === existing.subtype) {

        throw new Error("Cannot add a Service with the same UUID '" + existing.UUID + "' and subtype '" + existing.subtype + "' as another Service in this Accessory.");
      }
    }

    this.services.push(service);

    return service;
  }

  // Find the first service of the given type, whatever its subtype. HAP's getService matches by type alone, so a test reading a service through this lookup gets
  // what production would: the first service of the type the accessory carries, which is a subtyped sibling when that sibling was added first.
  public getService(type: ServiceType): TestService | undefined {

    return this.services.find((service) => service.type === type);
  }

  // Find the service of the given type AND subtype. Production uses subtypes to disambiguate among multiple Switch services on one accessory.
  public getServiceById(type: ServiceType, subtype: string): TestService | undefined {

    return this.services.find((service) => (service.type === type) && (service.subtype === subtype));
  }

  // Remove a service instance, mirroring HAP's PlatformAccessory.removeService - the path the real validService takes when an existing service fails validation.
  public removeService(service: TestService): void {

    const index = this.services.indexOf(service);

    if(index !== -1) {

      this.services.splice(index, 1);
    }
  }
}

/**
 * Build a TestAccessory with a sensible default name and UUID. Pass overrides when a test needs a specific identity.
 *
 * @param displayName - the accessory's display name. Defaults to "Test Ratgdo".
 * @param uuid        - the accessory's UUID. Defaults to a stable all-zero value so tests get reproducible identity by default.
 *
 * @returns a fresh TestAccessory pre-populated with an AccessoryInformation service.
 */
export function makeTestAccessory(displayName = "Test Ratgdo", uuid = "00000000-0000-0000-0000-000000000000"): TestAccessory {

  return new TestAccessory(displayName, uuid);
}

// A recorded esphome-client command dispatch. id is the branded entity id the device resolved through its registry; payload is the command options object.
export interface RecordedCommand {

  id: string;
  payload: unknown;
}

/* Construction options for TestEspHomeClient. Each field seeds one of the configurable reads so a test tailors the device's view of the wire without a live connection.
 * `onListen` and `throwOnListen` seed the two registration behaviors a consumer's connect body has to survive: a client that emits the instant a listener attaches, and
 * one whose registration fails outright.
 */
export interface TestEspHomeClientOptions {

  capabilities?: { encryption: { active: boolean } };
  deviceInfo?: Nullable<DeviceInfo>;
  entities?: { objectId: string; type: string }[];
  isEncrypted?: boolean;
  onListen?: (event: string, client: TestEspHomeClient) => void;
  snapshot?: ReadonlyMap<EntityId, TelemetryEvent>;
  throwOnListen?: boolean;
}

/* A fake esphome-client covering the surface the plugin calls: command (recorded), deviceInfo / snapshot / entitiesByDevice / capabilities / isEncrypted
 * (configurable), disconnect / subscribeToLogs (recorded), and on (registers a handler and returns a Disposable that records its own disposal). emit lets a test drive
 * a lifecycle / telemetry / log event through the registered handlers. Construction options seed the configurable reads so a test tailors the device's view of the wire
 * without a live connection.
 *
 * Disposal emits a disconnect through the handler map on every call, which is a deliberate modeling choice: a TestEspHomeClient stands for a client the open factory
 * already returned, and such a client always has a transport for its teardown to tear down. The real client emits only where a transport or a receiver existed, so a
 * never-connected client disposed straight away would emit nothing...the double does not model that arm, because no consumer disposes a client it never opened.
 */
export class TestEspHomeClient implements Disposable {

  public readonly commands: RecordedCommand[] = [];
  // Each listener Disposable pushes its own event name here when it runs, so a test can prove every listener a connect registered was released, and released once.
  public readonly listenerDisposals: string[] = [];
  public readonly logSubscriptions: number[] = [];
  public disconnected = false;
  // A counter rather than a boolean, because one counter answers both "was it disposed" and "how many times", where a boolean beside a counter would be two statements
  // of one fact and a double-dispose would read the same as a single one.
  public disposeCount = 0;
  private readonly capabilitiesValue: { encryption: { active: boolean } };
  private readonly deviceInfoValue: Nullable<DeviceInfo>;
  private readonly entities: { objectId: string; type: string }[];
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>();
  private readonly isEncryptedValue: boolean;
  private readonly onListen: ((event: string, client: TestEspHomeClient) => void) | undefined;
  // The latest-state cache is a MUTABLE Map copied from the seed snapshot, because captureInitialState reads snapshot() ONCE and its telemetry handler re-checks
  // completeness against THAT Map reference: deliverState must add the entity to this map before notifying, mirroring the ESPHome client's mutate-then-notify ordering.
  // Copying (rather than aliasing options.snapshot) keeps a caller's passed-in map immune to our mutations.
  private readonly stateCache: Map<EntityId, TelemetryEvent>;
  private readonly throwOnListen: boolean;

  public constructor(options: TestEspHomeClientOptions = {}) {

    this.capabilitiesValue = options.capabilities ?? { encryption: { active: false } };
    this.deviceInfoValue = options.deviceInfo ?? null;
    this.entities = options.entities ?? [];
    this.isEncryptedValue = options.isEncrypted ?? false;
    this.onListen = options.onListen;
    this.stateCache = new Map(options.snapshot ?? []);
    this.throwOnListen = options.throwOnListen ?? false;
  }

  // Record a command dispatch. The device resolves the branded id through its entity registry before calling, so the recorded id is the resolved wire id.
  public command(id: string, payload: unknown): void {

    this.commands.push({ id, payload });
  }

  // Return the configured device info, mirroring the ESPHome client's deviceInfo().
  public deviceInfo(): Nullable<DeviceInfo> {

    return this.deviceInfoValue;
  }

  // Return the configured latest-state snapshot, mirroring the ESPHome client's snapshot().
  public snapshot(): ReadonlyMap<EntityId, TelemetryEvent> {

    return this.stateCache;
  }

  /* Commit a state event to the cache and THEN notify telemetry listeners, mirroring the ESPHome client's mutate-then-notify ordering. captureInitialState's slow path
   * relies on this ordering: its telemetry handler re-reads completeness from the snapshot Map, so the entity must be present in the cache before the handler fires.
   * Tests drive the slow path by calling deliverState per entity until the required set completes.
   */
  public deliverState(event: TelemetryEvent): void {

    this.stateCache.set(entityId(event.type, event.entity), event);
    this.emit("telemetry", event);
  }

  // Return the configured discovered-entity list for device 0, mirroring the ESPHome client's entitiesByDevice(0).
  public entitiesByDevice(): { objectId: string; type: string }[] {

    return this.entities;
  }

  // Return the configured capability set, mirroring the ESPHome client's capabilities().
  public capabilities(): { encryption: { active: boolean } } {

    return this.capabilitiesValue;
  }

  // Mirror the real client's isEncrypted getter, so a snapshot's encryption state can be driven from a fixture.
  public get isEncrypted(): boolean {

    return this.isEncryptedValue;
  }

  // Record a manual disconnect.
  public disconnect(): void {

    this.disconnected = true;
  }

  /* Count the disposal and emit a disconnect, mirroring the ESPHome client's `[Symbol.dispose]`. openConnection's catch calls `client?.[Symbol.dispose]()` on every
   * failure branch, so a connection test reads `disposeCount` to confirm the partially-constructed client was torn down. The emit is synchronous and runs through the
   * handler map, so a teardown-ordering test can prove a consumer detached its listeners before the client went down: a listener still registered here hears the
   * disconnect, and one already released does not.
   */
  public [Symbol.dispose](): void {

    this.disposeCount++;
    this.emit("lifecycle", { cause: undefined, kind: "disconnect" });
  }

  // Record a per-connection log subscription request.
  public subscribeToLogs(level: number): void {

    this.logSubscriptions.push(level);
  }

  /* Register an event handler and return a Disposable that detaches it, mirroring the EventBus on() contract the platform composes onto the connection record. A
   * `throwOnListen` client refuses before anything is recorded, so a consumer's totality catch runs against a client that registered nothing; an `onListen` client
   * fires the hook synchronously once the handler is in the map, which is the window where a real client can deliver an event to a listener that has only just
   * attached. The returned Disposable records its own event name before detaching, so `listenerDisposals` reads as the release log.
   */
  public on(event: string, handler: (event: never) => void): Disposable {

    if(this.throwOnListen) {

      throw new Error("listener registration failed");
    }

    const list = this.handlers.get(event) ?? [];

    list.push(handler as (event: unknown) => void);
    this.handlers.set(event, list);
    this.onListen?.(event, this);

    return { [Symbol.dispose]: (): void => {

      this.listenerDisposals.push(event);
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((entry) => entry !== handler));
    } };
  }

  // Drive every handler registered for an event. Tests use this to deliver a lifecycle / telemetry / log event through the same path production wired.
  public emit(event: "lifecycle", data: LifecycleEvent): void;
  public emit(event: "telemetry", data: TelemetryEvent): void;
  public emit(event: "log", data: LogEventData): void;
  public emit(event: string, data: unknown): void {

    for(const handler of this.handlers.get(event) ?? []) {

      handler(data);
    }
  }
}

// Cast a TestEspHomeClient at the boundary to the EspHomeClient type captureInitialState and openConnection consume directly. The cast lives here in the harness so
// connection-test bodies that call captureInitialState directly carry no `as unknown` casts of their own; the double implements every method those functions reach.
export function asEspHomeClient(client: TestEspHomeClient): EspHomeClient {

  return client as unknown as EspHomeClient;
}

/* One recorded factory invocation, narrowed to the open-options fields a connection test asserts on: the static clientId, the host, the key resolver the connection
 * core hands the client (or null for a connection opened plaintext-first), and the logger and cancellation signal it forwards. Recording these is what lets a test
 * prove openConnection forwarded the right values across the injected boundary (the headline of the client-factory port), rather than merely that the call returned a
 * result. The logger and the signal are required rather than optional because openConnection forwards its own log argument and the caller's shutdown signal
 * unconditionally, so a recorded invocation always carries both and optionality would misstate the contract.
 */
export interface RecordedOpenOptions {

  clientId?: Nullable<string>;
  host: string;
  logger: HomebridgePluginLogging;
  psk?: Nullable<string> | PskResolver;
  signal: AbortSignal;
}

/* A per-call open handler: it answers each invocation on its own terms, receiving the options that invocation carried and its zero-based call index. This is what a
 * caller reaches for when the outcome has to differ between calls - a first connect that defers while a second resolves, a per-host answer, a failure only the retry
 * recovers from.
 */
export type OpenClientHandler = (options: RecordedOpenOptions, index: number) => Promise<TestEspHomeClient>;

/* Build a fake `openEspHomeClient` factory for openConnection and status-feed tests. Pass a TestEspHomeClient to model a successful open (the factory resolves it), an
 * Error to model a failed open (the factory rejects with it - an EncryptionKeyInvalidError, a PermanentError subclass, etc.), or a handler to answer each call on its
 * own terms. The fixed forms are wrapped into a handler at construction, so there is exactly one recording path and one `calls` array however the factory was built.
 * The returned function matches openEspHomeClient's port type through the one construction-boundary cast a test needs, so the test body itself stays cast-free, and the
 * `calls` array records the options each invocation received so a test can assert what openConnection forwarded across the boundary (every recorded field, the logger
 * adapter included).
 */
export function makeFakeOpenClient(result: Error | OpenClientHandler | TestEspHomeClient): OpenEspHomeClient & { calls: RecordedOpenOptions[] } {

  const calls: RecordedOpenOptions[] = [];

  // Normalize the fixed forms into the handler shape up front, so the recording below has one path to take rather than branching per invocation on what it was built
  // from. A function result is already a handler; an Error rejects on every call; a client resolves on every call.
  const handler: OpenClientHandler = (typeof result === "function") ? result : async (): Promise<TestEspHomeClient> => {

    if(result instanceof Error) {

      throw result;
    }

    return result;
  };
  const open = (options: RecordedOpenOptions): Promise<TestEspHomeClient> => {

    const index = calls.length;

    calls.push(options);

    return handler(options, index);
  };

  return Object.assign(open, { calls }) as unknown as OpenEspHomeClient & { calls: RecordedOpenOptions[] };
}

/* The key resolver a recorded factory invocation carried, for a test that plays the device's side of the handshake by hand - a first contact's hello, or a reconnect's
 * after the connection was admitted. It throws when the invocation carried none, so a test reading a resolver that was never handed over fails at the read rather than
 * at a confusing call of null.
 *
 * @param call - The recorded invocation, typically `openClient.calls[n]`.
 *
 * @returns The resolver that invocation carried.
 */
export function resolverOf(call: RecordedOpenOptions | undefined): PskResolver {

  const psk = call?.psk;

  if(typeof psk !== "function") {

    throw new Error("The recorded open carried no key resolver.");
  }

  return psk;
}

/* A per-call open handler that answers as an encrypting device does, for the parts of esphome-client's handshake a consumer can observe. It hands the invocation's
 * resolver the given server hello, exactly as the client does after reading one, and then settles the way the client settles on what the resolver did: an exception
 * the resolver throws rejects as thrown when it is an EspHomeError, and otherwise as a ConnectionError (`CONNECT_FAILED`) carrying it as `cause`; a resolver answering
 * no key fails with EncryptionKeyMissingError; an invocation carrying no resolver at all fails with EncryptionRequiredError, which is how an encrypted device answers a
 * plaintext client; and a resolver answering a key resolves the client. It never checks the key itself - a test asserts on what the resolver answered, and a
 * mismatched key is the fixed-error form's to model.
 *
 * @param options.client - The client the open resolves when the resolver answers a key.
 * @param options.hello  - The server hello the device announces.
 *
 * @returns The handler, for makeFakeOpenClient.
 */
export function openThroughHello({ client, hello }: { client: TestEspHomeClient; hello: NoiseServerHello }): OpenClientHandler {

  return async (options: RecordedOpenOptions): Promise<TestEspHomeClient> => {

    const { psk } = options;

    if(typeof psk !== "function") {

      throw new EncryptionRequiredError("The device requires encryption, and no key resolver was offered.");
    }

    let key: Nullable<string>;

    try {

      key = psk(hello);
    } catch(error) {

      if(error instanceof EspHomeError) {

        throw error;
      }

      throw new ConnectionError("The key resolver threw.", "CONNECT_FAILED", { cause: error });
    }

    if(!key) {

      throw new EncryptionKeyMissingError("The key resolver answered no key for this device.");
    }

    return client;
  };
}

/* Build a single telemetry event in the wire-faithful shape the esphome-client snapshot carries, mirroring esphome-client's own test factory: a { entity, key, type,
 * ...fields } literal cast to TelemetryEvent at this construction boundary. The cast is the same one esphome-client's own latest-state-cache tests use - the wire shape
 * is a schema-derived union with all-optional value fields, so the boundary cast is the blessed way to synthesize one.
 */
export function makeTelemetry(type: string, objectId: string, fields: Record<string, unknown> = {}): TelemetryEvent {

  return { entity: objectId, key: 0, type, ...fields } as unknown as TelemetryEvent;
}

// A cover telemetry event. position is the 0-1 float ESPHome reports; currentOperation is the CoverOperation the device translates into a HomeKit door state.
export function makeCoverEvent(objectId: string, position: number, currentOperation: CoverOperation = CoverOperation.IDLE): TelemetryEvent {

  return makeTelemetry("cover", objectId, { currentOperation, position });
}

// A lock telemetry event carrying a LockState.
export function makeLockEvent(objectId: string, state: LockState = LockState.UNLOCKED): TelemetryEvent {

  return makeTelemetry("lock", objectId, { state });
}

// A light telemetry event carrying the boolean on-state.
export function makeLightEvent(objectId: string, on: boolean): TelemetryEvent {

  return makeTelemetry("light", objectId, { state: on });
}

// A switch telemetry event carrying the boolean on-state.
export function makeSwitchEvent(objectId: string, on: boolean): TelemetryEvent {

  return makeTelemetry("switch", objectId, { state: on });
}

// A binary_sensor telemetry event carrying the boolean detected-state.
export function makeBinarySensorEvent(objectId: string, on: boolean): TelemetryEvent {

  return makeTelemetry("binary_sensor", objectId, { state: on });
}

/* Build the initial-state snapshot the accessory is born from. The device keys its reads by entityId(type, objectId), so we key each event the same way. The default
 * sets cover the Ratgdo variant's required entities at sensible resting values (door closed, light off, lock unlocked, obstruction clear, laser / led / vehicle off);
 * pass overrides to replace individual entries. The Konnected variant uses different object ids, so a Konnected test supplies its own entries.
 */
export function makeRatgdoInitialState(overrides: TelemetryEvent[] = []): Map<EntityId, TelemetryEvent> {

  const base = [

    makeCoverEvent("door", 0),
    makeBinarySensorEvent("obstruction", false),
    makeLightEvent("light", false),
    makeLockEvent("lock_remotes", LockState.UNLOCKED),
    makeSwitchEvent("laser", false),
    makeSwitchEvent("led", false),
    makeBinarySensorEvent("vehicle_detected", false)
  ];

  const state = new Map<EntityId, TelemetryEvent>();

  for(const event of [ ...base, ...overrides ]) {

    state.set(entityId(event.type, event.entity), event);
  }

  return state;
}

// Build a Konnected-variant initial-state snapshot. Konnected exposes different object ids (garage_door / garage_light / lock / str_output) than Ratgdo, so its
// resting snapshot is built separately.
export function makeKonnectedInitialState(overrides: TelemetryEvent[] = []): Map<EntityId, TelemetryEvent> {

  const base = [

    makeCoverEvent("garage_door", 0),
    makeBinarySensorEvent("obstruction", false),
    makeLightEvent("garage_light", false),
    makeLockEvent("lock", LockState.UNLOCKED),
    makeSwitchEvent("str_output", false)
  ];

  const state = new Map<EntityId, TelemetryEvent>();

  for(const event of [ ...base, ...overrides ]) {

    state.set(entityId(event.type, event.entity), event);
  }

  return state;
}

/**
 * Build a RatgdoDevice descriptor with sensible defaults. Pass overrides for the fields a test varies (variant, mac, model, name).
 *
 * @param overrides - partial RatgdoDevice fields to override the defaults.
 *
 * @returns a fully-populated RatgdoDevice.
 */
export function makeTestDevice(overrides: Partial<RatgdoDevice> = {}): RatgdoDevice {

  return {

    address: "192.0.2.10",
    firmwareVersion: "2.0.0",
    mac: "AABBCCDDEEFF",
    model: "1.0.0",
    name: "Test Ratgdo",
    variant: RatgdoVariant.RATGDO,
    ...overrides
  };
}

/** Build the resolved mDNS service a browser derives for a Ratgdo advertisement, composed from the library's own fixture so what a test advertises and what the
 * classify reads cannot disagree. Each TXT field becomes one record string through the library's `makeTxtStrings`, the inverse of the `txtEntries` read the
 * classify performs.
 *
 * The instance name is the TXT `mac` when one is present and the fixed "ratgdo" otherwise - one rule, so two devices advertising two MACs get two instance names,
 * which matters because the library keys its snapshot by instance name and a test advertising two devices must not collide them. The friendly name never names
 * the instance.
 *
 * @param txt       - The TXT fields to advertise, keyed by the ESPHome wire names the classify reads.
 * @param addresses - The advertised IP addresses, in the order the browser would list them. Defaults to a single TEST-NET-1 address.
 *
 * @returns the resolved service parseRatgdoService consumes.
 */
export function makeRatgdoService(txt: Partial<Record<RatgdoTxtKey, Nullable<string>>>, addresses: readonly [string, ...string[]] = ["192.0.2.10"]): MdnsService {

  const label = txt.mac ?? "ratgdo";

  return makeService({ addresses, host: "ratgdo-" + label, instance: label, port: 6053, serviceType: RATGDO_MDNS_SERVICE_TYPE, strings: makeTxtStrings(txt) });
}

// The platform double's read surface, as the accessory and its configure chain consume it. The construction-boundary cast to RatgdoPlatform happens
// in buildRatgdoAccessory.
export interface TestPlatform {

  api: { hap: TestHap };
  // The time source every timer the accessory arms reads, standing in for the production platform's own clock. Typed as the production Clock because that is the whole
  // of what the accessory consumes; the handles that drive it are typed TestClock where a test holds them.
  clock: Clock;
  // The double's config is the platform's RESOLVED shape, not the raw configuration properties, so a test can never seed a legacy property the accessory would never
  // have seen: the platform resolves those into this shape before any accessory is built.
  config: RatgdoResolvedConfig;
  featureOptions: FeatureOptions;
  getEspHomeClient: (mac: string) => TestEspHomeClient | undefined;
  hap: TestHap;
  log: HomebridgePluginLogging;
  mqtt: Nullable<TestMqttClient>;
  resolveLogName: (mac: string) => string | undefined;
}

// The HAP namespace shape the platform double exposes: the Service / Characteristic test namespaces plus a deterministic uuid generator.
interface TestHap {

  Characteristic: typeof Characteristic;
  Service: typeof Service;
  uuid: { generate: (data: string) => string };
}

/* Options for makeTestPlatform: the fake client to back getEspHomeClient, the clock the platform double publishes, the platform config, whether to attach a recording
 * MQTT double, and the feature-option strings. The clock is typed TestClock rather than Clock because the option exists to hand a caller a handle it can advance and
 * inspect, which a production Clock offers none of; a caller that omits it gets a fresh one it reads back off the result.
 */
export interface MakeTestPlatformOptions {

  client?: TestEspHomeClient;
  clientUnavailable?: boolean;
  clock?: TestClock;
  config?: TestPlatform["config"];
  mqtt?: boolean;
  userOptions?: string[];
}

// The handles makeTestPlatform returns: the platform double plus the doubles and capture buffer a test asserts against.
export interface MakeTestPlatformResult {

  client: TestEspHomeClient;
  clock: TestClock;
  entries: readonly TestLogEntry[];
  mqtt: Nullable<TestMqttClient>;
  platform: TestPlatform;
}

/* Build a platform double around a REAL FeatureOptions engine seeded with the supplied userOptions, so the production feature-option logic (test / value / getInteger /
 * logFeature) runs unchanged. A capturing log records every line; an optional recording MQTT double captures subscriptions and publishes; a fake esphome-client backs
 * getEspHomeClient. resolveLogName mirrors the production platform method exactly (empty string collapses to undefined). A TestClock stands in for the production
 * platform's time source, so every deadline an accessory built on this double arms is driven by advancing that clock. The returned handles let a test assert on the
 * captured logs, the recorded commands, and the MQTT traffic, and drive the clock.
 */
export function makeTestPlatform(options: MakeTestPlatformOptions = {}): MakeTestPlatformResult {

  const log = capturingLog();
  const client = options.client ?? new TestEspHomeClient();
  const clock = options.clock ?? new TestClock();
  // The double reports through the same capturing log the platform double carries, so the guarded publish's failure line lands in `entries` exactly as production
  // would log it and a test can read it there rather than reaching into the double.
  const mqtt = options.mqtt ? new TestMqttClient({ log }) : null;
  const fo = new FeatureOptions(featureOptionCategories, featureOptions, options.userOptions);
  const hap: TestHap = { Characteristic, Service, uuid: { generate: (data: string): string => data } };
  const platform: TestPlatform = {

    api: { hap },
    clock,
    config: options.config ?? { debug: false, options: undefined },
    featureOptions: fo,
    getEspHomeClient: (): TestEspHomeClient | undefined => (options.clientUnavailable ? undefined : client),
    hap,
    log,
    mqtt,
    resolveLogName: (mac: string): string | undefined => {

      const raw = fo.value("Device.LogName", mac);

      return raw?.length ? raw : undefined;
    }
  };

  return { client, clock, entries: log.entries, mqtt, platform };
}

/* Options for buildRatgdoAccessory: the accessory to construct against, device fields to override, initial-state snapshot, the clock the accessory's timers arm on,
 * platform config, client availability, MQTT double, and feature-option strings. The accessory member is how a test describes an install Homebridge restored from
 * its cache - a TestAccessory the test has pre-seeded with the services a previous run wired on - so the configure chain runs against an accessory that already
 * carries them; left unset, the harness builds a fresh accessory, which is the first-run case every other test wants. The clock carries makeTestPlatform's typing
 * and its omit-for-a-fresh-one behavior.
 */
export interface BuildRatgdoAccessoryOptions {

  accessory?: TestAccessory;
  clientUnavailable?: boolean;
  clock?: TestClock;
  config?: TestPlatform["config"];
  device?: Partial<RatgdoDevice>;
  initialState?: Map<EntityId, TelemetryEvent>;
  mqtt?: boolean;
  userOptions?: string[];
}

// The handles buildRatgdoAccessory returns: the constructed production accessory plus the underlying doubles and capture buffer a test asserts against.
export interface BuildRatgdoAccessoryResult {

  accessory: TestAccessory;
  client: TestEspHomeClient;
  clock: TestClock;
  entries: readonly TestLogEntry[];
  mqtt: Nullable<TestMqttClient>;
  platform: TestPlatform;
  ratgdo: RatgdoAccessory;
}

/* Construct a REAL RatgdoAccessory against the doubles - the device-test workhorse, analogous to HBPU's per-suite construction helpers. The construction-boundary casts
 * (platform, accessory) are the only casts a device test needs; everything the accessory then does runs the real production code against the doubles. Returns the
 * constructed accessory plus every handle a test asserts on: the underlying TestAccessory (to read services / characteristics), the captured log entries, the fake
 * client (to read recorded commands), the clock the accessory's timers arm on (to reach a deadline without waiting), and the recording MQTT double (when enabled).
 */
export function buildRatgdoAccessory(options: BuildRatgdoAccessoryOptions = {}): BuildRatgdoAccessoryResult {

  const device = makeTestDevice(options.device);
  const { client, clock, entries, mqtt, platform } = makeTestPlatform({ clientUnavailable: options.clientUnavailable, clock: options.clock, config: options.config,
    mqtt: options.mqtt, userOptions: options.userOptions });
  const accessory = options.accessory ?? makeTestAccessory(device.name, platform.hap.uuid.generate(device.mac));
  const initialState = options.initialState ?? ((device.variant === RatgdoVariant.KONNECTED) ? makeKonnectedInitialState() : makeRatgdoInitialState());

  // The construction-boundary casts (platform, accessory) bridge the doubles to the production constructor's parameter types - the only casts a device test needs.
  const ratgdo = new RatgdoAccessory(platform as unknown as ConstructorParameters<typeof RatgdoAccessory>[0],
    accessory as unknown as ConstructorParameters<typeof RatgdoAccessory>[1], device, initialState);

  return { accessory, client, clock, entries, mqtt, platform, ratgdo };
}
