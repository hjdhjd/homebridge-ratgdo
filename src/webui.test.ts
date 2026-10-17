/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui.test.ts: The settings page's trigger paths, exercised against the REAL homebridge-ui/public/ui.mjs running under a boundary double for the webUI framework.
 * Covers the boot warm, the trailing debounce, the send-suppression diff, every forced-resend belt, the address-refresh latch and the identity strip it feeds, the
 * feature-options parameters the page declares, the legacy-settings migration's write path, and the shared route constants both halves address.
 *
 * The page is the real module, not a re-implementation: the harness routes its framework specifiers to the shipped browser files and its webUI shell to the double,
 * so the feature-option engine the card composes its writes through and the configuration session that stages the migration are the library's own. What the fakes observe
 * is therefore the page's behavior rather than a restatement of it - the host's request log, the listener records each fake keeps for what the page registered on
 * it, the double's counters, and the fake document's state.
 */
import type { CommitResult, DeviceListResult, FakeCatalog, FakeConfigEntry, FakeDevice, FakeElement, RecordedLog } from "./webui-double.helpers.ts";
import { LIBRARY_UI_DIR, loadUi } from "./webui.helpers.ts";
import { STATUS_ADDRESSES_ROUTE, STATUS_PROBE_ROUTE, STATUS_WARM_ROUTE, defaultConfig, defaultDevices, fire, webUi } from "./webui-double.helpers.ts";
import { describe, test } from "node:test";
import { expectAt, settle } from "homebridge-plugin-utils/testing";
import { featureOptionCategories, featureOptions } from "./options.ts";
import type { LoadedUi } from "./webui.helpers.ts";
import { RATGDO_VARIANT_LABELS } from "./types.ts";
import assert from "node:assert/strict";

// The two fixture devices' macs, and the key configured against the first of them.
const MAC = "AABBCCDDEEFF";
const MAC_TWO = "112233445566";
const KEY = "c2VjcmV0LWtleQ==";

// A primary platform entry carrying the given option entries, which is the one shape every configuration test in this file varies.
const configWith = (...options: string[]): FakeConfigEntry[] => [{ name: "Ratgdo", options, platform: "Ratgdo" }];

