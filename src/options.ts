/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.ts: Feature option and type definitions for Ratgdo.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptionScope, FeatureOptions } from "homebridge-plugin-utils";
import { RATGDO_MQTT_TOPIC, RATGDO_OCCUPANCY_DURATION } from "./settings.ts";
import { buildFixedScopeDescribers, mqttFeatureOptions } from "homebridge-plugin-utils";
import type { PlatformConfig } from "homebridge";
import { RatgdoVariant } from "./types.ts";

/* The configuration properties a user's config.json can carry directly, as normalizeConfig narrows them out of Homebridge's open index-signature shape. Every field is
 * a plainly narrowed type because a property either survives its typeof guard or it is absent - there is no third answer at this boundary. The platform resolves these
 * against the feature-option catalog and runs on the resolved shape below.
 */
export type RatgdoOptions = Partial<{

  debug: boolean;
  mqttTopic: string;
  mqttUrl: string;
  options: string[];
}>;

/* The platform's effective configuration, assembled once by the constructor from each setting's configured feature option and its configuration property. This
 * describes what the plugin actually runs on rather than mirroring the shape of config.json, which is why it is a separate type from the property shape above rather
 * than a widening of it: the two have different value ranges. The debug flag is a plain boolean here because its resolution always reaches an answer - a configured
 * option, a configuration property, or the catalog's own declared default - where the narrowed property it starts from may be absent. The options array is the raw
 * entry list the feature-option engine was built from, carried alongside so a reader of this shape can see what every resolution ran against.
 */
export interface RatgdoResolvedConfig {

  debug: boolean;
  options: string[] | undefined;
}

/* The scope levels this plugin's own catalog admits. The framework's vocabulary carries a third level, "controller", for plugins whose devices sit beneath a hub the
 * user configures in its own right; a Ratgdo opener is reached directly, so there is nothing between the global level and the device itself. Extracting the two levels
 * this plugin uses from the framework's union rather than restating them keeps one vocabulary at work, so a level the framework renames or retires stops compiling
 * here rather than drifting quietly.
 */
export type RatgdoFeatureOptionScope = Extract<FeatureOptionScope, "device" | "global">;

/* A feature option entry as this plugin's own catalog declares one. The framework leaves scopes optional on its entry type, because a catalog also carries entries a
 * library contributes and those answer to the library; every entry this plugin authors must say where it may be configured, so we close that hole for our own. An
 * intersection with the base type does not work here - TypeScript resolves an intersected mutable-plus-readonly property as writable - so we Omit the base declaration
 * and redeclare it both required and readonly. The tuple is non-empty by construction, since an option declaring no level at all would render nowhere and resolve
 * nowhere.
 */
export interface RatgdoFeatureOption extends Omit<FeatureOptionEntry<RatgdoOptionMeta>, "scopes"> {

  readonly scopes: readonly [ RatgdoFeatureOptionScope, ...RatgdoFeatureOptionScope[] ];
}

/* The globally-scoped boolean option names, bound by convention to this catalog's own Log.Debug entry. The flag resolver narrows against this union, so asking it for
 * a value-bearing option, or for one no global lookup admits, is a type error rather than a lookup that quietly answers nothing.
 */
export type RatgdoGlobalFlagOption = "Log.Debug";

/* Normalize a Homebridge PlatformConfig into a typed RatgdoOptions. Homebridge passes plugin config through an open index-signature shape sourced from user JSON, so
 * without this boundary narrowing every consumer has to reach in with bracket notation - and downstream code would silently accept whatever shape the user supplied.
 * We perform the typeof-narrowing reads once here so the rest of the codebase consumes a typed result that actually reflects runtime guarantees, not just assertions.
 *
 * An absent or hand-edited debug property stays undefined rather than collapsing to false, because the resolver downstream has to tell "the user asked for it off"
 * apart from "the user said nothing at all" - only the second lets the catalog's own declared default decide.
 */
export function normalizeConfig(config: PlatformConfig | undefined): RatgdoOptions {

  if(!config) {

    return {};
  }

  // PlatformConfig has an index signature typed as `any`, which would silently propagate `any` through the rest of the function. We re-read each field as `unknown`
  // so the typeof / Array.isArray guards below are forced to do real narrowing rather than rubber-stamping a type assertion.
  const debug: unknown = config["debug"];
  const mqttTopic: unknown = config["mqttTopic"];
  const mqttUrl: unknown = config["mqttUrl"];
  const options: unknown = config["options"];

  return {

    debug: (typeof debug === "boolean") ? debug : undefined,
    mqttTopic: (typeof mqttTopic === "string") ? mqttTopic : undefined,
    mqttUrl: (typeof mqttUrl === "string") ? mqttUrl : undefined,
    options: (Array.isArray(options) && options.every((entry): entry is string => typeof entry === "string")) ? options : undefined
  };
}

