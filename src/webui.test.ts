/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui.test.ts: The settings page's trigger paths, exercised against the REAL homebridge-ui/public/ui.mjs running under a boundary double for the webUI framework.
 * Covers the boot warm, the trailing debounce, the send-suppression diff, the epoch refusal, every forced-resend belt, the address-refresh latch and the identity
 * strip it feeds, the feature-options parameters the page declares, the legacy-settings migration's write path, and the shared route constants both halves address.
 *
 * The page is the real module, not a re-implementation: the harness routes its framework specifiers to the shipped browser files and its webUI shell to the double,
 * so the feature-option engine that resolves each device's key and the configuration session that stages the migration are the library's own. What the fakes observe
 * is therefore the page's behavior rather than a restatement of it - the host's request log, the double's handler store and counters, and the fake document's state.
 */
import type { FakeCatalog, FakeConfigEntry } from "./webui-double.helpers.ts";
import { STATUS_ADDRESSES_ROUTE, STATUS_WARM_ROUTE, defaultConfig, defaultDevices, realCatalog } from "./webui-double.helpers.ts";
import { describe, test } from "node:test";
import type { LoadedUi } from "./webui.helpers.ts";
import assert from "node:assert/strict";
import { loadUi } from "./webui.helpers.ts";
import { settle } from "homebridge-plugin-utils/testing";

// The two fixture devices' macs, and the key configured against the first of them.
const MAC = "AABBCCDDEEFF";
const MAC_TWO = "112233445566";
const KEY = "c2VjcmV0LWtleQ==";

// A primary platform entry carrying the given option entries, which is the one shape every configuration test in this file varies.
const configWith = (...options: string[]): FakeConfigEntry[] => [{ name: "Ratgdo", options, platform: "Ratgdo" }];

// The device-scoped encryption-key entry the real feature-option engine resolves into a warm entry's psk.
const keyEntry = (mac: string, key: string): string => "Enable.Device.Encryption.Key." + mac + "=" + key;

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
      assert.deepEqual(sends[0], { devices: [ { mac: MAC, psk: KEY }, { mac: MAC_TWO } ] },
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
      assert.deepEqual(sends.at(-1), { devices: [ { mac: MAC, psk: "second" }, { mac: MAC_TWO } ] }, "the one send carries the settled value, not the half-typed one");
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

  describe("the epoch check", () => {

    test("refuses a send from a page copy the window has retired", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;

      // The visibility belt is a forced path, so the remembered set is cleared and the recompute runs all the way to its last condition before the send.
      page.document.visibilityState = "visible";
      page.double.fire("visibilitychange");
      page.double.epoch.abort();

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before, "a retired page copy sends nothing, even on a forced path with the remembered set cleared");
    });
  });

  describe("the forced-resend belts", () => {

    test("the visibility belt re-sends an unchanged set on a return to the foreground", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;

      page.document.visibilityState = "visible";
      page.double.fire("visibilitychange");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "returning to the foreground forces exactly one re-send");
    });

    test("the visibility belt stays quiet while the page is hidden", async (t) => {

      t.mock.timers.enable({ apis: ["setTimeout"] });

      using page = await loadUi();

      const before = warmSends(page).length;

      page.document.visibilityState = "hidden";
      page.double.fire("visibilitychange");

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
      page.double.fire("configChanged");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before, "a config change over unchanged keys sends nothing");

      setOptions(page, keyEntry(MAC, KEY));
      page.double.fire("configChanged");

      await releaseDebounce(t.mock.timers);

      assert.equal(warmSends(page).length, before + 1, "a config change that moved a key sends once");
    });
  });

  describe("the identity strip's addresses", () => {

    test("coalesces a connecting burst into one address read and renders the address it returns", async () => {

      using page = await loadUi({ addresses: { [MAC]: "192.0.2.10" } });

      const before = page.host.requests.filter((entry) => (entry.route === STATUS_ADDRESSES_ROUTE)).length;

      for(let push = 0; push < 3; push++) {

        page.double.fire("status", { data: { kind: "connecting" } });
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

      assert.deepEqual(warmSends(page)[0], { devices: [ { mac: MAC, psk: KEY }, { mac: MAC_TWO } ] },
        "tagging a row for the sidebar adds nothing to the warm body the server receives");
    });
  });

  describe("the shared status routes", () => {

    test("addresses the bridge through the constants the UI server reads", async () => {

      using page = await loadUi({ addresses: { [MAC]: "192.0.2.10" } });

      page.double.fire("status", { data: { kind: "connecting" } });

      await settle();

      const routes = page.host.requests.map((entry) => entry.route);

      assert.ok(routes.includes(STATUS_WARM_ROUTE), "the warm send addresses the shared warm route");
      assert.ok(routes.includes(STATUS_ADDRESSES_ROUTE), "the address read addresses the shared addresses route");
      assert.equal(defaultDevices().length, 2, "the default fixture install advertises one device of each variant");
    });
  });
});
