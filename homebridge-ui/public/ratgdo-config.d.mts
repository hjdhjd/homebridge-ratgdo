/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-config.d.mts: Type declarations for the pure Ratgdo platform-configuration interpreter.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptions } from "homebridge-plugin-utils";

/**
 * The primary platform-configuration entry, as it actually arrives from the Homebridge UI. Every consolidated setting is declared as an unknown-valued optional
 * property because that is the honest shape of an object read back from a user's `config.json`: a setting may be absent, may carry a hand-edited value of any type,
 * and may have been staged to `undefined` by this module's own patch. Interpreting exactly that is what the module is for.
 */
export interface RatgdoLegacyConfig {

  debug?: unknown;
  mqttTopic?: unknown;
  mqttUrl?: unknown;
  options?: unknown;
}

/**
 * The option catalog the plugin's UI server publishes, as the interpreter consumes it.
 */
export interface RatgdoConfigCatalog {

  categories: FeatureCategoryEntry[];
  options: Record<string, FeatureOptionEntry[]>;
}

/**
 * The commit-shaped patch the interpreter produces. A consumed legacy property rides here as a PRESENT key whose value is `undefined`, never as an omitted key: the
 * session's shallow-merge commit treats those two shapes oppositely, deleting the first and leaving the second untouched, and the type system cannot state that
 * difference. Assertions about this patch must therefore read own-property presence with `Object.hasOwn`, never compare against `undefined`. What actually holds the
 * guarantee is migrate()'s single unconditional staging line and the test discipline that reads it.
 */
export interface RatgdoConfigPatch {

  debug?: undefined;
  mqttTopic?: undefined;
  mqttUrl?: undefined;
  options?: string[];
}

/**
 * The interpreter over a fetched catalog. The migration is all of it: nothing in this plugin's browser code reads a configuration property, so there is no effective
 * value for this module to answer and no degraded-mode twin to fall back to.
 */
export interface RatgdoConfigInterpreter {

  migrate(config?: RatgdoLegacyConfig): RatgdoConfigPatch | null;
}

/**
 * Build the interpreter over an injected feature-option engine class and the served option catalog.
 *
 * @param injected.FeatureOptions - The feature-option engine class.
 * @param injected.catalog        - The served catalog.
 *
 * @returns The interpreter.
 */
export declare const makeRatgdoConfig: ({ FeatureOptions, catalog }: { FeatureOptions: typeof FeatureOptions; catalog: RatgdoConfigCatalog }) =>
  RatgdoConfigInterpreter;
