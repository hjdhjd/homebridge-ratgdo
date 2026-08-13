/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.ts: Feature option and type definitions for Ratgdo.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptions, Nullable } from "homebridge-plugin-utils";
import { RATGDO_MQTT_TOPIC, RATGDO_OCCUPANCY_DURATION } from "./settings.ts";
import type { PlatformConfig } from "homebridge";
import { mqttFeatureOptions } from "homebridge-plugin-utils";

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
 * than a widening of it: the two have different value ranges. A narrowed property is a string or nothing, while a resolved option routinely answers null - the
 * feature-option engine's word for "explicitly off" - and the MQTT client factory reads both absences as MQTT being off.
 */
export interface RatgdoResolvedConfig {

  debug: boolean;
  mqttTopic: Nullable<string> | undefined;
  mqttUrl: Nullable<string> | undefined;
  options: string[] | undefined;
}

/* The globally-scoped value-centric option names the platform resolves once at startup. The value resolver narrows against this union, so asking it for an option that
 * carries no global value is a type error rather than a lookup that quietly answers nothing. Both members name entries the library's MQTT factory publishes, and they
 * are bound to those entries by convention exactly as the flag union below is bound to this catalog's own Log.Debug entry.
 */
export type RatgdoGlobalValueOption = "Mqtt.Topic" | "Mqtt.Url";

/* The globally-scoped boolean option names, the flag counterpart of the union above and bound to the catalog the same way. The flag resolver narrows against it, so
 * asking it for a value-bearing option, or for one no global lookup admits, is a type error.
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

/* Resolve one consolidated setting to its effective value. An explicitly configured feature option always rules - its enabled, disabled, and valueless states alike -
 * because configuring an option is the user saying what they want. A configuration property, where one is present, otherwise outranks the catalog default, so a
 * configuration nobody has opened the webUI on keeps running correctly. That fallback arm is transitional and sunsets at the plugin's next major version, at which
 * point the option is the only home a setting has.
 *
 * The engine arrives as a parameter rather than being reached for, which keeps this a pure function of its inputs and lets it be driven against a real engine built
 * over any catalog.
 */
export const consolidatedValue = (featureOptions: FeatureOptions, option: RatgdoGlobalValueOption, legacy: string | undefined): Nullable<string | undefined> => {

  return featureOptions.exists(option) ? featureOptions.value(option) : legacy ?? featureOptions.value(option);
};

/* Resolve one consolidated boolean setting to its effective state, the flag twin of the resolver above and the same rule in boolean terms. An explicitly configured
 * feature option rules, enabled or disabled alike. A configuration property, where one carries an actual boolean, otherwise decides. The catalog's own declared
 * default closes the chain, which is what lets a flag whose default is on resolve honestly without a line changing here.
 */
export const consolidatedFlag = (featureOptions: FeatureOptions, option: RatgdoGlobalFlagOption, legacy: boolean | undefined): boolean => {

  return featureOptions.exists(option) ? featureOptions.test(option) : legacy ?? featureOptions.defaultValue(option);
};

/* The library's canonical MQTT option group, composed once at module scope and read by both the category list and the catalog below, so the two always describe the
 * same group. The factory's default scope is global, which is the only level that fits a single broker connection the whole plugin shares, and this registration is
 * the runtime's only consumer of the default topic constant, so the prefix a user never overrides is answered by the catalog itself.
 */
const mqtt = mqttFeatureOptions({ defaultTopic: RATGDO_MQTT_TOPIC });

// Feature option categories, in the order the webUI and the generated reference present them: the concerns every install has, then the device-specific tail.
export const featureOptionCategories = [

  { description: "Device", name: "Device" },
  { description: "Logging", name: "Log" },
  { description: "Opener", name: "Opener" },
  { description: "Opener light", name: "Light" },
  { description: "Opener motion", name: "Motion" },
  mqtt.category,
  { description: "Ratgdo (ESP32) Disco device-specific", name: "Disco" },
  { description: "Konnected device-specific", name: "Konnected" }
];

/* eslint-disable @stylistic/max-len */
/* Individual feature options, broken out by category. Every entry declares the scope levels it may be configured at, which the webUI reads to decide where an option
 * renders and the documentation generator restates in prose: a device-facing option belongs at the global level and on an individual device alike, while a
 * platform-wide fact - the broker connection, the debug stream - has exactly one home.
 */
