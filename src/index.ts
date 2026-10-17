/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * index.ts: homebridge-ratgdo plugin registration.
 */

// The explicit-resource-management bridge: it installs DisposableStack, AsyncDisposableStack, and SuppressedError as globals on a runtime below the platform
// release that ships them natively, and its position as the first import is the whole guarantee - one landing after a module that builds a stack is too late.
import "homebridge-plugin-utils/polyfills";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { API } from "homebridge";
import { RatgdoPlatform } from "./platform.ts";

// Register our platform with Homebridge.
export default (api: API): void => {

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RatgdoPlatform);
};
