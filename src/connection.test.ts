/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * connection.test.ts: Unit tests for the connection layer - captureInitialState's fast / slow / timeout / shutdown paths, the error taxonomy both entry points
 * classify with, openManualConnection's identification of whatever answered at an address, the key rule and the identity checks every connection runs through,
 * applyDeviceInfo's identity refresh, the isEncryptionError predicate, the identity comparison every later session is put to, and the describer that words a
 * permanent cause once for every path that meets it.
 * The ESPHome client factory is injected as a fake (makeFakeOpenClient), and the state-capture budget (timeoutSeconds) is injected in fractional seconds (e.g. 0.02)
 * so each wait resolves in milliseconds of real time, driving every branch deterministically without a live device, fake timers, or a fake Homebridge harness.
 */
import type { ConnectionOutcome, EncryptionKeyLookup, ManualConnectionOutcome, OpenConnectionOptions, OpenEspHomeClient,
  OpenManualConnectionOptions } from "./connection.ts";
import { DeviceIdentityError, applyDeviceInfo, captureInitialState, describePermanentCause, identityRefusal, isEncryptionError, openConnection,
  openManualConnection } from "./connection.ts";
import type { DeviceInfo, EntityId, NoiseServerHello, TelemetryEvent } from "esphome-client";
import { EncryptionKeyInvalidError, EncryptionKeyMissingError, EncryptionRequiredError, NegotiationFailedError, entityId } from "esphome-client";
import { RATGDO_ENTITIES, idFor, ratgdoInitialStateEntityIds } from "./entities.ts";
import { TestEspHomeClient, TestPermanentError, asEspHomeClient, makeCoverEvent, makeFakeOpenClient, makeLightEvent, makeTelemetry, makeTestDevice, openThroughHello,
  resolverOf } from "./testing.helpers.ts";
import { capturingLog, linesAt, logCount, loggedAt } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import type { Nullable } from "homebridge-plugin-utils";
import type { RatgdoEntityRef } from "./entities.ts";
import { RatgdoVariant } from "./types.ts";
import type { RecordedOpenOptions } from "./testing.helpers.ts";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// What the connection helpers in the suites below hand back: each call's outcome beside the capturing log's entries, and for a recorded attempt the factory as well.
interface ConnectionAttempt {

  entries: readonly TestLogEntry[];
  result: ConnectionOutcome;
}

interface ManualConnectionAttempt {

  entries: readonly TestLogEntry[];
  result: ManualConnectionOutcome;
}

interface RecordedManualAttempt {

  entries: readonly TestLogEntry[];
  openClient: ReturnType<typeof makeFakeOpenClient>;
  outcome: ManualConnectionOutcome;
}

describe("captureInitialState", () => {

  // Widen the branded ids to the general EntityId so a snapshot Map mixing cover and light keys infers a single Map<EntityId, TelemetryEvent> key type.
  const coverId: EntityId = entityId("cover", "door");
  const lightId: EntityId = entityId("light", "light");

  // The device advertises both cover and light; the test varies which of them the snapshot already holds.
  const bothExposed = [ { objectId: "door", type: "cover" }, { objectId: "light", type: "light" } ];

  // A fresh, never-aborted signal for the rows that resolve.
  const liveSignal = (): AbortSignal => new AbortController().signal;

  // A client that advertises cover + light but whose snapshot holds only the cover. The cover + light wait-list therefore reaches the slow path: the light must arrive
  // by telemetry, or the signal the row passes must end the wait.
  const coverPresentLightPending = (): TestEspHomeClient => new TestEspHomeClient({ entities: bothExposed, snapshot: new Map([[ coverId, makeCoverEvent("door", 0) ]]) });

  test("returns the snapshot immediately when the caller declares no required entities", async () => {

    const client = new TestEspHomeClient({ snapshot: new Map([[ coverId, makeCoverEvent("door", 0) ]]) });
    const cache = await captureInitialState({ client: asEspHomeClient(client), expected: [], signal: liveSignal() });

    assert.equal(cache, client.snapshot(), "an empty wait-list resolves with the current cache without subscribing to telemetry");
  });

  test("returns the snapshot immediately when the device exposes none of the required entities", async () => {

    // The caller wants cover + light, but the device advertises neither (entities is empty), so the intersection is empty and there is nothing to wait for.
    const client = new TestEspHomeClient({ entities: [], snapshot: new Map() });
    const cache = await captureInitialState({ client: asEspHomeClient(client), expected: [ coverId, lightId ], signal: liveSignal() });

    assert.equal(cache, client.snapshot(), "requiring only entities the firmware does not advertise collapses the wait-list to empty");
  });

  test("fast path: resolves immediately when the snapshot already holds every required entity", async () => {

    const snapshot = new Map([ [ coverId, makeCoverEvent("door", 0) ], [ lightId, makeLightEvent("light", false) ] ]);
    const client = new TestEspHomeClient({ entities: bothExposed, snapshot });
    const cache = await captureInitialState({ client: asEspHomeClient(client), expected: [ coverId, lightId ], signal: liveSignal() });

    assert.equal(cache, client.snapshot(), "the fast path returns the live cache reference when a complete snapshot satisfies the wait with no telemetry delivery");
  });

  test("slow path: resolves once delivered telemetry completes the required set", async () => {

    // captureInitialState subscribes synchronously before its first await, so delivering the missing light after the call resolves the pending wait.
    const client = coverPresentLightPending();
    const pending = captureInitialState({ client: asEspHomeClient(client), expected: [ coverId, lightId ], signal: AbortSignal.timeout(1000) });

    client.deliverState(makeLightEvent("light", false));

    const cache = await pending;

    assert.ok(cache.has(lightId), "the wait resolves the moment the last required entity lands in the cache");
  });

  test("timeout: rejects with a TimeoutError when the required set never completes", async () => {

    const client = coverPresentLightPending();
    const deadline = AbortSignal.timeout(20);

    await assert.rejects(
      captureInitialState({ client: asEspHomeClient(client), expected: [ coverId, lightId ], signal: deadline }),
      (error) => error === deadline.reason);
  });

  test("shutdown: rejects with the shutdown reason at the synchronous gate when the signal is already aborted", async () => {

    const client = coverPresentLightPending();

    await assert.rejects(
      captureInitialState({ client: asEspHomeClient(client), expected: [ coverId, lightId ], signal: AbortSignal.abort("shutdown") }),
      (reason) => reason === "shutdown");
  });

  test("shutdown: rejects with the shutdown reason when the signal aborts mid-wait", async () => {

    const controller = new AbortController();
    const client = coverPresentLightPending();
    const pending = captureInitialState({ client: asEspHomeClient(client), expected: [ coverId, lightId ], signal: controller.signal });

    controller.abort("shutdown");

    await assert.rejects(pending, (reason) => reason === "shutdown");
  });
});