/* Resolve one consolidated boolean setting to its effective state. An explicitly configured feature option rules, enabled or disabled alike, because configuring an
 * option is the user saying what they want. A configuration property, where one carries an actual boolean, otherwise outranks the catalog default, so a configuration
 * nobody has opened the webUI on keeps running correctly; that fallback arm is transitional and sunsets at the plugin's next major version, at which point the option
 * is the only home a setting has. The catalog's own declared default closes the chain, which is what lets a flag whose default is on resolve honestly without a line
 * changing here.
 *
 * The engine arrives as a parameter rather than being reached for, which keeps this a pure function of its inputs and lets it be driven against a real engine built
 * over any catalog. Debug is the one setting the plugin resolves for itself: the broker URL and the topic prefix are the library's to resolve, through
 * mqttConnectionSettings over this same catalog.
 */
export const consolidatedFlag = (featureOptions: FeatureOptions, option: RatgdoGlobalFlagOption, legacy: boolean | undefined): boolean => {

  return featureOptions.exists(option) ? featureOptions.test(option) : legacy ?? featureOptions.defaultValue(option);
};

/* The library's canonical MQTT option group, composed once at module scope and read by both the category list and the catalog below, so the two always describe the
 * same group. The factory's default scope is global, which is the only level that fits a single broker connection the whole plugin shares, and this registration is
 * the runtime's only consumer of the default topic constant, so the prefix a user never overrides is answered by the catalog itself.
 */
const mqtt = mqttFeatureOptions<RatgdoOptionMeta>({ defaultTopic: RATGDO_MQTT_TOPIC });

/* The plugin's own annotation on a catalog entry, carried through the opaque meta channel the library's category and option types thread along untouched. An entry that
 * names a variant is shown only to devices of that variant, and an entry that names none is shown to every device. Which hardware has which feature is therefore stated
 * once, here in the catalog, and the settings page decides what a device's page offers by reading this declaration rather than by matching category or option names of
 * its own.
 */
export interface RatgdoOptionMeta {

  readonly variant: RatgdoVariant;
}

// Feature option categories, in the order the webUI and the generated reference present them: the concerns every install has, then the device-specific tail.
export const featureOptionCategories: FeatureCategoryEntry<RatgdoOptionMeta>[] = [

  { description: "Device", name: "Device" },
  { description: "Logging", name: "Log" },
  { description: "Opener", name: "Opener" },
  { description: "Opener light", name: "Light" },
  { description: "Opener motion", meta: { variant: RatgdoVariant.RATGDO }, name: "Motion" },
  mqtt.category,
  { description: "Ratgdo (ESP32) Disco device-specific", meta: { variant: RatgdoVariant.RATGDO }, name: "Disco" },
  { description: "Konnected device-specific", meta: { variant: RatgdoVariant.KONNECTED }, name: "Konnected" }
];

/* eslint-disable @stylistic/max-len */
/* Individual feature options, broken out by category. Every entry declares the scope levels it may be configured at, which the webUI reads to decide where an option
 * renders and the documentation generator restates in prose: a device-facing option belongs at the global level and on an individual device alike, while a
 * platform-wide fact - the broker connection, the debug stream - has exactly one home.
 */

// Device options.
const deviceOptions: RatgdoFeatureOption[] = [

  { default: true, description: "Make this device available in HomeKit.", name: "", scopes: [ "device", "global" ] },
  { default: false, defaultValue: "", description: "Name to use for logging purposes. Defaults to the name the Ratgdo device advertises.", inputSize: 15, name: "LogName", scopes: [ "device", "global" ] },
  { default: false, defaultValue: "", description: "Base64-encoded encryption key to use for the ESPHome API as specified in your YAML configuration.", inputSize: 44, name: "Encryption.Key", scopes: [ "device", "global" ] }
];

// Ratgdo ESP32 Disco options.
const discoOptions: RatgdoFeatureOption[] = [

  { default: false, description: "Show the state of the backup battery in HomeKit. This requires ensuring the Ratgdo (ESP32) Disco is connected directly to the backup battery.", name: "Battery", scopes: [ "device", "global" ] },
  { default: false, description: "Add an occupancy sensor accessory for vehicle presence detection.", name: "OccupancySensor.Vehicle.Presence", scopes: [ "device", "global" ] },
  { default: false, description: "Add a contact sensor accessory for vehicle arrival.", name: "ContactSensor.Vehicle.Arriving", scopes: [ "device", "global" ] },
  { default: false, description: "Add a contact sensor accessory for vehicle departure.", name: "ContactSensor.Vehicle.Leaving", scopes: [ "device", "global" ] },
  { default: false, description: "Add a switch accessory to control the park assistance laser feature.", name: "Switch.Laser", scopes: [ "device", "global" ] },
  { default: false, description: "Add a switch accessory to control the LED setting.", name: "Switch.Led", scopes: [ "device", "global" ] }
];

// Konnected options.
const konnectedOptions: RatgdoFeatureOption[] = [

  { default: false, description: "Add a switch accessory to control the pre-close warning feature on Konnected openers. This can be useful in automation scenarios.", name: "Switch.Pcw", scopes: [ "device", "global" ] },
  { default: false, description: "Add a switch accessory to control the strobe setting on Konnected openers.", name: "Switch.Strobe", scopes: [ "device", "global" ] }
];

