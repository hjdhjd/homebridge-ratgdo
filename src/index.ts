/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * index.ts: homebridge-ratgdo plugin registration.
 */
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { API } from "homebridge";
import { RatgdoPlatform } from "./platform.ts";

// Register our platform with Homebridge.
export default (api: API): void => {

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RatgdoPlatform);
};