describe("openConnection", () => {

  const coverId = entityId("cover", "door");
  const coverEntity = [{ objectId: "door", type: "cover" }];

  // The device-info record of the device this suite's connections are for, so admission reads the MAC each connection is dialed for.
  const deviceInfo = { macAddress: "AA:BB:CC:DD:EE:FF" };

  // A client whose snapshot already holds the required cover, so captureInitialState's fast path resolves.
  const connectedClient = (): TestEspHomeClient => new TestEspHomeClient({ deviceInfo, entities: coverEntity,
    snapshot: new Map([[ coverId, makeCoverEvent("door", 0) ]]) });

  // A client that advertises the cover but whose snapshot never holds it, so the wait reaches the slow path (and times out or aborts).
  const pendingClient = (): TestEspHomeClient => new TestEspHomeClient({ deviceInfo, entities: coverEntity, snapshot: new Map() });

  /* Drive openConnection with the fixed host and wait-list this suite uses, varying only the injected factory and the optional shutdown signal / timeout per case.
   * Returns the capturing log alongside the result so each test asserts on both.
   *
   * Every diagnostic below is matched on a substring spanning the sentence AND the value interpolated into it, because each of these lines carries the device's own
   * words - the key fault, the negotiated version, the socket error - and a match confined to the sentence would pass while the plugin handed the user a diagnostic
   * naming the wrong fault.
   */
  const run = async (openClient: ReturnType<typeof makeFakeOpenClient>, overrides: Partial<OpenConnectionOptions> = {}): Promise<ConnectionAttempt> => {

    const log = capturingLog();
    const result = await openConnection({ expected: [coverId], host: "192.0.2.10", keyFor: () => undefined, log, mac: "AABBCCDDEEFF", openClient,
      shutdownSignal: new AbortController().signal, ...overrides });

    return { entries: log.entries, result };
  };

  test("success: resolves with the client and its captured initial state, leaving the client live", async () => {

    const client = connectedClient();
    const openClient = makeFakeOpenClient(client);
    const shutdownSignal = new AbortController().signal;
    const { entries, result } = await run(openClient, { keyFor: (mac) => (mac === "AABBCCDDEEFF") ? "test-psk" : undefined, shutdownSignal });

    assert.ok(result.ok, "a connected client with a complete snapshot yields a success outcome");
    assert.equal(result.client, client, "the resolved client is returned");
    assert.equal(result.initialState, client.snapshot(), "the captured initial state is the client's populated cache");
    assert.equal(client.disposeCount, 0, "a successful open does not dispose the client");
    assert.equal(entries.filter((entry) => entry.level === "error").length, 0, "the success path logs nothing at error level");

    // The headline of the client-factory port: the caller's key lookup reaches the factory as the resolver the client keys through. Assert that the factory received
    // exactly what openConnection forwards - the static clientId, the host, a resolver answering the caller's key, and the caller's own shutdown signal by reference -
    // since 100% line coverage alone would not catch openConnection passing the wrong host, dropping the key, or handing the factory a different signal than the one
    // that cancels the call.
    assert.equal(openClient.calls.length, 1, "openConnection invokes the factory exactly once");
    assert.equal(openClient.calls[0]?.clientId, "homebridge-ratgdo", "the static clientId is forwarded to the factory");
    assert.equal(openClient.calls[0].host, "192.0.2.10", "the host is forwarded to the factory");
    assert.equal(resolverOf(openClient.calls[0])({}), "test-psk", "the resolver the factory received answers the caller's key for this device");
    assert.equal(openClient.calls[0].signal, shutdownSignal, "the caller's shutdown signal reaches the factory by reference, so an abort cancels the call itself");
  });

  test("encryption error (mismatched key): returns the encryption-invalid outcome and logs the encryption-configuration diagnostic", async () => {

    const { entries, result } = await run(makeFakeOpenClient(new EncryptionKeyInvalidError("bad key")));

    assert.ok(!result.ok, "an encryption failure skips the discovery attempt");
    assert.equal(result.reason, "encryption-invalid", "a mismatched key carries the encryption-invalid reason token");
    assert.ok(loggedAt(entries, "error", "API encryption key: bad key"), "the user sees the encryption-key diagnostic naming the mismatched key's fault");
  });

  test("encryption error (missing key): returns the encryption-missing outcome and logs the encryption-configuration diagnostic", async () => {

    const { entries, result } = await run(makeFakeOpenClient(new EncryptionKeyMissingError("missing key")));

    assert.ok(!result.ok, "an encryption failure skips the discovery attempt");
    assert.equal(result.reason, "encryption-missing", "an absent key carries the encryption-missing reason token");
    assert.ok(loggedAt(entries, "error", "API encryption key: missing key"), "the user sees the encryption-key diagnostic naming the absent key's fault");
  });

  test("encryption error (key required): returns the encryption-missing outcome and logs the encryption-configuration diagnostic", async () => {

    const { entries, result } = await run(makeFakeOpenClient(new EncryptionRequiredError("key required")));

    assert.ok(!result.ok, "an encryption failure skips the discovery attempt");
    assert.equal(result.reason, "encryption-missing", "a device that requires but lacks a key carries the encryption-missing reason token");
    assert.ok(loggedAt(entries, "error", "API encryption key: key required"), "the user sees the encryption-key diagnostic naming the required key's fault");
  });

  test("logs the device's own words as the parameter of its diagnostic, never as part of the format, so the line carries them as the device wrote them", async () => {

    const words = "The key is 100% wrong, and 50%% of a guess.";
    const { entries } = await run(makeFakeOpenClient(new EncryptionKeyInvalidError(words)));

    assert.deepEqual(entries.filter((entry) => entry.level === "error").map((entry) => [ entry.message, entry.params ]),
      [[ "Encryption configuration error - check the device's API encryption key: %s", [words] ]],
      "the device's words reach the log as the parameter of a complete sentence, so no logger ever reads a percent sign in them as a format token");
    assert.deepEqual(linesAt(entries, "error"), ["Encryption configuration error - check the device's API encryption key: " + words],
      "and the line carries the device's message exactly as the device wrote it, a single and a doubled percent sign included");
  });

  test("permanent error: returns null and logs the permanent-connection diagnostic", async () => {

    const { entries, result } = await run(makeFakeOpenClient(new TestPermanentError("the device refused permanently")));

    assert.ok(!result.ok, "a permanent error skips the discovery attempt");
    assert.equal(result.reason, "permanent", "the failure outcome carries the permanent reason token");
    assert.ok(loggedAt(entries, "error", "Permanent connection error: TestPermanentError: the device refused permanently"),
      "the user sees the permanent-connection diagnostic carrying the inspected error");
  });

  test("unsupported API version: returns the unsupported outcome and logs the firmware-mismatch diagnostic", async () => {

    /* NegotiationFailedError extends PermanentError, so this case also proves the branch order: were the two tested in the other order, the supertype would claim this
     * error first and the reason would read permanent.
     */
    const { entries, result } = await run(makeFakeOpenClient(new NegotiationFailedError("api major 5 is outside the supported range",
      "API_MAJOR_OUT_OF_RANGE")));

    assert.ok(!result.ok, "a version mismatch skips the discovery attempt");
    assert.equal(result.reason, "unsupported", "a device the client cannot negotiate with carries the unsupported reason token");
    assert.ok(loggedAt(entries, "error", "API version is not one this plugin supports: api major 5 is outside the supported range"),
      "the user sees the firmware-mismatch diagnostic carrying the version the client rejected");
  });

  test("generic failure: returns null and logs the catch-all connection diagnostic", async () => {

    // A transient error that is neither an encryption misconfiguration, a PermanentError, nor a state-capture timeout falls through to the generic else branch.
    const { entries, result } = await run(makeFakeOpenClient(new Error("connection refused")));

    assert.ok(!result.ok, "an unclassified failure skips the discovery attempt");
    assert.equal(result.reason, "unknown", "the failure outcome carries the unknown reason token");
    assert.ok(loggedAt(entries, "error", "Failed to establish connection: Error: connection refused"),
      "the user sees the catch-all connection diagnostic carrying the inspected error");
  });

  test("timeout: returns null, logs the timeout diagnostic, and disposes the client", async () => {

    const client = pendingClient();
    const { entries, result } = await run(makeFakeOpenClient(client), { timeoutSeconds: 0.02 });

    assert.ok(!result.ok, "a state-capture timeout skips the discovery attempt");
    assert.equal(result.reason, "timeout", "the failure outcome carries the timeout reason token");
    assert.ok(loggedAt(entries, "error", "Initial-state capture timed out after 0.02 seconds"),
      "the user sees the timeout diagnostic carrying the budget it exhausted");
    assert.equal(client.disposeCount, 1, "the partially-constructed client is torn down");
  });

  test("a TimeoutError the factory rejects with is the library's failure, not a capture timeout", async () => {

    // The capture timeout is recognized by the core's own deadline, so a TimeoutError raised before any capture began - the library's connect timeout - reads as
    // the library's failure, never as a device that opened the connection and then failed to push its state.
    const { entries, result } = await run(makeFakeOpenClient(new DOMException("timed out", "TimeoutError")));

    assert.ok(!result.ok, "a factory rejection skips the discovery attempt");
    assert.equal(result.reason, "unknown", "a TimeoutError the factory rejects with carries the unknown reason token");
    assert.ok(loggedAt(entries, "error", "Failed to establish connection: DOMException [TimeoutError]: timed out"),
      "the user sees the catch-all connection diagnostic carrying the inspected error");
    assert.equal(logCount(entries, "error", "Initial-state capture timed out"), 0, "no capture-timeout diagnostic is logged for a timeout the library raised");
  });

  test("a handshake slower than the capture budget is not charged against it", async () => {

    // The budget starts when the client is open, so a handshake twice the budget still admits a device whose state arrives at once.
    const client = pendingClient();
    const openClient = makeFakeOpenClient(async () => {

      await delay(40);
      setTimeout(() => client.deliverState(makeCoverEvent("door", 0)), 0);

      return client;
    });
    const { result } = await run(openClient, { timeoutSeconds: 0.02 });

    assert.ok(result.ok, "a device whose state arrives as soon as its slow handshake completes is admitted");
  });

  test("shutdown: returns null silently and disposes the client", async () => {

    const client = pendingClient();
    const { entries, result } = await run(makeFakeOpenClient(client), { shutdownSignal: AbortSignal.abort("shutdown"), timeoutSeconds: 1 });

    assert.ok(!result.ok, "an in-flight discovery interrupted by shutdown is abandoned");
    assert.equal(result.reason, "shutdown", "the failure outcome carries the shutdown reason token");
    assert.equal(entries.filter((entry) => entry.level === "error").length, 0, "shutdown is not a failure, so nothing is logged at error level");
    assert.equal(client.disposeCount, 1, "the client opened before the shutdown abort is torn down");
  });

  test("shutdown mid-connect: a factory call cancelled by the shutdown signal stands down silently", async () => {

    const controller = new AbortController();

    /* Model the factory's documented cancellation contract without its retry loop: the call stays pending until the caller's signal aborts, then rejects with that
     * signal's reason. That is the shape esphome-client presents to openConnection when a shutdown lands mid-handshake, so this asserts the classification of an
     * abort-driven factory rejection end to end. It deliberately measures no latency - the real factory's attempt-and-backoff loop is bypassed here.
     */
    const openClient = ((options: RecordedOpenOptions): Promise<never> => {

      const { promise, reject } = Promise.withResolvers<never>();

      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });

      return promise;
    }) as unknown as OpenEspHomeClient;

    const log = capturingLog();
    const pending = openConnection({ expected: [coverId], host: "192.0.2.10", keyFor: () => undefined, log, mac: "AABBCCDDEEFF", openClient,
      shutdownSignal: controller.signal });

    controller.abort("shutdown");

    const result = await pending;

    assert.ok(!result.ok, "a connect cancelled mid-flight by shutdown is abandoned");
    assert.equal(result.reason, "shutdown", "a factory rejection that lands while the shutdown signal is aborted carries the shutdown reason token");
    assert.equal(log.entries.filter((entry) => entry.level === "error").length, 0, "the silent stand-down branch logs nothing at error level");
  });
});

