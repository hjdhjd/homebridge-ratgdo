/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * vehicle-sensors.ts: The vehicle sensors a Disco board drives: the one table the vehicle sensor list offers its choices from, the accessory creates its sensors
 * against, and the retired per-sensor options migrate through.
 */
import type { FeatureOptionChoice, RetiredFamily } from "homebridge-plugin-utils";
import { RATGDO_VEHICLE_SENSORS_OPTION } from "./settings.ts";

// One vehicle sensor: the value the list stores for it, the label the settings page shows it under, and the option that enabled it on its own in the retired grammar.
interface RatgdoVehicleSensorEntry {

  readonly label: string;
  readonly retired: string;
  readonly value: string;
}

// Every vehicle sensor, in the order the settings page lists them.
export const RATGDO_VEHICLE_SENSORS = [

  { label: "Presence", retired: "Disco.OccupancySensor.Vehicle.Presence", value: "Presence" },
  { label: "Arriving", retired: "Disco.ContactSensor.Vehicle.Arriving", value: "Arriving" },
  { label: "Leaving", retired: "Disco.ContactSensor.Vehicle.Leaving", value: "Leaving" }
] as const satisfies readonly RatgdoVehicleSensorEntry[];

// The value of one vehicle sensor, which is what the list stores and what the accessory asks the list about.
export type RatgdoVehicleSensor = typeof RATGDO_VEHICLE_SENSORS[number]["value"];

// The vehicle sensors as the choices the catalog declares inline, so the settings page lists them and the accessory reads the list with no source of their own.
export const RATGDO_VEHICLE_SENSOR_CHOICES: readonly FeatureOptionChoice[] = RATGDO_VEHICLE_SENSORS.map(({ label, value }) => ({ label, value }));

/* The retired grammar of the vehicle sensor list, one boolean option per sensor, each off by default, as the family HBPU's retired options translate into the list. It
 * is derived from the table, so every sensor the list offers is one a retired option carries forward.
 */
export const RATGDO_VEHICLE_SENSORS_FAMILY: RetiredFamily = {

  members: RATGDO_VEHICLE_SENSORS.map(({ retired, value }) => ({ default: false, option: retired, value })),
  option: RATGDO_VEHICLE_SENSORS_OPTION
};
