/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-config.ts: Pure interpreter over the injected Ratgdo platform configuration, which the settings page loads to migrate legacy settings, to compose the Add
 * Device card's writes, and to name the sidebar's devices. It lives in the folder the page and the plugin share because the address rule and the option names it reads
 * are defined there.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptions, createRetiredOptions, displayedName, formatValueList } from "homebridge-plugin-utils";
import { RATGDO_ADDRESS_OPTION, RATGDO_DEBUG_OPTION, RATGDO_ENCRYPTION_KEY_OPTION, RATGDO_NAME_OPTION } from "./settings.ts";
import { canonicalManualAddress, isZonedAddress } from "./manual-address.ts";
import { RATGDO_RETIRED_FAMILIES } from "./retired-options.ts";
import type { RatgdoOptions } from "../options.ts";

/* The single home for our plugin-config shape. Every function here is a pure interpreter of the primary platform-config entry the webUI framework injects into our
 * hooks - no I/O and no global reach - and the feature-option engine it reads through is handed in rather than imported, so the whole module is testable against the
 * real engine by handing that engine in. The framework owns reading and writing the persisted config through its session; this module owns the Ratgdo-specific
 * knowledge of where a setting lives.
 *
 * Two settings substrates meet here. A feature option is where a setting lives, and a handful of configuration properties are a second home the plugin honors so that
 * a configuration nobody has opened the webUI on keeps working. Reconciling the two is one of this module's jobs: the migration moves a property's value into its
 * option and marks the property for deletion. Nothing in this plugin's browser code reads a configuration property. The same migration carries options the plugin
 * has retired into the ones that took their place, through HBPU's retired options, so a configuration written in an earlier grammar is rewritten in the current one.
 *
 * Another job is composing the writes the page's own affordances make. A manual device is the one setting a user adds from a card rather than from the options
 * editor, and it lands in TWO places at once - the address on a list option, and its key at the device's MAC, which the card learned by testing the address - so the
 * composition belongs here beside the rest of this plugin's knowledge of where a setting lives, rather than in the page that happens to draw the card.
 *
 * And the page names each sidebar device as the plugin names its accessory, a custom Name applied where HomeKit can carry it, which is a reading of where the custom
 * Name lives and so belongs here too.
 */

// The configuration properties a legacy setting can still arrive on: every property the plugin's own configuration shape declares except the options array itself.
type LegacyProperty = Exclude<keyof RatgdoOptions, "options">;

/**
 * The primary platform-configuration entry, as it actually arrives from the Homebridge UI. Every configuration property the plugin declares is an unknown-valued
 * optional property here because that is the honest shape of an object read back from a user's `config.json`: a setting may be absent, may carry a hand-edited value of
 * any type, and may have been staged to `undefined` by this module's own patch. Interpreting exactly that is what the module is for.
 */
export type RatgdoLegacyConfig = Partial<Record<keyof RatgdoOptions, unknown>>;

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
 * The manual device the Add Device card asks the interpreter to compose a write for: the address the user typed, the key they typed beside it, and the MAC the card's
 * test learned, in the plugin's identity form, which is where the key is stored.
 */
export interface RatgdoManualDevice {

  address: string;
  key?: string;
  mac: string;
}

/**
 * The patch that adds a device by address. It carries only the options array, because both halves of a manual device - the listed address and the key stored at the
 * device's MAC - live in it; no configuration property is involved either way.
 */
export interface RatgdoManualDevicePatch {

  options: string[];
}

/**
 * One sidebar device as the page's device list carries it: the name its cached accessory carries, and its MAC in the plugin's identity form, the scope the framework
 * addresses its options at.
 */
export interface RatgdoDeviceRow {

  name: string;
  serialNumber?: string;
}

/**
 * The interpreter over a fetched catalog: the legacy-settings migration, the reads and writes behind the page's Add Device card, and the namer the sidebar's device
 * links are named through.
 */
export interface RatgdoConfigInterpreter {

  deviceNamer(config?: RatgdoLegacyConfig): (row: RatgdoDeviceRow) => string;
  globalKey(config?: RatgdoLegacyConfig): string | undefined;
  manualAddresses(config?: RatgdoLegacyConfig): readonly string[];
  migrate(config?: RatgdoLegacyConfig): RatgdoConfigPatch | null;
  withManualDevice(config: RatgdoLegacyConfig | undefined, device: RatgdoManualDevice): RatgdoManualDevicePatch | null;
}