describe("openManualConnection", () => {

  // The address the user listed and this suite dials.
  const DIALED = "192.0.2.10";

  /* A well-formed device-info record for a Ratgdo opener, spelled the way a connected ESPHome client reports one. Individual tests replace a single member of it, so
   * the member under test is the only difference between a refusal and the success asserted below.
   */
  const ratgdoInfo: DeviceInfo = { esphomeVersion: "2024.1.0", friendlyName: "Garage", macAddress: "AA:BB:CC:DD:EE:FF", projectName: "ratgdo.esp32",
    projectVersion: "2.5" };

  const ratgdoEntities = RATGDO_ENTITIES[RatgdoVariant.RATGDO];
  const konnectedEntities = RATGDO_ENTITIES[RatgdoVariant.KONNECTED];

  /* Both variants' stateful entities, advertised together by every client double here. Advertising the union is what makes the wait-list observable at all: the
   * capture waits for exactly the entities the classified variant declares, so a snapshot holding one variant's set completes a correctly-derived wait and stalls a
   * wait derived from the other. A double advertising only one variant's entities would collapse a wrong derivation to an empty wait-list and pass either way.
   */
  const bothVariants: RatgdoEntityRef[] = [ ratgdoEntities.cover, ratgdoEntities.laser, ratgdoEntities.led, ratgdoEntities.light, ratgdoEntities.lock,
    ratgdoEntities.obstruction, ratgdoEntities.vehicleDetected, konnectedEntities.cover, konnectedEntities.light, konnectedEntities.lock,
    konnectedEntities.obstruction, konnectedEntities.strOutput ];

  // The latest-state snapshot a device of one variant would have pushed by the time its handshake resolves: one event per entity that variant's wait-list names.
  const snapshotFor = (variant: RatgdoVariant): Map<EntityId, TelemetryEvent> => {

    const required = new Set<string>(ratgdoInitialStateEntityIds(variant));

    return new Map(bothVariants.filter((ref) => required.has(idFor(ref))).map((ref): [ EntityId, TelemetryEvent ] => [ idFor(ref),
      makeTelemetry(ref.type, ref.objectId) ]));
  };

  // Dial the fixed host this suite uses against an injected client or error, returning the capturing log's entries and the recorded factory alongside the outcome.
  const dial = async (result: Error | TestEspHomeClient, overrides: Partial<OpenManualConnectionOptions> = {}): Promise<RecordedManualAttempt> => {

    const log = capturingLog();
    const openClient = makeFakeOpenClient(result);
    const outcome = await openManualConnection({ host: DIALED, keyFor: () => undefined, log, openClient, shutdownSignal: new AbortController().signal,
      ...overrides });

    return { entries: log.entries, openClient, outcome };
  };

  test("success: resolves the identity the device-info record named alongside the connected client and its captured state", async () => {

    const client = new TestEspHomeClient({ deviceInfo: ratgdoInfo, entities: bothVariants, snapshot: snapshotFor(RatgdoVariant.RATGDO) });
    const { entries, openClient, outcome } = await dial(client, { keyFor: () => "test-psk", timeoutSeconds: 0.05 });

    assert.ok(outcome.ok, "a device that answers, identifies, and pushes its state yields a success outcome");
    assert.equal(outcome.discovered.strippedMac, "AABBCCDDEEFF", "the MAC the record carried is the identity the caller receives");
    assert.equal(outcome.discovered.variant, RatgdoVariant.RATGDO, "the project name the record carried classifies the variant");
    assert.equal(outcome.discovered.address, DIALED, "the identity names the address that was dialed, since that is where this device answers");
    assert.deepEqual(outcome.discovered.addresses, [DIALED], "and that one address stands in for the advertisement a record does not carry");
    assert.equal(outcome.client, client, "the dial's own connection is the device's connection, handed back live rather than closed and reopened");
    assert.equal(outcome.initialState, client.snapshot(), "the captured initial state is the client's populated cache");
    assert.equal(client.disposeCount, 0, "a successful dial does not dispose the client");
    assert.equal(openClient.calls[0]?.host, DIALED, "the listed address is the host the factory was given");
    assert.equal(resolverOf(openClient.calls[0])({}), "test-psk", "the resolver the factory received answers the caller's key");
    assert.equal(entries.filter((entry) => entry.level === "error").length, 0, "the success path logs nothing at error level");
  });

  test("the wait-list follows the classified variant rather than a fixed one", async () => {

    /* The one observation of which variant decided the wait-list. Both doubles advertise both variants' entities and hold only the Konnected set in their snapshot;
     * they differ only in the project name their record reports. The Konnected one completes its capture because its wait-list is satisfied, and the Ratgdo one
     * exhausts the budget waiting for entities this device advertised and never pushed.
     */
    const konnected = new TestEspHomeClient({ deviceInfo: { ...ratgdoInfo, projectName: "konnected.garage-door-gdov2-s" }, entities: bothVariants,
      snapshot: snapshotFor(RatgdoVariant.KONNECTED) });
    const satisfied = await dial(konnected, { timeoutSeconds: 0.05 });

    assert.ok(satisfied.outcome.ok, "a Konnected device whose Konnected entities have all pushed completes its capture");
    assert.equal(satisfied.outcome.discovered.variant, RatgdoVariant.KONNECTED, "and is identified as the variant its project name names");

    const mismatched = new TestEspHomeClient({ deviceInfo: ratgdoInfo, entities: bothVariants, snapshot: snapshotFor(RatgdoVariant.KONNECTED) });
    const stalled = await dial(mismatched, { timeoutSeconds: 0.02 });

    assert.ok(!stalled.outcome.ok, "a Ratgdo record's wait-list names entities this device advertised but never pushed");
    assert.equal(stalled.outcome.reason, "timeout", "so the capture exhausts its budget rather than resolving on the wrong variant's set");
    assert.equal(mismatched.disposeCount, 1, "and the client opened for a capture that timed out is torn down");
  });

  test("an unrecognized device is refused by address, and its connection is closed", async () => {

    const client = new TestEspHomeClient({ deviceInfo: { ...ratgdoInfo, projectName: "esphome.generic-sensor" }, entities: bothVariants,
      snapshot: snapshotFor(RatgdoVariant.RATGDO) });
    const { entries, outcome } = await dial(client);

    assert.ok(!outcome.ok, "a device that is not an opener we support yields a failure outcome");
    assert.equal(outcome.reason, "unrecognized", "the refusal carries the reason only an address dial can produce");
    assert.ok(loggedAt(entries, "error", "The device at 192.0.2.10 is not a Ratgdo or Konnected opener this plugin supports."),
      "the diagnostic names the address, because the address is the only thing the user gave us to correct");
    assert.equal(client.disposeCount, 1, "the connection is closed rather than left holding one of the device's few API slots");
  });

  test("a client reporting no device-info record at all is refused the same way", async () => {

    const client = new TestEspHomeClient({ deviceInfo: null, entities: bothVariants, snapshot: snapshotFor(RatgdoVariant.RATGDO) });
    const { entries, outcome } = await dial(client);

    assert.ok(!outcome.ok, "a client with nothing to identify the device by has identified no opener");
    assert.equal(outcome.reason, "unrecognized", "the refusal is the same one a device of the wrong kind earns");
    assert.ok(loggedAt(entries, "error", "The device at 192.0.2.10 is not"), "and the user is told which address answered without identifying itself");
    assert.equal(client.disposeCount, 1, "the connection is closed");
  });

  test("shutdown: stands down silently and closes the connection", async () => {

    const client = new TestEspHomeClient({ deviceInfo: ratgdoInfo, entities: bothVariants, snapshot: new Map() });
    const { entries, outcome } = await dial(client, { shutdownSignal: AbortSignal.abort("shutdown"), timeoutSeconds: 1 });

    assert.ok(!outcome.ok, "an in-flight dial interrupted by shutdown is abandoned");
    assert.equal(outcome.reason, "shutdown", "the failure outcome carries the shutdown reason token");
    assert.equal(entries.filter((entry) => entry.level === "error").length, 0, "shutdown is not a failure, so nothing is logged at error level");
    assert.equal(client.disposeCount, 1, "the client opened before the shutdown abort is torn down");
  });

  describe("the failure taxonomy is the one openConnection classifies with", () => {

    /* Both entry points run one connect core, and this is what holds them to it: the same thrown error is driven through each, and the reason and every log line
     * are compared against EACH OTHER rather than against a written-down expectation. An expectation written here would still pass if both paths drifted together;
     * an equality between the two cannot. The discovered path is given an empty wait-list because the error is thrown before any capture would run.
     */
    const failures: { error: Error; why: string }[] = [

      { error: new EncryptionKeyInvalidError("bad key"), why: "a mismatched encryption key" },
      { error: new EncryptionKeyMissingError("missing key"), why: "an absent encryption key" },
      { error: new EncryptionRequiredError("key required"), why: "a device that requires a key it was not given" },
      { error: new NegotiationFailedError("api major 5 is outside the supported range", "API_MAJOR_OUT_OF_RANGE"), why: "an unsupported API version" },
      { error: new TestPermanentError("the device refused permanently"), why: "a permanent connection error" },
      { error: new Error("connection refused"), why: "an unclassified connection error" }
    ];

    for(const { error, why } of failures) {

      test(why + " classifies identically on both entry points", async () => {

        const manualLog = capturingLog();
        const discoveredLog = capturingLog();
        const manual = await openManualConnection({ host: DIALED, keyFor: () => undefined, log: manualLog, openClient: makeFakeOpenClient(error),
          shutdownSignal: new AbortController().signal });
        const discovered = await openConnection({ expected: [], host: DIALED, keyFor: () => undefined, log: discoveredLog, mac: "AABBCCDDEEFF",
          openClient: makeFakeOpenClient(error), shutdownSignal: new AbortController().signal });

        assert.ok(!manual.ok, "the address dial refuses the connect");
        assert.ok(!discovered.ok, "and so does the discovered connect");
        assert.equal(manual.reason, discovered.reason, "the classified reason is the same through either entry point");
        assert.deepEqual(manualLog.entries, discoveredLog.entries, "and so is every diagnostic the user sees, because one body emits them");
      });
    }
  });
});

