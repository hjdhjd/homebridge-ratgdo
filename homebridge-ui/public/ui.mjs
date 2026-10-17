/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge Ratgdo webUI.
 */
import { FeatureOptions, formatValueList, scopeSafeId } from "homebridge-plugin-utils/featureOptions.js";
import { STATUS_ADDRESSES_ROUTE, STATUS_PROBE_ROUTE, STATUS_WARM_ROUTE } from "./status-routes.mjs";
import { canonicalManualAddress, isZonedAddress, makeRatgdoConfig } from "./ratgdo-config.mjs";
import { PluginConfigSession } from "homebridge-plugin-utils/pluginConfigSession.mjs";
import { STATUS_EVENT } from "homebridge-plugin-utils/webui-status.js";
import { webUi } from "homebridge-plugin-utils/webUi.mjs";
import { withDeadline } from "homebridge-plugin-utils/webUi-liveness.mjs";

// The motion-latch fallback duration, in seconds, for the placeholder skeleton only. The authoritative snapshot rows carry the server's RATGDO_MOTION_DURATION on their
// own latch, so this fallback governs the clear-back only until the first snapshot arrives; browser code cannot import the server constant, so the fallback is local by
// necessity and the snapshot is the source of truth once it lands.
const MOTION_LATCH_FALLBACK_SECONDS = 5;

// The trailing-debounce window, in milliseconds, before a hook- or belt-driven warm recompute sends. It mirrors homebridge-plugin-utils' own persist coalescing window:
// the edit hook fires once per option mutation, so a burst of keystrokes into an encryption-key field would otherwise re-send a warm on every character and reconnect the
// device against a half-typed key. The debounce coalesces the burst into one warm carrying the settled value. The load announcement's warm bypasses this window and
// sends immediately, because a page that has just established has nothing to coalesce with.
const WARM_DEBOUNCE_MS = 300;

/* The warm-set recompute state. sentSignature is a canonical string of the whole warm payload the server last received, and a recompute re-sends only when the payload
 * it just computed spells differently - a send-suppression optimization over the server's own authoritative diff. One signature over the whole payload rather than a
 * per-field memory is what makes "changed" mean any field of any entry changed, so a widening of the payload needs no second comparison written beside the first. Null
 * means nothing has been sent, which is also the state every forced-resend path returns it to. warmDebounceTimer is the trailing-debounce handle for the hook and belt
 * recompute paths.
 */
let sentSignature = null;
let warmDebounceTimer = null;

/* The identity-strip address cache. deviceAddresses maps each device's mac - device.serialNumber, the same key the status pushes carry - to that device's live discovery
 * address, so the strip's address row reads the very address the status connection dials. It starts empty and is replaced wholesale by refreshAddresses on every resolved
 * round trip. addressRefreshInFlight is the coalescing latch that keeps a burst of "connecting" pushes from firing one request per device.
 */
let deviceAddresses = {};
let addressRefreshInFlight = false;

/* Fire the warm-route request and feed it to the shared panel's link-lost watchdog as its own liveness probe. The raw request promise is captured so the watch observes
 * it directly: a rejection must reach the watchdog's two-armed hook as a rejection, and the console diagnostic goes through a separate chain off the same promise because
 * composing the watch after the .catch would convert every rejection into a resolution and blind the rejection-is-liveness path. The panel handle is read at call time
 * because it is minted per show() and must never be captured; the optional chaining keeps a pre-show() request honest, since the handle is null before the first show()
 * and an unwatched boot request is covered by the panel's own view probe once a device is viewed. Warm progress itself flows back over push events, not this response.
 */
const requestRoute = (route, body) => {

  const request = homebridge.request(route, body);

  ui.featureOptions.statusPanel?.watchRequest(request);

  // console is the browser panel's diagnostic transport; a transport failure here is a diagnostic, since feed progress and errors return over push events.
  // eslint-disable-next-line no-console
  request.catch((error) => console.error("The status route request failed.", error));
};

/* Refresh the identity-strip address cache from the server's live discovery projection. It fires the addresses route and hands the raw request promise to the shared
 * panel's link-lost watchdog exactly as requestRoute does - the watch observes the raw request so a rejection reaches the watchdog as a rejection, and the console
 * diagnostic goes through a separate chain, since composing the watch after a .catch would blind the rejection-is-liveness path. The panel handle is read at call time
 * because it is minted per show() and must never be captured. On resolution the cache is replaced wholesale, since the projection is the server's whole discovery
 * truth for this page session. A single boolean latch coalesces concurrent triggers: a "connecting" burst - every device connects fresh after page load - would
 * otherwise fire one request per device, so a refresh already in flight is not duplicated, and the two-armed settle clears the latch whether the request resolves or
 * rejects.
 */
const refreshAddresses = async () => {

  if(addressRefreshInFlight) {

    return;
  }

  addressRefreshInFlight = true;

  const request = homebridge.request(STATUS_ADDRESSES_ROUTE);

  ui.featureOptions.statusPanel?.watchRequest(request);

  // console is the browser panel's diagnostic transport; a transport failure here is a diagnostic, since the addresses are advisory identity data rendered best-effort.
  // eslint-disable-next-line no-console
  request.catch((error) => console.error("The status addresses request failed.", error));

  try {

    deviceAddresses = (await request) ?? {};
  } catch {

    // The transport failure is already logged on the separate chain above; keep the last-known addresses rather than blanking a populated cache on a transient failure.
  } finally {

    addressRefreshInFlight = false;
  }
};