/* What the page hands the interpreter: the feature-option engine class, the served catalog, HBPU's retired-options factory, HBPU's display-name rule, and the engine's
 * list formatter. Named apart from the factory's parameter list because the factory binds the engine, the retired-options factory, the rule, and the formatter under
 * the same names their types are read from.
 *
 * @property FeatureOptions       - The feature-option engine class.
 * @property catalog              - The served catalog, carrying its categories and its options record.
 * @property createRetiredOptions - HBPU's retired-options factory, which translates a retired option family into the option that supersedes it.
 * @property displayedName        - HBPU's display-name rule, which answers the custom name where one resolves and the fallback otherwise, as HomeKit carries it.
 * @property formatValueList      - The engine's own list formatter.
 */
interface RatgdoConfigInjected {

  FeatureOptions: typeof FeatureOptions;
  catalog: RatgdoConfigCatalog;
  createRetiredOptions: typeof createRetiredOptions;
  displayedName: typeof displayedName;
  formatValueList: typeof formatValueList;
}

/* Every consolidated setting, as the configuration property that carries it paired with the feature option that supersedes it. This pairing is this module's policy
 * knowledge and the one address book the factory below reads, so the migration's writes can never disagree with themselves about where a setting lives.
 *
 * The record is typed over the plugin's own configuration properties, so a property the plugin adds fails to compile here until it is paired with its option. The debug
 * option's name is the shared constant the platform resolves the setting by. The broker and topic options belong to homebridge-plugin-utils' MQTT group, which exports
 * no constant for either name, so the migration test suite's round trip through the real catalog is what holds those: a name that drifts here composes an entry the
 * runtime never reads, and the round trip fails on the resolved values rather than on the string.
 */
const CONSOLIDATED_SETTINGS: Readonly<Record<LegacyProperty, string>> = {

  debug: RATGDO_DEBUG_OPTION,
  mqttTopic: "Mqtt.Topic",
  mqttUrl: "Mqtt.Url"
};

/**
 * Build the interpreter over an injected feature-option engine class, the option catalog the plugin's own UI server publishes, HBPU's retired-options factory, HBPU's
 * display-name rule, and the engine's list formatter the composition needs. Each is handed in because a module in this folder imports values only from the folder
 * itself, and handing them in is also what keeps this module testable under node against the real engine, the real catalog, the real retired options, and the real
 * rule, rather than against a stand-in that could drift from any of them.
 *
 * @param injected.FeatureOptions       - The feature-option engine class.
 * @param injected.catalog              - The served catalog, carrying its categories and its options record.
 * @param injected.createRetiredOptions - HBPU's retired-options factory, built once here over the catalog and the plugin's retired families.
 * @param injected.displayedName        - HBPU's display-name rule, the one the plugin names an opener's accessory by.
 * @param injected.formatValueList      - The engine's own list formatter, so a list this module writes reads back exactly as the editor's own writes do.
 *
 * @returns The interpreter: the legacy-settings migration, the manual-device reads and writes, and the device-row namer.
 */
