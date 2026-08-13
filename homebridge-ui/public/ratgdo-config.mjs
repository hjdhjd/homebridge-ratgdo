/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ratgdo-config.mjs: Pure interpreter over the injected Ratgdo platform configuration.
 */
"use strict";

/* The single home for our plugin-config shape. Every function here is a pure interpreter of the primary platform-config entry the webUI framework injects into our
 * hooks - no I/O, no global reach, and no imports, so the whole module is testable against the real feature-option engine by handing that engine in. The framework
 * owns reading and writing the persisted config through its session; this module owns the Ratgdo-specific knowledge of where a setting lives.
 *
 * Two settings substrates meet here. A feature option is where a setting lives, and a handful of configuration properties are a second home the plugin honors so that
 * a configuration nobody has opened the webUI on keeps working. Reconciling the two is this module's whole job: the migration moves a property's value into its
 * option and marks the property for deletion. Nothing in this plugin's browser code reads a configuration property, so a migration is all this module offers.
 */

/* Every consolidated setting, as the configuration property that carries it paired with the feature option that supersedes it. This pairing is this module's policy
 * knowledge and the one address book the factory below reads, so the migration's writes can never disagree with themselves about where a setting lives.
 *
 * These option names live in three places at once: here at the wire, in the plugin runtime's TypeScript unions, and at the platform's own call sites. Nothing in the
 * language binds the three together, so the migration test suite's round trip through the real catalog is what pins them: a name that drifts here composes an entry
 * the runtime never reads, and the round trip fails on the resolved values rather than on the string.
 */
const CONSOLIDATED_SETTINGS = {

  debug: "Log.Debug",
  mqttTopic: "Mqtt.Topic",
  mqttUrl: "Mqtt.Url"
};

/* Build the interpreter over an injected feature-option engine class and the option catalog the plugin's own UI server publishes. Injecting both is what keeps this
 * module import-free and testable under node against the real engine and the real catalog, rather than against a stand-in that could drift from either.
 *
 * @param injected.FeatureOptions - The feature-option engine class.
 * @param injected.catalog        - The served catalog, carrying its categories and its options record.
 *
 * @returns The interpreter: the legacy-settings migration.
 */
export const makeRatgdoConfig = ({ FeatureOptions, catalog }) => {

  // A feature-option engine over the served catalog and the config's own entries. The array is handed in directly rather than copied: the engine's set-option path is
  // a pure transform that composes a fresh array and reassigns its own field, so the array it was given is never written to.
  const engineFor = (config) => new FeatureOptions(catalog.categories, catalog.options, Array.isArray(config?.options) ? config.options : []);

  /* The value the catalog registers as an option's default, read from the served entry's own defaultValue field. The engine exposes a same-named method that answers a
   * different question - the boolean enabled-state default - so this walks the catalog data instead. The migration needs this to tell a value the user chose from a
   * value that merely restates what the option already does, and only the first is worth writing an entry for.
   */
  const registeredDefault = (option) => {

    for(const [ category, entries ] of Object.entries(catalog?.options ?? {})) {

      for(const entry of entries) {

        if((entry.name ? category + "." + entry.name : category) === option) {

          return entry.defaultValue;
        }
      }
    }

    return undefined;
  };

  return {

    /* Move any legacy configuration properties into their feature options, as a patch for the session to stage. This is transitional work with a planned end: once a
     * configuration has been through it, there is nothing left to find and every later pass answers null.
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
    migrate: (config) => {

      if(!config || ((config.options !== undefined) && !Array.isArray(config.options))) {

        return null;
      }

      const carried = Object.entries(CONSOLIDATED_SETTINGS).filter(([property]) => config[property] !== undefined);

      if(!carried.length) {

        return null;
      }

      const engine = engineFor(config);
      const patch = {};
      let composed = false;

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

      // The entries ride the patch only when this pass actually composed one, so a config whose properties all decline stages a pure deletion.
      if(composed) {

        patch.options = engine.configuredOptions;
      }

      return patch;
    }
  };
};
