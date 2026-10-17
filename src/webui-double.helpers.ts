/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-double.helpers.ts: The webUI framework boundary double, and the fake Homebridge host, document, and console the settings page runs against.
 *
 * The suite imports the REAL homebridge-ui/public/ui.mjs and lets the page construct this class in place of homebridge-plugin-utils' own webUi, so every parameter the
 * page declares, every listener it registers, and every request it sends is recorded here rather than reaching a browser. Each member is shaped from the framework's
 * documented contract rather than from whatever the page happens to call today, and that is what makes the suite a drift check: a member the page reaches that this
 * class does not carry throws inside the test instead of passing unnoticed.
 *
 * The fixtures sit beside the double because both describe one imagined install - a host holding a configuration and an option catalog, a sidebar holding devices -
 * and a test that varies one of them wants the rest to follow from the same description.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, Nullable } from "homebridge-plugin-utils";
import { featureOptionCategories, featureOptions } from "./options.ts";

/* The shared route module, read the way every browser module is read from TypeScript here: through a specifier held in a variable, so the import resolves at runtime
 * against a module that publishes no declarations. The fake host answers the addresses route by this identity rather than by a literal of its own, which is what keeps
 * each route spelled out in exactly one file across the whole repository.
 */
const ROUTES_MODULE = "../homebridge-ui/public/status-routes.mjs";
const sharedRoutes = (await import(ROUTES_MODULE)) as { STATUS_ADDRESSES_ROUTE: string; STATUS_WARM_ROUTE: string };

export const STATUS_ADDRESSES_ROUTE = sharedRoutes.STATUS_ADDRESSES_ROUTE;
export const STATUS_WARM_ROUTE = sharedRoutes.STATUS_WARM_ROUTE;

// The option catalog the page reads, in the two members the framework's own accessor narrows a /getOptions response down to.
export interface FakeCatalog {

  categories: unknown[];
  options: Record<string, unknown>;
}

/* One sidebar device as the framework's device-list contract carries it. `model` is deliberately unknown rather than string: the row is built from a cached
 * accessory's characteristic values, so a test needs to be able to describe an accessory whose Model is missing or is not text at all.
 */
export interface FakeDevice {

  model?: unknown;
  name: string;
  serialNumber: string;
  sidebarGroup?: string;
}

// The framework's device-list result: the list and the fetch's own outcome together, which is the shape the live device fetch guards on before it renders anything.
export interface DeviceListResult {

  devices: FakeDevice[];
  error: string;
}

// A platform configuration entry as it arrives from the host - an arbitrary object, because that is honestly what a user's config.json holds.
export type FakeConfigEntry = Record<string, unknown>;

/* One recorded bridge call: the route addressed, the body carried, and the very promise the page received back. Keeping the answer promise is what lets a test prove
 * which request the page handed to the panel's liveness watchdog, rather than inferring it from a count.
 */
export interface RecordedRequest {

  answer: Promise<unknown>;
  body: unknown;
  route: string;
}

// One recorded console diagnostic: the page's own message and whatever context it attached.
export interface RecordedLog {

  message: unknown;
  parameters: unknown[];
}

// The status-panel handle the framework mints per show cycle, carrying the two methods the page calls on it and a record of each call.
export interface StatusPanelDouble {

  resetStaleGuards: () => void;
  resets: number;
  watchRequest: (request: Promise<unknown>) => void;
  watched: Promise<unknown>[];
}

// The per-plugin status-panel copy and cells the page declares. Typed here rather than left loose so a test reads the declaration the same way the framework does.
export interface StatusPanelParams {

  errorMessages?: Record<string, { label?: string; message?: string }>;
  identity?: (device: FakeDevice) => { label: string; mono?: boolean; value: unknown }[];
  onServerHello?: () => void;
  placeholderRows?: { id: string; label: string; latch?: { seconds: number; value: string }; sizer?: string }[];
}

/* The feature-options parameters the page declares. `getDevices` carries the framework's own two-argument call shape - the selected controller and a bag holding the
 * live platform config - so a test that exercises the page's hook calls it exactly as the framework does.
 */
export interface FeatureOptionsParams {

  getDevices?: (controller: unknown, args: { config: unknown }) => Promise<DeviceListResult>;
  onLoaded?: () => void;
  onOptionsEdited?: () => void;
  sidebar?: { deviceLabel?: string; groupOrder?: (a: string, b: string) => number };
  statusPanel?: StatusPanelParams;

  /* The framework's two visibility hooks as the page hands them over: one asked whether a device's page should render a given option, the other whether it should
   * render a given category. Both receive no device at the global scope, which is the case that offers everything.
   */
  ui?: {

    validOption?: (device: FakeDevice | undefined, option: FeatureOptionEntry) => boolean;
    validOptionCategory?: (device: FakeDevice | undefined, category: FeatureCategoryEntry) => boolean;
  };
}

// The feature-options facade the page reaches through `ui.featureOptions`.
export interface FeatureOptionsDouble {

  catalog: () => Promise<FakeCatalog>;
  editedConfig: FakeConfigEntry[];
  getHomebridgeDevices: () => Promise<DeviceListResult>;
  statusPanel: StatusPanelDouble;
}

