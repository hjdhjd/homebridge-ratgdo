/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Linting defaults for Homebridge plugins.
 */
import hbPluginUtils from "homebridge-plugin-utils/eslint";

export default hbPluginUtils({

  allowDefaultProject: [ "eslint.config.mjs", "homebridge-ui/*.@(js|mjs)", "homebridge-ui/public/*.@(js|mjs)", "homebridge-ui/public/lib/*.@(js|mjs)" ],

  /* Test, fixture, and helper files are co-located with production code under src/. They follow the same modern style rules as production but legitimately use a few
   * patterns the strict production preset would flag:
   *
   * - `describe()` / `test()` from `node:test` return promises whose lifecycle the runner itself manages, so a top-level `test(...)` looks like a floating promise to
   *   the linter even though it is the canonical test definition shape.
   *
   * - Tests routinely narrow `unknown` inputs through guards that, after narrowing, leave subsequent member access as "definitely defined" - the linter then flags the
   *   safety-net optional chain as "unnecessary" even though it is the chain that enabled the narrowing.
   *
   * - Test helpers compose doubles whose types are intentionally permissive; requiring explicit return-type annotations on every inline test arrow adds noise without
   *   catching real bugs.
   *
   * - Some test callbacks carry `Promise<T>` return signatures (because the helper they pass to is async-shaped) with no meaningful body to await; enforcing
   *   `require-await` would force a cosmetic `await Promise.resolve()` in each. We let the test express intent directly.
   *
   * We turn off only the rules needed for test infrastructure so the rest of the strict preset still applies. Mirrors the same admission unifi-protect uses.
   */
  extraConfigs: [
    // server.js runs in Node, so it needs console declared as a readonly global - the js preset applied to that file pattern does not supply it on its own.
    { files: ["homebridge-ui/server.js"], languageOptions: { globals: { console: "readonly" } } },
    {

      files: [ "**/*.test.ts", "**/*.fixtures.ts", "**/*.helpers.ts" ],
      rules: {

        "@typescript-eslint/explicit-function-return-type": "off",
        "@typescript-eslint/no-floating-promises": "off",
        "@typescript-eslint/no-unnecessary-condition": "off",
        "@typescript-eslint/require-await": "off"
      }
    }
  ],
  js: [ "homebridge-ui/public/**/*.@(js|mjs)", "homebridge-ui/server.js", "eslint.config.mjs" ],
  ts: ["src/**/*.ts"],
  ui: [ "homebridge-ui/public/lib/webUi.mjs", "homebridge-ui/public/lib/webUi-featureoptions.mjs", "homebridge-ui/public/ui.mjs" ]
});