describe("the key rule and the identity checks", () => {

  // The device each connection below is for, in the plugin's identity form, and the same MAC as a device-info record and a server hello spell it.
  const MAC = "AABBCCDDEEFF";
  const MAC_COLON = "AA:BB:CC:DD:EE:FF";

  // Another device, which answers where the one above was expected.
  const OTHER = "112233445566";
  const OTHER_COLON = "11:22:33:44:55:66";

  // The refusal the connect core logs, as a format string whose one argument is the error's message.
  const REFUSAL = "The wrong device answered, so the connection is refused: ";

  // The firmware warning a first contact keyed for no MAC adds to an encryption failure.
  const FIRMWARE_WARNING = "This device can use only the global encryption key, because its firmware does not announce its MAC address. Update it to ESPHome " +
    "2025.4.0 or newer to give it a key of its own.";

  /* A key store that inherits the way the feature-option engine does: a MAC's own key when it has one, otherwise the global key. It records every MAC it is asked for
   * - undefined for the global key - so a row can prove which identity a key was chosen for, and its store is mutable so a row can add a key after a connection opened.
   */
  const keyStore = (keys: Record<string, string>, global?: string): { asked: (string | undefined)[]; keyFor: EncryptionKeyLookup; keys: Record<string, string> } => {

    const asked: (string | undefined)[] = [];

    return { asked, keyFor: (mac?: string): string | undefined => {

      asked.push(mac);

      return ((mac === undefined) ? undefined : keys[mac]) ?? global;
    }, keys };
  };

  // A connected opener whose device-info record names the given MAC, or none, with its whole initial state already pushed so the capture resolves at once.
  const opener = (macAddress?: string): TestEspHomeClient => new TestEspHomeClient({ deviceInfo: { esphomeVersion: "2025.4.0", macAddress, projectName: "ratgdo.esp32" },
    entities: [], snapshot: new Map() });

  // Open a discovered device's connection for MAC, through the given factory and key store.
  const discover = async (openClient: ReturnType<typeof makeFakeOpenClient>, keyFor: EncryptionKeyLookup): Promise<ConnectionAttempt> => {

    const log = capturingLog();
    const result = await openConnection({ expected: [], host: "192.0.2.10", keyFor, log, mac: MAC, openClient, shutdownSignal: new AbortController().signal });

    return { entries: log.entries, result };
  };

  // Open a listed address's connection, through the given factory and key store.
  const dialAddress = async (openClient: ReturnType<typeof makeFakeOpenClient>, keyFor: EncryptionKeyLookup): Promise<ManualConnectionAttempt> => {

    const log = capturingLog();
    const result = await openManualConnection({ host: "192.0.2.10", keyFor, log, openClient, shutdownSignal: new AbortController().signal, timeoutSeconds: 0.05 });

    return { entries: log.entries, result };
  };

  test("a discovered connection keyed at its MAC answers its key to a hello announcing that MAC in the wire's colon form", async () => {

    const { keyFor } = keyStore({ [MAC]: "device-key" }, "global-key");
    const openClient = makeFakeOpenClient(opener(MAC_COLON));
    const { result } = await discover(openClient, keyFor);

    assert.ok(result.ok, "the device connects");
    assert.equal(resolverOf(openClient.calls[0])({ macAddress: MAC_COLON }), "device-key",
      "the hello's colon spelling and the connection's identity form name one device, so the resolver answers that device's own key");
  });

  test("a discovered connection refuses a hello announcing another MAC before any key is chosen for it", async () => {

    const client = opener(OTHER_COLON);
    const store = keyStore({ [MAC]: "device-key" }, "global-key");
    const { entries, result } = await discover(makeFakeOpenClient(openThroughHello({ client, hello: { macAddress: OTHER_COLON } })), store.keyFor);

    assert.ok(!result.ok, "the connection is refused, so no client is handed back");
    assert.equal(result.reason, "identity-mismatch", "the refusal is its own reason");
    assert.ok(!store.asked.includes(OTHER), "the lookup is never read for the MAC the hello announced, so no key is chosen for the device that answered");
    assert.equal(logCount(entries, "error", REFUSAL + OTHER + " answered, but this connection is for " + MAC + "."), 1,
      "the refusal is logged once, naming the device that answered and the device the connection is for");
  });

  test("a discovered connection whose MAC holds no key opens plaintext-first, with no resolver", async () => {

    const openClient = makeFakeOpenClient(opener(MAC_COLON));
    const { result } = await discover(openClient, keyStore({}).keyFor);

    assert.ok(result.ok, "a keyless device connects");
    assert.equal(openClient.calls[0]?.psk, null, "the client is handed no resolver, so it tries plaintext first as it always has for a keyless device");
  });

  test("a plaintext connection dialed for a MAC refuses a device whose device-info record names another, or none", async () => {

    /* A keyless device's MAC is its own unauthenticated word, so this is no defense against a device that lies about who it is. It is the defense against another
     * device answering at an address the opener has left, which a plaintext connection has no key to refuse.
     */
    const other = opener(OTHER_COLON);
    const answeredOther = await discover(makeFakeOpenClient(other), keyStore({}).keyFor);

    assert.ok(!answeredOther.result.ok && (answeredOther.result.reason === "identity-mismatch"), "a plaintext device naming another MAC is refused");
    assert.equal(logCount(answeredOther.entries, "error", REFUSAL + OTHER + " answered, but this connection is for " + MAC + "."), 1,
      "the refusal is logged once, naming the MAC that answered and the MAC expected");
    assert.equal(other.disposeCount, 1, "and the client it opened is disposed, once");

    const silent = await discover(makeFakeOpenClient(opener()), keyStore({}).keyFor);

    assert.ok(!silent.result.ok && (silent.result.reason === "identity-mismatch"), "a plaintext device naming no MAC cannot be shown to be the opener, so it is refused");
  });

  test("an address connection keyed for the MAC its hello announced refuses a device whose device-info record names another", async () => {

    const client = opener(OTHER_COLON);
    const { entries, result } = await dialAddress(makeFakeOpenClient(openThroughHello({ client, hello: { macAddress: MAC_COLON } })),
      keyStore({ [MAC]: "device-key" }).keyFor);

    assert.ok(!result.ok, "the connection is refused");
    assert.equal(result.reason, "identity-mismatch", "a key chosen for the hello's MAC is what the address connection is for, so a record naming another is refused");
    assert.equal(logCount(entries, "error", REFUSAL + OTHER + " answered, but this connection is for " + MAC + "."), 1,
      "the refusal names the MAC the device reported and the MAC the key was chosen for");
    assert.equal(client.disposeCount, 1, "and the client it opened is disposed, once");
  });

  test("an address connection keys for the MAC its hello announces, else the global key, and warns about firmware that announces none", async () => {

    /* The device's side of the handshake, played by hand: the resolver is handed the hello, what it answers is recorded, and the device then refuses that key. The
     * refusal is what triggers the firmware warning, and it keeps admission out of this row, which is about key choice alone.
     */
    const answered: Nullable<string>[] = [];
    const refusing = (hello: NoiseServerHello): ReturnType<typeof makeFakeOpenClient> => makeFakeOpenClient(async (options) => {

      answered.push(resolverOf(options)(hello));

      throw new EncryptionKeyInvalidError("bad key");
    });

    const announcing = await dialAddress(refusing({ macAddress: MAC_COLON }), keyStore({ [MAC]: "device-key" }, "global-key").keyFor);

    assert.equal(answered[0], "device-key", "a hello announcing a MAC is offered the key stored for that MAC");
    assert.ok(!announcing.result.ok && (announcing.result.reason === "encryption-invalid"), "the refused key classifies as a key fault");
    assert.equal(logCount(announcing.entries, "warn", FIRMWARE_WARNING), 0, "a device that announced its MAC is not told its firmware cannot");

    const silent = await dialAddress(refusing({}), keyStore({ [MAC]: "device-key" }, "global-key").keyFor);

    assert.equal(answered[1], "global-key", "a hello naming no MAC is offered the global key");
    assert.deepEqual(silent.entries.map((entry) => entry.level), [ "error", "warn" ], "the key fault is logged first, and the firmware warning follows it");
    assert.equal(logCount(silent.entries, "warn", FIRMWARE_WARNING), 1, "the warning names the limit and the fix");
  });

  test("a connection keyed for a MAC refuses a device whose device-info record names another", async () => {

    const client = opener(OTHER_COLON);
    const { entries, result } = await discover(makeFakeOpenClient(openThroughHello({ client, hello: {} })), keyStore({ [MAC]: "device-key" }).keyFor);

    assert.ok(!result.ok, "the connection is refused");
    assert.equal(result.reason, "identity-mismatch", "an authenticated device that is not the one the key was chosen for is the same refusal as a foreign hello");
    assert.equal(logCount(entries, "error", REFUSAL + OTHER + " answered, but this connection is for " + MAC + "."), 1,
      "the refusal is logged once, naming both MACs");
    assert.equal(client.disposeCount, 1, "and the client it opened is disposed, once");
  });

  test("a connection keyed for a MAC admits a device whose device-info record names that MAC in the wire's colon form", async () => {

    const client = opener(MAC_COLON);
    const { result } = await discover(makeFakeOpenClient(openThroughHello({ client, hello: {} })), keyStore({ [MAC]: "device-key" }).keyFor);

    assert.ok(result.ok, "the device-info record's colon spelling and the keyed-for identity form name one device, so the device is admitted");
    assert.equal(client.disposeCount, 0, "and its client is handed back live");
  });

  test("an admitted address connection refuses a later hello announcing another MAC, naming both", async () => {

    const client = opener(MAC_COLON);
    const openClient = makeFakeOpenClient(openThroughHello({ client, hello: {} }));
    const { result } = await dialAddress(openClient, keyStore({}, "global-key").keyFor);

    assert.ok(result.ok, "the device is admitted at its first contact");
    assert.throws(() => resolverOf(openClient.calls[0])({ macAddress: OTHER_COLON }),
      { constructor: DeviceIdentityError, message: OTHER + " answered, but this connection is for " + MAC + "." });
  });

  test("an admitted old-firmware address connection keeps offering the global key after a key is stored for its MAC", async () => {

    const client = opener(MAC_COLON);
    const store = keyStore({}, "global-key");
    const openClient = makeFakeOpenClient(openThroughHello({ client, hello: {} }));
    const { result } = await dialAddress(openClient, store.keyFor);

    assert.ok(result.ok, "the device is admitted on the global key");

    store.keys[MAC] = "device-key";

    assert.equal(resolverOf(openClient.calls[0])({}), "global-key",
      "a reconnect makes the same key choice its first contact made, so the MAC the connection was admitted as never chooses its key");
  });

  test("a connection keyed for a MAC refuses a device whose device-info record names no MAC at all", async () => {

    const client = opener();
    const { entries, result } = await discover(makeFakeOpenClient(openThroughHello({ client, hello: {} })), keyStore({ [MAC]: "device-key" }).keyFor);

    assert.ok(!result.ok, "the connection is refused");
    assert.equal(result.reason, "identity-mismatch", "a device that reports no MAC cannot be the one the key was chosen for");
    assert.ok(loggedAt(entries, "error", REFUSAL + "a device reporting no MAC address answered, but this connection is for " + MAC + "."),
      "the refusal says the device named no MAC");
  });

  test("a stored key that is empty reads as no key at all", async () => {

    const client = opener(MAC_COLON);
    const { result } = await dialAddress(makeFakeOpenClient(openThroughHello({ client, hello: { macAddress: MAC_COLON } })), keyStore({ [MAC]: "" }).keyFor);

    assert.ok(!result.ok, "a device that requires a key is refused");
    assert.equal(result.reason, "encryption-missing", "an empty entry is answered to the client as no key, which it reports as a missing key");
  });
});

