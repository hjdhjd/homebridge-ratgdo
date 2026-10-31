/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.shutdown.test.ts: The platform's shutdown, driven for real. A RatgdoPlatform is built on the shared Homebridge test double with its injectable defaults
 * set to the doubles, openers are admitted through fake dials, and the shutdown runs against the MQTT double on the platform's TestClock. Each row reads what a
 * subscriber and the openers see between the moment shutdown stops admitting and commanding and the moment the platform's lifetime ends: every opener's retained
 * offline on the broker, and nothing admitted, stated online, commanded or logged as a fault behind it.
 */
import type { BuildPlatformResult, TestEspHomeClient } from "./testing.helpers.ts";
import type { TestMqttClient, TestMqttPublish } from "homebridge-plugin-utils/testing";
import { buildPlatform, makeFakeOpenClient, makeOpenerClient, makeOpenerService } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import { logCount, present, settle, settleUntil } from "homebridge-plugin-utils/testing";
import { ConnectionError } from "esphome-client";
import type { Nullable } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { onAbort } from "homebridge-plugin-utils";

// The openers this suite admits, each in the plugin's identity form, and the address each advertises.
const MAC = "AABBCCDDEEFF";
const MAC_TWO = "112233445566";
const MAC_THREE = "778899AABBCC";
const ADDRESS = "192.0.2.10";
const ADDRESS_TWO = "192.0.2.11";
const ADDRESS_THREE = "192.0.2.12";

// An address the user listed, at which nothing answers, so its loop is pausing between attempts when shutdown arrives.
const LISTED = "192.0.2.20";

// Each opener's availability statements, as payload and retain pairs in the order the broker received them.
const statements = (published: readonly TestMqttPublish[], mac: string): { payload: string; retain: boolean }[] => published.filter((entry) => entry.topic ===
  mac + "/availability").map(({ payload, retain }) => ({ payload: payload.toString(), retain }));

// Admit each opener at its address through the platform's discovery, and wait until the platform has configured all of them.
const admitAll = async (built: BuildPlatformResult, openers: [string, string][]): Promise<void> => {

  const browser = built.launch();

  for(const [ mac, address ] of openers) {

    browser.found(makeOpenerService({ address, mac }));
  }

  await settleUntil(() => built.platform.configuredDevices.size === openers.length, { description: "every discovered opener to be admitted" });
};

// The MQTT double the platform built, and what it had published the moment the platform's lifetime signal aborted.
const sampleAtAbort = (built: BuildPlatformResult): { mqtt: TestMqttClient; sample: () => readonly TestMqttPublish[] } => {

  const mqtt = present(built.mqtt, "the MQTT double");
  let sampled: Nullable<TestMqttPublish[]> = null;

  onAbort(present(built.mqttSignal, "the lifetime signal the platform handed its MQTT factory"), () => {

    sampled = [...mqtt.published];
  });

  return { mqtt, sample: (): readonly TestMqttPublish[] => present(sampled, "what the broker had received when the platform's lifetime ended") };
};

