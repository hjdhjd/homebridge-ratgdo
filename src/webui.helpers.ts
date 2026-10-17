/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui.helpers.ts: The harness that runs the real settings page under node:test.
 *
 * The page is a browser module: it resolves the framework by bare specifiers Config UI X serves from the plugin's own lib directory, and it reads `homebridge` and
 * `document` off the global scope. Node resolves neither on its own - the library publishes no export entry for its browser files - so this module registers a resolve
 * hook that routes each of those specifiers to the shipped file on disk, and routes the one framework module the page must not really construct to the boundary double
 * beside this file. Everything else passes through untouched, so the pure library modules the page uses - the feature-option engine, the configuration session, the
 * liveness helpers - run as themselves rather than as stand-ins.
 *
 * The page is imported once per test under a fresh query string, which is what gives each test its own module instance: the page holds its warm-set memory and its
 * debounce handle in module scope, and a second test reading the first test's memory would assert nothing at all.
 *
 * The `document` installed here is the recording one, seeded with the mount points Config UI X's own markup carries. That is what lets the suite hold the Add Device
 * card: the page builds the card through plain DOM calls, and every one of those calls lands in a record a test reads back.
 */
import type { FakeCatalog, FakeConfigEntry, FakeConsole, FakeDevice, FakeDocument, FakeElement, FakeHost, webUi } from "./webui-double.helpers.ts";
import { defaultConfig, defaultDevices, makeConsole, makeDocument, makeHost, stageFixture } from "./webui-double.helpers.ts";
import type { Nullable } from "homebridge-plugin-utils";
import { registerHooks } from "node:module";
import { settle } from "homebridge-plugin-utils/testing";

// The boundary double's own file URL, derived from this module's location so the harness carries no absolute path of its own.
const DOUBLE_URL = new URL("./webui-double.helpers.ts", import.meta.url).href;

// The directory holding the framework's shipped browser modules, likewise derived from this module's location.
const LIBRARY_UI_DIR = new URL("../node_modules/homebridge-plugin-utils/dist/ui/", import.meta.url).href;

/* Which bare specifiers name a browser module. The match requires a file extension, which is what tells the framework's browser files apart from the package's real
 * export entries: `homebridge-plugin-utils/testing` resolves through the package's own exports map and must keep doing so, while `.../featureOptions.js` has no export
 * entry at all and only resolves here.
 */
const LIBRARY_BROWSER_MODULE = /^homebridge-plugin-utils\/([\w.-]+\.m?js)$/;

/* Route the page's framework specifiers. The one module the page must not really construct is its webUi shell: constructing it would mount views into a document that
 * does not exist. Every other browser module resolves to the file the package ships, so the page runs against the real feature-option engine and the real configuration
 * session rather than against doubles of them.
 */
registerHooks({ resolve: (specifier, context, nextResolve) => {

  if(specifier === "homebridge-plugin-utils/webUi.mjs") {

    return { shortCircuit: true, url: DOUBLE_URL };
  }

  const browserModule = LIBRARY_BROWSER_MODULE.exec(specifier)?.[1];

  return browserModule ? { shortCircuit: true, url: LIBRARY_UI_DIR + browserModule } : nextResolve(specifier, context);
} });

/* Everything a test says about the install the page loads against.
 *
 * @property addresses     - The discovery map the addresses route answers with, keyed by each device's mac.
 * @property catalog       - An override for the framework's option-catalog accessor, for a test that needs the read to reject or to answer a shape of its own.
 * @property config        - The platform configuration the host holds.
 * @property devices       - The devices the sidebar's device source lists.
 * @property failNextShow  - Makes the page's own launch fail before it establishes, which is the only way to reach that state: the page shows itself as it loads.
 * @property probe         - What the probe route answers, as a function so a test can describe a slow answer, a failing one, or one per call.
 */
export interface LoadUiOptions {

  addresses?: Record<string, string>;
  catalog?: Nullable<() => Promise<FakeCatalog>>;
  config?: FakeConfigEntry[];
  devices?: FakeDevice[];
  failNextShow?: boolean;
  probe?: () => Promise<unknown>;
}

/* One loaded page and the fakes that observed it. Disposable, so a test holds it with `using` and the globals the load installed are restored at the end of the test
 * whether it passed, failed, or threw.
 */
export interface LoadedUi extends Disposable {

  console: FakeConsole;
  document: FakeDocument;
  double: webUi;
  // The test-facing search over the tree the page built. It lives here rather than on the document, so that the document the page reads carries DOM members only.
  findElement: (predicate: (element: FakeElement) => boolean) => Nullable<FakeElement>;
  host: FakeHost;
}

// The load counter behind each page instance's query string.
let loads = 0;

/* Load the real settings page against a staged install and return the fakes that watched it.
 *
 * The load settles once before it returns. The page starts its first warm without awaiting it, so the module's own evaluation finishes while that send is still in
 * flight; letting the queue come to rest here means every test reads a page that has finished booting rather than one caught mid-boot.
 */
export const loadUi = async ({ addresses = {}, catalog = null, config = defaultConfig(), devices = defaultDevices(), failNextShow = false,
  probe }: LoadUiOptions = {}): Promise<LoadedUi> => {

  const fakeConsole = makeConsole();
  const dom = makeDocument();
  const host = makeHost({ addresses, config, probe });

  // The double the page is about to construct. It arrives through the fixture's own callback, because the page constructs it inside its module body where no caller
  // can reach the instance.
  let double: Nullable<webUi> = null;

  stageFixture({ catalog, config, devices, failNextShow, host, onConstructed: (constructed) => {

    double = constructed;
  } });

  // The globals the page reads. They are installed by descriptor rather than by assignment so the restore below can tell a global that existed before from one this
  // load introduced, and delete the latter instead of leaving an undefined behind.
  const scope = globalThis as unknown as Record<string, unknown>;
  const installed = { console: fakeConsole, document: dom.document, homebridge: host };
  const prior = new Map(Object.keys(installed).map((key) => [ key, Object.getOwnPropertyDescriptor(scope, key) ]));

  Object.assign(scope, installed);

  // The page's own specifier, carrying a per-load query string. It is held in a variable rather than written inline because the page publishes no declarations, and a
  // specifier TypeScript can resolve statically would be an implicit any it refuses.
  const specifier = "../homebridge-ui/public/ui.mjs?load=" + String(++loads);

  await import(specifier);
  await settle();

  // A page that never constructed its shell reached none of its own behavior, which is a failure worth naming rather than a null every test would have to guard.
  if(!double) {

    throw new Error("The settings page constructed no webUi.");
  }

  return {

    [Symbol.dispose]: (): void => {

      for(const [ key, descriptor ] of prior) {

        if(descriptor) {

          Object.defineProperty(scope, key, descriptor);

          continue;
        }

        Reflect.deleteProperty(scope, key);
      }
    },
    console: fakeConsole,
    document: dom.document,
    double,
    findElement: dom.find,
    host
  };
};