/* The Homebridge UI toast surface. The host carries it because the real bridge does, so a page that starts raising one reaches a channel rather than a missing member;
 * nothing observes what is raised, which is why each channel discards rather than records.
 */
export interface FakeToast {

  error: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
  success: (message: string, title?: string) => void;
  warning: (message: string, title?: string) => void;
}

/* The fake Homebridge bridge: the config endpoints the library's configuration session calls, the request channel the page's routes travel, and a record of each.
 * `requests` is the log every route assertion reads, `updates` holds each staged configuration array, and `saves` counts the writes to disk.
 */
export interface FakeHost {

  getPluginConfig: () => Promise<FakeConfigEntry[]>;
  request: (route: string, body?: unknown) => Promise<unknown>;
  requests: RecordedRequest[];
  savePluginConfig: () => Promise<void>;
  saves: number;
  toast: FakeToast;
  updatePluginConfig: (config: readonly FakeConfigEntry[]) => Promise<void>;
  updates: FakeConfigEntry[][];
}

// The fake document, carrying the one property the page reads and nothing else. A test sets `visibilityState` before firing the visibility belt's handler.
export interface FakeDocument {

  visibilityState: string;
}

// The fake console, recording what the page's diagnostic paths emit rather than writing it into the runner's output.
export interface FakeConsole {

  error: (message: unknown, ...parameters: unknown[]) => void;
  errors: RecordedLog[];
}

// One listener the page registered through the framework's scoped `on`, kept with its target so a test can tell the host's events from the document's.
export interface RegisteredListener {

  event: string;
  handler: (payload?: unknown) => void;
  target: unknown;
}

/* Everything a test says about the install the page loads against. It is staged rather than passed because the page constructs the double itself, deep inside its own
 * module body, so there is no call site for a test to hand these to.
 */
export interface DoubleFixture {

  catalog: Nullable<() => Promise<FakeCatalog>>;
  config: FakeConfigEntry[];
  devices: FakeDevice[];
  failNextShow: boolean;
  host: FakeHost;
  onConstructed: (double: webUi) => void;
}

// Every toast channel's sink. The page raises none, so a raised toast is discarded rather than recorded for a reader that does not exist.
const discardToast = (): void => undefined;

// The served catalog, exactly as the plugin's own UI server publishes it, so every test resolves feature options against the grammar the runtime resolves against.
export const realCatalog = (): FakeCatalog => ({ categories: featureOptionCategories, options: featureOptions });

// The two devices a default fixture install advertises: one of each variant, which is what lets a sidebar test see both family words without composing its own list.
export const defaultDevices = (): FakeDevice[] => [

  { model: "Ratgdo Disco", name: "Garage", serialNumber: "AABBCCDDEEFF" },
  { model: "Konnected GDOv2-Q", name: "Side Door", serialNumber: "112233445566" }
];

// The primary platform entry a default fixture install carries: the shape the configuration session seeds and the page reads its option entries from.
export const defaultConfig = (): FakeConfigEntry[] => [{ name: "Ratgdo", options: [], platform: "Ratgdo" }];

// The fixture the next construction reads. The page constructs the double itself, deep inside its own module body, so there is no call site to hand this to.
let staged: Nullable<DoubleFixture> = null;

// Stage the install the next page load runs against.
export const stageFixture = (fixture: DoubleFixture): void => {

  staged = fixture;
};

// Build the fake Homebridge bridge over a staged install. The catalog answer is the served one unless the test overrode the accessor, since the host's own catalog is
// what the page's configuration wiring reads regardless of how the page reaches its option catalog.
export const makeHost = ({ addresses = {}, config = defaultConfig() }: { addresses?: Record<string, string>; config?: FakeConfigEntry[] } = {}): FakeHost => {

  let held = config;

  // What each route answers with. The catalog is the served one, the addresses route hands back the staged discovery map, and everything else answers null exactly as
  // the plugin's own UI server does for its two void-returning handlers.
  const answerFor = (route: string): unknown => {

    switch(route) {

      case "/getOptions":

        return realCatalog();

      case STATUS_ADDRESSES_ROUTE:

        return addresses;

      default:

        return null;
    }
  };

  const host: FakeHost = {

    getPluginConfig: async () => held.map((entry) => ({ ...entry })),
    request: (route, body) => {

      const answer = Promise.resolve(answerFor(route));

      host.requests.push({ answer, body, route });

      return answer;
    },
    requests: [],
    savePluginConfig: async () => {

      host.saves += 1;
    },
    saves: 0,
    toast: { error: discardToast, info: discardToast, success: discardToast, warning: discardToast },
    updatePluginConfig: async (next) => {

      held = next.map((entry) => ({ ...entry }));
      host.updates.push(held);
    },
    updates: []
  };

  return host;
};

// Build the fake document. Only `visibilityState` is modelled, because the page reads nothing else off it - the framework's own `on` owns every registration.
export const makeDocument = (): FakeDocument => ({ visibilityState: "visible" });

