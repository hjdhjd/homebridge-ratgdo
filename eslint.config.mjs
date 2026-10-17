/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Linting defaults for Homebridge plugins.
 */
import hbPluginUtils from "homebridge-plugin-utils/eslint";

export default hbPluginUtils({

  allowDefaultProject: [ "eslint.config.mjs", "homebridge-ui/*.@(js|mjs)", "homebridge-ui/public/*.@(js|mjs)", "homebridge-ui/public/lib/*.@(js|mjs)" ],
  js: [ "homebridge-ui/public/**/*.@(js|mjs)", "homebridge-ui/server.js", "eslint.config.mjs" ],

  // This config file and the webUI's backend server run under Node rather than in a browser, so they take Node's globals. The test-file relaxations come from the
  // preset's `tests` default, which already names this plugin's test, fixture, and helper files.
  node: [ "eslint.config.mjs", "homebridge-ui/server.js" ],
  ts: ["src/**/*.ts"],
  ui: ["homebridge-ui/public/ui.mjs"]
});
