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
 * a configuration nobody has opened the webUI on keeps working. Reconciling the two is one of this module's jobs: the migration moves a property's value into its
 * option and marks the property for deletion. Nothing in this plugin's browser code reads a configuration property.
 *
 * The other job is composing the writes the page's own affordances make. A manual device is the one setting a user adds from a card rather than from the options
 * editor, and it lands in TWO places at once - the address on a list option, and its key at the device's MAC, which the card learned by testing the address - so the
 * composition belongs here beside the rest of this plugin's knowledge of where a setting lives, rather than in the page that happens to draw the card.
 */

/* Every consolidated setting, as the configuration property that carries it paired with the feature option that supersedes it. This pairing is this module's policy
 * knowledge and the one address book the factory below reads, so the migration's writes can never disagree with themselves about where a setting lives.
 *
 * These option names live in three places at once: here at the wire, in the plugin runtime's TypeScript unions, and at the platform's own call sites. Nothing in the
 * language binds the three together, so the migration test suite's round trip through the real catalog is what holds them: a name that drifts here composes an entry
 * the runtime never reads, and the round trip fails on the resolved values rather than on the string.
 */
const CONSOLIDATED_SETTINGS = {

  debug: "Log.Debug",
  mqttTopic: "Mqtt.Topic",
  mqttUrl: "Mqtt.Url"
};

// The option a manually addressed device's address is listed under, and the one its key is stored under. Named here for the same reason the table above is: the
// composition below must not be able to disagree with itself about where a manual device lives.
const ADDRESS_OPTION = "Device.Address";
const KEY_OPTION = "Device.Encryption.Key";

/* Reduce one address a user typed to the canonical form everything downstream uses: trimmed, lower-cased, and with one enclosing pair of square brackets removed.
 *
 * This is the page's half of a rule the plugin's runtime states in src/manual.ts, character for character. It is written twice on purpose rather than by oversight:
 * this module is import-free by design so it can run in a browser, and the runtime's copy is a Node module a browser cannot load. What holds the two together is the
 * shared vector table in the test suite, which runs both halves over the same inputs and asserts they agree - a drift shows up there rather than as one address the
 * page and the plugin spell two different ways.
 *
 * The brackets matter because a user typing an IPv6 literal reasonably reaches for the URL spelling, and the bracketed form is not an address to anything
 * downstream: Node's own parser does not read it as an IP literal, so a dial resolves it as a hostname and fails forever. Only an ENCLOSING pair goes, so a stray
 * bracket on one end stays where the user put it rather than being half-removed into a different address. No port is parsed and no IPv6 literal is compressed.
 *
 * @param address - The address as the user wrote it.
 *
 * @returns The canonical spelling of that address.
 */
export const canonicalManualAddress = (address) => {

  const trimmed = ((typeof address === "string") ? address : "").trim();
  const bare = (trimmed.startsWith("[") && trimmed.endsWith("]")) ? trimmed.slice(1, -1) : trimmed;

  return bare.toLowerCase();
};

/* Whether a canonical address carries an IPv6 zone identifier, which is the one shape this plugin refuses to dial.
 *
 * A zone identifier names the interface a link-local address was heard on, and it means nothing without that link. Autodiscovery already drops a zoned candidate
 * before anything can choose it; an address a user types gets the same answer, told to them on the card rather than buried in a log.
 *
 * @param address - A canonical address.
 *
 * @returns true when the address cannot be dialed because it names a zone.
 */
export const isZonedAddress = (address) => address.includes("%");

/* Build the interpreter over an injected feature-option engine class, the option catalog the plugin's own UI server publishes, and the engine's list formatter the
 * composition needs. Injecting all of them is what keeps this module import-free and testable under node against the real engine and the real catalog, rather than
 * against a stand-in that could drift from either.
 *
 * @param injected.FeatureOptions   - The feature-option engine class.
 * @param injected.catalog          - The served catalog, carrying its categories and its options record.
 * @param injected.formatValueList  - The engine's own list formatter, so a list this module writes reads back exactly as the editor's own writes do.
 *
 * @returns The interpreter: the legacy-settings migration, and the manual-device reads and writes.
 */
export const makeRatgdoConfig = ({ FeatureOptions, catalog, formatValueList }) => {

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

    /* The global encryption key, exactly as the plugin's runtime resolves it for a connection keyed for no MAC - the engine's global entry, with an empty one read as
     * no key at all.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The global encryption key, or undefined when none is set.
     */
    globalKey: (config) => {

      const key = engineFor(config).value(KEY_OPTION);

      return ((typeof key === "string") && key.length) ? key : undefined;
    },

    /* The addresses the user has listed, exactly as the plugin's runtime reads them. It goes through the engine's own list read rather than splitting the stored
     * string here, so the page and the runtime can never disagree about what counts as one entry - the grammar of that list is the engine's, not this module's.
     *
     * @param config - The platform configuration entry.
     *
     * @returns The listed addresses, in the user's own order.
     */
    manualAddresses: (config) => engineFor(config).valueList({ option: ADDRESS_OPTION }),

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

      // The entries are carried by the patch only when this pass actually composed one, so a config whose properties all decline stages a pure deletion.
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
    withManualDevice: (config, { address, key, mac }) => {

      // The address takes its canonical form ONCE, here, and every decision about it below reads that one value - whether the list already carries it, and what is
      // written into the list - so no decision can spell the address differently from another.
      const canonical = canonicalManualAddress(address);

      if(!canonical.length || isZonedAddress(canonical)) {

        return null;
      }

      const engine = engineFor(config);
      const listed = engine.valueList({ option: ADDRESS_OPTION });
      let composed = false;

      // Every listed entry is canonicalized for the comparison too, so a list holding the bracketed spelling of this address is recognized as already carrying it.
      if(!listed.some((entry) => (canonicalManualAddress(entry) === canonical))) {

        engine.setOption({ enabled: true, option: ADDRESS_OPTION, value: formatValueList([ ...listed, canonical ]) });
        composed = true;
      }

      // The key is addressed at the SAME identity the runtime reads it at. Resolving through the engine first is what makes an unchanged key a no-op: value() walks
      // the device's entry and then the global one, so a device whose key is already inherited globally gets no entry of its own.
      if((typeof key === "string") && key.length && (engine.value(KEY_OPTION, mac) !== key)) {

        engine.setOption({ enabled: true, id: mac, option: KEY_OPTION, value: key });
        composed = true;
      }

      return composed ? { options: engine.configuredOptions } : null;
    }
  };
};