/* Reduce a warm payload to one canonical string, the whole of what the send-suppression comparison reads.
 *
 * Two properties make the comparison sound. Each list is sorted by its own identity, so a device list the framework happens to hand back in a different order is not
 * mistaken for a change; and each entry is a fixed-position tuple with an explicit null for an absent field rather than an object with the field omitted, so no omitted
 * field can ever collide with a present one - a device named "x" with no key spells differently from a device with no name and the key "x". Together they make
 * "changed" mean exactly what it says: some field of some entry moved.
 *
 * @param {{ addresses?: Object[], devices: Object[] }} payload - The warm payload about to be sent.
 *
 * @returns {string} The canonical spelling of that payload.
 */
const warmSignature = (payload) => JSON.stringify({

  addresses: [...payload.addresses ?? []].sort((a, b) => a.address.localeCompare(b.address)).map((entry) => [ entry.address, entry.psk ?? null ]),
  devices: [...payload.devices].sort((a, b) => a.mac.localeCompare(b.mac)).map((entry) => [ entry.mac, entry.psk ?? null, entry.logName ?? null ])
});

/* Recompute the warm set from the live device list and feature-option edits, and re-send it to the server when it would change. Every warm send funnels through this one
 * function, which gates on config-view establishment and epoch liveness before it sends, so the diff-and-send logic and the integrity conditions that guard it live in
 * exactly one place rather than being restated per trigger; the address-refresh request is a read and is deliberately outside this funnel. The whole body is guarded:
 * a failed lookup logs to the console and keeps the last-sent set rather than throwing out of a callback. The device list comes from the public HBPU device-list source
 * (never a hand-parse of the cached accessories), and each device's effective key and log name come from one FeatureOptions engine rebuilt from the live editedConfig
 * against the framework's page-lifetime catalog, which it fetches once and shares with every reader, so option inheritance resolves entirely through the engine. The
 * payload is then reduced to a canonical signature and compared against the last one sent, so the send is suppressed unless some field of some entry moved - a
 * redundant warm would be a no-op at the server's authoritative diff, so suppressing it is purely an optimization.
 */
const recomputeWarmSet = async () => {

  try {

    const catalog = await ui.featureOptions.catalog();
    const devices = (await deviceList()).devices ?? [];

    /* The primary config block, read by position, whose absence is the establishment gate. The plugin-config session holds config[0] fixed as the primary platform
     * entry and the editedConfig getter hands that entry back first on every read, and the array it reads is Ratgdo-only by the host's own construction - the server
     * filters plugin config by platform tag before it ever reaches the browser - so position is the durable identity for this block. Matching by the platform tag is
     * fragile against the host UI: its schema-driven Settings form emits only schema-declared keys and strips every undeclared key, the platform tag included, from the
     * in-memory config block, so a tag match can miss against a fully keyed configuration after a Settings-tab visit and compute every encrypted device keyless.
     *
     * The getter answers with an empty array exactly until show() has supplied the session - a failed launch included, because the shell's show() reports a launch
     * failure to the user and resolves rather than rejecting - so an absent block gates establishment for every caller of this function alike: the load announcement's
     * warm, the debounced triggers, and the forced re-sends. The gate keys on the block being absent and never on its options being empty, so an established session
     * that has configured no options passes it and computes an honest keyless set for devices that need no key.
     *
     * Every show cycle that establishes the page announces its loaded model and warms at once; a cycle that fails before that point announces nothing, and the relaunch
     * the menu's recovery runs announces and warms when it establishes. A repeat cycle costs nothing beyond one cached-accessories read - the same read every trigger
     * already pays, served from the host's own cache - because the send suppression below refuses a re-send while no key has moved.
     */
    const block = ui.featureOptions.editedConfig[0];

    if(!block) {

      return;
    }

    const featureOptions = new FeatureOptions(catalog.categories, catalog.options, block.options ?? []);

    // One option's effective value at one identity, answered only when it is a non-empty string. Every option this page reads for the warm payload goes through here,
    // so the rule that an empty entry means "the user set nothing" is stated once for the page rather than once per read. The runtime states the same rule for itself;
    // browser code cannot import it, so the two are written apart deliberately rather than by oversight.
    const optionText = (option, id) => {

      const value = featureOptions.value(option, id);

      return ((typeof value === "string") && (value.length > 0)) ? value : undefined;
    };

    const devicePayload = [];

    for(const device of devices) {

      const mac = device.serialNumber;

      if((typeof mac !== "string") || (mac.length === 0)) {

        continue;
      }

      const logName = optionText("Device.LogName", mac);
      const psk = optionText("Device.Encryption.Key", mac);
      const entry = { mac };

      // Each optional field is attached only when the engine answered one, so the payload on the wire carries exactly what the user configured and the server's
      // narrowing reads an absent field rather than an explicit undefined that JSON would drop anyway.
      if(logName !== undefined) {

        entry.logName = logName;
      }

      if(psk !== undefined) {

        entry.psk = psk;
      }

      devicePayload.push(entry);
    }

    /* The listed addresses, read once per recompute and canonicalized before anything is done with them. Canonicalizing first is what makes the scope id the page
     * computes the same one the plugin computes: the runtime canonicalizes its own list before it dials, so a raw entry here would store a key at an identity the
     * plugin never looks for. Each key is then read at the address's OWN identity, exactly as the runtime reads it before a manual dial - a device named by address
     * has no mac anyone knows until something connects to it. scopeSafeId is the engine's own answer to an identifier carrying characters its stored form gives
     * meaning to, and using the library's function rather than a local rewrite is what keeps the page and the runtime writing the same entry.
     *
     * A zoned address is dropped rather than sent. The card refuses one before it is ever written, so an entry reaching here names a device nothing can dial, and
     * sending it would only have the feed drop it again.
     */
    const addressPayload = [];

    for(const entry of featureOptions.valueList({ option: "Device.Address" })) {

      const address = canonicalManualAddress(entry);

      if(!address.length || isZonedAddress(address)) {

        continue;
      }

      const psk = optionText("Device.Encryption.Key", scopeSafeId(address));
      const payloadEntry = { address };

      if(psk !== undefined) {

        payloadEntry.psk = psk;
      }

      addressPayload.push(payloadEntry);
    }

    const payload = { addresses: addressPayload, devices: devicePayload };
    const signature = warmSignature(payload);

    // Send-suppression: re-send only when the payload would spell differently than the one the server already holds. This premise - that an unchanged payload needs no
    // re-send - holds only against a living server that still holds it; every forced-resend path clears the signature first, so a helper restart or a lost send is
    // healed by the next forced trigger rather than staying suppressed.
    if(signature === sentSignature) {

      return;
    }

    /* The epoch check, the last integrity condition on the send path. The debounce timer and this function's own awaits can outlive the module copy that armed them: a
     * panel reopen mints a successor and aborts this copy's epoch mid-flight, and nothing cancels an armed setTimeout or an in-flight recompute. Testing the epoch here,
     * as the last act before the request, retires the whole zombie class at the one place it becomes observable instead of enumerating a cleanup per resource. Everything
     * above this line is read-only, so a late-firing recompute that bails here costs nothing beyond its own computation, and the check sits ahead of the signature
     * assignment so a refused send leaves the retired copy's module state untouched entirely.
     */
    if(ui.epochSignal.aborted) {

      return;
    }

    sentSignature = signature;

    // Reset the component's per-device stale-push guard. A warm re-send re-elicits the pool's pushes, so the guard's highest-seen floors must clear or the fresh pushes
    // would be dropped against stale tokens; the handle is read at call time because it is minted per show() and must never be captured. Safe by construction: tokens are
    // monotonic within a feed lifetime and the feed's session-identity guard is the real stale-push protection, so clearing the floors cannot admit a superseded push.
    ui.featureOptions.statusPanel?.resetStaleGuards();

    requestRoute(STATUS_WARM_ROUTE, payload);
  } catch(error) {

    // console is the browser panel's diagnostic transport; a failed warm recompute is a diagnostic, and keeping the last-sent set is the safe fallback.
    // eslint-disable-next-line no-console
    console.error("The device warm set could not be recomputed.", error);
  }
};