describe("applyDeviceInfo", () => {

  test("refreshes both identity fields from a record carrying both", () => {

    const device = makeTestDevice({ firmwareVersion: "1.0.0", model: "1.0.0" });

    applyDeviceInfo(device, asEspHomeClient(new TestEspHomeClient({ deviceInfo: { esphomeVersion: "2025.1.0", projectVersion: "2.5" } })));

    assert.equal(device.model, "2.5", "the project version becomes the device model");
    assert.equal(device.firmwareVersion, "2025.1.0", "the ESPHome version becomes the device firmware version");
  });

  test("leaves a field alone when the record omits its member", () => {

    const modelOnly = makeTestDevice({ firmwareVersion: "1.0.0", model: "1.0.0" });

    applyDeviceInfo(modelOnly, asEspHomeClient(new TestEspHomeClient({ deviceInfo: { projectVersion: "2.5" } })));

    assert.equal(modelOnly.model, "2.5", "the advertised member is applied");
    assert.equal(modelOnly.firmwareVersion, "1.0.0", "the omitted member leaves discovery's seed standing rather than blanking it");

    const firmwareOnly = makeTestDevice({ firmwareVersion: "1.0.0", model: "1.0.0" });

    applyDeviceInfo(firmwareOnly, asEspHomeClient(new TestEspHomeClient({ deviceInfo: { esphomeVersion: "2025.1.0" } })));

    assert.equal(firmwareOnly.firmwareVersion, "2025.1.0", "the advertised member is applied");
    assert.equal(firmwareOnly.model, "1.0.0", "the omitted member leaves discovery's seed standing rather than blanking it");
  });

  test("refreshes the device's own name from the record's friendly name, else its node name, and keeps the seeded name when it carries neither", () => {

    const device = makeTestDevice({ name: "Garage" });

    applyDeviceInfo(device, asEspHomeClient(new TestEspHomeClient({ deviceInfo: { friendlyName: "Workshop Door", name: "workshop-door" } })));

    assert.equal(device.name, "Workshop Door", "the friendly name the record carries becomes the device's own name");

    applyDeviceInfo(device, asEspHomeClient(new TestEspHomeClient({ deviceInfo: { friendlyName: "", name: "workshop-door" } })));

    assert.equal(device.name, "workshop-door", "an empty friendly name reads as none, and the node name stands in for it");

    applyDeviceInfo(device, asEspHomeClient(new TestEspHomeClient({ deviceInfo: { esphomeVersion: "2025.1.0" } })));

    assert.equal(device.name, "workshop-door", "a record carrying neither name leaves the name the device already holds");
  });

  test("writes nothing when the client has no device info at all", () => {

    const device = makeTestDevice({ firmwareVersion: "1.0.0", model: "1.0.0" });

    applyDeviceInfo(device, asEspHomeClient(new TestEspHomeClient()));

    assert.equal(device.model, "1.0.0", "a client with no device-info record leaves the model as discovery seeded it");
    assert.equal(device.firmwareVersion, "1.0.0", "a client with no device-info record leaves the firmware version as discovery seeded it");
  });
});