describe("RatgdoPlatform shutdown", () => {

  test("states every opener's retained offline to the broker before the platform's lifetime ends, and announces no disconnect of its own", async () => {

    const clients = new Map([ [ ADDRESS, makeOpenerClient({ mac: MAC }) ], [ ADDRESS_TWO, makeOpenerClient({ mac: MAC_TWO }) ] ]);
    const built = buildPlatform({ mqtt: true, openClient: makeFakeOpenClient(async (options) => present(clients.get(options.host), "the opener at " + options.host)) });

    await admitAll(built, [ [ MAC, ADDRESS ], [ MAC_TWO, ADDRESS_TWO ] ]);

    const admittedAt = built.entries.length;
    const { mqtt, sample } = sampleAtAbort(built);

    await built.platform.shutdown();

    for(const mac of [ MAC, MAC_TWO ]) {

      assert.deepEqual(statements(sample(), mac).at(-1), { payload: "offline", retain: true },
        "the broker held " + mac + "'s retained offline before the platform's lifetime ended");
    }

    assert.equal(logCount(built.entries.slice(admittedAt), "info", "Ratgdo disconnected."), 0, "shutdown announces no disconnect of its own in the log");
    assert.equal(mqtt.aborted, true, "the client's end tore it down, which is what fires its will for the plugin-level topic");
    assert.equal(logCount(built.entries, "warn", "final words went unsaid"), 0, "and it tore down only after every final word had been stated");
  });

  test("between the stopping signal and the abort nothing is admitted, stated online, commanded, or logged as a fault", async () => {

    const opener = makeOpenerClient({ mac: MAC });
    const arriving = makeOpenerClient({ mac: MAC_TWO });
    const pendingTwo = Promise.withResolvers<TestEspHomeClient>();
    const pendingThree = Promise.withResolvers<TestEspHomeClient>();
    const answers = new Map([ [ ADDRESS, Promise.resolve(opener) ], [ ADDRESS_TWO, pendingTwo.promise ], [ ADDRESS_THREE, pendingThree.promise ] ]);
    const openClient = makeFakeOpenClient(async (options) => answers.get(options.host) ?? Promise.reject(new ConnectionError("Nothing answers.", "CONNECT_FAILED")));
    const built = buildPlatform({ mqtt: true, openClient, userOptions: ["Enable.Device.Address=" + LISTED] });

    await admitAll(built, [[ MAC, ADDRESS ]]);

    // More openers are mid-dial when shutdown arrives, and the listed address is pausing after its failed first dial.
    built.browser().found(makeOpenerService({ address: ADDRESS_TWO, mac: MAC_TWO }));
    built.browser().found(makeOpenerService({ address: ADDRESS_THREE, mac: MAC_THREE }));

    await settleUntil(() => [ ADDRESS_TWO, ADDRESS_THREE, LISTED ].every((host) => openClient.calls.some((call) => call.host === host)),
      { description: "every pending dial to begin" });
    await settle();

    const { mqtt, sample } = sampleAtAbort(built);

    // The final words are held mid-flight, which holds the client's end in its grace: the window between the stopping signal and the abort stays open for the row.
    const release = mqtt.holdPublishes();
    const before = { entries: built.entries.length, published: mqtt.published.length };
    const done = built.platform.shutdown();

    pendingTwo.resolve(arriving);
    pendingThree.reject(new ConnectionError("The dial failed.", "CONNECT_FAILED"));
    opener.emit("lifecycle", { kind: "recovered" });
    await mqtt.invokeSet(MAC + "/garagedoor/set", "open");
    await settle(2);

    const during = built.entries.slice(before.entries);

    assert.equal(built.platform.configuredDevices.size, 1, "an opener whose dial resolves inside the window is not admitted");
    assert.equal(logCount(during, "info", "Configuring:"), 0, "and nothing is announced as configuring");
    assert.equal(arriving.disconnected, true, "its client is closed as it arrives");
    assert.deepEqual(opener.commands, [], "an MQTT door command inside the window reaches no opener");
    assert.deepEqual(during.filter((entry) => entry.level === "error"), [], "no loop, dial or discovery logs the teardown as a fault");

    release();
    await done;

    assert.deepEqual(mqtt.published.slice(before.published).map(({ payload, topic }) => [ topic, payload.toString() ]), [[ MAC + "/availability", "offline" ]],
      "the only statement shutdown made is the admitted opener's offline, with no online behind it");
    assert.deepEqual(statements(sample(), MAC).at(-1), { payload: "offline", retain: true }, "and the broker held it before the platform's lifetime ended");
    assert.equal(arriving.commands.length + opener.commands.length, 0, "no command reached any opener at any point");
  });

  test("Homebridge's shutdown event runs the one shutdown, and a second call states nothing twice", async () => {

    const built = buildPlatform({ mqtt: true, openClient: makeFakeOpenClient(makeOpenerClient({ mac: MAC })) });

    await admitAll(built, [[ MAC, ADDRESS ]]);

    const mqtt = present(built.mqtt, "the MQTT double");
    const before = mqtt.published.length;

    built.api.emit("shutdown");
    await built.platform.shutdown();
    await built.platform.shutdown();

    assert.deepEqual(statements(mqtt.published.slice(before), MAC), [{ payload: "offline", retain: true }],
      "the event and every call ran one shutdown, which stated the opener's offline once");
    assert.equal(mqtt.aborted, true, "and that shutdown ended the client");
  });
});