// Schedule a debounced warm recompute for the hook and belt paths. The edit hook fires once per option mutation, so a trailing debounce coalesces a burst of edits into
// one warm carrying the settled value rather than reconnecting an encrypted device against a half-typed key mid-burst.
const scheduleRecompute = () => {

  if(warmDebounceTimer !== null) {

    clearTimeout(warmDebounceTimer);
  }

  warmDebounceTimer = setTimeout(() => {

    warmDebounceTimer = null;
    void recomputeWarmSet();
  }, WARM_DEBOUNCE_MS);
};

/* Force a warm re-send: the recovery chokepoint every restart-recovery path goes through. It clears the send-suppression signature before scheduling the debounced
 * recompute, because that signature's premise - a re-send of an unchanged payload is a no-op at the server - is false across a helper restart: a fresh server process
 * starts with an empty warm set, so a suppressed re-send would leave it starved. Clearing the signature forces the next recompute to send whatever it computes. Routing
 * through the debounced recompute rather than an immediate one makes the debounce the serializer: a hello landing mid-keystroke coalesces with the typing burst instead
 * of racing it with a half-typed key, concurrent triggers (a hello and a foreground return together) collapse into one send, and the 300ms trailing delay is
 * imperceptible beside the roughly one-second connect floor. One honest bound: the load announcement's warm bypasses this debounce, so a hello arriving during a launch
 * can have its debounced recompute overlap that announcement's async body - both compute against the same live state, and the server's authoritative diff makes the
 * double-send harmless, which is the posture every redundant send in this design takes.
 */
const forceWarmResend = () => {

  sentSignature = null;
  scheduleRecompute();
};

/* The sidebar's own order for the groups this page assigns. These are the family words a device's Model characteristic opens with, declared for HomeKit in the plugin's
 * own variant table, listed here only to rank the sections; a word this list does not name sorts after both of them by locale rather than breaking the sidebar.
 */
const SIDEBAR_GROUP_ORDER = [ "Ratgdo", "Konnected" ];

// A group's place in the order above, with a group the order does not name ranking after every group it does.
const sidebarGroupRank = (group) => {

  const rank = SIDEBAR_GROUP_ORDER.indexOf(group);

  return (rank === -1) ? SIDEBAR_GROUP_ORDER.length : rank;
};

/* The sidebar group a device belongs to, read from the leading word of its Model. device.ts composes that Model as the family word followed by the hardware model, for
 * exactly this reason, so the group is available on every install the moment the page loads - nothing is persisted, nothing is migrated, and no plugin-runtime module
 * reaches the browser. A Model that is not text at all leaves the device untagged, which the framework renders under the top-level device heading.
 */
const variantGroup = (model) => {

  if((typeof model !== "string") || (model.length === 0)) {

    return undefined;
  }

  const space = model.indexOf(" ");

  return (space === -1) ? model : model.slice(0, space);
};

/* The page's device source, and the one place the device fetch and its grouping live. It hands back the framework's own result object - both `devices` and `error`,
 * which the framework's contract guard requires - with each row tagged by its variant group, so the sidebar and the warm recompute read one list processed one way.
 */