// Light options.
const lightOptions: RatgdoFeatureOption[] = [

  { default: true, description: "Make the light on the opener available in HomeKit.", name: "", scopes: [ "device", "global" ] }
];

// Logging options. The debug switch leads the list: it is the support knob, reached for far more often than the per-event log toggles beneath it.
const logOptions: RatgdoFeatureOption[] = [

  { default: false, description: "Enable debug logging.", name: "Debug", scopes: ["global"] },
  { default: true, description: "Log opener events in Homebridge.", name: "Opener", scopes: [ "device", "global" ] },
  { default: true, description: "Log light events in Homebridge.", name: "Light", scopes: [ "device", "global" ] },
  { default: true, description: "Log motion-related events in Homebridge.", name: "Motion", scopes: [ "device", "global" ] },
  { default: true, description: "Log obstruction events in Homebridge.", name: "Obstruction", scopes: [ "device", "global" ] },
  { default: true, description: "Log vehicle presence-related events in Homebridge. This is only valid on Ratgdo (ESP32) Disco openers.", meta: { variant: RatgdoVariant.RATGDO }, name: "VehiclePresence", scopes: [ "device", "global" ] }
];

// Motion options.
const motionOptions: RatgdoFeatureOption[] = [

  { default: true, description: "Make the motion sensor on the opener available in HomeKit.", name: "", scopes: [ "device", "global" ] },
  { default: false, description: "Add an occupancy sensor accessory using motion sensor activity to determine occupancy.", name: "OccupancySensor", scopes: [ "device", "global" ] },
  { default: true, defaultValue: RATGDO_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait without receiving a motion event to determine when occupancy is no longer detected.", group: "OccupancySensor", name: "OccupancySensor.Duration", scopes: [ "device", "global" ] }
];

// Opener options.
const openerOptions: RatgdoFeatureOption[] = [

  { default: true, description: "Make the wireless remote lock on the opener available in HomeKit.", name: "Lock", scopes: [ "device", "global" ] },
  { default: false, description: "Add a switch accessory to control the wireless remote lockout feature (if present) on your opener. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling the lock state of garage door openers.", group: "Lock", name: "Switch.RemoteLockout", scopes: [ "device", "global" ] },
  { default: false, description: "Make this opener read-only by ignoring open and close requests from HomeKit.", name: "ReadOnly", scopes: [ "device", "global" ] },
  { default: false, description: "Add a dimmer accessory to control the opener. This can be useful in automation scenarios where you want to set the door to a specific percentage.", name: "Dimmer", scopes: [ "device", "global" ] },
  { default: false, description: "Add a switch accessory to control the opener. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling garage door openers.", name: "Switch", scopes: [ "device", "global" ] },
  { default: false, description: "Add an occupancy sensor accessory using the open state of the opener to determine occupancy. This can be useful in automation scenarios where you want to trigger an action based on the opener being open for an extended period of time.", name: "OccupancySensor", scopes: [ "device", "global" ] },
  { default: true, defaultValue: RATGDO_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait once the opener has reached the open state before indicating occupancy.", group: "OccupancySensor", name: "OccupancySensor.Duration", scopes: [ "device", "global" ] }
];
/* eslint-enable @stylistic/max-len */

/* The full catalog, composed from the categories this plugin authors and the group the library contributes, in the order the webUI renders them and the generated
 * reference documents them. Two types are at work here on purpose, and neither needs a cast. The authored arrays are typed as this plugin's own entry, which is what
 * makes a missing, empty, or controller-level scopes declaration a compile error at the site where the entry is written. The exported record speaks the framework's
 * wider entry vocabulary, and that is what lets a group the library composes drop straight in beside the authored ones.
 */
export const featureOptions: Record<string, FeatureOptionEntry<RatgdoOptionMeta>[]> = {

  "Device": deviceOptions,
  "Disco": discoOptions,
  "Konnected": konnectedOptions,
  "Light": lightOptions,
  "Log": logOptions,
  "Motion": motionOptions,

  // The library's MQTT group, contributed whole rather than restated here, so the plugin and the library cannot disagree about the entries, their defaults, or
  // their scope.
  [mqtt.category.name]: mqtt.options,

  "Opener": openerOptions
};

/* Documentation hooks: the scope prose the generated feature-option reference renders. Every entry in this catalog declares one of exactly two shapes - a device-facing
 * option configurable at both levels, and a platform-wide fact configurable globally alone - which is the pair the library's fixed sentences are written for, so the
 * sentences themselves belong to the library and the choice of that pair is all this module states. The category hook comes back with it and contributes nothing: the
 * per-option suffixes carry the whole story, and a category-level sentence would either repeat them or contradict a category holding options at differing levels.
 */
export const { describeCategoryScope, describeOptionScope } = buildFixedScopeDescribers();
