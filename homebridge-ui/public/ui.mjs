/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge Ratgdo webUI.
 */
import { STATUS_ADDRESSES_ROUTE, STATUS_WARM_ROUTE } from "./status-routes.mjs";
import { FeatureOptions } from "homebridge-plugin-utils/featureOptions.js";
import { PluginConfigSession } from "homebridge-plugin-utils/pluginConfigSession.mjs";
import { STATUS_EVENT } from "homebridge-plugin-utils/webui-status.js";
import { makeRatgdoConfig } from "./ratgdo-config.mjs";
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

/* The warm-set recompute state. rememberedKeys is the warm set the server last received, keyed by mac with the value being that mac's effective key (undefined recorded
 * explicitly, so a tracked-keyless device is distinct from an untracked one); a recompute re-sends only when this set would change, a send-suppression optimization over
 * the server's authoritative diff. warmDebounceTimer is the trailing-debounce handle for the hook and belt recompute paths.
 */
let rememberedKeys = new Map();
let warmDebounceTimer = null;

/* The identity-strip address cache. deviceAddresses maps each device's mac - device.serialNumber, the same key the status pushes carry - to that device's live discovery
 * address, so the strip's address row reads the very address the status connection dials. It starts empty and is replaced wholesale by refreshAddresses on every resolved
 * round trip. addressRefreshInFlight is the coalescing latch that keeps a burst of "connecting" pushes from firing one request per device.
 */
let deviceAddresses = {};
let addressRefreshInFlight = false;

/* Fire the warm-route request and feed it to the shared panel's link-lost watchdog as its own liveness probe. The raw request promise is captured so the watch observes
 * it directly: a rejection must reach the watchdog's two-armed hook as a rejection, and the console diagnostic rides a separate chain off the same promise because
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
 * diagnostic rides a separate chain, since composing the watch after a .catch would blind the rejection-is-liveness path. The panel handle is read at call time
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

/* Recompute the warm set from the live device list and feature-option edits, and re-send it to the server when it would change. Every warm send funnels through this one
 * function, which gates on config-view establishment and epoch liveness before it sends, so the diff-and-send logic and the integrity conditions that guard it live in
 * exactly one place rather than being restated per trigger; the address-refresh request is a read and is deliberately outside this funnel. The whole body is guarded:
 * a failed lookup logs to the console and keeps the last-sent set rather than throwing out of a callback. The device list comes from the public HBPU device-list source
 * (never a hand-parse of the cached accessories), and each device's effective key comes from one FeatureOptions engine rebuilt from the live editedConfig against the
 * framework's page-lifetime catalog, which it fetches once and shares with every reader, so encryption-key inheritance resolves entirely through the engine. The
 * remembered set records every mac explicitly with undefined meaning "no key", so a keyless tracked device and an untracked one are distinguishable, and the send is
 * suppressed unless a mac is new or a key differs - a redundant warm would be a no-op at the server's authoritative diff, so suppressing it is purely an optimization.
 */