const deviceList = async () => {

  const result = await ui.featureOptions.getHomebridgeDevices();

  for(const device of result.devices ?? []) {

    device.sidebarGroup = variantGroup(device.model);
  }

  return result;
};

/* Whether one catalog entry - a category or an option - applies to the device whose page is being rendered. An entry applies when there is no device at all, which is
 * the global page and offers everything; when the entry names no variant, which is a concern every opener has; or when the device's own variant is the one named. The
 * device's variant is read from its sidebar group word, the family word its Model opens with and the same word SIDEBAR_GROUP_ORDER above ranks the sections by: that
 * word is the variant's label, and the variant key is the label lowercased, a pairing src/types.ts establishes by declaring the label beside the variant it belongs to.
 * A device whose Model the page could not read carries no group word and is offered everything, because a row that does not apply costs a reader far less than a page
 * that hides the row they came to set.
 */
const entryAppliesToDevice = (device, entry) => {

  if(!device || (device.sidebarGroup === undefined) || (entry.meta?.variant === undefined)) {

    return true;
  }

  return device.sidebarGroup.toLowerCase() === entry.meta.variant;
};

// Whether a device's page offers one feature option, which is the entry-level reading of the variant rule above.
const validOption = (device, option) => entryAppliesToDevice(device, option);

// Whether a device's page offers one feature option category, the same rule applied to the section the framework is about to render.
const validOptionCategory = (device, category) => entryAppliesToDevice(device, category);

/* The bound in seconds on one Test Connection round trip. It deliberately sits ABOVE the server's own probe budget, so what a slow device produces is the server's
 * classified answer - a timeout the card can explain - rather than this deadline firing first and leaving the card to guess which of the two happened. The page
 * cannot import the server's constant, so the ordering is stated here and held by the card's own timeout copy naming the device rather than the page.
 */
const PROBE_DEADLINE = 15;

// The card's copy for every verdict a probe can answer with. Keyed by the classified reason so the card renders one sentence per reason rather than branching, and
// worded in the status panel's own voice: what happened, then what to do about it.
const PROBE_MESSAGES = {

  "auth-invalid": "The device refused that encryption key. Check the key in this device's YAML configuration and try again.",
  "auth-missing": "This device requires its API encryption key. Enter the key from the device's YAML configuration and test again.",
  "misconfigured": "Something answered at that address, but it is not a Ratgdo or Konnected opener this plugin supports.",
  "timeout": "The device did not answer in time. Check that it is powered on and reachable at that address.",
  "unreachable": "Nothing answered at that address. Check the address, and that the device is on the network.",
  "unsupported": "This device's ESPHome API version is not one this plugin can talk to. Update the device's firmware or this plugin so the two match."
};

/* The interpreter over the served catalog, built once for the page's life and shared by everything that reads or writes this plugin's configuration shape - the
 * legacy migration at load, and the Add Device card's save. One construction, because two would be two engines over one catalog answering the same questions.
 */
let interpreter = null;

const configInterpreter = async () => {

  interpreter ??= makeRatgdoConfig({ FeatureOptions, catalog: await ui.featureOptions.catalog(), formatValueList, scopeSafeId });

  return interpreter;
};

/* Build one element through plain DOM calls. Every part of the Add Device card is composed with this and nothing else: no HTML string is ever parsed, because every
 * value the card shows came from a user or from a device, and `textContent` cannot be talked into being markup the way an HTML sink can.
 *
 * @param {string} tag                 - The element to create.
 * @param {Object} [options]           - What to set on it.
 * @param {Object} [options.attributes] - Attributes to set, by name.
 * @param {Array}  [options.children]  - Elements to append, in order.
 * @param {string} [options.className] - The class list.
 * @param {string} [options.text]      - The text content.
 *
 * @returns {Object} The built element.
 */
const buildElement = (tag, { attributes = {}, children = [], className = "", text = "" } = {}) => {

  const element = document.createElement(tag);

  if(className) {

    element.className = className;
  }

  if(text) {

    element.textContent = text;
  }

  for(const [ name, value ] of Object.entries(attributes)) {

    element.setAttribute(name, value);

    // The id is what a label's `for` resolves against, so it is set as a property too rather than only as an attribute.
    if(name === "id") {

      element.id = value;
    }
  }

  element.append(...children);

  return element;
};

/* The Add Device card: a labelled field pair, a live connection test, and a save that writes only what answered.
 *
 * The card is built at runtime rather than declared in the page's markup, for two reasons that both matter. The markup file carries a generated region the UI build
 * restamps, so hand-authored structure in it is the owner's to place rather than this feature's; and the settings-page harness verifies exactly what the page builds,
 * so a card the page constructs is a card the suite can hold, down to its labels and its copy.
 *
 * It mounts as two plugin-owned regions, each carrying `data-fo-region` so the framework hides and reveals them with the rest of the page and never clears them: the
 * Add Device button at the top of the sidebar, and the card itself above the settings content. Both are INSERTED beside the framework's own markup - nothing of the
 * framework's is reparented, and no framework element is ever written on, so the framework remains the only writer of its own regions. Opening the card shows it in
 * place above the settings; the settings content stays where it is.
 */