describe("isEncryptionError", () => {

  test("recognizes every encryption-configuration PermanentError subclass", () => {

    assert.equal(isEncryptionError(new EncryptionKeyMissingError("missing")), true, "a missing key is an encryption-configuration error");
    assert.equal(isEncryptionError(new EncryptionKeyInvalidError("invalid")), true, "an invalid key is an encryption-configuration error");
    assert.equal(isEncryptionError(new EncryptionRequiredError("required")), true, "a required-but-absent key is an encryption-configuration error");
  });

  test("rejects a generic error and a non-encryption PermanentError", () => {

    assert.equal(isEncryptionError(new Error("boom")), false, "a generic Error is not an encryption-configuration error");
    assert.equal(isEncryptionError(new TestPermanentError("the device refused permanently")), false,
      "a non-encryption PermanentError subclass is not an encryption-configuration error");
  });
});

describe("identityRefusal", () => {

  // A session whose device-info record names the given MAC, or carries no record at all.
  const session = (macAddress?: string): ReturnType<typeof asEspHomeClient> => {

    return asEspHomeClient(new TestEspHomeClient({ deviceInfo: (macAddress === undefined) ? null : { macAddress } }));
  };

  test("accepts a session whose device names the expected MAC in any spelling the MAC form folds", () => {

    for(const macAddress of [ "AA:BB:CC:DD:EE:FF", "aa:bb:cc:dd:ee:ff", "AABBCCDDEEFF" ]) {

      assert.equal(identityRefusal({ client: session(macAddress), expected: "AABBCCDDEEFF" }), null, macAddress + " names the expected device");
    }
  });

  test("refuses a session whose device names another MAC, names none, or reports no record", () => {

    const other = identityRefusal({ client: session("11:22:33:44:55:66"), expected: "AABBCCDDEEFF" });

    assert.ok(other instanceof DeviceIdentityError, "another MAC is the identity refusal");
    assert.equal(other.message, "112233445566 answered, but this connection is for AABBCCDDEEFF.",
      "and the refusal names the reported and the expected MAC in the identity form");

    for(const client of [ session(""), session() ]) {

      assert.ok(identityRefusal({ client, expected: "AABBCCDDEEFF" }) instanceof DeviceIdentityError,
        "a device that names no MAC cannot be shown to be the one expected, so it is refused");
    }
  });
});