// The encryption-key entry at a device's mac, or the global one when no mac is given, spelled the way the options editor writes it.
const keyEntry = (mac: string | undefined, key: string): string => "Enable.Device.Encryption.Key" + ((mac === undefined) ? "" : ("." + mac)) + "=" + key;

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

    test("sends once from the load announcement, carrying every device and the edited configuration", async () => {

      using page = await loadUi({ config: configWith(keyEntry(MAC, KEY)) });

      const sends = warmSends(page);

      assert.ok(page.double.params.onLoaded, "the page answers the framework's load announcement, which is what carries its first warm");
      assert.equal(page.double.showCalls, 1, "the page ran exactly one show cycle");
      assert.equal(sends.length, 1, "establishing the page sends exactly one warm");
      assert.deepEqual(sends[0], { devices: [ MAC, MAC_TWO ], options: [keyEntry(MAC, KEY)] },
        "the warm lists every device by its mac and carries the configuration's options as they stand, for the feed to resolve");

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

    test("sends its warm even when the option catalog cannot be read, because the page resolves nothing itself", async () => {

      /* The warm carries the configuration rather than values the page computed from it, so the page's warm needs no catalog at all. A catalog that cannot be read
       * still costs the migration its run, since the migration reads it at load, but it does not cost the panel its devices.
       */
      using page = await loadUi({ catalog: async (): Promise<FakeCatalog> => {

        throw new Error("The option catalog could not be read.");
      } });

      assert.equal(warmSends(page).length, 1, "the page warms on its load announcement whatever became of the catalog read");
      assert.ok(page.console.errors.some((entry) => (entry.message === "The configuration migration did not complete.")),
        "while the migration, which does need the catalog, reports that it did not run");
    });

    test("a device-list read that fails sends nothing and reports the diagnostic, and the next trigger sends once it resolves", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;
      const devices = page.double.featureOptions.getHomebridgeDevices;

      // The read fails for as long as the override stands, and the edit guarantees the recovered read has something new to send.
      page.double.featureOptions.getHomebridgeDevices = async (): Promise<never> => {

        throw new Error("The device list could not be read.");
      };
      setOptions(page, keyEntry(MAC, KEY));
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before, "a page that cannot read its device list sends no warm rather than one listing nothing");
      assert.ok(page.console.errors.some((entry) => (entry.message === "The device warm set could not be recomputed.")),
        "the failed recompute reports its own diagnostic");

      page.double.featureOptions.getHomebridgeDevices = devices;
      page.double.resume();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "the trigger after a recovered device-list read sends once");
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
      assert.deepEqual(sends.at(-1), { devices: [ MAC, MAC_TWO ], options: [keyEntry(MAC, "second")] },
        "the one send carries the settled value, not the half-typed one");
    });
  });

  describe("send suppression", () => {

    test("re-sends only when the configuration would change", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;

      // An edit hook firing against an unchanged configuration recomputes the same set, which the diff suppresses.
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before, "a recompute over an unchanged configuration sends nothing");

      setOptions(page, keyEntry(MAC, KEY));
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "a changed key sends once");
    });

    test("sends the devices and the options, suppresses an identical resend, and resends after an edit to an option the feed never reads", async (t) => {

      /* The signature covers the devices and the whole options array, so the page resends on any edit and leaves deciding what moved to the feed's own diff - which
       * resolves exactly what the plugin resolves, so an edit to an option it never reads moves no connection there. A device list handed back in another order is
       * the same list, and suppresses.
       */
      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi({ config: configWith(keyEntry(MAC, KEY)) });

      assert.deepEqual(warmSends(page).at(-1), { devices: [ MAC, MAC_TWO ], options: [keyEntry(MAC, KEY)] },
        "the payload is the sidebar's macs and the configuration's options, with nothing resolved by the page");

      const before = warmSends(page).length;
      const devices = page.double.featureOptions.getHomebridgeDevices;

      page.double.featureOptions.getHomebridgeDevices = async (): Promise<DeviceListResult> => {

        const result = await devices();

        return { ...result, devices: [...result.devices].reverse() };
      };
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before, "an identical payload, its devices merely reordered, is not sent again");

      setOptions(page, keyEntry(MAC, KEY), "Enable.Opener.ReadOnly");
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "an edit to an option the feed never reads still resends, because the page does not decide what the feed reads");
      assert.deepEqual((warmSends(page).at(-1) as { options: string[] }).options, [ keyEntry(MAC, KEY), "Enable.Opener.ReadOnly" ],
        "and the resend carries the configuration exactly as it now stands");
    });
  });

  describe("the manual addresses the warm payload carries", () => {

    test("carries every listed address as the configuration's own entry, for the feed to canonicalize and key", async () => {

      /* The feed reads the listed addresses out of the configuration through the plugin's own list function, and keys each dial for the MAC its device announces, so
       * the page sends the list exactly as the user wrote it and resolves no key for any address. The address shapes are here together because they are the ones a
       * user types.
       */
      const listed = "Enable.Device.Address=10.0.0.20, garage.local, fd00::1";

      using page = await loadUi({ config: configWith(listed, keyEntry(MAC, KEY)) });

      assert.deepEqual(warmSends(page)[0], { devices: [ MAC, MAC_TWO ], options: [ listed, keyEntry(MAC, KEY) ] },
        "the list travels as the entry the user wrote, beside the key stored at a device's MAC, with nothing resolved at any address");
    });

    test("carries a listed address with no key at all, and no address entry for an install that lists none", async () => {

      using none = await loadUi();

      assert.deepEqual((warmSends(none)[0] as { options: string[] }).options, [], "an install listing no address sends an empty configuration rather than nothing");

      using listed = await loadUi({ config: configWith("Enable.Device.Address=10.0.0.20") });

      assert.deepEqual((warmSends(listed)[0] as { options: string[] }).options, ["Enable.Device.Address=10.0.0.20"],
        "an address the user has set no key for is sent as its list entry alone, exactly as a keyless device is sent with no key entry");
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

      setOptions(page, "Enable.Device.Address=10.0.0.20", keyEntry(MAC, KEY));
      page.double.params.onOptionsEdited?.();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 2, "a key stored at the device the address reaches is a change the signature sees, so it sends");
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
      assert.ok(page.double.params.sidebar.groupOrder, "the sidebar carries the comparator that orders its variant groups");
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

      assert.deepEqual(warmSends(page)[0], { devices: [ MAC, MAC_TWO ], options: [keyEntry(MAC, KEY)] },
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
      assert.ok(page.double.params.ui.validOptionCategory, "the page declares the category visibility hook");
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

  // A probe answer describing a device that responded through an encrypted handshake announcing its MAC, which is the input every save row starts from.
  const ANSWERED = { address: "10.0.0.20", announcesMac: true, encrypted: true, firmwareVersion: "2.0.0", kind: "ok", mac: MAC, model: "Ratgdo Disco",
    name: "North Door", variant: "ratgdo" };

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

  // The option entries the page's first commit wrote. The commit itself is asserted present, so a save that never committed fails under its own description rather
  // than reading as an empty list.
  const committedOptions = (page: LoadedUi, description: string): readonly string[] => {

    const patch = expectAt(page.double.featureOptions.commits, 0, description).patch as { options?: string[] };

    return patch.options ?? [];
  };

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

      // The probe-first guard is the card's whole promise, so a failed answer must leave the configuration untouched.
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

      const options = committedOptions(page, "the save's commit");

      assert.ok(options.some((entry) => (entry === "Enable.Device.Address=10.0.0.20")), "the one patch lists the address");
      assert.ok(options.some((entry) => (entry === keyEntry(MAC, KEY))), "and carries its key at the MAC of the device that answered");
      assert.deepEqual(page.host.toasts, [{ channel: "success", message: "Saved. Restart Homebridge to add this device." }],
        "a new device is a restart away from HomeKit, and one success toast says so");
      assert.equal(isHeld(page, card.region), false, "a saved card gives the content area back");
    });

    test("tells a listed address with a new key apart from one with nothing to change", async () => {

      using rewritten = await loadUi({ config: configWith("Enable.Device.Address=10.0.0.20", keyEntry(MAC, "old-key")), probe: async () => ANSWERED });

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

      const options = committedOptions(page, "the save's commit");

      assert.ok(options.includes("Enable.Device.Address=2001:db8::5"), "and the address saved is the same one that was tested, not the spelling that was typed");
      assert.ok(options.includes(keyEntry(MAC, KEY)), "with the key stored at the MAC of the device that answered there");
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

    test("sends every listed address in the warm payload as written, leaving its canonical form to the feed", async () => {

      // The feed reads the list through the plugin's own list function, which is the one place an address takes its canonical form and a zoned entry is dropped, so
      // the page sends the entry exactly as it stands rather than a second canonicalization the two sides would have to keep in step.
      const listed = "Enable.Device.Address=[2001:DB8::5], Garage.Local, fe80::1%en0";

      using page = await loadUi({ config: configWith(listed, keyEntry(MAC, KEY)) });

      assert.deepEqual((warmSends(page)[0] as { options: string[] }).options, [ listed, keyEntry(MAC, KEY) ],
        "the bracketed literal, the mixed-case hostname, and the zoned entry all travel as written, beside the key stored at the device's MAC");
    });

    test("stores a typed key at the MAC the test learned, and writes no key entry when that key already resolves there", async () => {

      // The card learns the device's MAC by testing the address, and the key goes where every connection to that device reads it. A key the engine already
      // resolves at that MAC - here, the global encryption key the device inherits - writes nothing beyond the address.
      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      card.key.value = KEY;
      fire(card.save, "click");

      await settle();

      const options = committedOptions(page, "the first save's commit");

      assert.ok(options.includes("Enable.Device.Encryption.Key." + MAC + "=" + KEY), "the key is committed at the answered device's MAC");

      using inherited = await loadUi({ config: configWith(keyEntry(undefined, KEY)), probe: async () => ANSWERED });

      const second = openCard(inherited);

      second.address.value = "10.0.0.20";
      second.key.value = KEY;
      fire(second.save, "click");

      await settle();

      const written = committedOptions(inherited, "the second save's commit");

      assert.ok(written.includes("Enable.Device.Address=10.0.0.20"), "the address is still listed");
      assert.ok(!written.some((entry) => entry.startsWith("Enable.Device.Encryption.Key." + MAC)), "and no key entry is written where the key already resolves");
    });

    test("refuses to save a typed key for an encrypted device whose firmware announces no MAC, unless it is the global encryption key", async () => {

      /* The runtime reaches a device whose firmware announces no MAC only with the global encryption key, so a different key saved for it could never be used. The
       * card says why and names the fix, with the device's identity rows still shown, and Save writes nothing; typing the global encryption key itself saves.
       */
      const silent = { ...ANSWERED, announcesMac: false };

      using page = await loadUi({ config: configWith(keyEntry(undefined, "global-key")), probe: async () => silent });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      card.key.value = KEY;
      fire(card.save, "click");

      await settle();

      assert.equal(card.verdict.textContent, "This device answered, but its firmware does not announce its MAC address, so the plugin can reach it only with the " +
        "global encryption key. Update the device to ESPHome 2025.4.0 or newer, or set the global encryption key to this key.", "the card names the limit and the fix");
      assert.ok(page.findElement((element) => (element.textContent === "MAC: ")), "and still shows the device that answered");
      assert.equal(page.double.featureOptions.commits.length, 0, "while Save commits nothing");

      card.key.value = "global-key";
      fire(card.save, "click");

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 1, "the global encryption key is the one key such a device can use, so typing it saves");
    });
  });

  describe("actions that outlive the card", () => {

    test("shows the newer answer when two tests overlap, whichever resolves last, and reports nothing for the retired one", async () => {

      /* The first probe answers LAST and describes a different device, so an implementation without a latest-action guard would paint the first device's verdict
       * over the second's - the reason the card's actions start on one guard at all.
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

      // A user who presses Test Connection and then Cancel must not have the card light up underneath them afterward.
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
      assert.deepEqual(page.host.toasts, [], "and raises no toast, since a test whose card has closed is dropped rather than reported");
    });

    test("writes a save whose card closed mid-check once the device answers, confirming it by toast and scheduling the warm", async (t) => {

      /* Closing the card decides only where a pressed save reports, never whether it writes: the check keeps running across the Cancel, the write lands once, and the
       * confirmation the closed card cannot show goes to the host's toast. The debounce is released before the warms are counted, because the write moved the
       * address list, so a warm the page failed to schedule shows as a missing send.
       */
      t.mock.timers.enable({ apis: ["setTimeout"] });

      const answer = Promise.withResolvers<unknown>();

      using page = await loadUi({ probe: () => answer.promise });

      const card = openCard(page);
      const warms = warmSends(page).length;

      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      fire(byText(page, "Cancel"), "click");

      assert.equal(isHeld(page, card.region), false, "the card is closed while the save's check is still running");

      answer.resolve(ANSWERED);

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 1, "the save writes once its check passes, closed card or not");
      assert.deepEqual(page.host.toasts, [{ channel: "success", message: "Saved. Restart Homebridge to add this device." }],
        "and one success toast confirms it, since the card that would have shown it is gone");
      assert.equal(isHeld(page, card.region), false, "the card stays closed");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, warms + 1, "and the warm carrying the new address sends once");
    });

    test("writes a save whose page cycle ended mid-check once the device answers, confirming it by toast and scheduling the warm", async (t) => {

      // A navigation away ends the page cycle, which the harness models as the next show cycle tearing the standing one down. The page's configuration session
      // outlives the cycle, so a save pressed before the cycle ended writes and reports exactly as a cancelled card's save does.
      t.mock.timers.enable({ apis: ["setTimeout"] });

      const answer = Promise.withResolvers<unknown>();

      using page = await loadUi({ probe: () => answer.promise });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      await page.double.show();
      await settle();

      assert.equal(isHeld(page, card.region), false, "the cycle's end closed the card while the save's check is still running");

      const warms = warmSends(page).length;

      answer.resolve(ANSWERED);

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 1, "the save writes once its check passes");
      assert.deepEqual(page.host.toasts, [{ channel: "success", message: "Saved. Restart Homebridge to add this device." }], "and one success toast confirms it");
      assert.equal(isHeld(page, card.region), false, "the card stays closed");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, warms + 1, "and the warm carrying the new address sends once");
    });

    test("toasts a closed card's save refusal as an error in that reason's own sentence, and writes nothing", async () => {

      const answer = Promise.withResolvers<unknown>();

      using page = await loadUi({ probe: () => answer.promise });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      fire(byText(page, "Cancel"), "click");
      answer.resolve({ kind: "error", reason: "auth-invalid" });

      await settle();

      const refusal = "The device refused that encryption key. Check the key in this device's YAML configuration and try again.";

      assert.equal(page.double.featureOptions.commits.length, 0, "a device that refused the check is never written");
      assert.deepEqual(page.host.toasts, [{ channel: "error", message: refusal }],
        "and one error toast carries the card's own sentence for that reason, since the card is gone");
    });

    test("toasts a closed card's already-listed notice as info, and writes nothing", async () => {

      // The configuration already lists the address and no key is typed, so the device answering leaves nothing to change and the save ends in the already-listed notice.
      const answer = Promise.withResolvers<unknown>();

      using page = await loadUi({ config: configWith("Enable.Device.Address=10.0.0.20"), probe: () => answer.promise });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      fire(byText(page, "Cancel"), "click");

      assert.equal(isHeld(page, card.region), false, "the card is closed while the save's check is still running");

      answer.resolve(ANSWERED);

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 0, "an address already listed with nothing to change is never written");
      assert.deepEqual(page.host.toasts, [{ channel: "info", message: "This device is already listed." }],
        "and one info toast says so, since the card is gone");
      assert.equal(card.verdict.textContent, "Connecting to the device...",
        "and the notice never reaches the closed card's verdict line, which still reads what the card last said while open");
    });

    test("toasts a closed card's failed write as an error carrying the host's own message", async () => {

      const answer = Promise.withResolvers<unknown>();

      using page = await loadUi({ probe: () => answer.promise });

      const card = openCard(page);

      page.double.featureOptions.nextCommit = { error: new Error("the host refused the write"), kind: "failed" };
      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      fire(byText(page, "Cancel"), "click");
      answer.resolve(ANSWERED);

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 1, "the check passed, so the write was attempted once");
      assert.deepEqual(page.host.toasts, [{ channel: "error", message: "the host refused the write" }],
        "and its failure reaches the user as one error toast carrying the host's own words, since the card is gone");
    });

    test("writes a save whose card was closed and reopened mid-check, confirming it by toast and leaving the reopened card held and untouched", async (t) => {

      /* A reopen is not among the actions that cancel a pressed save, so the save writes when its check passes. The takeover it was pressed under ended with the
       * Cancel, so its outcome goes to the toast and nothing of it reaches the reopened card, and the release its confirmation makes is of that ended takeover, so
       * the reopened card stays held. The reopen empties the key field without an edit, which is what shows the commit carrying the key that was tested rather than
       * a fresh read of the field.
       */
      t.mock.timers.enable({ apis: ["setTimeout"] });

      const answer = Promise.withResolvers<unknown>();

      using page = await loadUi({ probe: () => answer.promise });

      const card = openCard(page);
      const warms = warmSends(page).length;

      card.address.value = "10.0.0.20";
      card.key.value = KEY;
      fire(card.save, "click");

      await settle();

      fire(byText(page, "Cancel"), "click");

      const reopened = openCard(page);

      answer.resolve(ANSWERED);

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 1, "the save writes once its check passes, across the close and the reopen");
      assert.ok(committedOptions(page, "the save's commit").includes(keyEntry(MAC, KEY)), "carrying the key that was tested, not the field the reopen emptied");
      assert.deepEqual(page.host.toasts, [{ channel: "success", message: "Saved. Restart Homebridge to add this device." }],
        "and one success toast confirms it, since the card it was pressed on is gone");
      assert.ok(isHeld(page, reopened.region), "the reopened card is still held, because the save released only the takeover it was pressed under");
      assert.equal(reopened.address.value, "", "with its cleared address");
      assert.equal(reopened.key.value, "", "and its cleared key");
      assert.equal(reopened.verdict.textContent, "", "and its blank verdict, which the save never painted");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, warms + 1, "and the warm carrying the new address sends once");
    });

    test("keeps a card reopened while a save's write is in flight held when that write lands, and confirms the write by toast", async () => {

      const answer = Promise.withResolvers<unknown>();
      const held = Promise.withResolvers<boolean>();
      let started = false;

      using page = await loadUi({ probe: () => answer.promise });

      const card = openCard(page);
      const original = page.double.featureOptions.commitConfig;

      // The commit is held open so the card can be reopened after the write has started, then released.
      page.double.featureOptions.commitConfig = async (compose): Promise<CommitResult> => {

        started = true;

        await held.promise;

        return original(compose);
      };

      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      fire(byText(page, "Cancel"), "click");
      answer.resolve(ANSWERED);

      await settle();

      assert.ok(started, "the save's write has started while the card is closed");

      const reopened = openCard(page);

      held.resolve(true);

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 1, "the write lands exactly once");
      assert.deepEqual(page.host.toasts, [{ channel: "success", message: "Saved. Restart Homebridge to add this device." }], "and one success toast confirms it");
      assert.ok(isHeld(page, reopened.region), "while the card opened after the write started stays held, since the save releases only its own takeover");
    });

    test("writes a commit that lands after the card closed exactly once, confirming it by toast and scheduling the warm", async (t) => {

      /* A started write always completes and always reports, so a card closed across the commit changes only where the confirmation goes. The distinguishing
       * observations are the commit COUNT, because an implementation that retried or re-entered on the late result would write twice, and the toast and the warm,
       * because an implementation that let the close suppress what follows the write would drop both. The debounce is released before the warms are counted, because
       * the write moved the address list, so a warm the page failed to schedule shows as a missing send.
       */
      t.mock.timers.enable({ apis: ["setTimeout"] });

      const held = Promise.withResolvers<boolean>();

      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);
      const original = page.double.featureOptions.commitConfig;

      // The commit is held open so the card can be closed across it, then released.
      page.double.featureOptions.commitConfig = async (compose): Promise<CommitResult> => {

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

      assert.equal(page.double.featureOptions.commits.length, 1, "the write that was already in flight happened, exactly once");
      assert.deepEqual(page.host.toasts, [{ channel: "success", message: "Saved. Restart Homebridge to add this device." }],
        "and one success toast confirms it, since the card is closed");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, warms + 1, "and the warm carrying the new address sends once");
    });

    test("reports a write that an edit lands across and schedules the warm, since nothing recalls a started write", async (t) => {

      /* An edit retires the save it lands on, but a save whose write has started has nothing left to retire: the commit lands once, it confirms by toast, releases
       * the card it was pressed on, and schedules the warm. An implementation that let the save's retirement decide whether to report after the write would drop all
       * three, which is the observation that tells the two apart - a close alone never retires a save, so only an edit or a newer action landing across the write can.
       */
      t.mock.timers.enable({ apis: ["setTimeout"] });

      const held = Promise.withResolvers<boolean>();
      let started = false;

      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);
      const original = page.double.featureOptions.commitConfig;

      // The commit is held open so the address field can be edited across it, then released.
      page.double.featureOptions.commitConfig = async (compose): Promise<CommitResult> => {

        started = true;

        await held.promise;

        return original(compose);
      };

      const warms = warmSends(page).length;

      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      assert.ok(started, "the save's write has started");

      card.address.value = "10.0.0.21";
      fire(card.address, "input");
      held.resolve(true);

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 1, "the write lands exactly once");
      assert.ok(committedOptions(page, "the save's commit").includes("Enable.Device.Address=10.0.0.20"), "carrying the address that was tested, not the edited one");
      assert.deepEqual(page.host.toasts, [{ channel: "success", message: "Saved. Restart Homebridge to add this device." }], "and one success toast confirms it");
      assert.equal(isHeld(page, card.region), false, "the save releases the card it was pressed on, as every resolved save does");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, warms + 1, "and the warm carrying the new address sends once");
    });

    test("toasts a failed write that an edit lands across, and leaves the edited card's verdict line blank", async () => {

      /* A failed write reports on the verdict line only while the card still presents the save that made it. An edit landing across the write takes the line over
       * and blanks it, so the host's error goes to a toast and the line stays as the edit left it, even though the card itself is still open.
       */
      const held = Promise.withResolvers<boolean>();
      let started = false;

      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);
      const original = page.double.featureOptions.commitConfig;

      // The commit is held open so the address field can be edited across it, then released into a failure.
      page.double.featureOptions.commitConfig = async (compose): Promise<CommitResult> => {

        started = true;

        await held.promise;

        return original(compose);
      };

      page.double.featureOptions.nextCommit = { error: new Error("the host refused the write"), kind: "failed" };
      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      assert.ok(started, "the save's write has started");

      card.address.value = "10.0.0.21";
      fire(card.address, "input");

      assert.equal(card.verdict.textContent, "", "the edit blanks the verdict line");

      held.resolve(true);

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 1, "the write was attempted once");
      assert.deepEqual(page.host.toasts, [{ channel: "error", message: "the host refused the write" }],
        "and its failure reaches the user as one error toast carrying the host's own words");
      assert.ok(isHeld(page, card.region), "the card stays open, since a failed write releases nothing");
      assert.equal(card.verdict.textContent, "", "and its verdict line is still blank from the edit, which took the line over");
    });

    for(const field of [ "address", "key" ] as const) {

      test("writes nothing and shows nothing for a save whose " + field + " field is edited during its check, and blanks the verdict", async () => {

        const answer = Promise.withResolvers<unknown>();

        using page = await loadUi({ probe: () => answer.promise });

        const card = openCard(page);

        card.address.value = "10.0.0.20";
        card.key.value = KEY;
        fire(card.save, "click");

        await settle();

        assert.equal(card.verdict.textContent, "Connecting to the device...", "the save's check is in flight");

        card[field].value += "0";
        fire(card[field], "input");

        assert.equal(card.verdict.textContent, "", "the edit blanks the verdict line at once");

        answer.resolve(ANSWERED);

        await settle();

        assert.equal(page.double.featureOptions.commits.length, 0, "the edit retired the save, so the text it was pressed with is never written");
        assert.deepEqual(page.host.toasts, [], "and a retired save raises nothing");
        assert.equal(card.verdict.textContent, "", "nor paints anything over the blanked line");
      });
    }

    for(const field of [ "address", "key" ] as const) {

      test("renders nothing and raises no toast for a test whose " + field + " field is edited while it is in flight", async () => {

        const answer = Promise.withResolvers<unknown>();

        using page = await loadUi({ probe: () => answer.promise });

        const card = openCard(page);

        card.address.value = "10.0.0.20";
        card.key.value = KEY;
        fire(card.test, "click");

        await settle();

        assert.equal(card.verdict.textContent, "Connecting to the device...", "the test's check is in flight");

        card[field].value += "0";
        fire(card[field], "input");

        assert.equal(card.verdict.textContent, "", "the edit blanks the verdict line at once");

        answer.resolve(ANSWERED);

        await settle();

        // The edit blanks the line whether or not it retired the test, so it is the line staying blank once the held answer lands that shows the test was retired.
        assert.equal(card.verdict.textContent, "", "the edit retired the test, so its late answer paints nothing over the blanked line");
        assert.ok(isHeld(page, card.region), "and the card stays open, since an edit closes nothing");
        assert.deepEqual(page.host.toasts, [], "and a retired test raises no toast");
        assert.equal(page.double.featureOptions.commits.length, 0, "nor writes anything, since a test never saves");
        assert.deepEqual(probeDiagnostics(page), [], "and the retired test has no failure to report, so nothing reaches the console");
      });
    }

    test("writes nothing for a save that a test pressed during its check retires", async () => {

      // The first probe is the save's, held open; the test's own probe answers at once.
      const saved = Promise.withResolvers<unknown>();
      let issued = 0;

      using page = await loadUi({ probe: () => ((issued++ === 0) ? saved.promise : Promise.resolve(ANSWERED)) });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      fire(card.test, "click");

      await settle();

      assert.equal(card.verdict.textContent, "This device answered.", "the test runs and paints its own verdict");

      saved.resolve(ANSWERED);

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 0, "the test retired the save, so nothing is written");
      assert.deepEqual(page.host.toasts, [], "and the retired save reports nothing");
    });

    test("commits once for two saves in a row when the first answers last", async () => {

      const answers = [ Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>() ];
      let issued = 0;

      using page = await loadUi({ probe: () => answers[issued++]?.promise ?? Promise.resolve(ANSWERED) });

      const card = openCard(page);

      card.address.value = "10.0.0.20";
      fire(card.save, "click");

      await settle();

      fire(card.save, "click");

      await settle();

      // The SECOND save's check answers first and writes, then the first one's answers late and must write nothing.
      answers[1]?.resolve(ANSWERED);

      await settle();

      answers[0]?.resolve(ANSWERED);

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 1, "the second save retired the first, so only the newer one writes");
      assert.deepEqual(page.host.toasts, [{ channel: "success", message: "Saved. Restart Homebridge to add this device." }],
        "and one toast confirms that one write, with nothing from the retired save beside it");
    });

    test("starts nothing for a save pressed while another save's write is in flight", async () => {

      /* A write cannot be recalled once it has started, so a second press during it begins nothing at all: it sends no probe, repaints nothing, raises nothing, and
       * leaves the card held, and the first save's outcome lands as it would have. The readout is compared by identity as well as by text, so a press that repainted
       * the same answer over itself would still read as a repaint.
       */
      const held = Promise.withResolvers<boolean>();

      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);
      const original = page.double.featureOptions.commitConfig;

      // The commit is held open so a second save can be pressed while the first one's write is in flight, then released.
      page.double.featureOptions.commitConfig = async (compose): Promise<CommitResult> => {

        await held.promise;

        return original(compose);
      };

      card.address.value = "10.0.0.20";
      card.key.value = KEY;
      fire(card.save, "click");

      await settle();

      const readout = page.findElement((element) => (element.textContent === "MAC: "));

      assert.equal(card.verdict.textContent, "This device answered.", "the save names the device that answered while its write runs");
      assert.ok(readout, "with the identity readout beneath it");

      const probes = page.host.requests.filter((entry) => (entry.route === STATUS_PROBE_ROUTE)).length;

      fire(card.save, "click");

      await settle();

      assert.equal(page.host.requests.filter((entry) => (entry.route === STATUS_PROBE_ROUTE)).length, probes, "the second press sends no probe");
      assert.equal(card.verdict.textContent, "This device answered.", "and leaves the verdict line as the first save painted it");
      assert.equal(page.findElement((element) => (element.textContent === "MAC: ")), readout, "with the same identity readout beneath it");
      assert.deepEqual(page.host.toasts, [], "and raises no toast");
      assert.ok(isHeld(page, card.region), "while the card stays held");

      held.resolve(true);

      await settle();

      assert.equal(page.double.featureOptions.commits.length, 1, "the first save's write lands exactly once");
      assert.deepEqual(page.host.toasts, [{ channel: "success", message: "Saved. Restart Homebridge to add this device." }], "and one success toast confirms it");
      assert.equal(isHeld(page, card.region), false, "and the saved card gives the content area back");
    });

    test("holds the Save button, and no other, disabled for as long as a save's write is in flight", async () => {

      /* The page states which button saves and the library's flow does the rest, so this row reads the button itself and never a flag of the page's own: the Save
       * button is disabled from the turn its write starts until that write settles, and no other element of the page is disabled while it runs.
       */
      const held = Promise.withResolvers<boolean>();

      using page = await loadUi({ probe: async () => ANSWERED });

      const card = openCard(page);
      const original = page.double.featureOptions.commitConfig;

      // The commit is held open so the card can be read while the save's write is in flight, then released.
      page.double.featureOptions.commitConfig = async (compose): Promise<CommitResult> => {

        await held.promise;

        return original(compose);
      };

      card.address.value = "10.0.0.20";
      card.key.value = KEY;

      assert.equal(card.save.disabled, false, "the Save button is enabled before it is pressed");

      fire(card.save, "click");

      await settle();

      assert.equal(page.findElement((element) => (element.disabled === true) && (element !== card.save)), null,
        "no element of the page but the Save button is disabled while the write is in flight");
      assert.equal(card.save.disabled, true, "and the Save button is disabled for as long as the write runs");

      held.resolve(true);

      await settle();

      // The saved card has given the content area back and left the page, so the button is read through the reference the open took rather than by a search.
      assert.equal(card.save.disabled, false, "the Save button is enabled again once the write settles");
      assert.equal(page.double.featureOptions.commits.length, 1, "and exactly one commit landed");
    });

    // The outcomes of a save that write nothing, each arranged as the rows above arrange it: a device refusing the test, an address already listed with no key
    // typed, and a write the host refuses.
    const unwritten: { commit?: CommitResult; config?: FakeConfigEntry[]; name: string; probe: unknown; verdict: string }[] = [

      { name: "the device refused", probe: { kind: "error", reason: "auth-missing" },
        verdict: "This device requires its API encryption key. Enter the key from the device's YAML configuration and test again." },
      { config: configWith("Enable.Device.Address=10.0.0.20"), name: "found the device already listed", probe: ANSWERED, verdict: "This device is already listed." },
      { commit: { error: new Error("the host refused the write"), kind: "failed" }, name: "failed to write", probe: ANSWERED, verdict: "the host refused the write" }
    ];

    for(const outcome of unwritten) {

      test("keeps the card open for a save that " + outcome.name, async () => {

        using page = await loadUi({ config: outcome.config, probe: async () => outcome.probe });

        const card = openCard(page);

        if(outcome.commit) {

          page.double.featureOptions.nextCommit = outcome.commit;
        }

        card.address.value = "10.0.0.20";
        fire(card.save, "click");

        await settle();

        assert.ok(isHeld(page, card.region), "the card stays held, since the save wrote nothing and the user may want to try again");
        assert.equal(card.verdict.textContent, outcome.verdict, "the verdict line reads that outcome's own sentence");
        assert.equal(page.findElement((element) => (element.textContent === "MAC: ")), null, "and no identity readout stands beneath it");
      });
    }

    for(const field of [ "address", "key" ] as const) {

      test("blanks a standing verdict when the " + field + " field is edited with nothing in flight", async () => {

        using page = await loadUi({ probe: async () => ANSWERED });

        const card = openCard(page);

        card.address.value = "10.0.0.20";
        fire(card.test, "click");

        await settle();

        assert.equal(card.verdict.textContent, "This device answered.", "a verdict stands with nothing in flight");

        card[field].value += "0";
        fire(card[field], "input");

        assert.equal(card.verdict.textContent, "", "the edit blanks it, since it describes the text that was tested rather than what the field holds");
        assert.equal(page.findElement((element) => (element.textContent === "MAC: ")), null, "and the readout beneath it goes with it");
      });
    }
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