const card = {

  // The elements the card's behavior reads and writes, filled in at mount. Held together rather than looked up by id at each use, because the card is built once and
  // these are the same elements for the page's life.
  address: null,

  /* The card's action generation, and the single mechanism that retires a stale answer.
   *
   * Two different things make an answer stale, and one counter covers both: a NEWER action started (the user pressed Test Connection again, or pressed Save while a
   * test was still running), or the card CLOSED while an answer was still in flight. Every action reads this counter before it awaits and compares afterward, and
   * both starting an action and closing the card bump it - so one comparison retires a slow probe, a superseded probe, and an answer to a card that is no longer
   * open, rather than three separate guards that could disagree.
   */
  generation: 0,
  key: null,
  mounted: false,
  readout: null,
  region: null,
  verdict: null
};

// Whether the answer an action is holding is still the one the card wants. False once a newer action started or the card closed, which is what keeps a slow answer
// from painting over newer input or rendering into a card the user has already dismissed.
const cardIsCurrent = (generation) => (card.generation === generation) && !ui.epochSignal.aborted;

// Render the card's verdict line, and clear the identity readout unless the caller is filling it. The verdict element carries role="status", so a screen reader
// announces each new verdict without the user having to go looking for it.
const renderVerdict = (message, rows = []) => {

  card.verdict.textContent = message;

  // replaceChildren with no arguments is the DOM's own way to empty a node. `children` is an HTMLCollection whose length is a getter, so assigning to it throws.
  card.readout.replaceChildren();

  for(const [ label, value ] of rows) {

    card.readout.append(buildElement("div", { children: [ buildElement("span", { className: "fw-bold", text: label + ": " }),
      buildElement("span", { text: value }) ] }));
  }
};

// Close the card, retiring whatever is in flight on the way out. Bumping the generation is what makes a probe or a commit that answers afterward render nothing.
const closeCard = () => {

  if(!card.mounted) {

    return;
  }

  card.generation++;
  card.region.hidden = true;
};

/* Open the card, fresh. The fields and the verdict are cleared rather than left as the last visit wrote them, because the card is built once and reused - a stale
 * verdict above empty fields would read as a claim about the device the user is about to type.
 */
const openCard = () => {

  card.generation++;
  card.address.value = "";
  card.key.value = "";
  card.region.hidden = false;
  renderVerdict("");
};

/* Run one connection test and render what came back. Returns the successful result so Save can act on it, and null for every other outcome including a retired one -
 * Save writing nothing unless a device answered is exactly what this return says.
 *
 * The typed address takes its canonical form ONCE, here, and the value this returns alongside the answer is what Save writes - so the address that was tested and the
 * address that is saved cannot be two different strings. A zoned address is refused before any request goes out, because a zone identifier means nothing without the
 * link it was heard on and nothing could dial it; the user is told on the card rather than left watching a probe that was always going to fail.
 *
 * The request is bounded twice over: by the page's own deadline, which is the longer of the two so the server's classified answer wins a race with it, and by the
 * page epoch, so a panel reopen retires the request rather than leaving it to resolve into a retired copy.
 */
const runProbe = async () => {

  const address = canonicalManualAddress(card.address.value);
  const psk = card.key.value.trim();

  if(!address.length) {

    renderVerdict("Please enter the device's address.");

    return null;
  }

  if(isZonedAddress(address)) {

    renderVerdict("An address with a zone identifier cannot be dialed. List the device's routable address or hostname instead.");

    return null;
  }

  // Starting an action bumps the generation, which is what retires an earlier test still in flight: two overlapping tests must leave the NEWER one's verdict on the
  // card, whichever of them the network answers first.
  const generation = ++card.generation;

  renderVerdict("Connecting to the device...");

  try {

    const answer = await withDeadline({ promise: homebridge.request(STATUS_PROBE_ROUTE, { address, psk }), seconds: PROBE_DEADLINE, signal: ui.epochSignal });

    if(!cardIsCurrent(generation)) {

      return null;
    }

    if(answer?.kind !== "ok") {

      renderVerdict(PROBE_MESSAGES[answer?.reason] ?? PROBE_MESSAGES.unreachable);

      return null;
    }

    // The readout names what answered, so a user who typed the wrong address of two openers can see which one they reached. Encrypted is shown only when the
    // transport actually negotiated encryption, because its absence is not a fact worth a row.
    const rows = [ [ "Name", answer.name ?? "" ], [ "Model", answer.model ?? "" ], [ "MAC", answer.mac ], [ "Firmware", answer.firmwareVersion ] ];

    if(answer.encrypted) {

      rows.push([ "Encrypted", "Yes" ]);
    }

    renderVerdict("This device answered.", rows);

    return answer;
  } catch(error) {

    if(cardIsCurrent(generation)) {

      renderVerdict(PROBE_MESSAGES.unreachable);
    }

    // console is the browser panel's diagnostic transport; the user already has the verdict, and this is for whoever is reading the console.
    // eslint-disable-next-line no-console
    console.error("The device connection test failed.", error);

    return null;
  }
};

/* Save: test first, then write, and write nothing at all if the device did not answer. That ordering is the whole promise of the card - an address only reaches the
 * configuration once something at it has identified itself as an opener this plugin supports.
 *
 * The decision about whether anything would change is made BEFORE any commit, against the configuration the page is holding: a composer answering null means the
 * address is listed and its key is already what the user typed, so the card says so and never opens a write. The composer runs a second time inside the commit,
 * against whatever entry the framework hands it there, and its `?? {}` covers only the narrow case of the configuration having moved between the two.
 */
