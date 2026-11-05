/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * variants.ts: The family word each device variant is known by, which the settings page and the plugin both import, and the settings page's reading of the Model
 * those words open.
 */
import type { RatgdoOptionMeta } from "../options.ts";
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

/* The annotation the catalog marks the Disco board's entries with: the Ratgdo variant, the only one carrying the board, and the Disco mark within it. The catalog's
 * Disco section carries it, and the settings page asks its visibility rule about it wherever it decides whether Disco options apply to a device, so the two cannot
 * describe the board differently.
 */
export const RATGDO_DISCO_META = { disco: true, variant: "ratgdo" } as const satisfies RatgdoOptionMeta;

/* The words of a device's Model characteristic. device.ts composes the Model as the family word above followed by the model the device's firmware reports, and on a
 * Ratgdo that second word is the firmware's project version rather than the name of a board: live devices read "32disco" or "1.2.2", and custom firmware can read
 * anything. A Model that is not text, or is empty, has no words. This is the page's one reading of a Model, so the group a device is filed under and the Disco rule
 * below read the same words.
 *
 * @param model - The Model a device's cached accessory carries, whatever its type.
 *
 * @returns The Model's words, split on each space, or none.
 */
export const modelWords = (model: unknown): readonly string[] => ((typeof model === "string") && (model.length > 0)) ? model.split(" ") : [];

/* Whether a device whose Model reads as given may carry the Disco board. The Model names the firmware rather than the board, so the rule answers no only on a positive
 * match - a version opening with "2.", which is how the v2 boards' stock firmware reads - and yes on every other reading, an unrecognized version and a Model carrying
 * none included, because an option that does not apply costs a reader far less than a page that hides the option they came to set.
 *
 * @param model - The Model a device's cached accessory carries, whatever its type.
 *
 * @returns `false` when the Model shows the device is a v2 board, and `true` otherwise.
 */
export const mayCarryDisco = (model: unknown): boolean => !(modelWords(model)[1]?.startsWith("2.") ?? false);
