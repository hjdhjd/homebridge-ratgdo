/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.redial.test.ts: How the platform reaches an opener it holds no connection for, driven for real. A RatgdoPlatform is built on the shared Homebridge test
 * double with its injectable defaults set to the doubles, openers are discovered and admitted through scripted dials, and each row releases an opener the way the
 * field does - a reconnect the client gives up for good, a session whose device is another opener, a dial of a moved opener that fails - and reads what follows on
 * the platform's TestClock: when the opener is dialed again and where, what the log says about it, and how it comes back. Every dial is scripted per address and
 * parks once its script runs out, so a row's dial count is exact and a loop that stops pausing fails that count rather than the suite's timeout.
 */
import type { BuildPlatformResult, ScriptedAnswer, TestEspHomeClient } from "./testing.helpers.ts";
import { Characteristic, Service, buildPlatform, colonMac, customNameEntry, makeOpenerClient, makeOpenerService, makeScriptedOpenClient,
  nameLookupsDuring } from "./testing.helpers.ts";
import { ConnectionRefusedError, EncryptionKeyInvalidError } from "esphome-client";
import type { TestLogEntry, TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import { expectAt, formatLogEntry, linesAt, logCount, present, settle, settleUntil } from "homebridge-plugin-utils/testing";
import type { HomebridgePluginLogging } from "homebridge-plugin-utils";
import type { RatgdoAccessory } from "./device.ts";
import assert from "node:assert/strict";

// The opener this suite releases, in the plugin's identity form, the address it is admitted at, and the address it moves to.
const MAC = "AABBCCDDEEFF";
const ADDRESS = "192.0.2.10";
const MOVED = "192.0.2.30";

// A second opener, whose advertisement triggers a discovery pass of its own.
const MAC_TWO = "112233445566";
const ADDRESS_TWO = "192.0.2.11";

// Another device, which answers at the opener's address while the opener is away.
const OTHER = "778899AABBCC";

// An address the user listed, which reaches the opener.
const LISTED = "192.0.2.20";

// The retry interval, in milliseconds, which the redial pauses for before each dial.
const INTERVAL = 300000;

// The info line a redial says once when it begins.
const RETRY_LINE = "The connection will be retried every 5 minutes";

// The feature option that turns the platform's debug setting on, which routes a debug line through warn, so a row can count a repeat where it lands.
const DEBUG = "Enable.Log.Debug";

// The cause of a reconnect the client gives up for good: the device refuses the key, which the client never retries.
const refusedKey = (): EncryptionKeyInvalidError => new EncryptionKeyInvalidError("The device refused the key.");

/* A dial nothing answers, which the connect core reports as a failure it cannot classify. It is a host name that does not resolve, a failure the connection
 * fault rule keeps at error, because the rows below read a repeat on the debug channel, which the platform's debug setting routes through warn, and a
 * failure reported at warn would land its first report on that same channel.
 */
const unanswered = (): ConnectionRefusedError => new ConnectionRefusedError("Connection to the opener failed: ENOTFOUND.", "ENOTFOUND");

// How often a message has been reported at error and repeated on the debug channel, which the platform's debug setting routes through warn.
const reported = (built: BuildPlatformResult, message: string): [ number, number ] => [ logCount(built.entries, "error", message),
  logCount(built.entries, "warn", message) ];

/* A platform whose dials are scripted per address, an opener discovered and admitted at its address through the first answer of that address's script, and the
 * handles a row reads: the platform, the opener's accessory and client, and the dial factory.
 */
interface Released {

  accessory: TestPlatformAccessory;
  built: BuildPlatformResult;
  client: TestEspHomeClient;
  dialsTo: (host: string) => number;
  loggerOf: (host: string) => HomebridgePluginLogging;
  ratgdo: RatgdoAccessory;
}

/* Admit the opener at its address through a client this builds, whose dial is the first at that address, with every other dial answered from the row's scripts: an
 * address's script after the admission, and every other address's from its first dial.
 */
const admit = async (scripts: Partial<Record<string, ScriptedAnswer[]>> = {}, userOptions?: string[]): Promise<Released> => {

  const client = makeOpenerClient({ mac: MAC });
  const openClient = makeScriptedOpenClient({ ...scripts, [ADDRESS]: [ client, ...(scripts[ADDRESS] ?? []) ] });
  const built = buildPlatform({ openClient, userOptions });

  built.launch().found(makeOpenerService({ address: ADDRESS, mac: MAC }));

  await settleUntil(() => built.platform.configuredDevices.size === 1, { description: "the discovered opener to be admitted" });

  return { accessory: expectAt(built.api.accessories, 0, "the accessory the platform registered"), built, client,
    dialsTo: (host: string): number => openClient.calls.filter((call) => call.host === host).length,
    loggerOf: (host: string): HomebridgePluginLogging => present(openClient.calls.findLast((call) => call.host === host), "the latest dial at " + host).logger,
    ratgdo: present([...built.platform.configuredDevices.values()][0], "the admitted opener") };
};

// The reconnect the client gives up for good: the first failed attempt's lost, then the terminal disconnect carrying the permanent cause.
const giveUp = (client: TestEspHomeClient): void => {

  client.emit("lifecycle", { cause: refusedKey(), kind: "lost" });
  client.emit("lifecycle", { cause: refusedKey(), kind: "disconnect" });
};

// Cross the redial's pause and let the dial it releases settle.
const crossInterval = async (built: BuildPlatformResult): Promise<void> => {

  built.clock.advance(INTERVAL);

  await settle(4);
};

// Where in the log the first line at a level carrying a message landed, or -1 when none did, so a row can read which of the lines it names was written first.
const indexOf = (entries: readonly TestLogEntry[], level: TestLogEntry["level"], message: string): number => entries.findIndex((entry) => (entry.level === level) &&
  formatLogEntry(entry).includes(message));

// The Model and FirmwareRevision the accessory's information service carries.
const identity = (accessory: TestPlatformAccessory): unknown[] => {

  const info = present(accessory.getService(Service.AccessoryInformation), "the accessory information service");

  return [ info.getCharacteristic(Characteristic.Model).value, info.getCharacteristic(Characteristic.FirmwareRevision).value ];
};

describe("RatgdoPlatform redial", () => {

  test("a permanent give-up releases the opener into a redial that pauses first, says so once, quiets a repeating refusal, and installs the opener once it answers",
    async () => {

      const fixed = makeOpenerClient({ mac: MAC });
      const opener = await admit({ [ADDRESS]: [ refusedKey(), refusedKey(), fixed ] });
      const { built } = opener;

      giveUp(opener.client);

      assert.equal(opener.ratgdo.isOnline, false, "the give-up states the opener offline");
      assert.equal(built.platform.getEspHomeClient(MAC), undefined, "and releases its connection record, since the given-up client will never dial again");
      assert.equal(opener.client.disposeCount, 1, "the given-up client is disposed");
      assert.equal(logCount(built.entries, "info", RETRY_LINE), 1, "the release says once that the opener will be retried, and that a key change needs a restart");
      assert.equal(opener.dialsTo(ADDRESS), 1, "nothing is dialed at once, because the give-up has just said why the opener refused");
      assert.ok(built.clock.requested.includes(INTERVAL), "the redial pauses for the retry interval first");

      await crossInterval(built);

      assert.equal(opener.dialsTo(ADDRESS), 2, "crossing the interval dials the opener where it last answered");
      assert.equal(logCount(built.entries, "error", "Encryption configuration error"), 1,
        "the redial's first refusal repeats the one the give-up reported, so it adds no error line");

      await crossInterval(built);

      assert.equal(opener.dialsTo(ADDRESS), 3, "the refusal is retried on the interval");
      assert.equal(logCount(built.entries, "error", "Encryption configuration error"), 1,
        "a repeating refusal adds no error line, quieted to the debug channel the platform's debug setting gates");
      assert.equal(opener.ratgdo.isOnline, false, "and the opener stays offline while it refuses");

      await crossInterval(built);

      assert.equal(opener.dialsTo(ADDRESS), 4, "the opener is dialed again once the interval passes");
      assert.equal(built.platform.getEspHomeClient(MAC), fixed, "the opener that answers is installed as its accessory's connection");
      assert.equal(fixed.disposeCount, 0, "and its client is kept rather than disposed as a second client for a configured device");
      assert.equal(opener.ratgdo.isOnline, true, "the opener answers HomeKit again");
      assert.equal(logCount(built.entries, "info", "Ratgdo connected."), 2, "and the connection is announced, once for the admission and once for the install");
      assert.equal(built.platform.configuredDevices.size, 1, "the accessory that stood throughout is the one connected");

      await crossInterval(built);
      await crossInterval(built);

      assert.equal(opener.dialsTo(ADDRESS), 4, "the installed opener ends its redial, so nothing dials it again");
    });

  test("a give-up reports the device's own words as the parameter of its diagnostic, never as part of the format, so the line carries them as the device wrote them",
    async () => {

      const words = "The key is 100% wrong, and 50%% of a guess.";
      const opener = await admit();
      const { built } = opener;
      const sentence = opener.ratgdo.device.name + ": Encryption configuration error - check the device's API encryption key: ";

      opener.client.emit("lifecycle", { cause: new EncryptionKeyInvalidError(words), kind: "lost" });
      opener.client.emit("lifecycle", { cause: new EncryptionKeyInvalidError(words), kind: "disconnect" });

      assert.deepEqual(built.entries.filter((entry) => entry.level === "error").map((entry) => [ entry.message, entry.params ]), [[ sentence + "%s", [words] ]],
        "the device's words reach the log as the parameter of a complete sentence, so no logger ever reads a percent sign in them as a format token");
      assert.deepEqual(linesAt(built.entries, "error"), [sentence + words],
        "and the line carries the device's message exactly as the device wrote it, a single and a doubled percent sign included");
    });

  test("the opener's own advertisement redials it at once where it answers, and a pass another opener's advertisement triggers dials nothing", async () => {

    const moved = makeOpenerClient({ mac: MAC });
    const opener = await admit({ [ADDRESS_TWO]: [makeOpenerClient({ mac: MAC_TWO })], [MOVED]: [moved] });
    const { built } = opener;

    giveUp(opener.client);
    built.browser().found(makeOpenerService({ address: ADDRESS_TWO, mac: MAC_TWO }));

    await settleUntil(() => built.platform.configuredDevices.size === 2, { description: "the second opener to be admitted" });
    await settle(4);

    assert.equal(opener.dialsTo(ADDRESS), 1, "the pass the other opener's advertisement triggered reads the released opener's advertisement but dials nothing");

    built.browser().updated(makeOpenerService({ address: MOVED, mac: MAC }));

    await settleUntil(() => opener.ratgdo.isOnline, { description: "the released opener to be installed" });
    await settle(4);

    assert.equal(opener.dialsTo(MOVED), 1, "the opener's own advertisement dials it once, at once, at the address it advertises");
    assert.equal(built.platform.getEspHomeClient(MAC), moved, "and the opener answering there is installed");
    assert.equal(opener.ratgdo.device.address, MOVED, "the device records the address its live connection was opened at");
    assert.equal(opener.dialsTo(ADDRESS), 1, "and nothing dialed the address it left");
  });

  test("a session whose device is another opener is refused on its connect, released ahead of the line explaining why, and redialed until the opener answers",
    async () => {

      const wrong = makeOpenerClient({ mac: OTHER });
      const fixed = makeOpenerClient({ mac: MAC });
      const opener = await admit({ [ADDRESS]: [ wrong, fixed ] });
      const { built } = opener;
      const admittedAt = built.entries.length;

      // Another device took the opener's address while the client was reconnecting, and its session reports its own MAC, model and firmware.
      Object.assign(present(opener.client.deviceInfo(), "the session's device-info record"), { esphomeVersion: "2025.10.1", macAddress: "77:88:99:AA:BB:CC",
        projectVersion: "9.9.9" });
      opener.client.emit("lifecycle", { kind: "disconnect" });
      opener.client.emit("lifecycle", { encrypted: false, kind: "connect" });

      const refusal = built.entries.slice(admittedAt);

      assert.equal(opener.ratgdo.isOnline, false, "the plaintext session of the wrong device is refused, so the opener reads offline");
      assert.deepEqual(identity(opener.accessory), [ "Ratgdo 1.0.0", "2.0.0" ], "the wrong device's model and firmware never reach the information service");
      assert.equal(logCount(refusal, "info", "Ratgdo reconnected after a brief connection drop."), 0, "and no line claims the opener is back");
      assert.equal(built.platform.getEspHomeClient(MAC), undefined, "the session's connection is released");
      assert.equal(opener.client.disposeCount, 1, "and its client disposed");
      assert.ok(indexOf(refusal, "info", "Ratgdo disconnected.") >= 0, "the opener is announced offline");
      assert.ok(indexOf(refusal, "info", "Ratgdo disconnected.") < indexOf(refusal, "error", "The wrong device answered"),
        "ahead of the line explaining why");
      assert.equal(logCount(refusal, "info", RETRY_LINE), 1, "and the opener is handed to its redial, which says so once");

      await crossInterval(built);

      assert.equal(opener.dialsTo(ADDRESS), 2, "the redial dials the opener's address again");
      assert.equal(wrong.disposeCount, 1, "the wrong device still answering there is refused on its first contact, plaintext though it is");
      assert.equal(built.platform.getEspHomeClient(MAC), undefined, "so it is never admitted as the opener");
      assert.equal(opener.ratgdo.isOnline, false, "and the opener stays offline");

      await crossInterval(built);

      assert.equal(built.platform.getEspHomeClient(MAC), fixed, "once the opener answers its own address again, it is installed");
      assert.equal(opener.ratgdo.isOnline, true, "and answers HomeKit");
    });

  test("a redial ends without dialing once another path connects the opener", async () => {

    const listedAnswer = Promise.withResolvers<TestEspHomeClient>();
    const listed = makeOpenerClient({ deviceInfo: { projectName: "ratgdo.esp32" }, mac: MAC });
    const opener = await admit({ [LISTED]: [listedAnswer.promise] }, ["Enable.Device.Address=" + LISTED]);
    const { built } = opener;

    giveUp(opener.client);

    // The listed address's first dial lands while the redial is pausing, and the listed address takes the opener over and installs its own connection.
    listedAnswer.resolve(listed);

    await settleUntil(() => built.platform.getEspHomeClient(MAC) !== undefined, { description: "the listed address to connect the opener" });
    await crossInterval(built);
    await crossInterval(built);

    assert.equal(opener.dialsTo(LISTED), 1, "the redial woke to a connection another path made and dialed nothing");
    assert.equal(opener.dialsTo(ADDRESS), 1, "at the address discovery found it at");
    assert.equal(built.clock.requested.filter((ms) => ms === INTERVAL).length, 1, "and it paused no more, because it had ended");
    assert.equal(listed.disposeCount, 0, "the listed address's connection stands");
  });

  test("a redial's dial that lands after a listed address installed the opener's connection is disposed, and the listed connection stands", async () => {

    const listedAnswer = Promise.withResolvers<TestEspHomeClient>();
    const redialAnswer = Promise.withResolvers<TestEspHomeClient>();
    const listed = makeOpenerClient({ deviceInfo: { projectName: "ratgdo.esp32" }, mac: MAC });
    const late = makeOpenerClient({ mac: MAC });

    // A second answer at the listed address, which only a dial that went on to the listed address over the connection installed there would reach.
    const again = makeOpenerClient({ deviceInfo: { projectName: "ratgdo.esp32" }, mac: MAC });
    const opener = await admit({ [ADDRESS]: [redialAnswer.promise], [LISTED]: [ listedAnswer.promise, again ] }, ["Enable.Device.Address=" + LISTED]);
    const { built } = opener;

    giveUp(opener.client);

    await crossInterval(built);

    assert.equal(opener.dialsTo(ADDRESS), 2, "the redial's dial is in flight at the address the opener last answered");

    // The listed address's first dial lands while the redial's is still in flight, and the listed address takes the opener over and installs its own connection.
    listedAnswer.resolve(listed);

    await settleUntil(() => built.platform.getEspHomeClient(MAC) !== undefined, { description: "the listed address to install the opener's connection" });

    assert.equal(built.platform.getEspHomeClient(MAC), listed, "the listed address's connection is installed while the redial's dial is in flight");

    redialAnswer.resolve(late);

    await settleUntil(() => late.disposeCount === 1, { description: "the redial's client to be disposed" });
    await settle(4);

    assert.equal(built.platform.getEspHomeClient(MAC), listed, "the listed address's connection stands, rather than being installed over");
    assert.equal(listed.disposeCount, 0, "and its client is kept");
    assert.equal(opener.dialsTo(LISTED), 1, "nothing dials the listed address again, since the opener it reaches is served");

    await crossInterval(built);

    assert.equal(opener.dialsTo(ADDRESS), 2, "and the redial ends without dialing, since the opener is served");
  });

  test("a redial's dial that lands after a listed address came to govern the opener is disposed, and the governing address is dialed at once", async () => {

    const listedAnswer = Promise.withResolvers<TestEspHomeClient>();
    const movedAnswer = Promise.withResolvers<TestEspHomeClient>();
    const admitted = makeOpenerClient({ mac: MAC });
    const governed = makeOpenerClient({ mac: MAC });
    const listed = makeOpenerClient({ deviceInfo: { projectName: "ratgdo.esp32" }, mac: MAC });
    const late = makeOpenerClient({ mac: MAC });

    // The address the user lists is the one discovery finds the opener at, so the listed loop's first dial and discovery's are the first two at that address.
    const openClient = makeScriptedOpenClient({ [ADDRESS]: [ listedAnswer.promise, admitted, governed ], [MOVED]: [movedAnswer.promise] });
    const built = buildPlatform({ openClient, userOptions: ["Enable.Device.Address=" + ADDRESS] });
    const dialsTo = (host: string): number => openClient.calls.filter((call) => call.host === host).length;
    const browser = built.launch();

    await settle();

    assert.equal(dialsTo(ADDRESS), 1, "the listed address's loop dials as the platform launches, and its dial is held");

    browser.found(makeOpenerService({ address: ADDRESS, mac: MAC }));

    await settleUntil(() => built.platform.configuredDevices.size === 1, { description: "the discovered opener to be admitted" });

    const ratgdo = present([...built.platform.configuredDevices.values()][0], "the admitted opener");

    assert.equal(built.platform.getEspHomeClient(MAC), admitted, "discovery's dial admits the opener");
    assert.equal(ratgdo.device.manualAddress, undefined, "before any listed address governs it");

    // The opener gives up, then advertises itself at a new address, which wakes its redial to dial there at once.
    giveUp(admitted);
    built.browser().updated(makeOpenerService({ address: MOVED, mac: MAC }));

    await settleUntil(() => dialsTo(MOVED) === 1, { description: "the redial to dial the address the opener advertises" });

    // The listed address's held dial lands while the redial's is in flight. The opener's last connection was opened at that very address, so the listed address
    // takes the opener's governance and installs nothing.
    listedAnswer.resolve(listed);

    await settleUntil(() => ratgdo.device.manualAddress === ADDRESS, { description: "the listed address to govern the opener" });

    assert.equal(built.platform.getEspHomeClient(MAC), undefined, "the listed address leaves the opener without a connection record");

    movedAnswer.resolve(late);

    await settleUntil(() => built.platform.getEspHomeClient(MAC) !== undefined, { description: "a connection to be installed for the opener" });

    assert.equal(late.disposeCount, 1, "the redial's client, opened at an address the listed one has overruled, is disposed");
    assert.equal(dialsTo(ADDRESS), 3, "the governing address is dialed at once");
    assert.equal(built.platform.getEspHomeClient(MAC), governed, "and the opener answering there is installed");
    assert.equal(ratgdo.device.address, ADDRESS, "at the address that governs it");
  });

  test("a give-up while a redial runs wakes that redial rather than starting a second, so the opener keeps one cadence", async () => {

    const listedAnswer = Promise.withResolvers<TestEspHomeClient>();
    const listed = makeOpenerClient({ deviceInfo: { projectName: "ratgdo.esp32" }, mac: MAC });
    const opener = await admit({ [LISTED]: [ listedAnswer.promise, refusedKey(), refusedKey() ] },
      ["Enable.Device.Address=" + LISTED]);
    const { built } = opener;

    giveUp(opener.client);
    listedAnswer.resolve(listed);

    await settleUntil(() => built.platform.getEspHomeClient(MAC) !== undefined, { description: "the listed address to connect the opener" });

    // The listed address's connection gives up too, before the redial that is still pausing has noticed it.
    giveUp(listed);

    await settle(4);

    assert.equal(opener.dialsTo(LISTED), 2, "the release wakes the running redial, which dials the listed address governing the opener at once");
    assert.equal(logCount(built.entries, "info", RETRY_LINE), 1, "no second redial begins, so the retry is announced once");

    await crossInterval(built);

    assert.equal(opener.dialsTo(LISTED), 3, "one interval later the opener is dialed once, on the one cadence its one redial keeps");
    assert.equal(opener.dialsTo(ADDRESS), 1, "and never off the listed address that governs it");
  });

  test("a failed dial of a moved opener hands the opener to its redial, which reaches it where it moved", async () => {

    const moved = makeOpenerClient({ mac: MAC });
    const opener = await admit({ [MOVED]: [ unanswered(), moved ] });
    const { built } = opener;

    built.browser().updated(makeOpenerService({ address: MOVED, mac: MAC }));

    await settleUntil(() => logCount(built.entries, "info", RETRY_LINE) === 1, { description: "the failed follow to hand the opener to its redial" });

    assert.equal(logCount(built.entries, "info", "Address changed from " + ADDRESS + " to " + MOVED + ". Reconnecting."), 1, "the move is announced");
    assert.equal(opener.dialsTo(MOVED), 1, "and dialed once, which failed");
    assert.equal(opener.ratgdo.isOnline, false, "the opener reads offline with no connection");

    await crossInterval(built);

    assert.equal(opener.dialsTo(MOVED), 2, "the redial dials the address the opener moved to");
    assert.equal(built.platform.getEspHomeClient(MAC), moved, "and installs the opener answering there");
    assert.equal(opener.ratgdo.device.address, MOVED, "at its new address");
  });

  /* A follow opens the opener's episode before it dials, so the client its dial installs is handed that episode's attempt log and keeps it as its logger for its
   * life, writing a debug line for every state event. The opener carries a custom Name, so the prefix is read through the displayed-name rule, and a spy on the
   * platform's option engine counts the custom Name lookups that rule makes while one line is written, which is how the row reads that a suppressed debug line
   * resolves no name.
   */
  test("a client the address follow installs drops a debug line with debug off before resolving the opener's name, and writes each line it emits under that name",
    async () => {

      // Admit the opener under the given options and follow it to the address it moves to, answering the platform, the log adapter the client installed there was
      // handed, and the log entries written since that install.
      const follow = async (userOptions: string[]):
      Promise<{ built: BuildPlatformResult; logger: HomebridgePluginLogging; since: () => readonly TestLogEntry[] }> => {

        const { built, loggerOf, ratgdo } = await admit({ [MOVED]: [makeOpenerClient({ mac: MAC })] }, userOptions);

        built.browser().updated(makeOpenerService({ address: MOVED, mac: MAC }));

        await settleUntil(() => ratgdo.device.address === MOVED, { description: "the follow to install the client answering where the opener moved" });

        const installedAt = built.entries.length;

        return { built, logger: loggerOf(MOVED), since: (): readonly TestLogEntry[] => built.entries.slice(installedAt) };
      };

      // The formatted lines at a level carrying a message, written since the followed client was installed.
      const linesSince = (since: () => readonly TestLogEntry[], level: TestLogEntry["level"], message: string): string[] => linesAt(since(), level)
        .filter((line) => line.includes(message));

      const quiet = await follow([customNameEntry("Workshop", MAC)]);

      assert.equal(nameLookupsDuring(quiet.built.platform, () => quiet.logger.debug("A debug line.")), 0,
        "with debug off the followed client's adapter drops a debug line before resolving the name");
      assert.deepEqual(quiet.since().map((entry) => formatLogEntry(entry)).filter((line) => line.includes("A debug line.")), [],
        "and the line reaches the log at no level");

      const verbose = await follow([ DEBUG, customNameEntry("Workshop", MAC) ]);

      assert.equal(nameLookupsDuring(verbose.built.platform, () => verbose.logger.debug("A debug line.")), 1,
        "with debug on the followed client's adapter resolves the opener's name for the line");
      assert.deepEqual(linesSince(verbose.since, "warn", "A debug line."), ["Workshop: A debug line."],
        "and the line reaches the log once, at warn, under the opener's displayed name");

      for(const followed of [ quiet, verbose ]) {

        for(const level of [ "error", "info", "warn" ] as const) {

          followed.logger[level]("A line at " + level + ".");

          assert.deepEqual(linesSince(followed.since, level, "A line at " + level + "."), ["Workshop: A line at " + level + "."],
            "the " + level + " level reaches the log under the opener's displayed name whatever the debug setting");
        }
      }
    });

  test("shutdown ends a pausing redial without a dial or a fault", async () => {

    const opener = await admit();
    const { built } = opener;

    giveUp(opener.client);

    const releasedAt = built.entries.length;

    await built.platform.shutdown();
    await crossInterval(built);

    assert.equal(opener.dialsTo(ADDRESS), 1, "a stopping platform dials no released opener");
    assert.deepEqual(built.entries.slice(releasedAt).filter((entry) => entry.level === "error"), [], "and the redial's unwind is no fault");
  });

  /* A release and the redial it starts are one episode of one fault: the release reports the fault, and each redial attempt that meets it again repeats it on the
   * debug channel. Every row here turns the platform's debug setting on, so a repeat is counted where it lands rather than inferred from the error line it did not
   * add.
   */
  describe("one episode per release", () => {

    test("a give-up reports its refusal at error once, and each redial attempt that meets the refusal again repeats it at debug", async () => {

      const opener = await admit({ [ADDRESS]: [ refusedKey(), refusedKey() ] }, [DEBUG]);
      const { built } = opener;

      giveUp(opener.client);

      assert.deepEqual(reported(built, "Encryption configuration error"), [ 1, 0 ], "the give-up reports the refused key at error");

      await crossInterval(built);

      assert.equal(opener.dialsTo(ADDRESS), 2, "the redial dials the opener");
      assert.deepEqual(reported(built, "Encryption configuration error"), [ 1, 1 ], "and its first refusal repeats the give-up's at debug, adding no error line");

      await crossInterval(built);

      assert.equal(opener.dialsTo(ADDRESS), 3, "the redial dials the opener again");
      assert.deepEqual(reported(built, "Encryption configuration error"), [ 1, 2 ], "and so does each refusal after it");
    });

    test("a session refused as another device reports the refusal at error once, and each redial attempt that meets the refusal again repeats it at debug",
      async () => {

        const opener = await admit({ [ADDRESS]: [ makeOpenerClient({ mac: OTHER }), makeOpenerClient({ mac: OTHER }) ] }, [DEBUG]);
        const { built } = opener;

        Object.assign(present(opener.client.deviceInfo(), "the session's device-info record"), { macAddress: colonMac(OTHER) });
        opener.client.emit("lifecycle", { kind: "disconnect" });
        opener.client.emit("lifecycle", { encrypted: false, kind: "connect" });

        assert.deepEqual(reported(built, "The wrong device answered"), [ 1, 0 ], "the refused session reports the wrong device at error");

        await crossInterval(built);

        assert.equal(opener.dialsTo(ADDRESS), 2, "the redial dials the opener's address");
        assert.deepEqual(reported(built, "The wrong device answered"), [ 1, 1 ], "and its first refusal repeats the session's at debug, adding no error line");

        await crossInterval(built);

        assert.equal(opener.dialsTo(ADDRESS), 3, "the redial dials the opener's address again");
        assert.deepEqual(reported(built, "The wrong device answered"), [ 1, 2 ], "and so does each refusal after it");
      });

    test("a failed dial of a moved opener reports its failure at error once, and each redial attempt that meets the failure again repeats it at debug", async () => {

      const opener = await admit({ [MOVED]: [ unanswered(), unanswered(), unanswered() ] }, [DEBUG]);
      const { built } = opener;

      built.browser().updated(makeOpenerService({ address: MOVED, mac: MAC }));

      await settleUntil(() => logCount(built.entries, "info", RETRY_LINE) === 1, { description: "the failed follow to hand the opener to its redial" });

      assert.equal(opener.dialsTo(MOVED), 1, "the follow dials the address the opener moved to");
      assert.deepEqual(reported(built, "Failed to establish connection"), [ 1, 0 ], "and reports the failed dial at error");

      await crossInterval(built);

      assert.equal(opener.dialsTo(MOVED), 2, "the redial dials the moved opener");
      assert.deepEqual(reported(built, "Failed to establish connection"), [ 1, 1 ], "and its first failure repeats the follow's at debug, adding no error line");

      await crossInterval(built);

      assert.equal(opener.dialsTo(MOVED), 3, "the redial dials the moved opener again");
      assert.deepEqual(reported(built, "Failed to establish connection"), [ 1, 2 ], "and so does each failure after it");
    });

    test("a redial attempt failing for a reason other than the one its release reported reports that reason at error too", async () => {

      const opener = await admit({ [ADDRESS]: [ unanswered(), unanswered() ] }, [DEBUG]);
      const { built } = opener;

      giveUp(opener.client);

      await crossInterval(built);

      assert.deepEqual(reported(built, "Encryption configuration error"), [ 1, 0 ], "the give-up reports the refused key at error");
      assert.deepEqual(reported(built, "Failed to establish connection"), [ 1, 0 ], "and the redial's first attempt reports its different failure at error too");

      await crossInterval(built);

      assert.deepEqual(reported(built, "Failed to establish connection"), [ 1, 1 ], "the episode goes on from the new reason, so its repeat goes to debug");
    });
  });
});