const saveCard = async () => {

  const answered = await runProbe();

  if(!answered) {

    return;
  }

  const generation = card.generation;

  // The address the probe tested, not a fresh read of the field: the canonical form was settled once before the request went out, so what is saved is exactly what
  // answered. Re-reading here would let a keystroke landing during the probe save an address nothing ever tested.
  const address = answered.address;
  const key = card.key.value.trim();
  const ratgdoConfig = await configInterpreter();

  if(!cardIsCurrent(generation)) {

    return;
  }

  const listed = ratgdoConfig.manualAddresses(ui.featureOptions.editedConfig[0]);

  if(!ratgdoConfig.withManualDevice(ui.featureOptions.editedConfig[0], { address, key })) {

    renderVerdict("This device is already listed.");

    return;
  }

  /* Whether this address was already in the list decides the confirmation copy, and it is read BEFORE the write, while the answer is still the truth. Every listed
   * entry is canonicalized for the comparison, so a list holding the bracketed spelling of this address reads as already carrying it - the same rule the composer
   * itself applies, which is what keeps the copy and the write from disagreeing.
   */
  const wasListed = listed.some((entry) => (canonicalManualAddress(entry) === address));
  const result = await ui.featureOptions.commitConfig((platform) => ratgdoConfig.withManualDevice(platform, { address, key }) ?? {});

  // A commit already in flight cannot be recalled, so a card closed across it still leaves the configuration written - once. What a retired generation suppresses is
  // everything AFTER the write: the confirmation, the close, and the warm recompute.
  if(!cardIsCurrent(generation)) {

    return;
  }

  switch(result.kind) {

    case "committed":
    case "staged":

      if(result.kind === "staged") {

        renderVerdict(String(result.error?.message ?? result.error));

        return;
      }

      renderVerdict(wasListed ? "Updated the key for this device." : "Saved. Restart Homebridge to add this device.");
      closeCard();
      scheduleRecompute();

      return;

    case "failed":

      renderVerdict(String(result.error?.message ?? result.error));

      return;

    default:

      // A superseded write belongs to a page copy the window has retired, which renders nothing at all.
      return;
  }
};

/* Mount the card, once per page life. The framework announces a loaded model on every show cycle, so a later cycle finds the card already built and only closes it -
 * rebuilding would discard the elements the framework has promised never to clear, and would register a second set of listeners on them.
 */
const mountCard = () => {

  if(card.mounted) {

    closeCard();

    return;
  }

  const sidebar = document.getElementById("sidebar");
  const stats = document.getElementById("deviceStatsContainer");

  // A page whose markup does not carry the mount points is a page this card has nothing to attach to. It says nothing and stays unmounted rather than throwing out
  // of the framework's load announcement.
  if(!sidebar || !stats) {

    return;
  }

  card.address = buildElement("input", { attributes: { autocapitalize: "off", autocomplete: "off", id: "ratgdoAddressField", placeholder:
    "garage.local or 10.0.0.20", spellcheck: "false", type: "text" }, className: "form-control font-monospace" });
  card.key = buildElement("input", { attributes: { autocapitalize: "off", autocomplete: "off", id: "ratgdoKeyField", spellcheck: "false", type: "text" },
    className: "form-control font-monospace" });
  card.verdict = buildElement("div", { attributes: { role: "status" }, className: "mt-2" });
  card.readout = buildElement("div", { className: "mt-2" });

  const test = buildElement("button", { attributes: { type: "button" }, className: "btn btn-primary me-2", text: "Test Connection" });
  const save = buildElement("button", { attributes: { type: "button" }, className: "btn btn-primary me-2", text: "Save" });
  const cancel = buildElement("button", { attributes: { type: "button" }, className: "btn btn-secondary", text: "Cancel" });

  card.region = buildElement("div", { attributes: { "data-fo-region": "" }, children: [

    buildElement("h5", { text: "Add a device by address" }),
    buildElement("p", { text: "The plugin finds openers on your network by itself. Add one here when it sits somewhere autodiscovery cannot reach, or when you want " +
      "the plugin to use a specific address for it." }),
    buildElement("label", { attributes: { for: "ratgdoAddressField" }, className: "form-label", text: "Address" }),
    card.address,
    buildElement("label", { attributes: { for: "ratgdoKeyField" }, className: "form-label mt-2", text: "Encryption key (optional)" }),
    card.key,
    buildElement("div", { children: [ test, save, cancel ], className: "mt-3" }),
    card.verdict,
    card.readout
  ], className: "alert-info rounded p-3 mb-3" });
  card.region.hidden = true;

  const open = buildElement("button", { attributes: { type: "button" }, className: "btn btn-sm w-100", text: "Add Device" });
  const launcher = buildElement("div", { attributes: { "data-fo-region": "" }, children: [open], className: "mb-2" });

  sidebar.prepend(launcher);
  stats.before(card.region);
  card.mounted = true;

  ui.on(open, "click", openCard);
  ui.on(test, "click", () => void runProbe());
  ui.on(save, "click", () => void saveCard());
  ui.on(cancel, "click", closeCard);

  /* Selecting a device is the user moving on, so the card closes. The listener is delegated on the sidebar because that is the only element the device rows are
   * inside - registering a listener reads the page rather than writing on it, so the framework stays the only writer of its own markup - and a click on this
   * plugin's own launcher is excluded, since that click is what opens the card.
   */
  ui.on(sidebar, "click", (event) => {

    // Node.contains answers this directly, and it answers true for the launcher itself as well as for the button inside it - which is the whole rule, since the click
    // that opens the card is a click on that button and must not also close it.
    if(launcher.contains(event?.target)) {

      return;
    }

    closeCard();
  });
};

