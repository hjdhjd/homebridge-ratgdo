/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * connection.test.ts: Unit tests for the connection layer - captureInitialState's fast / slow / timeout / shutdown paths, openConnection's error taxonomy,
 * and the isEncryptionError predicate. The ESPHome client factory is injected as a fake (makeFakeOpenClient), and the state-capture budget (timeoutSeconds) is
 * injected in fractional seconds (e.g. 0.02) so each wait resolves in milliseconds of real time, driving every branch deterministically without a live device, fake
 * timers, or a fake Homebridge harness.
 */
import { AuthenticationError, EncryptionKeyInvalidError, EncryptionKeyMissingError, EncryptionRequiredError, entityId } from "esphome-client";
import { TestEspHomeClient, asEspHomeClient, loggedAt, makeCapturingLog, makeCoverEvent, makeFakeOpenClient, makeLightEvent } from "./testing.helpers.ts";
import { captureInitialState, isEncryptionError, openConnection } from "./connection.ts";
import { describe, test } from "node:test";
import type { EntityId } from "esphome-client";
import assert from "node:assert/strict";

describe("captureInitialState", () => {

  // Widen the branded ids to the general EntityId so a snapshot Map mixing cover and light keys infers a single Map<EntityId, TelemetryEvent> key type.
  const coverId: EntityId = entityId("cover", "door");
  const lightId: EntityId = entityId("light", "light");

  // The device advertises both cover and light; the test varies which of them the snapshot already holds.
  const bothExposed = [ { objectId: "door", type: "cover" }, { objectId: "light", type: "light" } ];

  // A fresh, never-aborted shutdown signal for the cases that resolve normally.
  const liveSignal = (): AbortSignal => new AbortController().signal;

  // A client that advertises cover + light but whose snapshot holds only the cover. The cover + light wait-list therefore reaches the slow path: the light must arrive
  // by telemetry, or the wait must time out / abort.
  const coverPresentLightPending = (): TestEspHomeClient => new TestEspHomeClient({ entities: bothExposed, snapshot: new Map([[ coverId, makeCoverEvent("door", 0) ]]) });

  test("returns the snapshot immediately when the caller declares no required entities", async () => {

    const client = new TestEspHomeClient({ snapshot: new Map([[ coverId, makeCoverEvent("door", 0) ]]) });
    const cache = await captureInitialState({ client: asEspHomeClient(client), expected: [], shutdownSignal: liveSignal() });

    assert.equal(cache, client.snapshot(), "an empty wait-list resolves with the current cache without subscribing to telemetry");
  });

  test("returns the snapshot immediately when the device exposes none of the required entities", async () => {

    // The caller wants cover + light, but the device advertises neither (entities is empty), so the intersection is empty and there is nothing to wait for.
    const client = new TestEspHomeClient({ entities: [], snapshot: new Map() });
    const cache = await captureInitialState({ client: asEspHomeClient(client), expected: [ coverId, lightId ], shutdownSignal: liveSignal() });

    assert.equal(cache, client.snapshot(), "requiring only entities the firmware does not advertise collapses the wait-list to empty");
  });

  test("fast path: resolves immediately when the snapshot already holds every required entity", async () => {

    const snapshot = new Map([ [ coverId, makeCoverEvent("door", 0) ], [ lightId, makeLightEvent("light", false) ] ]);
    const client = new TestEspHomeClient({ entities: bothExposed, snapshot });
    const cache = await captureInitialState({ client: asEspHomeClient(client), expected: [ coverId, lightId ], shutdownSignal: liveSignal() });

    assert.equal(cache, client.snapshot(), "the fast path returns the live cache reference when a complete snapshot satisfies the wait with no telemetry delivery");
  });

  test("slow path: resolves once delivered telemetry completes the required set", async () => {

    // captureInitialState subscribes synchronously before its first await, so delivering the missing light after the call resolves the pending wait.
    const client = coverPresentLightPending();
    const pending = captureInitialState({ client: asEspHomeClient(client), expected: [ coverId, lightId ], shutdownSignal: liveSignal(), timeoutSeconds: 1 });

    client.deliverState(makeLightEvent("light", false));

    const cache = await pending;

    assert.ok(cache.has(lightId), "the wait resolves the moment the last required entity lands in the cache");
  });

  test("timeout: rejects with a TimeoutError when the required set never completes", async () => {

    const client = coverPresentLightPending();

    await assert.rejects(
      captureInitialState({ client: asEspHomeClient(client), expected: [ coverId, lightId ], shutdownSignal: liveSignal(), timeoutSeconds: 0.02 }),
      (error) => (error instanceof DOMException) && (error.name === "TimeoutError"),
      "an unsatisfied wait rejects with the AbortSignal.timeout TimeoutError DOMException");
  });

  test("shutdown: rejects with the shutdown reason at the synchronous gate when the signal is already aborted", async () => {

    const client = coverPresentLightPending();

    await assert.rejects(
      captureInitialState({ client: asEspHomeClient(client), expected: [ coverId, lightId ], shutdownSignal: AbortSignal.abort("shutdown"), timeoutSeconds: 1 }),
      (reason) => reason === "shutdown",
      "a pre-aborted shutdown signal surfaces its reason through the throwIfAborted gate");
  });

  test("shutdown: rejects with the shutdown reason when the signal aborts mid-wait", async () => {

    const controller = new AbortController();
    const client = coverPresentLightPending();
    const pending = captureInitialState({ client: asEspHomeClient(client), expected: [ coverId, lightId ], shutdownSignal: controller.signal, timeoutSeconds: 1 });

    controller.abort("shutdown");

    await assert.rejects(pending, (reason) => reason === "shutdown", "an abort delivered while waiting surfaces the reason through the abort listener");
  });
});