// Build the fake console, recording the page's diagnostics instead of writing them into the runner's output where a deliberate one would read as noise.
export const makeConsole = (): FakeConsole => {

  const fake: FakeConsole = {

    error: (message, ...parameters) => {

      fake.errors.push({ message, parameters });
    },
    errors: []
  };

  return fake;
};

/* The boundary double for homebridge-plugin-utils' webUi, named as the framework names it so the page's own import binds to it unchanged.
 *
 * Two members carry the framework's timing rather than a convenience of their own. `statusPanel` exists from construction, because the framework mints that handle
 * while it mounts its views and before it announces a loaded model, so a page that sends its first request from the load announcement must find the handle already
 * there. And `show()` announces `onLoaded` on every cycle that establishes the page and announces nothing on a cycle that fails, which is the contract a page relying
 * on that announcement has to be tested against.
 */
export class webUi {

  // The page epoch. A test aborts this controller to retire the page copy the way a reopened settings panel does.
  readonly epoch = new AbortController();

  // The feature-options facade the page reads through.
  readonly featureOptions: FeatureOptionsDouble;

  // The framework's clock-gap detector, holding the handlers the page registered against it.
  readonly liveness: { onResume: (handler: () => void) => void };

  // Every listener the page registered through the scoped `on`, in registration order.
  readonly listeners: RegisteredListener[] = [];

  // The plugin name the page declared.
  readonly name: string;

  // The feature-options parameters the page declared, which is the whole of what it asks the framework to do on its behalf.
  readonly params: FeatureOptionsParams;

  // The resume handlers the page registered.
  readonly resumeHandlers: (() => void)[] = [];

  /* Makes the next show() cycle fail before it establishes the page, modelling a launch that never reaches a loaded model. It is seeded from the fixture as well as
   * settable afterwards, because the page runs its own first show() inside its module body where no test can reach in ahead of it.
   */
  failNextShow: boolean;

  // How many times the page asked the framework to show, counting failed cycles - a failed launch is a cycle that happened.
  showCalls = 0;

  // How many times the page adopted the framework's theming.
  themingCalls = 0;

  // The catalog read's memo, mirroring the framework's own: one read serves every caller for the page's life, and a rejection clears it so the next caller retries.
  #catalogPromise: Nullable<Promise<FakeCatalog>> = null;

  constructor({ featureOptions: params, name }: { featureOptions: FeatureOptionsParams; name: string }) {

    if(!staged) {

      throw new Error("No fixture was staged for the settings page to load against.");
    }

    const fixture = staged;

    this.failNextShow = fixture.failNextShow;
    this.name = name;
    this.params = params;

    this.liveness = { onResume: (handler) => {

      this.resumeHandlers.push(handler);
    } };

    this.featureOptions = {

      catalog: () => {

        this.#catalogPromise ??= (fixture.catalog ?? (async () => (await fixture.host.request("/getOptions")) as FakeCatalog))().catch((error: unknown) => {

          this.#catalogPromise = null;

          throw error;
        });

        return this.#catalogPromise;
      },
      editedConfig: fixture.config,
      getHomebridgeDevices: async () => ({ devices: fixture.devices.map((device) => ({ ...device })), error: "" }),
      statusPanel: {

        resetStaleGuards: () => {

          this.featureOptions.statusPanel.resets += 1;
        },
        resets: 0,
        watchRequest: (request) => {

          this.featureOptions.statusPanel.watched.push(request);
        },
        watched: []
      }
    };

    fixture.onConstructed(this);
  }

  // The page epoch's signal, which the page reads as the last condition before it sends.
  get epochSignal(): AbortSignal {

    return this.epoch.signal;
  }

  // Compose the page epoch into a caller's signal. The double hands the argument straight back, so a test drives cancellation through the caller's own controller.
  epochBounded(signal: AbortSignal): AbortSignal {

    return signal;
  }

  // Record a scoped listener registration.
  on(target: unknown, event: string, handler: (payload?: unknown) => void): void {

    this.listeners.push({ event, handler, target });
  }

  // Adopt the framework's theming.
  registerTheming(): Promise<void> {

    this.themingCalls += 1;

    return Promise.resolve();
  }

  /* Run one show cycle. A cycle that establishes the page announces the loaded model exactly once; a cycle the test marked as failing counts itself, spends the mark,
   * and announces nothing, which is how the framework treats a launch that never reached a loaded model.
   */
  async show(): Promise<void> {

    this.showCalls += 1;

    if(this.failNextShow) {

      this.failNextShow = false;

      return;
    }

    this.params.onLoaded?.();
  }

  // Fire every listener the page registered for an event. An event nobody registered for is a test's own mistake, so it is named rather than silently doing nothing.
  fire(event: string, payload?: unknown): void {

    const handlers = this.listeners.filter((listener) => (listener.event === event));

    if(!handlers.length) {

      throw new Error("The settings page registered no listener for " + event + ".");
    }

    for(const listener of handlers) {

      listener.handler(payload);
    }
  }

  // Fire every resume handler the page registered, the way the framework's clock-gap detector does on a page that froze and woke.
  resume(): void {

    for(const handler of this.resumeHandlers) {

      handler();
    }
  }
}
