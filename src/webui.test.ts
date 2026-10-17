/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui.test.ts: The settings page's trigger paths, exercised against the REAL homebridge-ui/public/ui.mjs running under a boundary double for the webUI framework.
 * Covers the boot warm, the trailing debounce, the send-suppression diff, every forced-resend belt, the address-refresh latch and the identity strip it feeds, the
 * feature-options parameters the page declares, the legacy-settings migration's write path, and the shared route constants both halves address.
 *
 * The page is the real module, not a re-implementation: the harness routes its framework specifiers to the shipped browser files and its webUI shell to the double,
 * so the feature-option engine that resolves each device's key and the configuration session that stages the migration are the library's own. What the fakes observe
 * is therefore the page's behavior rather than a restatement of it - the host's request log, the listener records each fake keeps for what the page registered on
 * it, the double's counters, and the fake document's state.
 */
import type { FakeCatalog, FakeConfigEntry, FakeDevice, FakeElement, RecordedLog } from "./webui-double.helpers.ts";
import { LIBRARY_UI_DIR, loadUi } from "./webui.helpers.ts";
import { STATUS_ADDRESSES_ROUTE, STATUS_PROBE_ROUTE, STATUS_WARM_ROUTE, defaultConfig, defaultDevices, fire, realCatalog, webUi } from "./webui-double.helpers.ts";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import type { LoadedUi } from "./webui.helpers.ts";
import { RATGDO_VARIANT_LABELS } from "./types.ts";
import assert from "node:assert/strict";
import { settle } from "homebridge-plugin-utils/testing";

// The two fixture devices' macs, and the key configured against the first of them.
const MAC = "AABBCCDDEEFF";
const MAC_TWO = "112233445566";
const KEY = "c2VjcmV0LWtleQ==";

// A primary platform entry carrying the given option entries, which is the one shape every configuration test in this file varies.
const configWith = (...options: string[]): FakeConfigEntry[] => [{ name: "Ratgdo", options, platform: "Ratgdo" }];

// The device-scoped encryption-key entry the real feature-option engine resolves into a warm entry's psk.
const keyEntry = (mac: string, key: string): string => "Enable.Device.Encryption.Key." + mac + "=" + key;

/* The log-name entry the engine resolves into a warm entry's logName, at whichever scope the caller addresses. Passing no mac composes the global entry, which is what
 * lets one helper describe both halves of the inheritance the page leaves entirely to the engine.
 */
const logNameEntry = (name: string, mac?: string): string => "Enable.Device.LogName" + ((mac === undefined) ? "" : ("." + mac)) + "=" + name;

// Every warm request the page has sent, in order. Reading the log by route is how each test counts sends without depending on what else the page asked for.
const warmSends = (page: LoadedUi): unknown[] => page.host.requests.filter((entry) => (entry.route === STATUS_WARM_ROUTE)).map((entry) => entry.body);

/* Rewrite the primary config entry's option entries the way an edit through the feature-options UI does, so the page's next recompute resolves against them. The
 * entry's presence is asserted rather than guarded, because a fixture without one describes no install the page could ever run against.
 */
const setOptions = (page: LoadedUi, ...options: string[]): void => {

  const primary = page.double.featureOptions.editedConfig[0];

  assert.ok(primary, "the fixture configuration carries a primary platform entry");

  primary["options"] = options;
};

// Let the debounce window elapse on the mocked clock and the recompute it releases come to rest, which is the pair every trigger test needs before it counts sends.
const releaseDebounce = async (timers: { tick: (milliseconds: number) => void }): Promise<void> => {

  timers.tick(300);

  await settle();
};

