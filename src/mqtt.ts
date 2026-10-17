/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.ts: The single source of truth for the MQTT topics ratgdo publishes and subscribes to.
 */
import { mqttTopicCatalog } from "homebridge-plugin-utils";

/* The plugin's whole MQTT topic surface, declared once and read from here by everything that spells a topic. Each publish and subscribe site in the device class
 * takes its tail and its log label from this catalog, and the documentation build projects it into the two marked regions of docs/MQTT.md, so what the document
 * prints cannot disagree with what the plugin puts on the wire. The presence of `publish`, `get`, and `set` on an entry is the declaration that the plugin performs
 * that verb, which is why an entry's message text and the code path that sends it are one statement rather than two that have to be kept in step.
 *
 * The library's builder validates the whole declaration the moment this module is evaluated - a duplicate wire tail, an empty topic, an entry declaring no verb at
 * all - so a malformed catalog fails the plugin's own import rather than reaching a broker. The export carries no type annotation because the builder types it:
 * annotating it would widen every topic to `string` and silence that compile-time half.
 *
 * This module imports the library and nothing else. The documentation CLI loads it compiled and standalone, exactly as it loads the feature-option catalog, so a
 * single import from the device side would drag the whole HomeKit accessory graph into that load.
 *
 * An entry's label is the word the client's get and set log lines carry: it reaches subscribeGet and subscribeSet as the name of the thing being read or written,
 * and the user sees it in the sentence the client writes.
 */
export const mqttTopics = mqttTopicCatalog({

  doorOpenOccupancy: { get: "`true` will trigger a publish event of the current garage door opener door open indicator occupancy status.",
    label: "Door Open Indicator Occupancy",
    publish: "`true` when the garage door open indicator occupancy is detected. `false` when the garage door open indicator occupancy event is reset.",
    topic: "dooropenoccupancy" },
  garageDoor: { get: "`true` will trigger a publish event of the current garage door opener state.", label: "Garage Door",
    publish: "`closed`, `closing`, `open`, `opening`, or `stopped`, when garage door state changes are detected.",
    set: "One of `close` or `open`. This will send the respective command to the garage door opener. When using the ESPHome firmware, `open` takes an optional " +
      "parameter between 0 and 100 to set the door position appropriately: `open 50` will set the garage door to the 50% open position.", topic: "garagedoor" },
  laser: { label: "Laser", publish: "`true` when the Ratgdo (ESP32) Disco park assistance laser is activated. `false` otherwise.", topic: "laser" },
  led: { label: "LED", publish: "`true` when the Ratgdo (ESP32) Disco LED is activated. `false` otherwise.", topic: "led" },
  light: { get: "`true` will trigger a publish event of the current garage door opener light.", label: "Light",
    publish: "`true` when the light has been activated. `false` when the light has been turned off.", topic: "light" },
  lock: { get: "`true` will trigger a publish event of the current garage door opener wireless remote lock status.", label: "Lock",
    publish: "`1` when the garage door opener's wireless remotes are locked out. `0` when they are permitted.", topic: "lock" },
  motion: { get: "`true` will trigger a publish event of the current garage door opener motion sensor.", label: "Motion",
    publish: "`true` when motion is detected. `false` when the motion event is reset.", topic: "motion" },
  obstruction: { get: "`true` will trigger a publish event of the current garage door opener obstruction sensor.", label: "Obstruction",
    publish: "`true` when an obstruction in the garage door opener is detected. `false` when the obstruction event is reset.", topic: "obstruction" },
  occupancy: { get: "`true` will trigger a publish event of the current garage door opener occupancy status.", label: "Occupancy",
    publish: "`true` when occupancy is detected. `false` when the occupancy event is reset.", topic: "occupancy" },
  strobe: { label: "Strobe", publish: "`true` when the Konnected strobe is activated. `false` otherwise.", topic: "strobe" },
  vehicleArriving: { label: "Vehicle Arriving", publish: "`true` when Ratgdo (ESP32) Disco detects a vehicle is arriving. `false` otherwise.",
    topic: "vehiclearriving" },
  vehicleLeaving: { label: "Vehicle Leaving", publish: "`true` when Ratgdo (ESP32) Disco detects a vehicle is leaving. `false` otherwise.",
    topic: "vehicleleaving" },
  vehiclePresence: { label: "Vehicle Presence", publish: "`true` when Ratgdo (ESP32) Disco detects the presence of a vehicle. `false` otherwise.",
    topic: "vehiclepresence" }
});
