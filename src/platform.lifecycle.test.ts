/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.lifecycle.test.ts: The platform's connection lifecycle, driven for real. A RatgdoPlatform is built on the shared Homebridge test double with its
 * injectable defaults set to the doubles, an opener is discovered through the browser double and admitted through a fake dial, and the admitted client's lifecycle
 * events are delivered in the orders esphome-client emits them. Each row reads what the opener's users see: whether HomeKit answers, the info and error lines, the
 * MQTT availability statement, and the identity characteristics each session refreshes.
 */
import type { BuildPlatformResult, TestEspHomeClient } from "./testing.helpers.ts";
import { Characteristic, Service, buildPlatform, makeFakeOpenClient, makeOpenerClient, makeOpenerService } from "./testing.helpers.ts";
import { ConnectionError, EncryptionKeyInvalidError, LogLevel } from "esphome-client";
import type { TestLogEntry, TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import { expectAt, formatLogEntry, hapStatus, logCount, present, settleUntil, triggerGet } from "homebridge-plugin-utils/testing";
import { DeviceIdentityError } from "./connection.ts";
import type { DeviceInfo } from "esphome-client";
import { HAPStatus } from "homebridge-plugin-utils";
import type { RatgdoAccessory } from "./device.ts";
import assert from "node:assert/strict";

// The opener this suite discovers, in the plugin's identity form, and the address it advertises.
const MAC = "AABBCCDDEEFF";
const ADDRESS = "192.0.2.10";

// The device info a reconnecting session reports, distinct from the record the opener was admitted with, so a refreshed identity shows.
const UPGRADED_INFO = { esphomeVersion: "2025.10.1", projectVersion: "2.5.0" };

// The error a failed reconnect attempt carries on lost, a cause the client retries.
const ATTEMPT_FAILED = new ConnectionError("The reconnect attempt failed.", "CONNECT_FAILED");

/* An opener the platform has discovered and admitted: the platform, its client double, the device-info record that client reports, the accessory the platform
 * built, and how many log entries had been written once admission was done.
 */
interface AdmittedOpener {

  accessory: TestPlatformAccessory;
  admittedAt: number;
  built: BuildPlatformResult;
  client: TestEspHomeClient;
  ratgdo: RatgdoAccessory;
  record: DeviceInfo;
}

/* Discover an opener through the browser double and let the platform admit it through a fake dial answering with an opener's client. The client reports its
 * device-info record by reference, so a row moves the identity fields on that record the way a session on new firmware would before driving the session's connect.
 */
const admit = async ({ encrypted = false, mqtt = false, userOptions }: { encrypted?: boolean; mqtt?: boolean; userOptions?: string[] } = {}):
Promise<AdmittedOpener> => {

  const client = makeOpenerClient({ encrypted, mac: MAC });
  const built = buildPlatform({ mqtt, openClient: makeFakeOpenClient(client), userOptions });

  built.launch().found(makeOpenerService({ address: ADDRESS, mac: MAC }));

  await settleUntil(() => built.platform.configuredDevices.size === 1, { description: "the discovered opener to be admitted" });

  return { accessory: expectAt(built.api.accessories, 0, "the accessory the platform registered"), admittedAt: built.entries.length, built, client,
    ratgdo: present([...built.platform.configuredDevices.values()][0], "the admitted opener"), record: present(client.deviceInfo(), "the opener's device-info record") };
};

// The log entries written since the opener was admitted, so a row reads what its own events produced apart from the bridge's announcement.
const since = (opener: AdmittedOpener): readonly TestLogEntry[] => opener.built.entries.slice(opener.admittedAt);

// Read the door the way HomeKit does, so a refusal surfaces as the rejection HomeKit would receive.
const readDoor = (opener: AdmittedOpener): ReturnType<typeof triggerGet> => {

  return triggerGet(present(opener.accessory.getService(Service.GarageDoorOpener), "the garage door service").getCharacteristic(Characteristic.CurrentDoorState));
};

// The Model and FirmwareRevision the accessory's information service carries.
const identity = (opener: AdmittedOpener): unknown[] => {

  const info = present(opener.accessory.getService(Service.AccessoryInformation), "the accessory information service");

  return [ info.getCharacteristic(Characteristic.Model).value, info.getCharacteristic(Characteristic.FirmwareRevision).value ];
};

// The formatted info lines carrying a message, so a row reads the encryption glyph the line leads with.
const infoLines = (entries: readonly TestLogEntry[], message: string): string[] => entries.filter((entry) => entry.level === "info")
  .map((entry) => formatLogEntry(entry)).filter((line) => line.includes(message));

// Where in the log the first line at a level carrying a message landed, or -1 when none did, so a row can read which of the lines it names was written first.
const indexOf = (entries: readonly TestLogEntry[], level: TestLogEntry["level"], message: string): number => entries.findIndex((entry) => (entry.level === level) &&
  formatLogEntry(entry).includes(message));

// The refusal HomeKit renders as No Response.
const isNoResponse = hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

describe("RatgdoPlatform lifecycle listener", () => {

  test("a platform built on the kit starts no discovery, socket or timer until Homebridge finishes launching", () => {

    const before = process.getActiveResourcesInfo().sort();
    const built = buildPlatform();

    assert.deepEqual(process.getActiveResourcesInfo().sort(), before, "constructing the platform leaves the process's active resources as they were");
    assert.equal(built.api.listenerCount("didFinishLaunching"), 1, "and discovery waits on Homebridge's launch");
  });

  test("the fresh client's bridge announces the connection once, states the opener online, and subscribes the battery log once for the client's life", async () => {

    const opener = await admit({ encrypted: true, mqtt: true, userOptions: ["Enable.Disco.Battery"] });
    const mqtt = present(opener.built.mqtt, "the MQTT double");

    assert.equal(logCount(opener.built.entries, "info", "Ratgdo connected."), 1, "the bridge announces the fresh client's first session once");
    assert.ok(infoLines(opener.built.entries, "Ratgdo connected.").every((line) => line.includes("\u{1F512}")),
      "the announcement carries the encryption glyph read from the fresh client's session");
    assert.equal(opener.ratgdo.isOnline, true, "the bridge states the opener online");
    assert.deepEqual(mqtt.publishedTo(MAC + "/availability").map(({ payload, retain }) => ({ payload, retain })), [{ payload: "online", retain: true }],
      "and that statement reaches the broker as the opener's retained online");
    assert.deepEqual(opener.client.logSubscriptions, [LogLevel.VERBOSE], "the battery log is subscribed for the fresh client");

    opener.client.emit("lifecycle", { kind: "disconnect" });
    opener.client.emit("lifecycle", { cause: ATTEMPT_FAILED, kind: "lost" });
    opener.client.emit("lifecycle", { encrypted: true, kind: "connect" });
    opener.client.emit("lifecycle", { kind: "recovered" });
    opener.client.emit("lifecycle", { kind: "disconnect" });
    opener.client.emit("lifecycle", { encrypted: true, kind: "connect" });

    assert.deepEqual(opener.client.logSubscriptions, [LogLevel.VERBOSE], "the client re-sends the subscription itself, so no later session subscribes again");
  });

  test("keeps the opener answering through a drop the client heals on its first attempt, refreshing its identity and logging one reconnect line", async () => {

    const opener = await admit({ encrypted: true });

    assert.deepEqual(identity(opener), [ "Ratgdo 1.0.0", "2.0.0" ], "the accessory starts with the identity its admission's device info carried");

    opener.client.emit("lifecycle", { kind: "disconnect" });

    assert.equal(opener.ratgdo.isOnline, true, "a plain disconnect states nothing, so the opener stays online through the patience window");
    await assert.doesNotReject(readDoor(opener), "HomeKit's read answers from the last known state while the client works on the drop");

    Object.assign(opener.record, UPGRADED_INFO);
    opener.client.emit("lifecycle", { encrypted: true, kind: "connect" });

    assert.equal(opener.ratgdo.isOnline, true, "the healed drop never takes the opener offline");
    assert.deepEqual(identity(opener), [ "Ratgdo 2.5.0", "2025.10.1" ], "the session's connect refreshes Model and FirmwareRevision from its device info");
    assert.equal(logCount(since(opener), "info", "Ratgdo reconnected after a brief connection drop."), 1, "the healed drop is reported once, at info");
    assert.ok(infoLines(since(opener), "Ratgdo reconnected after a brief connection drop.").every((line) => line.includes("\u{1F512}")),
      "the reconnect line carries the encryption glyph of the session it announces");
    assert.equal(logCount(since(opener), "info", "Ratgdo disconnected."), 0, "no disconnect is announced for a drop that never reached a verdict");
    assert.equal(logCount(since(opener), "info", "Ratgdo connected."), 0, "and no connection is announced, since availability never moved");
  });

  test("states a lost opener offline once, and the connect that follows says nothing of its own", async () => {

    const opener = await admit();

    opener.client.emit("lifecycle", { kind: "disconnect" });
    opener.client.emit("lifecycle", { cause: ATTEMPT_FAILED, kind: "lost" });

    assert.equal(opener.ratgdo.isOnline, false, "lost states the opener offline");
    await assert.rejects(readDoor(opener), isNoResponse, "HomeKit's read refuses with No Response once the opener is lost");
    assert.equal(logCount(since(opener), "info", "Ratgdo disconnected."), 1, "the disconnect is announced once, at lost");

    Object.assign(opener.record, UPGRADED_INFO);
    opener.client.emit("lifecycle", { encrypted: false, kind: "connect" });

    assert.equal(opener.ratgdo.isOnline, false, "a connect is no verdict, so the opener stays offline until recovered");
    assert.deepEqual(identity(opener), [ "Ratgdo 2.5.0", "2025.10.1" ], "the session's connect still refreshes the identity while the opener is offline");
    assert.equal(logCount(since(opener), "info", "Ratgdo reconnected after a brief connection drop."), 0, "a connect after lost is no healed drop");
    assert.equal(logCount(since(opener), "info", "Ratgdo connected."), 0, "the connection is announced by recovered, not by the connect before it");
  });

  test("states the opener online again on recovered, announcing the connection once with the encryption glyph", async () => {

    const opener = await admit({ encrypted: true });

    opener.client.emit("lifecycle", { kind: "disconnect" });
    opener.client.emit("lifecycle", { cause: ATTEMPT_FAILED, kind: "lost" });
    opener.client.emit("lifecycle", { encrypted: true, kind: "connect" });
    opener.client.emit("lifecycle", { kind: "recovered" });

    assert.equal(opener.ratgdo.isOnline, true, "recovered states the opener online");
    await assert.doesNotReject(readDoor(opener), "HomeKit's read answers again once the opener has recovered");
    assert.equal(logCount(since(opener), "info", "Ratgdo connected."), 1, "the connection is announced exactly once");
    assert.ok(infoLines(since(opener), "Ratgdo connected.").every((line) => line.includes("\u{1F512}")),
      "the connection line carries the encryption glyph read from the client's session, the accessor the fresh-client bridge reads too");
    assert.equal(logCount(since(opener), "info", "Ratgdo disconnected."), 1, "the outage announced its disconnect once, at lost");
  });

  test("leaves the encryption glyph off the connection line of a plaintext session", async () => {

    const opener = await admit({ encrypted: false });

    opener.client.emit("lifecycle", { cause: ATTEMPT_FAILED, kind: "lost" });
    opener.client.emit("lifecycle", { kind: "recovered" });

    const lines = infoLines(since(opener), "Ratgdo connected.");

    assert.equal(lines.length, 1, "recovered announces the connection once");
    assert.equal(lines.some((line) => line.includes("\u{1F512}")), false, "a plaintext session's connection line carries no encryption glyph");
  });

  test("states the opener offline at lost on a permanent give-up and logs the encryption diagnostic at the terminal disconnect", async () => {

    const opener = await admit();
    const refused = new EncryptionKeyInvalidError("The device refused the key.");

    opener.client.emit("lifecycle", { kind: "disconnect" });
    opener.client.emit("lifecycle", { cause: refused, kind: "lost" });

    assert.equal(opener.ratgdo.isOnline, false, "the give-up's lost states the opener offline");
    assert.equal(logCount(since(opener), "error", "Encryption configuration error"), 0, "lost carries no diagnostic line of its own");

    opener.client.emit("lifecycle", { cause: refused, kind: "disconnect" });

    await assert.rejects(readDoor(opener), isNoResponse, "HomeKit's read refuses with No Response after the give-up");
    assert.equal(logCount(since(opener), "error", "Encryption configuration error"), 1, "the terminal disconnect logs the encryption diagnostic once");
    assert.equal(logCount(since(opener), "info", "Ratgdo disconnected."), 1, "the disconnect was announced once, at lost");
    assert.ok(indexOf(since(opener), "info", "Ratgdo disconnected.") < indexOf(since(opener), "error", "Encryption configuration error"),
      "and that announcement landed ahead of the diagnostic");
  });

  test("logs the wrong-device diagnostic at a terminal disconnect carrying the identity refusal, after the disconnect it explains", async () => {

    const opener = await admit();
    const refused = new DeviceIdentityError({ expected: MAC, reported: "112233445566" });

    opener.client.emit("lifecycle", { cause: refused, kind: "lost" });
    opener.client.emit("lifecycle", { cause: refused, kind: "disconnect" });

    assert.equal(opener.ratgdo.isOnline, false, "the identity refusal leaves the opener offline");
    assert.equal(logCount(since(opener), "error", "The wrong device answered"), 1, "the terminal disconnect logs the wrong-device diagnostic once");
    assert.ok(indexOf(since(opener), "info", "Ratgdo disconnected.") >= 0, "the disconnect is announced");
    assert.ok(indexOf(since(opener), "info", "Ratgdo disconnected.") < indexOf(since(opener), "error", "The wrong device answered"),
      "and the announcement lands ahead of the diagnostic that explains it");
  });

  test("states the opener offline on a permanent-cause disconnect that no verdict preceded, announcing it ahead of its diagnostic", async () => {

    const opener = await admit();

    opener.client.emit("lifecycle", { cause: new EncryptionKeyInvalidError("The device refused the key."), kind: "disconnect" });

    assert.equal(opener.ratgdo.isOnline, false, "a cause the client will not retry states the opener offline, since no verdict would ever follow it");
    await assert.rejects(readDoor(opener), isNoResponse, "HomeKit's read refuses with No Response");
    assert.equal(logCount(since(opener), "info", "Ratgdo disconnected."), 1, "the disconnect is announced once");
    assert.equal(logCount(since(opener), "error", "Encryption configuration error"), 1, "and its diagnostic is logged once");
    assert.ok(indexOf(since(opener), "info", "Ratgdo disconnected.") < indexOf(since(opener), "error", "Encryption configuration error"),
      "the announcement lands ahead of the diagnostic, so the diagnostic follows the disconnect it explains");
  });
});