describe("the ratgdo settings page", () => {

  describe("the first warm", () => {

    test("sends once from the load announcement, carrying every device and the key the engine resolves", async () => {

      using page = await loadUi({ config: configWith(keyEntry(MAC, KEY)) });

      const sends = warmSends(page);

      assert.ok(page.double.params.onLoaded, "the page answers the framework's load announcement, which is what carries its first warm");
      assert.equal(page.double.showCalls, 1, "the page ran exactly one show cycle");
      assert.equal(sends.length, 1, "establishing the page sends exactly one warm");
      assert.deepEqual(sends[0], { addresses: [], devices: [ { mac: MAC, psk: KEY }, { mac: MAC_TWO } ] },
        "the warm lists every device, carrying the configured key for the device that has one and no key for the device that does not");

      const warm = page.host.requests.find((entry) => (entry.route === STATUS_WARM_ROUTE));

      assert.ok(warm, "the warm send reached the host");
      assert.ok(page.double.featureOptions.statusPanel.watched.includes(warm.answer),
        "the panel's handle already existed when the announcement sent, so the first warm is watched rather than unobserved");
    });

    test("a launch that never establishes sends nothing, and the relaunch that establishes warms at once", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi({ failNextShow: true });

      assert.equal(page.double.showCalls, 1, "the failed launch is a cycle that happened");
      assert.equal(warmSends(page).length, 0, "a cycle that never reached a loaded model announces nothing, so nothing is sent");

      // The menu's re-launch recovery runs another show cycle, which establishes and announces.
      await page.double.show();
      await settle();

      assert.equal(warmSends(page).length, 1, "the relaunch that establishes the page warms at once rather than waiting for the next trigger");

      await page.double.show();
      await settle();

      assert.equal(warmSends(page).length, 1, "a further cycle over unchanged keys re-sends nothing");

      setOptions(page, keyEntry(MAC, KEY));

      await page.double.show();
      await settle();

      assert.equal(warmSends(page).length, 2, "a cycle after a key moved sends once");
    });

    test("a catalog read that fails sends nothing and reports the diagnostic, and the next trigger sends once it resolves", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      /* The read fails for as long as the flag stands. Both of the page's catalog readers are served by this one override - the configuration wiring reads it at load
       * and the recompute reads it on every send - so the flag governs the whole page rather than a counted read whose number would depend on their ordering.
       */
      let failing = true;
      const catalog = async (): Promise<FakeCatalog> => {

        if(failing) {

          throw new Error("The option catalog could not be read.");
        }

        return realCatalog();
      };

      using page = await loadUi({ catalog });

      assert.equal(warmSends(page).length, 0, "a page that cannot read its option catalog sends no warm rather than one computed keyless");
      assert.ok(page.console.errors.some((entry) => (entry.message === "The device warm set could not be recomputed.")),
        "the failed recompute reports its own diagnostic");

      // The accessor cleared its memo on each rejection, so the next trigger reaches a fresh read - which now resolves.
      failing = false;
      page.double.resume();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, 1, "the trigger after a recovered catalog read sends once");
    });
  });

  describe("the trailing debounce", () => {

    test("coalesces a burst of option edits into one send at the end of the window", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;

      // Two edits inside one window, each of them changing the resolved key, so nothing but the debounce can explain a single send.
      setOptions(page, keyEntry(MAC, "first"));
      page.double.params.onOptionsEdited?.();
      t.mock.timers.tick(299);

      await settle();

      assert.equal(warmSends(page).length, before, "nothing is sent while the debounce window is still open");

      setOptions(page, keyEntry(MAC, "second"));
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      const sends = warmSends(page);

      assert.equal(sends.length, before + 1, "the burst coalesces into exactly one send");
      assert.deepEqual(sends.at(-1), { addresses: [], devices: [ { mac: MAC, psk: "second" }, { mac: MAC_TWO } ] },
        "the one send carries the settled value, not the half-typed one");
    });
  });

  describe("send suppression", () => {

    test("re-sends only when a key would change", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;

      // An edit hook firing against an unchanged configuration recomputes the same set, which the diff suppresses.
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before, "a recompute over unchanged keys sends nothing");

      setOptions(page, keyEntry(MAC, KEY));
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "a changed key sends once");
    });
  });

  describe("the log names the warm payload carries", () => {

    test("carries the name the engine resolves at the device's own scope and at the global one, and omits it for a device with neither", async () => {

      // Two devices and two scopes in one fixture: the first device's own entry, and a global entry the second device inherits. Resolution is the engine's alone, so
      // what this asserts is that the page reads the option at each device's identity and sends exactly what came back.
      using page = await loadUi({ config: configWith(logNameEntry("North Door", MAC)) });

      assert.deepEqual(warmSends(page)[0], { addresses: [], devices: [ { logName: "North Door", mac: MAC }, { mac: MAC_TWO } ] },
        "the named device carries its name and the unnamed one carries no logName field at all");

      using global = await loadUi({ config: configWith(logNameEntry("Every Opener")) });

      assert.deepEqual(warmSends(global)[0], { addresses: [], devices: [ { logName: "Every Opener", mac: MAC }, { logName: "Every Opener", mac: MAC_TWO } ] },
        "a global entry reaches every device, because the page asks the engine rather than reading the entry itself");
    });

    test("re-sends for a log-name-only edit and stays suppressed when nothing moved", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi({ config: configWith(keyEntry(MAC, KEY)) });

      const before = warmSends(page).length;

      // A name is not a key, so this edit moves no field the old per-mac key memory could have seen. It re-sends because the payload itself spells differently.
      setOptions(page, keyEntry(MAC, KEY), logNameEntry("North Door", MAC));
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      const sends = warmSends(page);

      assert.equal(sends.length, before + 1, "an edit that changed only a log name sends once");
      assert.deepEqual(sends.at(-1), { addresses: [], devices: [ { logName: "North Door", mac: MAC, psk: KEY }, { mac: MAC_TWO } ] },
        "the send carries the new name beside the unchanged key");

      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "a recompute over the same names and keys sends nothing");
    });

    test("tells an omitted field from a present one, so a name and a key cannot be confused for each other", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      /* The distinguishing input for a signature that collapses its fields: one device moves its key from "x" to nothing while another takes the name "x". A
       * comparison over a flattened set of values would read those two edits as no change at all, where a fixed-position tuple reads them as two.
       */
      using page = await loadUi({ config: configWith(keyEntry(MAC, "x")) });

      const before = warmSends(page).length;

      setOptions(page, logNameEntry("x", MAC_TWO));
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "dropping one device's key while another takes that same text as its name is a change, and it sends");
      assert.deepEqual(warmSends(page).at(-1), { addresses: [], devices: [ { mac: MAC }, { logName: "x", mac: MAC_TWO } ] },
        "the payload carries the key's removal and the name's arrival together");
    });
  });

  describe("the manual addresses the warm payload carries", () => {

    test("carries every listed address with the key the engine resolves at that address's own identity", async () => {

      /* The key for a manually addressed device is stored under the ADDRESS, because a device nobody has connected to yet has no mac anyone knows. The three
       * address shapes are here together because each one reaches the engine's stored form differently: an IPv4 address and a hostname both carry periods the
       * stored form gives meaning to, while an IPv6 literal's colons pass through untouched.
       */
      using page = await loadUi({ config: configWith(
        "Enable.Device.Address=10.0.0.20, garage.local, fd00::1",
        "Enable.Device.Encryption.Key.10-0-0-20=" + KEY,
        "Enable.Device.Encryption.Key.garage-local=hostname-key",
        "Enable.Device.Encryption.Key.fd00::1=literal-key"
      ) });

      const sent = warmSends(page)[0] as { addresses: unknown[] };

      assert.deepEqual(sent.addresses, [ { address: "10.0.0.20", psk: KEY }, { address: "garage.local", psk: "hostname-key" },
        { address: "fd00::1", psk: "literal-key" } ],
      "each listed address travels with the key stored at its own identity, in the order the user listed them");
    });

    test("carries a listed address with no key at all, and omits the list entirely for an install that has none", async () => {

      using none = await loadUi();

      assert.deepEqual((warmSends(none)[0] as { addresses: unknown[] }).addresses, [], "an install listing no address sends an empty list rather than nothing");

      using listed = await loadUi({ config: configWith("Enable.Device.Address=10.0.0.20") });

      assert.deepEqual((warmSends(listed)[0] as { addresses: unknown[] }).addresses, [{ address: "10.0.0.20" }],
        "an address the user has set no key for carries no psk field, exactly as a keyless device does");
    });

    test("re-sends when an address is added and stays suppressed when the list has not moved", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;

      setOptions(page, "Enable.Device.Address=10.0.0.20");
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "adding an address sends once");

      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "a recompute over the same list sends nothing");

      setOptions(page, "Enable.Device.Address=10.0.0.20", "Enable.Device.Encryption.Key.10-0-0-20=" + KEY);
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 2, "a key set against a listed address is a change the signature sees, so it sends");
    });
  });

  describe("the forced-resend belts", () => {

    test("the visibility belt re-sends an unchanged set on a return to the foreground", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;

      page.document.visibilityState = "visible";
      fire(page.document, "visibilitychange");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "returning to the foreground forces exactly one re-send");
    });

    test("the visibility belt stays quiet while the page is hidden", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;

      page.document.visibilityState = "hidden";
      fire(page.document, "visibilitychange");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before, "a page going into the background forces nothing");
    });

    test("the resume trigger re-sends an unchanged set after a page froze and woke", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;

      page.double.resume();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "a wake forces exactly one re-send");
    });

    test("a server hello re-sends an unchanged set after a helper restart", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;

      page.double.params.statusPanel?.onServerHello?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "a fresh helper's hello forces exactly one re-send");
    });

    test("the schema-form belt recomputes without forcing, so an unchanged set stays suppressed", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;

      // configChanged feeds the plain debounced recompute rather than the forced chokepoint, so the diff still governs whether it sends.
      fire(page.host, "configChanged");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before, "a config change over unchanged keys sends nothing");

      setOptions(page, keyEntry(MAC, KEY));
      fire(page.host, "configChanged");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "a config change that moved a key sends once");
    });
  });

  describe("the identity strip's addresses", () => {

    test("coalesces a connecting burst into one address read and renders the address it returns", async () => {

      using page = await loadUi({ addresses: { [MAC]: "192.0.2.10" } });

      const before = page.host.requests.filter((entry) => (entry.route === STATUS_ADDRESSES_ROUTE)).length;

      for(let push = 0; push < 3; push++) {

        fire(page.host, "status", { data: { kind: "connecting" } });
      }

      await settle();

      assert.equal(page.host.requests.filter((entry) => (entry.route === STATUS_ADDRESSES_ROUTE)).length, before + 1,
        "a burst of connecting pushes coalesces into one address read");

      const identity = page.double.params.statusPanel?.identity;

      assert.ok(identity, "the page declares the identity cells");

      const known = identity({ model: "Ratgdo Disco", name: "Garage", serialNumber: MAC });
      const unknown = identity({ model: "Ratgdo Disco", name: "Elsewhere", serialNumber: "FFEEDDCCBBAA" });

      assert.equal(known.find((row) => (row.label === "IP Address"))?.value, "192.0.2.10", "a discovered device renders the address the status connection dials");
      assert.equal(unknown.find((row) => (row.label === "IP Address"))?.value, "", "a device the server has not discovered renders an empty address");
    });
  });

  describe("the feature-options parameters", () => {

    test("declares the panel copy, the sidebar label, and the placeholder rows, and watches the warm request", async () => {

      using page = await loadUi();

      const panel = page.double.params.statusPanel;

      assert.deepEqual(Object.keys(panel?.errorMessages ?? {}).sort(), [ "auth-invalid", "auth-missing", "not-found", "unsupported" ],
        "the page overrides exactly the reasons whose ratgdo wording differs from the framework's defaults");
      assert.match(panel?.errorMessages?.["unsupported"]?.message ?? "", /firmware/,
        "the unsupported copy tells an opener's user which side to update rather than naming the protocol");
      assert.equal(page.double.params.sidebar?.deviceLabel, "Ratgdo Devices", "the sidebar names the devices the way an opener's user reads them");
      assert.ok(page.double.params.sidebar?.groupOrder, "the sidebar carries the comparator that orders its variant groups");
      assert.deepEqual(panel?.placeholderRows?.map((row) => row.id), [ "door", "lock", "motion", "light", "obstruction" ],
        "the placeholder skeleton carries a row per status the panel renders");

      const watched = page.double.featureOptions.statusPanel.watched;
      const warm = page.host.requests.find((entry) => (entry.route === STATUS_WARM_ROUTE));

      assert.equal(watched.length, 1, "the boot warm is the one request the panel's link-lost watchdog is watching");
      assert.equal(watched[0], warm?.answer, "the watchdog observes the warm request itself, so a rejection reaches it as a rejection");
    });
  });

  describe("the legacy-settings migration", () => {

    test("stages and saves a configuration carrying a legacy property", async () => {

      using page = await loadUi({ config: [{ mqttUrl: "mqtt://127.0.0.1:1883", name: "Ratgdo", platform: "Ratgdo" }] });

      assert.equal(page.host.updates.length, 1, "the migration stages exactly one configuration edit");
      assert.equal(page.host.saves, 1, "the migration writes that edit to disk itself rather than waiting for the user's own save");

      const primary = page.host.updates[0]?.[0];

      assert.ok(primary, "the staged configuration carries a primary platform entry");

      const options = primary["options"];

      assert.ok(Array.isArray(options), "the staged primary entry carries an options array");
      assert.ok((options as string[]).some((entry) => entry.startsWith("Enable.Mqtt.Url=")), "the broker URL moved into its feature option");
      assert.equal(primary["mqttUrl"], undefined, "the consumed legacy property is staged for deletion");
    });

    test("touches the disk not at all for a configuration with nothing to migrate", async () => {

      using page = await loadUi({ config: defaultConfig() });

      assert.equal(page.host.updates.length, 0, "a migrated configuration stages nothing");
      assert.equal(page.host.saves, 0, "a migrated configuration saves nothing");
    });
  });

  describe("the sidebar's variant groups", () => {

    test("tags each device with the family word its Model opens with, and leaves a device with no Model untagged", async () => {

      using page = await loadUi({ devices: [

        { model: "Ratgdo Disco", name: "Garage", serialNumber: MAC },
        { model: "Konnected GDOv2-Q", name: "Side Door", serialNumber: MAC_TWO },
        { model: "Konnected", name: "Bare", serialNumber: "AABBCCDDEE01" },
        { model: 42, name: "Nameless", serialNumber: "AABBCCDDEE02" }
      ] });

      const getDevices = page.double.params.getDevices;

      assert.ok(getDevices, "the page supplies its own device source");

      // The framework calls the hook with the selected controller and a bag carrying the live platform config, so the test calls it the same way.
      const result = await getDevices(null, { config: {} });

      assert.equal(result.error, "", "the hook hands back the framework's own result object, carrying its empty error");
      assert.deepEqual(result.devices.map((device) => device.sidebarGroup), [ "Ratgdo", "Konnected", "Konnected", undefined ],
        "each device groups under the family word its Model opens with, and a Model that is not text leaves the device untagged");
      assert.deepEqual(result.devices.map((device) => device.name), [ "Garage", "Side Door", "Bare", "Nameless" ], "the hook returns the same devices it was given");
    });

    test("orders the Ratgdo section ahead of the Konnected one, and an unnamed group after both", async () => {

      using page = await loadUi();

      const groupOrder = page.double.params.sidebar?.groupOrder;

      assert.ok(groupOrder, "the page supplies the sidebar's group comparator");
      assert.ok(groupOrder("Ratgdo", "Konnected") < 0, "the Ratgdo section sorts ahead of the Konnected one");
      assert.ok(groupOrder("Konnected", "Ratgdo") > 0, "the comparator is consistent when its arguments are reversed");
      assert.ok(groupOrder("Konnected", "Something") < 0, "a group the order does not name sorts after both named ones");
      assert.ok(groupOrder("Ratgdo", "Something") < 0, "a group the order does not name sorts after the Ratgdo section too");
      assert.ok(groupOrder("Another", "Something") < 0, "two unnamed groups fall back to locale order");
    });

    test("the grouped device source leaves the warm set it feeds unchanged", async () => {

      using page = await loadUi({ config: configWith(keyEntry(MAC, KEY)) });

      assert.deepEqual(warmSends(page)[0], { addresses: [], devices: [ { mac: MAC, psk: KEY }, { mac: MAC_TWO } ] },
        "tagging a row for the sidebar adds nothing to the warm body the server receives");
    });
  });

  describe("the variant visibility hooks", () => {

    // One sidebar device of each variant as the page's own device source tags them, plus the row whose Model the page could not read and therefore left untagged.
    const ratgdoDevice: FakeDevice = { model: "Ratgdo Disco", name: "Garage", serialNumber: MAC, sidebarGroup: "Ratgdo" };
    const konnectedDevice: FakeDevice = { model: "Konnected GDOv2-Q", name: "Side Door", serialNumber: MAC_TWO, sidebarGroup: "Konnected" };
    const untaggedDevice: FakeDevice = { model: 42, name: "Nameless", serialNumber: "AABBCCDDEE02" };

    /* The categories a device's page offers, and the options one of its sections offers, read off the REAL served catalog through the very hooks the page handed the
     * framework. Driving the whole catalog rather than a fixture of its own is what ties these assertions to what a user actually sees: a category or option whose
     * declaration moves shows up here without a line changing.
     */
    const visibleCategories = (page: LoadedUi, device: FakeDevice | undefined): string[] => {

      return featureOptionCategories.filter((category) => page.double.params.ui?.validOptionCategory?.(device, category)).map((category) => category.name);
    };

    const visibleOptions = (page: LoadedUi, device: FakeDevice | undefined, category: string): string[] => {

      return (featureOptions[category] ?? []).filter((option) => page.double.params.ui?.validOption?.(device, option)).map((option) => option.name);
    };

    test("hands the framework both hooks", async () => {

      using page = await loadUi();

      assert.ok(page.double.params.ui?.validOption, "the page declares the option visibility hook");
      assert.ok(page.double.params.ui?.validOptionCategory, "the page declares the category visibility hook");
    });

    test("offers a Ratgdo device its own hardware sections and withholds the other variant's", async () => {

      using page = await loadUi();

      assert.deepEqual(visibleCategories(page, ratgdoDevice), [ "Device", "Log", "Opener", "Light", "Motion", "Mqtt", "Disco" ],
        "a Ratgdo device is offered every shared section plus Motion and Disco, and is not offered the Konnected section");
    });

    test("offers a Konnected device its own hardware section and withholds the Ratgdo-only ones", async () => {

      using page = await loadUi();

      assert.deepEqual(visibleCategories(page, konnectedDevice), [ "Device", "Log", "Opener", "Light", "Mqtt", "Konnected" ],
        "a Konnected device is offered every shared section plus Konnected, and is offered neither Motion nor Disco");
    });

    test("offers the global page every section, since it configures no one device", async () => {

      using page = await loadUi();

      assert.deepEqual(visibleCategories(page, undefined), [ "Device", "Log", "Opener", "Light", "Motion", "Mqtt", "Disco", "Konnected" ],
        "with no device in scope every section is offered, which is what the global page means");
    });

    test("offers a device it could not classify every section rather than none", async () => {

      using page = await loadUi();

      assert.deepEqual(visibleCategories(page, untaggedDevice), [ "Device", "Log", "Opener", "Light", "Motion", "Mqtt", "Disco", "Konnected" ],
        "a device carrying no group word is offered everything, so an unreadable Model costs a user rows they can ignore rather than rows they cannot reach");
    });

    test("withholds the vehicle-presence log from a Konnected device and keeps every other logging row", async () => {

      using page = await loadUi();

      assert.deepEqual(visibleOptions(page, konnectedDevice, "Log"), [ "Debug", "Opener", "Light", "Motion", "Obstruction" ],
        "the vehicle-presence log names the Ratgdo variant and drops off a Konnected device's page, while the motion log - the door-open indicator Konnected drives " +
        "too - stays");
      assert.deepEqual(visibleOptions(page, ratgdoDevice, "Log"), [ "Debug", "Opener", "Light", "Motion", "Obstruction", "VehiclePresence" ],
        "a Ratgdo device is offered the whole logging section, the vehicle-presence row included");
      assert.deepEqual(visibleOptions(page, undefined, "Log"), [ "Debug", "Opener", "Light", "Motion", "Obstruction", "VehiclePresence" ],
        "the global page is offered the whole logging section");
    });

    test("bridges a device's group word to a variant key by lowercasing it, which is the pairing the plugin declares", () => {

      for(const [ variant, label ] of Object.entries(RATGDO_VARIANT_LABELS)) {

        assert.equal(label.toLowerCase(), variant,
          "the " + label + " family word lowercases to the variant key the catalog declares, which is the fold the page's visibility rule rests on");
      }
    });
  });

  describe("the shared status routes", () => {

    test("addresses the bridge through the constants the UI server reads", async () => {

      using page = await loadUi({ addresses: { [MAC]: "192.0.2.10" } });

      fire(page.host, "status", { data: { kind: "connecting" } });

      await settle();

      const routes = page.host.requests.map((entry) => entry.route);

      assert.ok(routes.includes(STATUS_WARM_ROUTE), "the warm send addresses the shared warm route");
      assert.ok(routes.includes(STATUS_ADDRESSES_ROUTE), "the address read addresses the shared addresses route");
      assert.equal(defaultDevices().length, 2, "the default fixture install advertises one device of each variant");
    });
  });
});

