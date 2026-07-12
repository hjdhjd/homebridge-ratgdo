/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.updatestate-vehicle.test.ts: updateState() concern net for the Disco vehicle sensors, the light, the auxiliary switches, and the backup battery.
 *
 * RatgdoAccessory.updateState() is the per-telemetry-event state router. This file exercises the branches that flip an auxiliary characteristic, log, and publish to
 * MQTT: the Disco vehicle arriving / leaving contact sensors and the vehicle presence occupancy sensor (driven through updateVehicleSensorState), the opener light, the
 * Disco laser / LED switches and the Konnected strobe (driven through updateSwitchState), and the verbose-log-derived backup battery state. Each branch carries the
 * same "only act on a real transition" contract, so every concern is netted with a happy-path transition, an explicit unchanged-state no-op, and - where the branch
 * logs - a feature-gated logging negative. The accessory is built with mqtt:true throughout so the recording MQTT double captures every publish the transitions emit.
 */
import { Characteristic, Service, buildRatgdoAccessory, makeKonnectedInitialState } from "./testing.helpers.ts";
import { RatgdoService, RatgdoVariant } from "./types.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("RatgdoAccessory.updateState() vehicle, light, switch, and battery telemetry", () => {

  // Every Disco vehicle feature defaults off, so every vehicle test enables them all together; this keeps the subtyped services present regardless of which event
  // a given test drives.
  const vehicleOptions = [ "Enable.Disco.ContactSensor.Vehicle.Arriving", "Enable.Disco.ContactSensor.Vehicle.Leaving", "Enable.Disco.OccupancySensor.Vehicle.Presence" ];

  describe("the Disco vehicle arriving contact sensor", () => {

    test("flips the contact state, logs, and publishes on a vehicle-arriving ON transition", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: vehicleOptions });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "binary_sensor-vehicle_arriving", state: "ON" });

      const service = accessory.getServiceById(Service.ContactSensor, RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING);

      assert.ok(service, "the vehicle arriving contact sensor service exists when the feature is enabled");
      assert.equal(service.getCharacteristic(Characteristic.ContactSensorState).value, true, "an ON arriving event writes true to the ContactSensorState characteristic");
      assert.equal(entries.some((entry) => (entry.level === "info") && String(entry.parameters[0]).includes("Vehicle arriving detected.")), true,
        "an arriving transition logs at info when Log.VehiclePresence is enabled");
      assert.equal(mqtt.publishes.find((entry) => entry.topic.endsWith("vehiclearriving"))?.payload, "true",
        "an arriving transition publishes true to the vehiclearriving MQTT topic");
    });

    test("clears the contact state, logs, and publishes on the following OFF transition", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: vehicleOptions });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "binary_sensor-vehicle_arriving", state: "ON" });
      ratgdo.updateState({ id: "binary_sensor-vehicle_arriving", state: "OFF" });

      const service = accessory.getServiceById(Service.ContactSensor, RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING);

      assert.equal(service?.getCharacteristic(Characteristic.ContactSensorState).value, false,
        "the following OFF arriving event writes false to the ContactSensorState characteristic");
      assert.equal(entries.some((entry) => (entry.level === "info") && String(entry.parameters[0]).includes("Vehicle arriving no longer detected.")), true,
        "the OFF arriving transition logs the no-longer-detected message at info");
      assert.equal(mqtt.publishes.filter((entry) => entry.topic.endsWith("vehiclearriving")).at(-1)?.payload, "false",
        "the OFF arriving transition publishes false to the vehiclearriving MQTT topic");
    });

    test("is a no-op when an OFF event repeats the already-cleared resting state", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: vehicleOptions });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "binary_sensor-vehicle_arriving", state: "OFF" });

      assert.equal(mqtt.publishes.some((entry) => entry.topic.endsWith("vehiclearriving")), false, "an unchanged OFF arriving event publishes nothing to MQTT");
      assert.equal(entries.some((entry) => String(entry.parameters[0]).includes("Vehicle arriving")), false, "an unchanged OFF arriving event logs nothing");
    });

    test("suppresses the log but still publishes and flips the characteristic when Log.VehiclePresence is disabled", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: [ ...vehicleOptions, "Disable.Log.VehiclePresence" ] });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "binary_sensor-vehicle_arriving", state: "ON" });

      const service = accessory.getServiceById(Service.ContactSensor, RatgdoService.CONTACT_DISCO_VEHICLE_ARRIVING);

      assert.equal(entries.some((entry) => String(entry.parameters[0]).includes("Vehicle arriving detected.")), false,
        "disabling Log.VehiclePresence suppresses the arriving detection log entirely");
      assert.equal(service?.getCharacteristic(Characteristic.ContactSensorState).value, true, "the characteristic still flips to true with logging disabled");
      assert.equal(mqtt.publishes.find((entry) => entry.topic.endsWith("vehiclearriving"))?.payload, "true", "MQTT still publishes with logging disabled");
    });
  });

  describe("the Disco vehicle leaving contact sensor", () => {

    test("flips the contact state, logs, and publishes on a vehicle-leaving ON transition", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: vehicleOptions });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "binary_sensor-vehicle_leaving", state: "ON" });

      const service = accessory.getServiceById(Service.ContactSensor, RatgdoService.CONTACT_DISCO_VEHICLE_LEAVING);

      assert.ok(service, "the vehicle leaving contact sensor service exists when the feature is enabled");
      assert.equal(service.getCharacteristic(Characteristic.ContactSensorState).value, true, "an ON leaving event writes true to the ContactSensorState characteristic");
      assert.equal(entries.some((entry) => (entry.level === "info") && String(entry.parameters[0]).includes("Vehicle leaving detected.")), true,
        "a leaving transition logs at info when Log.VehiclePresence is enabled");
      assert.equal(mqtt.publishes.find((entry) => entry.topic.endsWith("vehicleleaving"))?.payload, "true",
        "a leaving transition publishes true to the vehicleleaving MQTT topic");
    });

    test("is a no-op when an OFF event repeats the already-cleared resting state", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: vehicleOptions });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "binary_sensor-vehicle_leaving", state: "OFF" });

      assert.equal(mqtt.publishes.some((entry) => entry.topic.endsWith("vehicleleaving")), false, "an unchanged OFF leaving event publishes nothing to MQTT");
      assert.equal(entries.some((entry) => String(entry.parameters[0]).includes("Vehicle leaving")), false, "an unchanged OFF leaving event logs nothing");
    });
  });

  describe("the Disco vehicle presence occupancy sensor", () => {

    test("flips occupancy, logs, and publishes on a vehicle-detected ON transition", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: vehicleOptions });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "binary_sensor-vehicle_detected", state: "ON" });

      const service = accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE);

      assert.ok(service, "the vehicle presence occupancy sensor service exists when the feature is enabled");
      assert.equal(service.getCharacteristic(Characteristic.OccupancyDetected).value, true,
        "an ON vehicle-detected event writes true to the OccupancyDetected characteristic");
      assert.equal(entries.some((entry) => (entry.level === "info") && String(entry.parameters[0]).includes("Vehicle detected.")), true,
        "a presence transition logs at info when Log.VehiclePresence is enabled");
      assert.equal(mqtt.publishes.find((entry) => entry.topic.endsWith("vehiclepresence"))?.payload, "true",
        "a presence transition publishes true to the vehiclepresence MQTT topic");
    });

    test("clears occupancy, logs, and publishes on the following OFF transition", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: vehicleOptions });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "binary_sensor-vehicle_detected", state: "ON" });
      ratgdo.updateState({ id: "binary_sensor-vehicle_detected", state: "OFF" });

      const service = accessory.getServiceById(Service.OccupancySensor, RatgdoService.OCCUPANCY_DISCO_VEHICLE_PRESENCE);

      assert.equal(service?.getCharacteristic(Characteristic.OccupancyDetected).value, false,
        "the following OFF event writes false to the OccupancyDetected characteristic");
      assert.equal(entries.some((entry) => (entry.level === "info") && String(entry.parameters[0]).includes("Vehicle no longer detected.")), true,
        "the OFF presence transition logs the no-longer-detected message at info");
      assert.equal(mqtt.publishes.filter((entry) => entry.topic.endsWith("vehiclepresence")).at(-1)?.payload, "false",
        "the OFF presence transition publishes false to the vehiclepresence MQTT topic");
    });

    test("is a no-op when an OFF event repeats the already-cleared resting state", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: vehicleOptions });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "binary_sensor-vehicle_detected", state: "OFF" });

      assert.equal(mqtt.publishes.some((entry) => entry.topic.endsWith("vehiclepresence")), false, "an unchanged OFF vehicle-detected event publishes nothing to MQTT");
      assert.equal(entries.some((entry) => String(entry.parameters[0]).includes("Vehicle")), false, "an unchanged OFF vehicle-detected event logs nothing");
    });
  });

  describe("the opener light", () => {

    test("turns on, logs, and publishes on a light ON transition", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "light-light", state: "ON" });

      const service = accessory.getService(Service.Lightbulb);

      assert.equal(service?.getCharacteristic(Characteristic.On).value, true, "an ON light event writes true to the On characteristic");
      assert.equal(entries.some((entry) => (entry.level === "info") && String(entry.parameters[0]).includes("Light on.")), true,
        "a light transition logs at info when Log.Light is enabled");
      assert.equal(mqtt.publishes.find((entry) => entry.topic.endsWith("light"))?.payload, "true", "a light ON transition publishes true to the light MQTT topic");
    });

    test("turns off, logs, and publishes on the following OFF transition", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "light-light", state: "ON" });
      ratgdo.updateState({ id: "light-light", state: "OFF" });

      const service = accessory.getService(Service.Lightbulb);

      assert.equal(service?.getCharacteristic(Characteristic.On).value, false, "the following OFF light event writes false to the On characteristic");
      assert.equal(entries.some((entry) => (entry.level === "info") && String(entry.parameters[0]).includes("Light off.")), true,
        "the OFF light transition logs at info");
      assert.equal(mqtt.publishes.filter((entry) => entry.topic.endsWith("light")).at(-1)?.payload, "false",
        "the OFF light transition publishes false to the light MQTT topic");
    });

    test("is a no-op when an OFF event repeats the already-off resting state", () => {

      const { entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "light-light", state: "OFF" });

      assert.equal(mqtt.publishes.some((entry) => entry.topic.endsWith("light")), false, "an unchanged OFF light event publishes nothing to MQTT");
      assert.equal(entries.some((entry) => String(entry.parameters[0]).includes("Light o")), false, "an unchanged OFF light event logs nothing");
    });

    test("suppresses the log but still publishes and flips the characteristic when Log.Light is disabled", () => {

      const { accessory, entries, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Disable.Log.Light"] });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "light-light", state: "ON" });

      const service = accessory.getService(Service.Lightbulb);

      assert.equal(entries.some((entry) => String(entry.parameters[0]).includes("Light on.")), false, "disabling Log.Light suppresses the light-on log entirely");
      assert.equal(service?.getCharacteristic(Characteristic.On).value, true, "the characteristic still flips to true with light logging disabled");
      assert.equal(mqtt.publishes.find((entry) => entry.topic.endsWith("light"))?.payload, "true", "MQTT still publishes with light logging disabled");
    });
  });

  describe("the Disco laser and LED switches", () => {

    test("turns the laser switch on and publishes on a switch-laser ON transition", () => {

      const { accessory, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Disco.Switch.Laser"] });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "switch-laser", state: "ON" });

      const service = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_DISCO_LASER);

      assert.ok(service, "the Disco laser switch service exists when the feature is enabled");
      assert.equal(service.getCharacteristic(Characteristic.On).value, true, "an ON laser event writes true to the On characteristic");
      assert.equal(mqtt.publishes.find((entry) => entry.topic.endsWith("laser"))?.payload, "true", "a laser ON transition publishes true to the laser MQTT topic");
    });

    test("turns the LED switch on and publishes on a switch-led ON transition", () => {

      const { accessory, mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Disco.Switch.Led"] });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "switch-led", state: "ON" });

      const service = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_DISCO_LED);

      assert.ok(service, "the Disco LED switch service exists when the feature is enabled");
      assert.equal(service.getCharacteristic(Characteristic.On).value, true, "an ON led event writes true to the On characteristic");
      assert.equal(mqtt.publishes.find((entry) => entry.topic.endsWith("led"))?.payload, "true", "an led ON transition publishes true to the led MQTT topic");
    });

    test("is a no-op when a laser OFF event repeats the already-off resting state", () => {

      const { mqtt, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Disco.Switch.Laser"] });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "switch-laser", state: "OFF" });

      assert.equal(mqtt.publishes.some((entry) => entry.topic.endsWith("laser")), false, "an unchanged OFF laser event publishes nothing to MQTT");
    });
  });

  describe("the Konnected strobe switch", () => {

    test("turns the strobe switch on and publishes on a switch-str_output ON transition", () => {

      const { accessory, mqtt, ratgdo } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(), mqtt: true,
        userOptions: ["Enable.Konnected.Switch.Strobe"] });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "switch-str_output", state: "ON" });

      const service = accessory.getServiceById(Service.Switch, RatgdoService.SWITCH_KONNECTED_STROBE);

      assert.ok(service, "the Konnected strobe switch service exists when the feature is enabled");
      assert.equal(service.getCharacteristic(Characteristic.On).value, true, "an ON str_output event writes true to the On characteristic");
      assert.equal(mqtt.publishes.find((entry) => entry.topic.endsWith("strobe"))?.payload, "true", "a strobe ON transition publishes true to the strobe MQTT topic");
    });

    test("is a no-op when a strobe OFF event repeats the already-off resting state", () => {

      const { mqtt, ratgdo } = buildRatgdoAccessory({ device: { variant: RatgdoVariant.KONNECTED }, initialState: makeKonnectedInitialState(), mqtt: true,
        userOptions: ["Enable.Konnected.Switch.Strobe"] });

      assert.ok(mqtt, "the recording MQTT double is attached when mqtt is enabled");

      ratgdo.updateState({ id: "switch-str_output", state: "OFF" });

      assert.equal(mqtt.publishes.some((entry) => entry.topic.endsWith("strobe")), false, "an unchanged OFF strobe event publishes nothing to MQTT");
    });
  });

  describe("the Disco backup battery", () => {

    test("maps a CHARGING battery state to the CHARGING charging state", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Disco.Battery"] });

      ratgdo.updateState({ id: "battery", state: "CHARGING" });

      const service = accessory.getService(Service.Battery);

      assert.ok(service, "the backup battery service exists when the feature is enabled");
      assert.equal(service.getCharacteristic(Characteristic.ChargingState).value, Characteristic.ChargingState.CHARGING,
        "a CHARGING battery event writes the CHARGING charging state");
    });

    test("maps a FULL battery state to the NOT_CHARGING charging state", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Disco.Battery"] });

      ratgdo.updateState({ id: "battery", state: "FULL" });

      const service = accessory.getService(Service.Battery);

      assert.equal(service?.getCharacteristic(Characteristic.ChargingState).value, Characteristic.ChargingState.NOT_CHARGING,
        "a FULL battery event writes the NOT_CHARGING charging state");
    });

    test("maps an UNKNOWN battery state to the NOT_CHARGING charging state", () => {

      const { accessory, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Disco.Battery"] });

      ratgdo.updateState({ id: "battery", state: "UNKNOWN" });

      const service = accessory.getService(Service.Battery);

      assert.equal(service?.getCharacteristic(Characteristic.ChargingState).value, Characteristic.ChargingState.NOT_CHARGING,
        "an UNKNOWN battery event writes the NOT_CHARGING charging state");
    });

    test("logs an error and leaves the charging state untouched on an unrecognized battery state", () => {

      const { accessory, entries, ratgdo } = buildRatgdoAccessory({ mqtt: true, userOptions: ["Enable.Disco.Battery"] });

      // Establish a known non-default charging state first, so the assertion that a garbage event does not overwrite it is meaningful.
      ratgdo.updateState({ id: "battery", state: "CHARGING" });
      ratgdo.updateState({ id: "battery", state: "WILDCARD" });

      const service = accessory.getService(Service.Battery);

      assert.equal(entries.some((entry) => (entry.level === "error") && String(entry.parameters[0]).includes("Unknown battery state received")), true,
        "an unrecognized battery state logs at error");
      assert.equal(service?.getCharacteristic(Characteristic.ChargingState).value, Characteristic.ChargingState.CHARGING,
        "an unrecognized battery state returns early and leaves the prior charging state in place");
    });
  });
});
