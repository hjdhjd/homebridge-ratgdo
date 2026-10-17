/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-config.d.mts: Type declarations for the pure Ratgdo platform-configuration interpreter.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptions, formatValueList, scopeSafeId } from "homebridge-plugin-utils";

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
 * The commit-shaped patch the interpreter produces. A consumed legacy property is carried here as a PRESENT key whose value is `undefined`, never as an omitted key:
 * the session's shallow-merge commit treats those two shapes oppositely, deleting the first and leaving the second untouched, and the type system cannot state that
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
 * The manual device the Add Device card asks the interpreter to compose a write for: the address the user typed, and the key they typed beside it.
 */
export interface RatgdoManualDevice {

  address: string;
  key?: string;
}

/**
 * The patch that adds a device by address. It carries only the options array, because both halves of a manual device - the listed address and the key stored at that
 * address's identity - live in it; no configuration property is involved either way.
 */
export interface RatgdoManualDevicePatch {

  options: string[];
}

/**
 * The interpreter over a fetched catalog: the legacy-settings migration, plus the reads and writes behind the page's Add Device card.
 */
export interface RatgdoConfigInterpreter {

  manualAddresses(config?: RatgdoLegacyConfig): readonly string[];
  migrate(config?: RatgdoLegacyConfig): RatgdoConfigPatch | null;
  withManualDevice(config: RatgdoLegacyConfig | undefined, device: RatgdoManualDevice): RatgdoManualDevicePatch | null;
}

/**
 * Reduce one address a user typed to its canonical form: trimmed, lower-cased, and with one enclosing pair of square brackets removed. This is the page's half of a
 * rule the plugin's runtime states in `src/manual.ts`. The two halves are held together by a shared vector table in the test suite rather than by an import, because
 * this module is import-free so that it can run in a browser.
 *
 * @param address - The address as the user wrote it.
 *
 * @returns The canonical spelling of that address.
 */
export declare const canonicalManualAddress: (address: unknown) => string;

/**
 * Whether a canonical address carries an IPv6 zone identifier, which is the one shape this plugin refuses to dial: a zone names the interface a link-local address
 * was heard on, and means nothing without that link.
 *
 * @param address - A canonical address.
 *
 * @returns true when the address cannot be dialed because it names a zone.
 */
export declare const isZonedAddress: (address: string) => boolean;

/**
 * Build the interpreter over an injected feature-option engine class, the served option catalog, and the two engine helpers the manual-device composition needs.
 *
 * @param injected.FeatureOptions  - The feature-option engine class.
 * @param injected.catalog         - The served catalog.
 * @param injected.formatValueList - The engine's own list formatter.
 * @param injected.scopeSafeId     - The engine's own identifier rule.
 *
 * @returns The interpreter.
 */
export declare const makeRatgdoConfig: ({ FeatureOptions, catalog, formatValueList, scopeSafeId }: { FeatureOptions: typeof FeatureOptions;
  catalog: RatgdoConfigCatalog; formatValueList: typeof formatValueList; scopeSafeId: typeof scopeSafeId; }) => RatgdoConfigInterpreter;