export const makeRatgdoConfig = ({ FeatureOptions, catalog, createRetiredOptions, displayedName, formatValueList }: RatgdoConfigInjected): RatgdoConfigInterpreter => {

  // The retired option families over the served catalog, built once for the interpreter's life, so each retired family reads as the list that superseded it.
  const retired = createRetiredOptions({ categories: catalog.categories, families: RATGDO_RETIRED_FAMILIES, options: catalog.options });

  // The config's own entries, exactly as the host stored them, or none for a config that carries no options array.
  const optionsOf = (config: RatgdoLegacyConfig | undefined): string[] => Array.isArray(config?.options) ? config.options as string[] : [];

  // A feature-option engine over the served catalog and a list of entries. The array is handed in directly rather than copied: the engine's set-option path is a pure
  // transform that composes a fresh array and reassigns its own field, so the array it was given is never written to.
  const engineOver = (options: string[]): FeatureOptions => new FeatureOptions(catalog.categories, catalog.options, options);

  // A feature-option engine over the served catalog and the config's own entries, which the engine reads exactly as the host stored them.
  const engineFor = (config: RatgdoLegacyConfig | undefined): FeatureOptions => engineOver(optionsOf(config));

  /* The value the catalog registers as an option's default, read from the served entry's own defaultValue field. The engine exposes a same-named method that answers a
   * different question - the boolean enabled-state default - so this walks the catalog data instead. The migration needs this to tell a value the user chose from a
   * value that merely restates what the option already does, and only the first is worth writing an entry for.
   */
  const registeredDefault = (option: string): number | string | undefined => {

    for(const [ category, entries ] of Object.entries(catalog.options)) {

      for(const entry of entries) {

        if((entry.name ? category + "." + entry.name : category) === option) {

          return entry.defaultValue;
        }
      }
    }

    return undefined;
  };

  return {

    /* The namer for one configuration's device rows, over one engine for the whole list, so the sidebar pays for one catalog index rather than one per row. A row shows
     * the name the plugin gives its opener's accessory in HomeKit: the custom Name read at the row's MAC, the scope the plugin reads it at, where HomeKit can carry it,
     * and otherwise the name the row's cached accessory carries, by HBPU's display-name rule.
     *
     * The rule is applied here rather than written onto the row, so a custom name being edited shows before anything is saved, and a row the page keeps never
     * carries a custom name it would go on showing once that name is cleared.
     *
     * @param config - The platform configuration entry, the edited one when the page names rows under an edit.
     *
     * @returns The namer: a device row in, the name the page shows for it out.
     */
    deviceNamer: (config?: RatgdoLegacyConfig): ((row: RatgdoDeviceRow) => string) => {

      const engine = engineFor(config);

      return (row) => displayedName({ fallback: row.name, override: engine.value(RATGDO_NAME_OPTION, row.serialNumber) });
    },

    /* The global encryption key, exactly as the plugin's runtime resolves it for a connection keyed for no MAC - the engine's global entry, with an empty one read as
     * no key at all.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The global encryption key, or undefined when none is set.
     */
    globalKey: (config?: RatgdoLegacyConfig): string | undefined => {

      const key = engineFor(config).value(RATGDO_ENCRYPTION_KEY_OPTION);

      return ((typeof key === "string") && key.length) ? key : undefined;
    },

    /* The addresses the user has listed, exactly as the plugin's runtime reads them. It goes through the engine's own list read rather than splitting the stored
     * string here, so the page and the runtime can never disagree about what counts as one entry - the grammar of that list is the engine's, not this module's.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The listed addresses, in the user's own order.
     */
    manualAddresses: (config?: RatgdoLegacyConfig): readonly string[] => engineFor(config).valueList({ option: RATGDO_ADDRESS_OPTION }),

    /* Move any legacy configuration properties into their feature options, and any retired options into the ones that took their place, as a patch for the session to
     * stage. This is transitional work with a planned end: once a configuration has been through it, there is nothing left to find and every later pass answers null.
     *
     * The retired options go first. HBPU's retired options rewrite each family RATGDO_RETIRED_FAMILIES names into the list that superseded it, scope by scope,
     * writing an entry only where a scope's selection differs from what it inherits, so a device carrying less or more than the global selection keeps that
     * difference. The rewrite answers the very array it was handed when nothing in it was retired, so a changed array is what tells this pass it has entries to
     * carry, and the engine the properties migrate onto below reads the rewritten entries. Openers sit beneath no controller, so the rewrite is exact without a
     * topology to compose through.
     *
     * A property that is present with a defined value always leaves, carried on the patch as an explicitly undefined key so the shallow-merge commit deletes it rather
     * than skipping it. Whether its value additionally becomes an option entry depends on which kind of option it addresses, and the kind is read from the catalog
     * rather than declared here: the engine treats an entry that declares a defaultValue as value-centric, so an option whose registered default comes back undefined
     * is a flag. That keeps the address table a plain map of names and leaves the catalog the single authority on kind.
     *
     * A value migrates when all of the following hold: it is a non-empty string, its option is not already configured (an existing entry is the user's own choice and
     * outranks a property, whether that entry enables or disables the option), and it is not byte-equal to the option's registered default (migrating a value that
     * only restates the default would manufacture configuration out of nothing).
     *
     * A flag composes a valueless enable entry on exactly one input: the boolean true, with its option not already configured. False needs no entry, because off is
     * what the catalog already declares, and writing one would manufacture configuration for no gain - the same minimal-config rule the value arm follows. Anything
     * that is not a boolean is a hand-edit we decline to interpret, and it leaves without composing.
     *
     * Two shapes decline entirely. A legacy key present with the value undefined is the terminal shape this very patch produces, so it reads as absent and a second
     * pass over an already-staged config stages nothing. And an options array that is not an array at all is a substrate we cannot parse, so the migration leaves the
     * whole config alone rather than guessing at it. An ABSENT options key is not that shape - it is the ordinary configuration of an install that has never set a
     * feature option, and it migrates onto an empty engine.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The patch to commit, or null when there is nothing to do.
     */
    migrate: (config?: RatgdoLegacyConfig): RatgdoConfigPatch | null => {

      if(!config || ((config.options !== undefined) && !Array.isArray(config.options))) {

        return null;
      }

      const configured = optionsOf(config);
      const { configuredOptions } = retired.migrate({ configuredOptions: configured });
      const rewritten = configuredOptions !== configured;

      // Object.entries widens a record's keys to string, and the record's own type holds them to the legacy properties.
      const carried = (Object.entries(CONSOLIDATED_SETTINGS) as [LegacyProperty, string][]).filter(([property]) => config[property] !== undefined);

      if(!rewritten && !carried.length) {

        return null;
      }

      const engine = engineOver([...configuredOptions]);
      const patch: RatgdoConfigPatch = {};
      let composed = rewritten;

      for(const [ property, option ] of carried) {

        const value = config[property];
        const catalogDefault = registeredDefault(option);

        patch[property] = undefined;

        // An option the catalog gives no registered default is a flag, and a flag's whole payload is the entry's existence.
        if(catalogDefault === undefined) {

          if((value !== true) || engine.exists(option)) {

            continue;
          }

          engine.setOption({ enabled: true, option });
          composed = true;

          continue;
        }

        if((typeof value !== "string") || !value.length || engine.exists(option) || (value === catalogDefault)) {

          continue;
        }

        engine.setOption({ enabled: true, option, value });
        composed = true;
      }

      // The entries are carried by the patch only when this pass rewrote a retired option or composed an entry, so a config whose properties all decline stages a pure
      // deletion.
      if(composed) {

        patch.options = engine.configuredOptions;
      }

      return patch;
    },

    /* Compose the configuration write that adds a device by address, or answer null when nothing would change.
     *
     * Two entries can move, and they are deliberately decided apart. The ADDRESS is appended to the list option unless the list already carries it, compared without
     * regard to case because a hostname and an IPv6 literal are both case-insensitive; the list is rewritten through the engine's own formatter, so an entry this
     * module adds is spelled the way the options editor would have spelled it. The KEY is written at the device's MAC - which the card learned by testing the address,
     * and which is where every connection to the device reads its key - and only when it differs from what the engine already resolves there, so a key already stored
     * for that MAC, or one equal to the global encryption key, writes no entry.
     *
     * An already-listed address is accepted rather than refused, and that is the whole point of the second half: it is how a user fixes a key they got wrong, and how
     * a device that was hand-added to the list without one finally gets one. An EMPTY key never clears a stored one - a user who leaves the field blank is saying
     * nothing about the key, not asking to delete it, and the options editor is where a deletion belongs.
     *
     * Null when neither entry moved is the already-listed answer: the framework's commit reports it as unchanged and writes nothing, so the card tells the user their
     * device is already listed rather than writing a configuration identical to the one on disk and making the host offer a restart for nothing.
     *
     * @param config         - The platform configuration entry.
     * @param device.address - The address the user typed.
     * @param device.key     - The key they typed beside it, if any.
     * @param device.mac     - The MAC the card's test learned, in the plugin's identity form.
     *
     * @returns The patch to commit, or null when there is nothing to do.
     */
    withManualDevice: (config: RatgdoLegacyConfig | undefined, { address, key, mac }: RatgdoManualDevice): RatgdoManualDevicePatch | null => {

      // The address takes its canonical form ONCE, here, and every decision about it below reads that one value - whether the list already carries it, and what is
      // written into the list - so no decision can spell the address differently from another.
      const canonical = canonicalManualAddress(address);

      if(!canonical.length || isZonedAddress(canonical)) {

        return null;
      }

      const engine = engineFor(config);
      const listed = engine.valueList({ option: RATGDO_ADDRESS_OPTION });
      let composed = false;

      // Every listed entry is canonicalized for the comparison too, so a list holding the bracketed spelling of this address is recognized as already carrying it.
      if(!listed.some((entry) => (canonicalManualAddress(entry) === canonical))) {

        engine.setOption({ enabled: true, option: RATGDO_ADDRESS_OPTION, value: formatValueList([ ...listed, canonical ]) });
        composed = true;
      }

      // The key is addressed at the SAME identity the runtime reads it at. Resolving through the engine first is what makes an unchanged key a no-op: value() walks
      // the device's entry and then the global one, so a device whose key is already inherited globally gets no entry of its own.
      if((typeof key === "string") && key.length && (engine.value(RATGDO_ENCRYPTION_KEY_OPTION, mac) !== key)) {

        engine.setOption({ enabled: true, id: mac, option: RATGDO_ENCRYPTION_KEY_OPTION, value: key });
        composed = true;
      }

      return composed ? { options: engine.configuredOptions } : null;
    }
  };
};