/* The feature-options parameters. onLoaded is the page's first warm: the framework announces it once per show cycle that reaches a loaded model, with the status panel's
 * handle already minted and the configuration session established, which is exactly the state the recompute's own establishment gate waits for. The statusPanel
 * configuration supplies exactly the parts ratgdo owns and inherits the shared homebridge-plugin-utils panel around them:
 * the error-copy overrides for the reasons whose ratgdo wording differs from the component's credential-neutral defaults, the identity cells (Model, plus the monospace
 * MAC and IP address rows), and the placeholder rows the skeleton renders before the first snapshot. The row ids, labels, and sizers are ratgdo's vocabulary; the motion
 * row's placeholder latch is the fallback the snapshot's authoritative latch supersedes.
 */
const featureOptionsParams = {

  getDevices: deviceList,
  onLoaded: () => {

    mountCard();
    void recomputeWarmSet();
  },
  onOptionsEdited: scheduleRecompute,
  sidebar: {

    deviceLabel: "Ratgdo Devices",

    /* Where each group of the device list sits: the Ratgdo family first, then the Konnected one. The framework hands this comparator only the names that render as
     * sections, so the reserved hidden group never reaches it, and a group the order above does not name sorts after both of the named ones by locale.
     */
    groupOrder: (a, b) => (sidebarGroupRank(a) - sidebarGroupRank(b)) || a.localeCompare(b)
  },
  statusPanel: {

    errorMessages: {

      "auth-invalid": { label: "Key mismatch", message: "The configured encryption key does not match the key in this device's YAML configuration." },
      "auth-missing": { label: "Key required", message: "This device requires its API encryption key. Set it with the Device Encryption Key feature option." },
      "not-found": { message: "This device was not discovered via mDNS." },
      "unsupported": { message: "This device's ESPHome API version is not one this plugin can talk to. Update the device's firmware or this plugin so the two match." }
    },
    identity: (device) => [

      { label: "Model", value: device.model },
      { label: "MAC Address", mono: true, value: device.serialNumber },
      { label: "IP Address", mono: true, value: deviceAddresses[device.serialNumber] ?? "" }
    ],
    onServerHello: forceWarmResend,
    placeholderRows: [

      { id: "door", label: "Door", sizer: "Stopped (100%)" },
      { id: "lock", label: "Remotes", sizer: "Unlocked" },
      { id: "motion", label: "Motion", latch: { seconds: MOTION_LATCH_FALLBACK_SECONDS, value: "Detected" }, sizer: "Detected" },
      { id: "light", label: "Light", sizer: "Off" },
      { id: "obstruction", label: "Obstruction", sizer: "Obstructed" }
    ]
  },
  ui: { validOption, validOptionCategory }
};

const ui = new webUi({ featureOptions: featureOptionsParams, name: "Ratgdo" });

/* Adopt the framework's theming for this page - the design tokens, the themed canvas, the dark-mode corrections, and the host's own accent - with one call that holds for
 * as long as this module copy owns the window. The registration is memoized by the framework, and the feature-options view routes through this same call when it shows,
 * so what registering here settles is when the theme arrives: at module load rather than at the settings view's first show, which is what keeps the support view and a
 * launch-failure recovery shell wearing it too. The promise is voided rather than awaited because the framework owns its rejection posture - a failed initial
 * lighting-mode read still leaves the sheets adopted and the host's theme signals followed, so the next announcement the host makes brings the page into step.
 */
void ui.registerTheming();

/* The trigger registrations, every one of them scoped to this module copy's claim on the window. Each subscription belongs to the module rather than to a panel, so it
 * must outlive any single panel mount and end only when a successor webUi construction claims the window; they are carried by the framework's ui.on, which composes
 * the page epoch into every registration it makes, so a retired copy stops receiving events at all rather than driving the live copy's state from a stale closure. They
 * register after construction because the facade that makes the registration must exist first, and before show() because a trigger arriving during the launch is
 * answered honestly by the recompute's own establishment gate. One bounded caveat: the composed { signal } option depends on the native EventTarget, which every
 * browser the Homebridge UI supports provides, while the bridge library carries a legacy constructor polyfill whose listener registration drops its options argument -
 * on that path a retired copy's listeners survive, and the recompute's pre-send epoch check is the correctness backstop, degrading the hazard from a wrong send to a
 * wasted recompute.
 */

// The schema-form belt: a config edit made through Homebridge's own settings form (rather than the feature-options UI) surfaces only as configChanged, so it feeds the
// same debounced recompute the option-edit hook does, keeping the warm set current regardless of which surface changed a key.
ui.on(homebridge, "configChanged", scheduleRecompute);

/* The address-refresh trigger. ui.mjs registers its own STATUS_EVENT listener beside the configChanged belt - the same broadcast the shared panel consumes, and multiple
 * listeners are the host relay's natural fan-out, so this sibling consumer neither stops the event's propagation nor touches the panel's own handling; it reads
 * event.data and refreshes only. The listener lives for this module copy's claim on the window, and a successor's construction retires it. On every "connecting" push it
 * refreshes the address cache. The timing argument that makes this sufficient: every device connects fresh after page load, because the helper's connection pool dies
 * with the page's socket, so a "connecting" push proves the server has just discovered that device's address, and the helper-local round trip resolves well inside the
 * device's own connect time - so the cache holds the address before the snapshot rebuild re-invokes the identity fields. Refreshing on every "connecting" event, not only
 * uncached macs, keeps a reconnect cycle's address current across a DHCP change at negligible cost.
 */
ui.on(homebridge, STATUS_EVENT, (event) => {

  if(event.data?.kind === "connecting") {

    void refreshAddresses();
  }
});

