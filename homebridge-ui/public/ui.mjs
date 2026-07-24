/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge Ratgdo webUI.
 */
import { FeatureOptions } from "homebridge-plugin-utils/featureOptions.js";
import { STATUS_EVENT } from "homebridge-plugin-utils/webui-status.js";
import { webUi } from "homebridge-plugin-utils/webUi.mjs";

// The warm-route literal, ratgdo's extension to the shared status protocol. It must stay in step with STATUS_WARM_ROUTE in src/webui-status.ts, the owner of the warm
// extension, because browser code cannot import from dist/. The warm route carries the whole sidebar's device list plus each device's effective key; the shared push
// event and view route belong to homebridge-plugin-utils and are handled by the imported statusPanel component, so this warm-extension route is the one bridge literal
// this module mirrors.
const STATUS_WARM_ROUTE = "/statusWarm";

// The addresses-route literal, ratgdo's identity-strip extension to the shared status protocol. It must stay in step with STATUS_ADDRESSES_ROUTE in src/webui-status.ts,
// the route's owner, because browser code cannot import from dist/. The route answers with the server's live discovery map - each device's mac to the address the status
// connection dials - which the strip's address row reads by device.serialNumber. Its response carries the whole projection; the request carries no body.
const STATUS_ADDRESSES_ROUTE = "/statusAddresses";

// The motion-latch fallback duration, in seconds, for the placeholder skeleton only. The authoritative snapshot rows carry the server's RATGDO_MOTION_DURATION on their
// own latch, so this fallback governs the clear-back only until the first snapshot arrives; browser code cannot import the server constant, so the fallback is local by
// necessity and the snapshot is the source of truth once it lands.
const MOTION_LATCH_FALLBACK_SECONDS = 5;

// The trailing-debounce window, in milliseconds, before a hook- or belt-driven warm recompute sends. It mirrors homebridge-plugin-utils' own persist coalescing window:
// the edit hook fires once per option mutation, so a burst of keystrokes into an encryption-key field would otherwise re-send a warm on every character and reconnect the
// device against a half-typed key. The debounce coalesces the burst into one warm carrying the settled value. The initial warm bypasses this and sends immediately.
const WARM_DEBOUNCE_MS = 300;

/* The warm-set recompute state. optionsCatalog caches the /getOptions catalog for the session - the FeatureOptions engine is rebuilt from live editedConfig on every
 * recompute, but the catalog's categories and option definitions are static, so it is fetched once. rememberedKeys is the warm set the server last received, keyed by mac
 * with the value being that mac's effective key (undefined recorded explicitly, so a tracked-keyless device is distinct from an untracked one); a recompute re-sends only
 * when this set would change, a send-suppression optimization over the server's authoritative diff. warmDebounceTimer is the trailing-debounce handle for the hook and
 * belt recompute paths.
 */
let optionsCatalog = null;
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

/* Recompute the warm set from the live device list and feature-option edits, and re-send it to the server when it would change. This is the single send path, reached
 * three ways - the initial warm, the onOptionsEdited hook, and the configChanged belt - so the diff-and-send logic lives in exactly one place. The whole body is guarded:
 * a failed lookup logs to the console and keeps the last-sent set rather than throwing out of a callback. The device list comes from the public HBPU device-list source
 * (never a hand-parse of the cached accessories), and each device's effective key comes from one FeatureOptions engine rebuilt from the live editedConfig against the
 * once-fetched catalog, so encryption-key inheritance resolves entirely through the engine. The remembered set records every mac explicitly with undefined meaning "no
 * key", so a keyless tracked device and an untracked one are distinguishable, and the send is suppressed unless a mac is new or a key differs - a redundant warm would be
 * a no-op at the server's authoritative diff, so suppressing it is purely an optimization.
 */