const recomputeWarmSet = async () => {

  try {

    const catalog = await ui.featureOptions.catalog();
    const devices = (await deviceList()).devices ?? [];

    /* The primary config block, read by position, whose absence is the establishment gate. The plugin-config session pins config[0] as the primary platform entry and the
     * editedConfig getter hands that entry back first on every read, and the array it reads is Ratgdo-only by the host's own construction - the server filters plugin
     * config by platform tag before it ever reaches the browser - so position is the durable identity for this plugin's block. Matching by the platform tag instead is
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
    const warm = [];
    const nextKeys = new Map();

    for(const device of devices) {

      const mac = device.serialNumber;

      if((typeof mac !== "string") || (mac.length === 0)) {

        continue;
      }

      const key = featureOptions.value("Device.Encryption.Key", mac);
      const psk = ((typeof key === "string") && (key.length > 0)) ? key : undefined;
      const entry = { mac };

      if(psk !== undefined) {

        entry.psk = psk;
      }

      warm.push(entry);
      nextKeys.set(mac, psk);
    }

    // Send-suppression: re-send only when the warm set would change. A size difference covers a device added to or removed from the list; the per-mac scan covers a new
    // mac or a changed key at constant size. This premise - that an unchanged set needs no re-send - holds only against a living server that still holds the set; every
    // forced-resend path clears the remembered keys first, so a helper restart or a lost send is healed by the next forced trigger rather than staying suppressed.
    let changed = (nextKeys.size !== rememberedKeys.size);

    if(!changed) {

      for(const [ mac, psk ] of nextKeys) {

        if(!rememberedKeys.has(mac) || (rememberedKeys.get(mac) !== psk)) {

          changed = true;

          break;
        }
      }
    }

    if(!changed) {

      return;
    }

    /* The epoch check, the last integrity condition on the send path. The debounce timer and this function's own awaits can outlive the module copy that armed them: a
     * panel reopen mints a successor and aborts this copy's epoch mid-flight, and nothing cancels an armed setTimeout or an in-flight recompute. Testing the epoch here,
     * as the last act before the request, retires the whole zombie class at the one place it becomes observable instead of enumerating a cleanup per resource. Everything
     * above this line is read-only, so a late-firing recompute that bails here costs nothing beyond its own computation, and the check sits ahead of the remembered-key
     * assignment so a refused send leaves the retired copy's module state untouched entirely.
     */
    if(ui.epochSignal.aborted) {

      return;
    }

    rememberedKeys = nextKeys;

    // Reset the component's per-device stale-push guard. A warm re-send re-elicits the pool's pushes, so the guard's highest-seen floors must clear or the fresh pushes
    // would be dropped against stale tokens; the handle is read at call time because it is minted per show() and must never be captured. Safe by construction: tokens are
    // monotonic within a feed lifetime and the feed's session-identity guard is the real stale-push protection, so clearing the floors cannot admit a superseded push.
    ui.featureOptions.statusPanel?.resetStaleGuards();

    requestRoute(STATUS_WARM_ROUTE, { devices: warm });
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

/* Force a warm re-send: the recovery chokepoint every restart-recovery path rides. It clears the send-suppression cache before scheduling the debounced recompute,
 * because that cache's premise - a re-send with an unchanged set is a no-op at the server - is false across a helper restart: a fresh server process starts with an empty
 * warm set, so a suppressed re-send would leave it starved. Clearing the remembered keys forces the next recompute to send. Routing through the debounced recompute
 * rather than an immediate one makes the debounce the serializer: a hello landing mid-keystroke coalesces with the typing burst instead of racing it with a
 * half-typed key, concurrent triggers (a hello and a foreground return together) collapse into one send, and the 300ms trailing delay is imperceptible beside the
 * roughly one-second connect floor. One honest bound: the load announcement's warm bypasses this debounce, so a hello arriving during a launch can have its debounced
 * recompute overlap that announcement's async body - both compute against the same live state, and the server's authoritative diff makes the double-send harmless,
 * which is the posture every redundant send in this design takes.
 */
const forceWarmResend = () => {

  rememberedKeys = new Map();
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
  }
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
 * must outlive any single panel mount and end only when a successor webUi construction claims the window; they ride the framework's ui.on, which composes the page epoch
 * into every registration it makes, so a retired copy stops receiving events at all rather than driving the live copy's state from a stale closure. They register after
 * construction because the facade that makes the registration must exist first, and before show() because a trigger arriving during the launch is answered honestly by
 * the recompute's own establishment gate. One bounded caveat: the composed { signal } option rides the native EventTarget, which every browser the Homebridge UI supports
 * provides, while the bridge library carries a legacy constructor polyfill whose listener registration drops its options argument - on that path a retired copy's
 * listeners survive, and the recompute's pre-send epoch check is the correctness backstop, degrading the hazard from a wrong send to a wasted recompute.
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
 * the helper process may have been replaced, so the whole-pool re-send rides it. The framework bounds this subscription by the epoch itself, and the send chokepoint's
 * establishment and epoch gates bound what it produces exactly as they bound every other trigger.
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
 * epoch-composition rule - the same rule every listener registration rides. The epoch half matters because a reopened settings panel mints a successor copy and
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

  const ratgdoConfig = makeRatgdoConfig({ FeatureOptions, catalog: await ui.featureOptions.catalog() });

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