/* The Add Device card, exercised against the real page building real elements into the recording document.
 *
 * Everything below reads the card off what the page BUILT - the button text it wrote, the fields it labelled, the verdict it rendered - rather than off a structure
 * this file describes. That is the whole reason the card is constructed at runtime rather than declared in markup: a card the page builds is a card the harness can
 * hold, and a change to its copy or its shape has to come through here.
 */
describe("the ratgdo settings page's Add Device card", () => {

  // A probe answer describing a device that responded, which is the input every save row starts from.
  const ANSWERED = { address: "10.0.0.20", encrypted: true, firmwareVersion: "2.0.0", kind: "ok", mac: MAC, model: "Ratgdo Disco", name: "North Door",
    variant: "ratgdo" };

  // Find one element the page built, by the text it carries. Reading by text is how a row addresses a button the way a user would - by what it says.
  const byText = (page: LoadedUi, text: string): FakeElement => {

    const found = page.findElement((element) => (element.textContent === text));

    assert.ok(found, "the page built an element reading " + JSON.stringify(text));

    return found;
  };

  /* Open the card and hand back what a row drives and reads, so each row says what it is doing rather than re-finding elements. The verdict line is captured here, by
   * its role, while the card is held, and every verdict a row reads is read through this element. A released card has left the page, so a walk of the page's
   * tree would read an empty string whether or not a retired action had painted into the card - and a row asserting that nothing was painted would pass against a
   * card that was painted.
   */
  const openCard = (page: LoadedUi): { address: FakeElement; key: FakeElement; region: FakeElement; save: FakeElement; test: FakeElement; verdict: FakeElement } => {

    fire(byText(page, "Add Device"), "click");

    const address = page.document.getElementById("ratgdoAddressField");
    const key = page.document.getElementById("ratgdoKeyField");
    const verdict = page.findElement((element) => (element.attributes["role"] === "status"));
    const region = address?.parentElement;

    assert.ok(address && key && verdict && region, "the open card stands in the page with its address and key fields and its verdict line");

    return { address, key, region, save: byText(page, "Save"), test: byText(page, "Test Connection"), verdict };
  };

  // Whether the card is held: standing in the page inside the framework's takeover element, which the page's tree carries only for as long as the takeover lasts.
  const isHeld = (page: LoadedUi, region: FakeElement): boolean => {

    const container = region.parentElement;

    return (container !== null) && Object.hasOwn(container.attributes, "data-fo-takeover") && (page.findElement((element) => (element === container)) !== null);
  };

  // Every takeover element standing in the main content, where the framework inserts one. The count is what tells a takeover that replaced the standing one from one
  // stacked beside it.
  const takeovers = (page: LoadedUi): FakeElement[] => page.document.getElementById("deviceStatsContainer")?.parentElement?.children
    .filter((child) => Object.hasOwn(child.attributes, "data-fo-takeover")) ?? [];

  // The diagnostics a failed connection test writes to the console. A retired test has no failure to report, so a row about one reads this as empty.
  const probeDiagnostics = (page: LoadedUi): RecordedLog[] => page.console.errors.filter((entry) => (entry.message === "The device connection test failed."));

  describe("mounting", () => {

    test("inserts its button at the top of the sidebar, and stands the card ahead of the settings content only once it is opened", async () => {

      using page = await loadUi();

      const sidebar = page.document.getElementById("sidebar");
      const stats = page.document.getElementById("deviceStatsContainer");

      assert.ok(sidebar && stats, "the page markup carries the sidebar and the device-stats region");

      const launcher = sidebar.children[0];

      assert.ok(launcher, "the sidebar carries a first child");
      assert.ok(Object.hasOwn(launcher.attributes, "data-fo-region"),
        "the button sits in a plugin-owned region, so the framework hides and reveals it with the page and never clears it");
      assert.equal(launcher.children[0]?.textContent, "Add Device", "and that region holds the Add Device button");
      assert.equal(sidebar.children[1]?.className, "sidebar-content", "the framework's own sidebar content is still there, after the inserted region");
      assert.equal(page.findElement((element) => (element.textContent === "Add a device by address")), null,
        "the card is not in the page until it is opened - mounting it is not opening it");

      const card = openCard(page);
      const main = stats.parentElement;
      const container = card.region.parentElement;

      assert.ok(main && container, "the opened card stands inside an element in the main content");
      assert.ok(Object.hasOwn(container.attributes, "data-fo-takeover"), "opening hands the card to the framework's takeover, which holds it in an element of its own");
      assert.equal(container.parentElement, main, "that element sits in the main content");
      assert.equal(main.children.indexOf(container) + 1, main.children.indexOf(stats), "immediately ahead of the framework's device-stats region");
    });

    test("builds the card's copy, its labelled fields, and its three actions", async () => {

      using page = await loadUi();

      fire(byText(page, "Add Device"), "click");

      const address = page.document.getElementById("ratgdoAddressField");
      const key = page.document.getElementById("ratgdoKeyField");

      assert.ok(address && key, "both fields exist and carry ids, which is what a label's for attribute resolves against");
      assert.equal(address.attributes["placeholder"], "garage.local or 10.0.0.20", "the address field shows both address shapes a user might type");
      assert.ok(address.className.split(" ").includes("fo-monospace") && key.className.split(" ").includes("fo-monospace"),
        "both fields wear the page kit's monospace, since both carry exact text");
      assert.ok(address.parentElement?.className.split(" ").includes("fo-page"),
        "the card region carries the page-kit marker, so the framework's dark-mode form-control corrections reach its fields");
      assert.equal(byText(page, "Address").attributes["for"], "ratgdoAddressField", "the address label is associated with its field");
      assert.equal(byText(page, "Encryption key (optional)").attributes["for"], "ratgdoKeyField", "and the key label with its own, naming the key as optional");

      for(const label of [ "Test Connection", "Save", "Cancel" ]) {

        assert.ok(byText(page, label), "the card offers " + label);
      }

      assert.ok(page.findElement((element) => (element.attributes["role"] === "status")), "the verdict line is a status region, so each verdict is announced");
    });

    test("mounts once for the page's life, and a later show cycle ends the takeover rather than rebuilding the card", async () => {

      using page = await loadUi();

      const sidebar = page.document.getElementById("sidebar");
      const card = openCard(page);

      assert.ok(isHeld(page, card.region), "the card is open");

      await page.double.show();
      await settle();

      assert.equal(sidebar?.children.filter((child) => Object.hasOwn(child.attributes, "data-fo-region")).length, 1,
        "a second cycle builds no second button - the framework promises never to clear a plugin region, so rebuilding would only duplicate it");
      assert.equal(isHeld(page, card.region), false, "and the new cycle ends the takeover, so the card leaves the page");
    });

    test("gives the content area back on Cancel, and the launcher reopens the card with its fields and verdict cleared", async () => {

      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      card.key.value = KEY;
      fire(card.test, "click");

      await settle();

      assert.equal(card.verdict.textContent, "This device answered.", "the card has a verdict standing before it closes");

      fire(byText(page, "Cancel"), "click");

      assert.equal(isHeld(page, card.region), false, "Cancel releases the takeover, so the card leaves the page");

      const reopened = openCard(page);

      assert.equal(reopened.region, card.region, "the launcher reopens the same card rather than building another");
      assert.ok(isHeld(page, reopened.region), "the card is held again");
      assert.equal(reopened.address.value, "", "the address field opens empty");
      assert.equal(reopened.key.value, "", "and so does the key field");
      assert.equal(reopened.verdict.textContent, "", "and the verdict from the last visit is gone");
    });

    test("leaves the page when a re-show fails, and the launcher opens it again once a cycle establishes", async () => {

      using page = await loadUi();

      const card = openCard(page);

      page.double.failNextShow = true;

      await page.double.show();
      await settle();

      assert.equal(isHeld(page, card.region), false, "a re-show tears the standing cycle down before it fails, so the card leaves the page");

      await page.double.show();
      await settle();

      const reopened = openCard(page);

      assert.ok(isHeld(page, reopened.region), "the next cycle that establishes gives the area again, and the launcher opens the card into it");
    });

    test("a second open while the card is held ends the first takeover, clears the card, and retires the test in flight", async () => {

      const answer = Promise.withResolvers<unknown>();

      using page = await loadUi({ probe: () => answer.promise });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      card.key.value = KEY;
      fire(card.test, "click");

      await settle();

      assert.equal(card.verdict.textContent, "Connecting to the device...", "a test is in flight when the card is opened again");

      const second = openCard(page);
      const standing = takeovers(page);

      assert.equal(standing.length, 1, "the page carries exactly one takeover element - the second open ended the first rather than stacking beside it");
      assert.ok(standing[0]?.children.includes(second.region), "and that element holds the card");
      assert.equal(second.address.value, "", "the second open clears the address");
      assert.equal(second.key.value, "", "and the key");
      assert.equal(second.verdict.textContent, "", "and the verdict");

      answer.resolve(ANSWERED);

      await settle();

      assert.equal(card.verdict.textContent, "", "the test retired with the takeover it started under, so its late answer paints nothing into the card");
    });

    test("stays held through a click that does not navigate, since the page listens on none of the sidebar's own surfaces", async () => {

      using page = await loadUi();

      const card = openCard(page);
      const sidebar = page.document.getElementById("sidebar");
      const content = page.document.querySelector("sidebar-content");

      assert.ok(sidebar && content, "the page markup carries the sidebar and its content wrapper");

      /* Only a navigation ends the takeover, and that rule is the framework's. `fire` does not model bubbling, so the harness observes this as the absence of a click
       * listener on every surface a stray click could reach - the sidebar, its content wrapper, and the document - which leaves nothing a non-navigating click could
       * reach that would release the card.
       */
      assert.throws(() => fire(sidebar, "click"), /registered no click listener/, "the page listens for no click on the sidebar");
      assert.throws(() => fire(content, "click"), /registered no click listener/, "nor on the sidebar's content wrapper");
      assert.throws(() => fire(page.document, "click"), /registered no click listener/, "nor on the document");
      assert.ok(isHeld(page, card.region), "and the card is still held");
    });

    test("leaves the page on a navigation, and a test in flight renders nothing and reports nothing when it answers", async () => {

      const answer = Promise.withResolvers<unknown>();

      using page = await loadUi({ probe: () => answer.promise });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      fire(card.test, "click");

      await settle();

      page.double.navigate();

      assert.equal(isHeld(page, card.region), false, "the user moving the selection gives the content area back, so the card leaves the page");

      // The retirement settles the test's bounded await before the answer lands, as it does in a browser where the network answers long after the abort, so the
      // test ends through its failure path - the one path that could write a console diagnostic.
      await settle();

      answer.resolve(ANSWERED);

      await settle();

      assert.equal(card.verdict.textContent, "Connecting to the device...",
        "the late answer renders nothing into the card - its verdict is what it last said while held");
      assert.deepEqual(probeDiagnostics(page), [], "and a retired test has no failure to report, so nothing reaches the console");
    });
  });

  describe("testing a connection", () => {

    test("refuses an empty address without sending a request", async () => {

      using page = await loadUi();

      const card = openCard(page);
      const before = page.host.requests.filter((entry) => (entry.route === STATUS_PROBE_ROUTE)).length;

      fire(card.test, "click");

      await settle();

      assert.equal(card.verdict.textContent, "Please enter the device's address.", "the card says what is missing");
      assert.equal(page.host.requests.filter((entry) => (entry.route === STATUS_PROBE_ROUTE)).length, before, "and nothing was asked of the server");
    });

    test("sends exactly what was typed and renders the device that answered", async () => {

      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);

      card.address.value = "  10.0.0.20  ";
      card.key.value = " secret ";
      fire(card.test, "click");

      await settle();

      const probes = page.host.requests.filter((entry) => (entry.route === STATUS_PROBE_ROUTE));

      assert.equal(probes.length, 1, "one test is one request");
      assert.deepEqual(probes[0]?.body, { address: "10.0.0.20", psk: "secret" }, "the typed address and key are sent trimmed, exactly as typed otherwise");
      assert.equal(card.verdict.textContent, "This device answered.", "the card says so plainly");

      const readout = page.findElement((element) => (element.textContent === "MAC: "))?.parentElement;

      assert.ok(readout, "the identity readout names the MAC");
      assert.equal(readout.children[1]?.textContent, MAC, "and carries the value beside the label");

      for(const label of [ "Name", "Model", "Firmware", "Encrypted" ]) {

        assert.ok(page.findElement((element) => (element.textContent === (label + ": "))), "the readout names " + label);
      }
    });

    test("replaces the identity readout between verdicts rather than stacking them", async () => {

      /* Two successful probes in ONE page session, which is the only input that can tell a readout that is cleared from one that is appended to. The card is built
       * once and reused, so a readout that merely appended would show the first device's identity underneath the second's - and a user testing two addresses in a row
       * would be reading a row that belongs to neither.
       */
      const answers = [ { ...ANSWERED, mac: MAC, name: "North Door" }, { ...ANSWERED, mac: MAC_TWO, name: "South Door" } ];
      let issued = 0;

      using page = await loadUi({ probe: async () => answers[issued++] ?? answers[1] });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      fire(card.test, "click");

      await settle();

      assert.ok(page.findElement((element) => (element.textContent === "North Door")), "the first device's name is shown");

      card.address.value = "10.0.0.21";
      fire(card.test, "click");

      await settle();

      assert.ok(page.findElement((element) => (element.textContent === "South Door")), "the second device's name is shown");
      assert.equal(page.findElement((element) => (element.textContent === "North Door")), null,
        "and the first device's name is gone, because the readout is replaced between verdicts rather than added to");

      const readout = page.findElement((element) => (element.textContent === "MAC: "))?.parentElement?.parentElement;

      assert.ok(readout, "the readout is found");
      assert.equal(readout.children.length, 5, "it carries exactly one verdict's worth of rows, not two stacked");
    });

    test("renders one sentence per failure reason, and omits the encrypted row for a plaintext device", async () => {

      // Every reason the server can answer with, so a reason added to the wire without copy here shows up as an unreachable fallback rather than silently.
      const copy: Record<string, RegExp> = {

        "auth-invalid": /refused that encryption key/,
        "auth-missing": /requires its API encryption key/,
        "misconfigured": /not a Ratgdo or Konnected opener/,
        "timeout": /did not answer in time/,
        "unreachable": /Nothing answered at that address/,
        "unsupported": /ESPHome API version/
      };

      for(const [ reason, expected ] of Object.entries(copy)) {

        // eslint-disable-next-line no-await-in-loop
        using page = await loadUi({ probe: async () => ({ kind: "error", reason }) });

        const card = openCard(page);

        card.address.value = "10.0.0.20";
        fire(card.test, "click");

        // eslint-disable-next-line no-await-in-loop
        await settle();

        assert.match(card.verdict.textContent, expected, "the card explains " + reason + " in its own sentence");
      }

      using plaintext = await loadUi({ probe: async () => ({ ...ANSWERED, encrypted: false }) });

      const card = openCard(plaintext);

      card.address.value = "10.0.0.20";
      fire(card.test, "click");

      await settle();

      assert.equal(plaintext.findElement((element) => (element.textContent === "Encrypted: ")), null,
        "a device that negotiated no encryption shows no Encrypted row - its absence is not a fact worth a line");
    });
  });

  describe("saving", () => {

    test("writes nothing at all when the device did not answer", async () => {

      // A17 and T18's second half: the probe-first guard is the card's whole promise, so a failed answer must leave the configuration untouched.
      using page = await loadUi({ probe: async () => ({ kind: "error", reason: "auth-missing" }) });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 0, "a device that refused the connection is never written to the configuration");
      assert.match(card.verdict.textContent, /requires its API encryption key/, "and the card says why rather than claiming a save");
    });

    test("commits exactly once, with one patch carrying both the address and its key", async () => {

      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      card.key.value = KEY;
      fire(card.save, "click");

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 1, "a save is ONE coordinated write, never one per entry");

      const options = (page.double.featureOptions.commits[0]?.patch as { options?: string[] })?.options ?? [];

      assert.ok(options.some((entry) => (entry === "Enable.Device.Address=10.0.0.20")), "the one patch lists the address");
      assert.ok(options.some((entry) => (entry === ("Enable.Device.Encryption.Key.10-0-0-20=" + KEY))), "and carries its key at the address identity");
      assert.deepEqual(page.host.toasts, [{ channel: "success", message: "Saved. Restart Homebridge to add this device." }],
        "a new device is a restart away from HomeKit, and one success toast says so");
      assert.equal(isHeld(page, card.region), false, "a saved card gives the content area back");
    });

    test("tells a listed address with a new key apart from one with nothing to change", async () => {

      using rewritten = await loadUi({ config: configWith("Enable.Device.Address=10.0.0.20", "Enable.Device.Encryption.Key.10-0-0-20=old-key"),
        probe: async () => ANSWERED });

      const first = openCard(rewritten);

      first.address.value = "10.0.0.20";
      first.key.value = KEY;
      fire(first.save, "click");

      await settle();

      assert.equal(rewritten.double.featureOptions.commits.length, 1, "a listed address with a new key is still a write");
      assert.deepEqual(rewritten.host.toasts, [{ channel: "success", message: "Updated the key for this device." }],
        "and its confirmation says what actually changed, not that a device was added");

      using unchanged = await loadUi({ config: configWith("Enable.Device.Address=10.0.0.20"), probe: async () => ANSWERED });

      const second = openCard(unchanged);

      second.address.value = "10.0.0.20";
      fire(second.save, "click");

      await settle();

      assert.equal(unchanged.double.featureOptions.commits.length, 0, "nothing would change, so no write is opened at all");
      assert.equal(second.verdict.textContent, "This device is already listed.", "and the card says so rather than offering a pointless restart");
    });

    test("renders the host's error for a failed write and keeps the card open", async () => {

      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);

      page.double.featureOptions.nextCommit = { error: new Error("the host refused the write"), kind: "failed" };
      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      assert.equal(card.verdict.textContent, "the host refused the write", "a failed write shows the host's own message rather than a claim of success");
      assert.ok(isHeld(page, card.region), "and the card stays open, since the user may want to try again");
      assert.deepEqual(page.host.toasts, [], "a write that changed nothing raises no toast");
    });

    test("confirms a staged write with a warning toast, gives the content area back, and schedules the warm", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);
      const warms = warmSends(page).length;

      page.double.featureOptions.nextCommit = { error: new Error("the write never reached disk"), kind: "staged" };
      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      const warning = "This device has been saved, but Homebridge could not write the configuration file. Save the plugin's settings to keep the change.";

      assert.deepEqual(page.host.toasts, [{ channel: "warning", message: warning }],
        "a staged write reached the host's memory but not the disk, so one warning toast asks for the user's own save");
      assert.equal(isHeld(page, card.region), false, "the card gives the content area back, since the device was saved");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, warms + 1, "the page is reconciled on what the host holds, so the warm carrying the new address sends once");
    });
  });

  describe("the address the card accepts", () => {

    test("refuses an address naming a zone without sending a probe or writing anything", async () => {

      /* A zone identifier names the interface a link-local address was heard on and means nothing without that link - nothing could dial it, so the card says so
       * before a request goes out rather than letting the user watch a probe that was always going to fail. The assertion reads the exact sentence, because this is
       * the one place the user is told what to do instead.
       */
      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);
      const probes = page.host.requests.filter((entry) => (entry.route === STATUS_PROBE_ROUTE)).length;

      card.address.value = "fe80::1%en0";
      fire(card.save, "click");

      await settle();

      assert.equal(card.verdict.textContent, "An address with a zone identifier cannot be dialed. List the device's routable address or hostname instead.",
        "the card explains the refusal and names what to list instead");
      assert.equal(page.host.requests.filter((entry) => (entry.route === STATUS_PROBE_ROUTE)).length, probes, "no probe is sent for an address nothing can dial");
      assert.equal(page.double.featureOptions.commits.length, 0, "and nothing is written");
    });

    test("probes and saves the canonical form of a bracketed address", async () => {

      /* A user typing an IPv6 literal reasonably reaches for the URL spelling. What is tested and what is written must both be the bare literal: the bracketed form
       * is not an address to Node's own parser, so a dial carrying it resolves as a hostname and fails for good.
       */
      using page = await loadUi({ probe: async () => ({ ...ANSWERED, address: "2001:db8::5", mac: MAC }) });

      const card = openCard(page);

      card.address.value = "  [2001:DB8::5]  ";
      card.key.value = KEY;
      fire(card.save, "click");

      await settle();

      const probe = page.host.requests.find((entry) => (entry.route === STATUS_PROBE_ROUTE));

      assert.deepEqual(probe?.body, { address: "2001:db8::5", psk: KEY }, "the address tested is the bare, trimmed, lower-cased literal");

      const options = (page.double.featureOptions.commits[0]?.patch as { options?: string[] })?.options ?? [];

      assert.ok(options.includes("Enable.Device.Address=2001:db8::5"), "and the address saved is the same one that was tested, not the spelling that was typed");
      assert.ok(options.includes("Enable.Device.Encryption.Key.2001:db8::5=" + KEY), "with the key stored at that canonical identity");
    });

    test("tells a user their bracketed spelling of a listed address is already listed", async () => {

      using page = await loadUi({ config: configWith("Enable.Device.Address=2001:db8::5"),
        probe: async () => ({ ...ANSWERED, address: "2001:db8::5", mac: MAC }) });

      const card = openCard(page);

      card.address.value = "[2001:DB8::5]";
      fire(card.save, "click");

      await settle();

      assert.equal(card.verdict.textContent, "This device is already listed.", "the two spellings are one address, so there is nothing to add");
      assert.equal(page.double.featureOptions.commits.length, 0, "and no write is opened for it");
    });

    test("sends the canonical form of every listed address in the warm payload", async () => {

      // The page and the plugin have to name one identity for one address, so the payload carries what the plugin would dial rather than what the user typed - and
      // an entry nothing could dial is dropped rather than sent for the feed to drop again.
      using page = await loadUi({ config: configWith("Enable.Device.Address=[2001:DB8::5], Garage.Local, fe80::1%en0",
        "Enable.Device.Encryption.Key.2001:db8::5=" + KEY) });

      const sent = warmSends(page)[0] as { addresses: { address: string; psk?: string }[] };

      assert.deepEqual(sent.addresses, [ { address: "2001:db8::5", psk: KEY }, { address: "garage.local" } ],
        "the bracketed literal is sent bare with the key found at its canonical identity, the hostname is lower-cased, and the zoned entry is not sent at all");
    });
  });

  describe("actions that outlive the card", () => {

    test("shows the newer answer when two tests overlap, whichever resolves last, and reports nothing for the retired one", async () => {

      /* Risk 8's ordering row. The first probe answers LAST and describes a different device, so an implementation without a latest-action guard would paint the first
       * device's verdict over the second's - the reason the card's actions start on one guard at all.
       */
      const answers = [ Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>() ];
      let issued = 0;

      using page = await loadUi({ probe: () => answers[issued++]?.promise ?? Promise.resolve(ANSWERED) });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      fire(card.test, "click");

      await settle();

      card.address.value = "10.0.0.21";
      fire(card.test, "click");

      await settle();

      // The SECOND probe answers first, then the first one answers late with a verdict that must not be rendered.
      answers[1]?.resolve({ kind: "error", reason: "timeout" });

      await settle();

      answers[0]?.resolve(ANSWERED);

      await settle();

      assert.match(card.verdict.textContent, /did not answer in time/, "the verdict is the newer action's, and the slow answer to the retired one paints nothing");
      assert.deepEqual(probeDiagnostics(page), [], "and the retired test has no failure to report, so nothing reaches the console");
    });

    test("keeps the refusal of an empty address when an earlier test answers afterward", async () => {

      const answer = Promise.withResolvers<unknown>();

      using page = await loadUi({ probe: () => answer.promise });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      fire(card.test, "click");

      await settle();

      // A Test click is a new action from the click itself, so the refusal below retires the test still in flight even though it sends nothing of its own.
      card.address.value = "";
      fire(card.test, "click");

      await settle();

      answer.resolve(ANSWERED);

      await settle();

      assert.equal(card.verdict.textContent, "Please enter the device's address.", "the earlier answer paints nothing over the refusal the user is looking at");
    });

    test("keeps a failed save's message when a test started before the save answers afterward", async () => {

      // The first probe is the test's, held open; every later one is the save's own probe, which answers at once.
      const tested = Promise.withResolvers<unknown>();
      let issued = 0;

      using page = await loadUi({ probe: () => ((issued++ === 0) ? tested.promise : Promise.resolve(ANSWERED)) });

      const card = openCard(page);

      page.double.featureOptions.nextCommit = { error: new Error("the host refused the write"), kind: "failed" };
      card.address.value = "10.0.0.20";
      fire(card.test, "click");

      await settle();

      fire(card.save, "click");

      await settle();

      assert.equal(card.verdict.textContent, "the host refused the write", "the save ran its own test and renders its failed write");

      tested.resolve(ANSWERED);

      await settle();

      assert.equal(card.verdict.textContent, "the host refused the write", "the save retired the test in flight, so the test's late answer does not overwrite it");
    });

    test("renders nothing and schedules no warm when a probe answers after the card closed", async () => {

      // The ruling's named row, probe half. A user who presses Test Connection and then Cancel must not have the card light up underneath them afterward.
      const answer = Promise.withResolvers<unknown>();

      using page = await loadUi({ probe: () => answer.promise });

      const card = openCard(page);
      const warms = warmSends(page).length;

      card.address.value = "10.0.0.20";
      fire(card.test, "click");

      await settle();

      fire(byText(page, "Cancel"), "click");

      assert.equal(isHeld(page, card.region), false, "the card is closed while the test is still running");

      answer.resolve(ANSWERED);

      await settle();

      assert.equal(isHeld(page, card.region), false, "the late answer does not reopen the card");
      assert.equal(card.verdict.textContent, "Connecting to the device...",
        "and it renders nothing into it - the verdict is still whatever the card last said while open");
      assert.equal(page.double.featureOptions.commits.length, 0, "a probe that never reached a save writes nothing");
      assert.equal(warmSends(page).length, warms, "and schedules no warm recompute, since nothing was saved");
    });

    test("leaves a commit that lands after the card closed written exactly once, raising no toast and scheduling no warm", async (t) => {

      /* The ruling's named row, commit half. A commit already in flight cannot be recalled, so the configuration IS written - what the close suppresses is
       * everything after the write: the confirmation, the release, and the warm recompute. The distinguishing observation is the commit COUNT, because an
       * implementation that retried or re-entered on the late result would write twice. The debounce is released before the warms are counted, because the write
       * moved the address list, so a warm the page wrongly scheduled would send rather than hide inside the window.
       */
      t.mock.timers.enable({ apis: ["setTimeout"] });

      const held = Promise.withResolvers<boolean>();

      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);
      const original = page.double.featureOptions.commitConfig;

      // The commit is held open so the card can be closed across it, then released.
      page.double.featureOptions.commitConfig = async (compose) => {

        await held.promise;

        return original(compose);
      };

      const warms = warmSends(page).length;

      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      fire(byText(page, "Cancel"), "click");

      assert.equal(isHeld(page, card.region), false, "the card is closed while the write is still in flight");

      held.resolve(true);

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 1, "the write that was already in flight still happened, exactly once");
      assert.deepEqual(page.host.toasts, [], "but no confirmation is raised, since the card is closed");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, warms, "and no warm recompute is scheduled for a card the user dismissed");
    });
  });
});