const recomputeWarmSet = async () => {

  try {

    optionsCatalog ??= await homebridge.request("/getOptions");

    const result = await ui.featureOptions.getHomebridgeDevices();
    const devices = result?.devices ?? [];
    const block = ui.featureOptions.editedConfig.find((entry) => entry.platform === "Ratgdo");
    const featureOptions = new FeatureOptions(optionsCatalog.categories, optionsCatalog.options, block?.options ?? []);
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
    // mac or a changed key at constant size. This premise - that an unchanged set needs no re-send - holds only against a living server that still holds the set; the
    // forced-resend paths (the restart-recovery hello and the foreground-visibility belt) clear the remembered keys first, so a helper restart or a lost send is healed
    // by the next forced trigger rather than staying suppressed.
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

/* Force a warm re-send: the recovery chokepoint both restart-recovery paths ride. It clears the send-suppression cache before scheduling the debounced recompute, because
 * that cache's premise - a re-send with an unchanged set is a no-op at the server - is false across a helper restart: a fresh server process starts with an empty warm
 * set, so a suppressed re-send would leave it starved. Clearing the remembered keys forces the next recompute to send. Routing through the debounced recompute
 * rather than an immediate one makes the debounce the serializer: a hello landing mid-keystroke coalesces with the typing burst instead of racing it with a
 * half-typed key, concurrent triggers (a hello and a foreground return together) collapse into one send, and the 300ms trailing delay is imperceptible beside the
 * roughly one-second connect floor. One honest bound: the boot-time initial warm bypasses this debounce, so a boot hello's debounced recompute can overlap the
 * initial warm's async body - both compute against the same live state, and the server's authoritative diff makes the double-send harmless, the same posture every
 * redundant send in this design rides.
 */
const forceWarmResend = () => {

  rememberedKeys = new Map();
  scheduleRecompute();
};

// The schema-form belt: a config edit made through Homebridge's own settings form (rather than the feature-options UI) surfaces only as configChanged, so it feeds the
// same debounced recompute the option-edit hook does, keeping the warm set current regardless of which surface changed a key.
homebridge.addEventListener("configChanged", scheduleRecompute);

/* The address-refresh trigger. ui.mjs registers its own page-lifetime STATUS_EVENT listener beside the configChanged belt - the same broadcast the shared panel consumes,
 * and multiple listeners are the host relay's natural fan-out, so this sibling consumer neither stops the event's propagation nor touches the panel's own handling; it
 * reads event.data and refreshes only. On every "connecting" push it refreshes the address cache. The timing argument that makes this sufficient: every device connects
 * fresh after page load, because the helper's connection pool dies with the page's socket, so a "connecting" push proves the server has just discovered that device's
 * address, and the helper-local round trip resolves well inside the device's own connect time - so the cache holds the address before the snapshot rebuild re-invokes the
 * identity fields. Refreshing on every "connecting" event, not only uncached macs, keeps a reconnect cycle's address current across a DHCP change at negligible cost.
 */
homebridge.addEventListener(STATUS_EVENT, (event) => {

  if(event.data?.kind === "connecting") {

    void refreshAddresses();
  }
});

/* The visibility belt: an iPad app switch kills and respawns the helper process, and the fresh process's hello may race the page's socket reattach, so a return to the
 * foreground forces a warm re-send directly. This is the deterministic cover for the suspend/resume path the hello relay alone cannot guarantee. Honest bounds: a forced
 * resend fired during the old helper's death window may be lost with its process - the next trigger heals it, since the triggers repeat and the posture is
 * fire-and-forget - and the cross-generation stale-token handoff bound the shared status union documents is inherited here: a belt resend racing a two-process handoff
 * can interleave old-generation pushes after a fresh adoption, a window that needs both processes alive across the resume, with the per-event generation field the
 * protocol's additive escape and field reports the tripwire.
 */
document.addEventListener("visibilitychange", () => {

  if(document.visibilityState === "visible") {

    forceWarmResend();
  }
});

/* The feature-options parameters. The statusPanel configuration supplies exactly the parts ratgdo owns and inherits the shared homebridge-plugin-utils panel around them:
 * the error-copy overrides for the reasons whose ratgdo wording differs from the component's credential-neutral defaults, the identity cells (Model, plus the monospace
 * MAC and IP address rows), and the placeholder rows the skeleton renders before the first snapshot. The row ids, labels, and sizers are ratgdo's vocabulary; the motion
 * row's placeholder latch is the fallback the snapshot's authoritative latch supersedes.
 */
const featureOptionsParams = {

  onOptionsEdited: scheduleRecompute,
  sidebar: { deviceLabel: "Ratgdo Devices" },
  statusPanel: {

    errorMessages: {

      "auth-invalid": { label: "Key mismatch", message: "The configured encryption key does not match the key in this device's YAML configuration." },
      "auth-missing": { label: "Key required", message: "This device requires its API encryption key. Set it with the Device Encryption Key feature option." },
      "not-found": { message: "This device was not discovered via mDNS." }
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

// Await show() before the first warm: editedConfig returns [] until show() has supplied the session, so warming before it would send every encrypted device a keyless
// entry and fail them all spuriously. Once show() has resolved, the initial warm sends immediately, bypassing the debounce that only the burst-prone hook and belt need.
await ui.show();

void recomputeWarmSet();