/* The visibility belt: a helper process can die while the page sits in the background, leaving the panel holding a warm set no living server has, so a return to the
 * foreground forces a warm re-send directly. Its reach is exactly what the environment delivers to this embedded frame: desktop tab switches and window minimize deliver
 * visibilitychange here, while an iPad app switch does not, and there the server hello relay and the resume trigger carry recovery instead. Honest bounds: a forced
 * resend fired during the old helper's death window may be lost with its process - the next trigger heals it, since the triggers repeat and the posture is
 * fire-and-forget - and the cross-generation stale-token handoff bound the shared status union documents is inherited here: a belt resend racing a two-process handoff
 * can interleave old-generation pushes after a fresh adoption, a window that needs both processes alive across the resume, with the per-event generation field the
 * protocol's additive escape and field reports the tripwire.
 */
ui.on(document, "visibilitychange", () => {

  if(document.visibilityState === "visible") {

    forceWarmResend();
  }
});

/* The resume trigger: the framework's clock-gap detector fires on a page that froze and woke - the iPad app-switch case the belt cannot see - and a wake is exactly when
 * the helper process may have been replaced, so the whole-pool re-send goes with it. The framework bounds this subscription by the epoch itself, and the send
 * chokepoint's establishment and epoch gates bound what it produces exactly as they bound every other trigger.
 */
ui.liveness.onResume(forceWarmResend);

/* The bound in seconds on the configuration wiring below. Five seconds settles the envelope provably inside the page boot monitor's ten-second watchdog, so a wiring
 * step that hangs against an unresponsive host can never be what makes the settings panel look broken.
 */
const WIRING_DEADLINE = 5;

// The configuration wiring's own lifecycle. Aborting it is how an envelope that failed or expired tells a continuation still running underneath it that it must not
// stage anything after the fact.
const wiringController = new AbortController();

/* The signal the wiring's cancellation points read: the envelope's own controller bounded by this module copy's claim on the window, through the facade's one
 * epoch-composition rule - the same rule every listener registration follows. The epoch half matters because a reopened settings panel mints a successor copy and
 * retires this one: bounding the envelope aborts a superseded copy's wiring at the same chokepoints the deadline uses, rather than letting a retired copy write
 * config underneath the copy the user is looking at.
 */
const wiringSignal = ui.epochBounded(wiringController.signal);

/* Run the legacy-settings migration, once, at load.
 *
 * A migration that composes a patch persists it to disk itself, without waiting for the user to press Save. Most people never open this panel to save anything, so a
 * migration that waited for one would leave a fleet split between two configuration shapes indefinitely, and the plumbing that reconciles them could never retire. The
 * write is gated on there being a patch, which is what bounds it: only a session that actually found legacy settings writes, so a migrated install's every later open
 * reads, finds nothing to do, and touches the disk not at all. The host's restart indicator therefore appears at most once per install, in the single session that
 * converts it.
 *
 * The weaker outcomes are deliberate. A save the deadline overtakes, and a save the host rejects, both leave the migration sitting in the modal's pending
 * configuration, where the user's own Save picks it up.
 *
 * Reopening the panel is convergent rather than racing. The settings frame is reused and each open imports a fresh copy of this module whose wiring runs independently,
 * but a second copy reads the saved configuration, finds no legacy keys in it, and so composes nothing and writes nothing. Two genuinely simultaneous wirings read the
 * same configuration and compose identical patches, so either ordering of their commits and saves leaves the same disk state.
 *
 * One bound stated honestly: the check before the commit is the LAST cancellation point. A commit whose bridge round trip is already in flight cannot be recalled - the
 * session takes no signal, and the deadline bounds only the await - so composing the epoch into the signal narrows the stale-write window to that in-flight instant
 * rather than closing it. It is harmful only if a successor commits a differing edit inside the same instant, and two migration wirings are convergent regardless.
 */
const wireRatgdoConfig = async () => {

  const ratgdoConfig = await configInterpreter();

  // The library's session is the single conduit the framework's own writes use, so the patch merges onto a replica synced just now rather than onto a snapshot taken
  // before the page opened.
  const session = await PluginConfigSession.open({ host: homebridge, name: "Ratgdo" });
  const patch = ratgdoConfig.migrate(session.platform);

  // The signal is read immediately before the write, so an envelope that expired - or a copy the window has retired - cannot stage a patch after the fact.
  if(patch && !wiringSignal.aborted) {

    await session.commit(patch);

    // The signal is read a second time, because the commit itself was an await and the envelope may have expired across it. A save the deadline overtakes is skipped
    // rather than forced, which leaves the migration staged for the user's own save - the weaker outcome, and the honest one.
    if(!wiringSignal.aborted) {

      await session.persist();
    }
  }
};

/* Await the wiring envelope here rather than at module top, so the page's chrome and every trigger above arm immediately instead of waiting on a bridge round trip.
 * show() still waits on it, which is the ordering that matters: the framework opens its own configuration session inside the launch path show() starts, so every
 * replica it hands to a hook is read after the migration has settled and none of them can commit a pre-migration snapshot over it.
 */
try {

  await withDeadline({ promise: wireRatgdoConfig(), seconds: WIRING_DEADLINE, signal: wiringSignal });
} catch(error) {

  wiringController.abort(error);

  // console is the browser panel's diagnostic transport; a migration that did not settle is a diagnostic, since the settings page loads either way and the next healthy
  // session migrates the configuration forward on its own.
  // eslint-disable-next-line no-console
  console.error("The configuration migration did not complete.", error);
}

// Await show() so this module's import settles with the page established rather than mid-launch - the loader awaits this module, so what it awaits is a page that has
// finished coming up. The first warm is the load announcement's, sent from inside the launch the moment the model loads.
await ui.show();
