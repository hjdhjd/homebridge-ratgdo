/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * index.ts: homebridge-ratgdo plugin registration.
 */
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { API } from "homebridge";
import { RatgdoPlatform } from "./ratgdo-platform.js";

// Register our platform with Homebridge.
export default (api: API): void => {

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RatgdoPlatform);
};