export const featureOptions: Record<string, FeatureOptionEntry[]> = {

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "", scopes: [ "device", "global" ] },
    { default: false, defaultValue: "", description: "Name to use for logging purposes. Defaults to the name the Ratgdo device advertises.", inputSize: 15, name: "LogName", scopes: [ "device", "global" ] },
    { default: false, defaultValue: "", description: "Base64-encoded encryption key to use for the ESPHome API as specified in your YAML configuration.", inputSize: 44, name: "Encryption.Key", scopes: [ "device", "global" ] }
  ],

  // Ratgdo ESP32 Disco options.
  "Disco": [

    { default: false, description: "Show the state of the backup battery in HomeKit. This requires ensuring the Ratgdo (ESP32) Disco is connected directly to the backup battery.", name: "Battery", scopes: [ "device", "global" ] },
    { default: false, description: "Add an occupancy sensor accessory for vehicle presence detection.", name: "OccupancySensor.Vehicle.Presence", scopes: [ "device", "global" ] },
    { default: false, description: "Add a contact sensor accessory for vehicle arrival.", name: "ContactSensor.Vehicle.Arriving", scopes: [ "device", "global" ] },
    { default: false, description: "Add a contact sensor accessory for vehicle departure.", name: "ContactSensor.Vehicle.Leaving", scopes: [ "device", "global" ] },
    { default: false, description: "Add a switch accessory to control the park assistance laser feature.", name: "Switch.Laser", scopes: [ "device", "global" ] },
    { default: false, description: "Add a switch accessory to control the LED setting.", name: "Switch.Led", scopes: [ "device", "global" ] }
  ],

  // Konnected options.
  "Konnected": [

    { default: false, description: "Add a switch accessory to control the pre-close warning feature on Konnected openers. This can be useful in automation scenarios.", name: "Switch.Pcw", scopes: [ "device", "global" ] },
    { default: false, description: "Add a switch accessory to control the strobe setting on Konnected openers.", name: "Switch.Strobe", scopes: [ "device", "global" ] }
  ],

  // Light options.
  "Light": [

    { default: true, description: "Make the light on the opener available in HomeKit.", name: "", scopes: [ "device", "global" ] }
  ],

  // Logging options. The debug switch leads the list: it is the support knob, reached for far more often than the per-event log toggles beneath it.
  "Log": [

    { default: false, description: "Enable debug logging.", name: "Debug", scopes: ["global"] },
    { default: true, description: "Log opener events in Homebridge.", name: "Opener", scopes: [ "device", "global" ] },
    { default: true, description: "Log light events in Homebridge.", name: "Light", scopes: [ "device", "global" ] },
    { default: true, description: "Log motion-related events in Homebridge.", name: "Motion", scopes: [ "device", "global" ] },
    { default: true, description: "Log obstruction events in Homebridge.", name: "Obstruction", scopes: [ "device", "global" ] },
    { default: true, description: "Log vehicle presence-related events in Homebridge. This is only valid on Ratgdo (ESP32) Disco openers.", name: "VehiclePresence", scopes: [ "device", "global" ] }
  ],

  // Motion options.
  "Motion": [

    { default: true, description: "Make the motion sensor on the opener available in HomeKit.", name: "", scopes: [ "device", "global" ] },
    { default: false, description: "Add an occupancy sensor accessory using motion sensor activity to determine occupancy.", name: "OccupancySensor", scopes: [ "device", "global" ] },
    { default: true, defaultValue: RATGDO_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait without receiving a motion event to determine when occupancy is no longer detected.", group: "OccupancySensor", name: "OccupancySensor.Duration", scopes: [ "device", "global" ] }
  ],

  // The library's MQTT group, contributed whole rather than restated here, so the plugin and the library cannot disagree about the entries, their defaults, or their scope.
  [mqtt.category.name]: mqtt.options,

  // Opener options.
  "Opener": [

    { default: true, description: "Make the wireless remote lock on the opener available in HomeKit.", name: "Lock", scopes: [ "device", "global" ] },
    { default: false, description: "Make this opener read-only by ignoring open and close requests from HomeKit.", name: "ReadOnly", scopes: [ "device", "global" ] },
    { default: false, description: "Add a dimmer accessory to control the opener. This can be useful in automation scenarios where you want to set the door to a specific percentage.", name: "Dimmer", scopes: [ "device", "global" ] },
    { default: false, description: "Add a switch accessory to control the opener. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling garage door openers.", name: "Switch", scopes: [ "device", "global" ] },
    { default: false, description: "Add an occupancy sensor accessory using the open state of the opener to determine occupancy. This can be useful in automation scenarios where you want to trigger an action based on the opener being open for an extended period of time.", name: "OccupancySensor", scopes: [ "device", "global" ] },
    { default: true, defaultValue: RATGDO_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait once the opener has reached the open state before indicating occupancy.", group: "OccupancySensor", name: "OccupancySensor.Duration", scopes: [ "device", "global" ] },
    { default: false, description: "Add a switch accessory to control the wireless remote lockout feature (if present) on your opener. This can be useful in automation scenarios where you want to work around HomeKit's security restrictions for controlling the lock state of garage door openers.", name: "Switch.RemoteLockout", scopes: [ "device", "global" ] }
  ]
};
/* eslint-enable @stylistic/max-len */

/* Documentation hook: the scope sentence appended to an option's description cell in the generated feature-option reference. The entry's own scopes declaration is the
 * single source and this is only its formatter, so an entry that changes level changes its prose with it. Ratgdo declares two shapes - a device-facing option at both
 * levels, and a platform-wide fact at the global level alone - and the presence of the device level is what tells them apart.
 *
 * The suffix carries its own leading separator because the renderer concatenates it straight onto the bolded-default text and passes hook-owned markup through
 * verbatim. The scopes guard is what the renderer's generic entry type requires, since that type keeps scopes optional; every entry in this catalog declares one.
 */
export function describeOptionScope(option: FeatureOptionEntry, _category: FeatureCategoryEntry): string | undefined {

  const scopes = option.scopes;

  if(!scopes) {

    return undefined;
  }

  return scopes.includes("device") ? "<BR>This option may be applied globally or on individual devices." : "<BR>This option may only be applied globally.";
}

/* Documentation hook: the scope sentence rendered beneath a category heading. Ratgdo has none to give - the per-option suffixes above carry the whole story, and a
 * category-level sentence would either repeat them or contradict a category holding options at differing levels. The hook is exported all the same so the catalog
 * states that choice outright rather than leaving the renderer to infer it from an absent export.
 */
export function describeCategoryScope(_category: FeatureCategoryEntry): string | undefined {

  return undefined;
}
