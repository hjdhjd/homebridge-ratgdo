/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.test.ts: The parity net over the MQTT topic catalog - the declaration every publish site, every subscribe site, and the generated document read.
 *
 * The catalog is the one place a tail, a verb, and a log label are spelled, so this file states the shipped surface as literals and holds the declaration to them.
 * A renamed tail, a verb quietly dropped from an entry, and a label that drifts away from what the client logs each fail here, where the shipped contract is written
 * down, rather than in whichever accessory suite happens to exercise that topic.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mqttTopics } from "./mqtt.ts";

// The wire tails the plugin ships, written out rather than derived, so this list is the receipt a reader compares the declaration against.
const TAILS = [ "dooropenoccupancy", "garagedoor", "laser", "led", "light", "lock", "motion", "obstruction", "occupancy", "strobe", "vehiclearriving",
  "vehicleleaving", "vehiclepresence" ];

// The tails the plugin answers a /get on, and the tail it accepts a /set on.
const GET_TAILS = [ "dooropenoccupancy", "garagedoor", "light", "lock", "motion", "obstruction", "occupancy" ];
const SET_TAILS = ["garagedoor"];

/* The label beside each subscribed tail. The label is user-visible: the client names it in the sentence it logs when a get or a set arrives, so a site reading the
 * right topic beside another entry's label would otherwise reach a user's log before it reached a test.
 */
const SUBSCRIPTION_LABELS = [ [ "dooropenoccupancy", "Door Open Indicator Occupancy" ], [ "garagedoor", "Garage Door" ], [ "light", "Light" ], [ "lock", "Lock" ],
  [ "motion", "Motion" ], [ "obstruction", "Obstruction" ], [ "occupancy", "Occupancy" ] ];

describe("the MQTT topic catalog", () => {

  // Every entry, read back off the catalog itself rather than restated here, so an entry added or removed reaches each assertion below without a second edit.
  const entries = Object.values(mqttTopics);

  // The tails of the entries declaring a given verb, sorted, since the declaration order the catalog is authored in is not part of the contract.
  const tailsDeclaring = (verb: "get" | "publish" | "set"): string[] => entries.filter((entry) => verb in entry).map((entry) => entry.topic).sort();

  test("declares exactly the shipped set of wire tails", () => {

    assert.deepEqual(entries.map((entry) => entry.topic).sort(), TAILS, "the catalog's tails are the ones the plugin ships, with none added and none dropped");
  });

  test("declares a published message on every entry", () => {

    assert.deepEqual(tailsDeclaring("publish"), TAILS, "every topic the catalog declares is one the plugin publishes, so no entry documents a row nothing writes");
  });

  test("declares a get on exactly the tails the plugin answers reads on", () => {

    assert.deepEqual(tailsDeclaring("get"), GET_TAILS, "the get children are the ones the plugin subscribes to, so the document promises no reply it will not send");
  });

  test("declares a set on the garage door alone", () => {

    assert.deepEqual(tailsDeclaring("set"), SET_TAILS, "the garage door is the one topic the plugin accepts a command on");
  });

  test("carries the log label the client names each subscribed topic by", () => {

    const labels = entries.filter((entry) => ("get" in entry) || ("set" in entry)).map((entry) => [ entry.topic, entry.label ]).sort();

    assert.deepEqual(labels, SUBSCRIPTION_LABELS, "each subscribed tail carries its own label, which is what a user reads in the client's get and set log lines");
  });
});