describe("describePermanentCause", () => {

  test("words and classifies each refusal a user can act on with the sentence a first open and a give-up share, the device's own words its parameter", () => {

    const vectors: { cause: Error; diagnostic: [ string, string ]; reason: string }[] = [

      { cause: new DeviceIdentityError({ expected: "AABBCCDDEEFF", reported: "112233445566" }),
        diagnostic: [ "The wrong device answered, so the connection is refused: %s", "112233445566 answered, but this connection is for AABBCCDDEEFF." ],
        reason: "identity-mismatch" },
      { cause: new EncryptionKeyInvalidError("bad key"), diagnostic: [ "Encryption configuration error - check the device's API encryption key: %s", "bad key" ],
        reason: "encryption-invalid" },
      { cause: new EncryptionKeyMissingError("missing key"), diagnostic: [ "Encryption configuration error - check the device's API encryption key: %s", "missing key" ],
        reason: "encryption-missing" },
      { cause: new EncryptionRequiredError("key required"), diagnostic: [ "Encryption configuration error - check the device's API encryption key: %s", "key required" ],
        reason: "encryption-missing" },
      { cause: new NegotiationFailedError("api major 5 is outside the supported range", "API_MAJOR_OUT_OF_RANGE"),
        diagnostic: [ "The device's ESPHome API version is not one this plugin supports: %s", "api major 5 is outside the supported range" ], reason: "unsupported" }
    ];

    for(const { cause, diagnostic, reason } of vectors) {

      assert.deepEqual(describePermanentCause(cause), { diagnostic, reason }, cause.name + " is worded and classified once");
    }
  });

  test("answers null for a cause no user can act on", () => {

    for(const cause of [ new TestPermanentError("the device refused permanently"), new Error("connection refused"), undefined ]) {

      assert.equal(describePermanentCause(cause), null, "each caller words a cause like this itself");
    }
  });
});