/* The boundary double, held to the library it stands in for.
 *
 * The page runs against a hand-kept double, so a member the library has dropped but the double still carries would let every row above pass over a page that throws
 * in a browser. The library's own classes are the source the double is checked against: every page-facing member the double carries must be one they carry too.
 */
describe("the webUI boundary double", () => {

  test("carries only members the library's own webUi and webUiFeatureOptions classes carry", async () => {

    /* The double's own test-facing methods, which have no library counterpart by design and which the page never reaches: `navigate` stands in for the user moving
     * the sidebar selection, and `resume` for the framework's clock-gap detector waking a page that froze.
     */
    const testFacingShell = [ "navigate", "resume" ];

    // The feature-options facade's test-facing members: `commits` records every coordinated write the page made, and `nextCommit` is how a test chooses what the
    // next write answers.
    const testFacingFacade = [ "commits", "nextCommit" ];

    // The library's instance fields, which its class declares on each instance rather than on the prototype, so no prototype shows them: `statusPanel` is the
    // handle each show cycle mints for the status view.
    const libraryInstanceFields = ["statusPanel"];

    // The library's browser modules, imported by file URL: the harness reroutes only the bare webUi specifier to the double, so these are the real classes.
    const shell = (await import(LIBRARY_UI_DIR + "webUi.mjs")) as { webUi: { prototype: object } };
    const page = (await import(LIBRARY_UI_DIR + "webUi-featureOptions.mjs")) as { webUiFeatureOptions: { prototype: object } };

    for(const member of Object.getOwnPropertyNames(webUi.prototype).filter((name) => !testFacingShell.includes(name))) {

      assert.ok(Object.hasOwn(shell.webUi.prototype, member), "the double's webUi carries " + member + ", which the library's webUi does not");
    }

    using loaded = await loadUi();

    const facade = Object.keys(loaded.double.featureOptions).filter((name) => !testFacingFacade.includes(name) && !libraryInstanceFields.includes(name));

    for(const member of facade) {

      assert.ok(Object.hasOwn(page.webUiFeatureOptions.prototype, member),
        "the double's featureOptions carries " + member + ", which the library's webUiFeatureOptions does not");
    }
  });
});
