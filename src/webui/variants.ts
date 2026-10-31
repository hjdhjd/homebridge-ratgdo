/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * variants.ts: The family word each device variant is known by, which the settings page and the plugin both import.
 */
import type { RatgdoVariant } from "../types.ts";

/* The family word each variant's devices are known by. It is the word HomeKit's Model characteristic opens with, which device.ts composes from this table, and it is
 * also the heading the settings sidebar groups a device under - the page reads the group word off the leading word of the Model it reads back, and looks the variant
 * up in this same table. One table typed over every variant is what keeps those readings one vocabulary: a variant added without a label fails to compile here rather
 * than rendering an unlabelled group.
 */
export const RATGDO_VARIANT_LABELS = {

  konnected: "Konnected",
  ratgdo: "Ratgdo"
} as const satisfies Record<RatgdoVariant, string>;
