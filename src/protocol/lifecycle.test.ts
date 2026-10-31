/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * lifecycle.test.ts: Unit tests for translateLifecycle - the pure ESPHome-lifecycle-to-availability translation the platform and the webUI status feed each apply.
 */
import { ConnectionError, EncryptionKeyInvalidError, HeartbeatStalledError } from "esphome-client";
import { describe, test } from "node:test";
import { DeviceIdentityError } from "../connection.ts";
import { TestPermanentError } from "../testing.helpers.ts";
import assert from "node:assert/strict";
import { translateLifecycle } from "./lifecycle.ts";

describe("translateLifecycle", () => {

  test("states offline on lost, whatever the failed attempt's cause", () => {

    assert.equal(translateLifecycle({ cause: new ConnectionError("The reconnect attempt failed.", "CONNECT_FAILED"), kind: "lost" }), "offline",
      "a lost verdict carrying a transient cause states the opener offline");
    assert.equal(translateLifecycle({ cause: new EncryptionKeyInvalidError("The key was refused."), kind: "lost" }), "offline",
      "a lost verdict carrying a permanent cause states the opener offline too");
  });

  test("states online on recovered", () => {

    assert.equal(translateLifecycle({ kind: "recovered" }), "online", "the recovered verdict states the opener online");
  });

  test("states nothing on connect, encrypted or not, because a session beginning is no verdict", () => {

    assert.equal(translateLifecycle({ encrypted: false, kind: "connect" }), null, "a plaintext connect makes no availability statement");
    assert.equal(translateLifecycle({ encrypted: true, kind: "connect" }), null, "an encrypted connect makes no availability statement");
  });

  test("states nothing on a disconnect whose cause the client retries, so a drop healed on the first attempt stays unseen", () => {

    assert.equal(translateLifecycle({ kind: "disconnect" }), null, "a disconnect with no cause makes no availability statement");
    assert.equal(translateLifecycle({ cause: new HeartbeatStalledError("The heartbeat stalled."), kind: "disconnect" }), null,
      "a stalled session's disconnect makes no availability statement");
    assert.equal(translateLifecycle({ cause: new ConnectionError("The peer closed the connection.", "CONNECTION_DROPPED"), kind: "disconnect" }), null,
      "a dropped connection's disconnect makes no availability statement");
  });

  test("states offline on a disconnect whose cause is a PermanentError, because no reconnect attempt and so no verdict follows it", () => {

    assert.equal(translateLifecycle({ cause: new EncryptionKeyInvalidError("The key was refused."), kind: "disconnect" }), "offline",
      "an encryption failure the client will not retry states the opener offline");
    assert.equal(translateLifecycle({ cause: new DeviceIdentityError({ expected: "AABBCCDDEEFF", reported: "112233445566" }), kind: "disconnect" }), "offline",
      "the plugin's own wrong-device refusal, a PermanentError, states the opener offline");
    assert.equal(translateLifecycle({ cause: new TestPermanentError("A permanent failure the library does not name."), kind: "disconnect" }), "offline",
      "any PermanentError subclass states the opener offline, not only the ones the library ships");
  });
});