describe("openConnection", () => {

  const coverId = entityId("cover", "door");
  const coverEntity = [{ objectId: "door", type: "cover" }];

  // A client whose snapshot already holds the required cover, so captureInitialState's fast path resolves.
  const connectedClient = (): TestEspHomeClient => new TestEspHomeClient({ entities: coverEntity, snapshot: new Map([[ coverId, makeCoverEvent("door", 0) ]]) });

  // A client that advertises the cover but whose snapshot never holds it, so the wait reaches the slow path (and times out or aborts).
  const pendingClient = (): TestEspHomeClient => new TestEspHomeClient({ entities: coverEntity, snapshot: new Map() });

  // Drive openConnection with the fixed host and wait-list this suite uses, varying only the injected factory and the optional shutdown signal / timeout per case.
  // Returns the capturing log alongside the result so each test asserts on both.
  const run = async (openClient: ReturnType<typeof makeFakeOpenClient>, overrides: Partial<Parameters<typeof openConnection>[0]> = {}) => {

    const { entries, log } = makeCapturingLog();
    const result = await openConnection({ expected: [coverId], host: "192.0.2.10", log, openClient, shutdownSignal: new AbortController().signal, ...overrides });

    return { entries, result };
  };

  test("success: resolves with the client and its captured initial state, leaving the client live", async () => {

    const client = connectedClient();
    const openClient = makeFakeOpenClient(client);
    const { entries, result } = await run(openClient, { psk: "test-psk" });

    assert.ok(result.ok, "a connected client with a complete snapshot yields a success outcome");
    assert.equal(result.client, client, "the resolved client is returned");
    assert.equal(result.initialState, client.snapshot(), "the captured initial state is the client's populated cache");
    assert.equal(client.disposed, false, "a successful open does not dispose the client");
    assert.equal(entries.filter((entry) => entry.level === "error").length, 0, "the success path logs nothing at error level");

    // The headline of the client-factory port: the platform resolves the encryption key and threads a concrete psk through openConnection into the factory. Pin that the
    // factory received exactly what openConnection forwards - the static clientId, the host, and the resolved psk unchanged - since 100% line coverage alone would not
    // catch openConnection passing the wrong host or dropping the psk.
    assert.equal(openClient.calls.length, 1, "openConnection invokes the factory exactly once");
    assert.equal(openClient.calls[0]?.clientId, "homebridge-ratgdo", "the static clientId is forwarded to the factory");
    assert.equal(openClient.calls[0]?.host, "192.0.2.10", "the host is forwarded to the factory");
    assert.equal(openClient.calls[0]?.psk, "test-psk", "the resolved psk threads through openConnection to the factory unchanged");
  });

  test("encryption error (mismatched key): returns the encryption-invalid outcome and logs the encryption-configuration diagnostic", async () => {

    const { entries, result } = await run(makeFakeOpenClient(new EncryptionKeyInvalidError("bad key")));

    assert.ok(!result.ok, "an encryption failure skips the discovery attempt");
    assert.equal(result.reason, "encryption-invalid", "a mismatched key carries the encryption-invalid reason token");
    assert.ok(loggedAt(entries, "error", "Encryption configuration error"), "the user sees the encryption-key diagnostic");
  });

  test("encryption error (missing key): returns the encryption-missing outcome and logs the encryption-configuration diagnostic", async () => {

    const { entries, result } = await run(makeFakeOpenClient(new EncryptionKeyMissingError("missing key")));

    assert.ok(!result.ok, "an encryption failure skips the discovery attempt");
    assert.equal(result.reason, "encryption-missing", "an absent key carries the encryption-missing reason token");
    assert.ok(loggedAt(entries, "error", "Encryption configuration error"), "the user sees the encryption-key diagnostic");
  });

  test("encryption error (key required): returns the encryption-missing outcome and logs the encryption-configuration diagnostic", async () => {

    const { entries, result } = await run(makeFakeOpenClient(new EncryptionRequiredError("key required")));

    assert.ok(!result.ok, "an encryption failure skips the discovery attempt");
    assert.equal(result.reason, "encryption-missing", "a device that requires but lacks a key carries the encryption-missing reason token");
    assert.ok(loggedAt(entries, "error", "Encryption configuration error"), "the user sees the encryption-key diagnostic");
  });

  test("permanent error: returns null and logs the permanent-connection diagnostic", async () => {

    const { entries, result } = await run(makeFakeOpenClient(new AuthenticationError("auth failed")));

    assert.ok(!result.ok, "a permanent error skips the discovery attempt");
    assert.equal(result.reason, "permanent", "the failure outcome carries the permanent reason token");
    assert.ok(loggedAt(entries, "error", "Permanent connection error"), "the user sees the permanent-connection diagnostic");
  });

  test("generic failure: returns null and logs the catch-all connection diagnostic", async () => {

    // A transient error that is neither an encryption misconfiguration, a PermanentError, nor a state-capture timeout falls through to the generic else branch.
    const { entries, result } = await run(makeFakeOpenClient(new Error("connection refused")));

    assert.ok(!result.ok, "an unclassified failure skips the discovery attempt");
    assert.equal(result.reason, "unknown", "the failure outcome carries the unknown reason token");
    assert.ok(loggedAt(entries, "error", "Failed to establish connection"), "the user sees the catch-all connection diagnostic");
  });

  test("timeout: returns null, logs the timeout diagnostic, and disposes the client", async () => {

    const client = pendingClient();
    const { entries, result } = await run(makeFakeOpenClient(client), { timeoutSeconds: 0.02 });

    assert.ok(!result.ok, "a state-capture timeout skips the discovery attempt");
    assert.equal(result.reason, "timeout", "the failure outcome carries the timeout reason token");
    assert.ok(loggedAt(entries, "error", "Initial-state capture timed out"), "the user sees the timeout diagnostic");
    assert.equal(client.disposed, true, "the partially-constructed client is torn down");
  });

  test("shutdown: returns null silently and disposes the client", async () => {

    const client = pendingClient();
    const { entries, result } = await run(makeFakeOpenClient(client), { shutdownSignal: AbortSignal.abort("shutdown"), timeoutSeconds: 1 });

    assert.ok(!result.ok, "an in-flight discovery interrupted by shutdown is abandoned");
    assert.equal(result.reason, "shutdown", "the failure outcome carries the shutdown reason token");
    assert.equal(entries.filter((entry) => entry.level === "error").length, 0, "shutdown is not a failure, so nothing is logged at error level");
    assert.equal(client.disposed, true, "the client opened before the shutdown abort is torn down");
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
    assert.equal(isEncryptionError(new AuthenticationError("auth failed")), false, "a non-encryption PermanentError subclass is not an encryption-configuration error");
  });
});
