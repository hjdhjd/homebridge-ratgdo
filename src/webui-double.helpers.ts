/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-double.helpers.ts: The webUI framework boundary double, and the fake Homebridge host, document, and console the settings page runs against.
 *
 * The suite imports the REAL homebridge-ui/public/ui.mjs and lets the page construct this class in place of homebridge-plugin-utils' own webUi, so every parameter the
 * page declares and every request it sends is recorded here rather than reaching a browser, and every listener it registers is recorded by the fake host, document,
 * or element it is registered on. Each member is shaped from the framework's documented contract rather than from whatever the page happens to call today, and that is
 * what makes the suite a drift check: a member the page reaches that this class does not carry throws inside the test instead of passing unnoticed.
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
const sharedRoutes = (await import(ROUTES_MODULE)) as { STATUS_ADDRESSES_ROUTE: string; STATUS_PROBE_ROUTE: string; STATUS_WARM_ROUTE: string };

export const STATUS_ADDRESSES_ROUTE = sharedRoutes.STATUS_ADDRESSES_ROUTE;
export const STATUS_PROBE_ROUTE = sharedRoutes.STATUS_PROBE_ROUTE;
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

/* What a coordinated configuration write became, as the framework's own `commitConfig` reports it. `committed` and `staged` both mean the configuration changed -
 * `staged` reached the host's memory and not the disk - while `failed` means nothing changed.
 */
export type CommitResult = { kind: "committed" } | { error: unknown; kind: "failed" } | { error: unknown; kind: "staged" };

/* One recorded `commitConfig` call: the patch the page's composer produced against the fixture's primary entry, and what the double answered. Recording the composed
 * patch rather than the composer itself is what lets a test assert WHAT would be written without running the write twice.
 */
export interface RecordedCommit {

  patch: unknown;
  result: CommitResult;
}

// The feature-options facade the page reaches through `ui.featureOptions`.
export interface FeatureOptionsDouble {

  catalog: () => Promise<FakeCatalog>;
  commitConfig: (compose: (platform: FakeConfigEntry) => Record<string, unknown>) => Promise<CommitResult>;
  commits: RecordedCommit[];
  editedConfig: FakeConfigEntry[];
  getHomebridgeDevices: () => Promise<DeviceListResult>;
  // What the next commitConfig call answers. A test sets it to drive the staged and failed arms the page renders differently.
  nextCommit: CommitResult;
  statusPanel: StatusPanelDouble;
  takeover: (element: FakeElement) => { release: () => void; signal: AbortSignal };
}

/* The Homebridge UI toast surface, as the real bridge carries it. Each channel records what the page raises into the host's `toasts`, together with the channel it was
 * raised on, so a test reads a confirmation or a warning the way the user sees it.
 */
export interface FakeToast {

  error: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
  success: (message: string, title?: string) => void;
  warning: (message: string, title?: string) => void;
}

// One toast the page raised: the channel it was raised on and the message it carried.
export interface RecordedToast {

  channel: keyof FakeToast;
  message: string;
}

/* The fake Homebridge bridge: the config endpoints the library's configuration session calls, the request channel the page's routes travel, the event target the
 * host's broadcasts arrive on, the toast surface, and a record of each. `requests` is the log every route assertion reads, `updates` holds each staged configuration
 * array, `saves` counts the writes to disk, and `toasts` lists every toast the page raised, in order.
 */
export interface FakeHost {

  addEventListener: (type: string, listener: FakeListener) => void;
  getPluginConfig: () => Promise<FakeConfigEntry[]>;
  request: (route: string, body?: unknown) => Promise<unknown>;
  requests: RecordedRequest[];
  savePluginConfig: () => Promise<void>;
  saves: number;
  toast: FakeToast;
  toasts: RecordedToast[];
  updatePluginConfig: (config: readonly FakeConfigEntry[]) => Promise<void>;
  updates: FakeConfigEntry[][];
}

/* One recorded DOM element. The page builds its Add Device card through plain DOM calls, so this records exactly the calls the page is allowed to make and nothing
 * more - a member the page reaches that this does not carry throws inside the test, which is what makes the harness a drift check rather than a mirror.
 *
 * Every member here is spelled the way the DOM spells it, and that spelling is the whole point. A double carrying a convenience member of its own - a `parent` where
 * the DOM says `parentElement` - accepts page code no browser would run, and the suite then goes green on a card that cannot open. So the names are the DOM's, the
 * behavior is the DOM's wherever it is observable, and anything the DOM does not offer is deliberately absent so that reaching for it throws here instead.
 *
 * `children` is a frozen view rather than the live array for that same reason: the real thing is an HTMLCollection whose `length` is a getter, so `children.length = 0`
 * throws in a browser and has to throw here too. The tree is mutated through `append`, `prepend`, `before`, `remove`, and `replaceChildren`, exactly as it is in a
 * browser.
 * There is deliberately no innerHTML and no insertAdjacentHTML: the card renders values that came from a user and from a device, so an HTML-string sink is a member
 * the page must not have.
 */
export interface FakeElement {

  addEventListener: (type: string, listener: FakeListener) => void;
  append: (...nodes: FakeElement[]) => void;
  attributes: Record<string, string>;
  before: (...nodes: FakeElement[]) => void;
  readonly children: readonly FakeElement[];
  className: string;
  id: string;
  parentElement: Nullable<FakeElement>;
  prepend: (...nodes: FakeElement[]) => void;
  remove: () => void;
  replaceChildren: (...nodes: FakeElement[]) => void;
  setAttribute: (name: string, value: string) => void;
  tagName: string;
  textContent: string;
  value: string;
}

/* The fake document the page reads off the global scope. Every member is one the real document has, so a page reaching for anything else throws here rather than in a
 * browser - the same rule FakeElement follows, for the same reason. The test-facing search lives on the harness handle instead of on this object, because a
 * convenience member hanging off the document is exactly the sort of thing page code could reach for and get away with.
 */
export interface FakeDocument {

  addEventListener: (type: string, listener: FakeListener) => void;
  createElement: (tag: string) => FakeElement;
  getElementById: (id: string) => Nullable<FakeElement>;
  querySelector: (selector: string) => Nullable<FakeElement>;
  visibilityState: string;
}

/* The fake document together with the test-facing search over the tree the page built. They are handed back together and installed apart: the document goes onto the
 * global scope where the page reads it, and `find` stays on the harness handle where only a test can reach it.
 */
export interface FakeDom {

  document: FakeDocument;
  find: (predicate: (element: FakeElement) => boolean) => Nullable<FakeElement>;
}

// The fake console, recording what the page's diagnostic paths emit rather than writing it into the runner's output.
export interface FakeConsole {

  error: (message: unknown, ...parameters: unknown[]) => void;
  errors: RecordedLog[];
}

// A listener the page hands to a fake's `addEventListener`. It receives whatever payload a test fires with, the way a DOM listener receives the event.
export type FakeListener = (event?: unknown) => void;

// Any fake the page can register a listener on: the host its broadcasts arrive on, the document, and every element the page builds.
export type ListenerTarget = FakeDocument | FakeElement | FakeHost;

// One registration a fake recorded: the event type and the listener, kept in the store below under the target the page registered it on.
interface RegisteredListener {

  listener: FakeListener;
  type: string;
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

/* Every listener the page registered, keyed by the fake it registered on. It sits in a WeakMap beside the factories rather than on the fakes themselves for the reason
 * `liveChildren` below does: a record hanging off a fake is a member page code could reach for, and nothing outside this file may have it. A registration appends and
 * nothing is deduplicated, since the DOM keeps every distinct function it is handed.
 */
const registeredListeners = new WeakMap<ListenerTarget, RegisteredListener[]>();

// Record one registration against the fake it was made on. Every fake's addEventListener goes through here, so every kind of target shares the one store.
const recordListener = (target: ListenerTarget, type: string, listener: FakeListener): void => {

  const listeners = registeredListeners.get(target) ?? [];

  listeners.push({ listener, type });
  registeredListeners.set(target, listeners);
};

/* Fire one event at one fake: every listener the page registered on that target for that type runs, in registration order, and each receives the payload. That is
 * what a click on one button, a host broadcast, or a document event is. A target with no listener for the type is a test's own mistake, or a page that registered on
 * the wrong target, so it is named rather than silently doing nothing.
 */
export const fire = (target: ListenerTarget, type: string, payload?: unknown): void => {

  const listeners = (registeredListeners.get(target) ?? []).filter((entry) => (entry.type === type));

  if(!listeners.length) {

    throw new Error("The settings page registered no " + type + " listener on that target.");
  }

  for(const { listener } of listeners) {

    listener(payload);
  }
};

// Build the fake Homebridge bridge over a staged install. The catalog answer is the served one unless the test overrode the accessor, since the host's own catalog is
// what the page's configuration wiring reads regardless of how the page reaches its option catalog.
export const makeHost = ({ addresses = {}, config = defaultConfig(), probe }: { addresses?: Record<string, string>; config?: FakeConfigEntry[];
  probe?: () => Promise<unknown>; } = {}): FakeHost => {

  let held = config;

  // What each route answers with. The catalog is the served one, the addresses route hands back the staged discovery map, the probe route hands back whatever the
  // fixture staged for it, and everything else answers null exactly as the plugin's own UI server does for its void-returning handlers.
  const answerFor = (route: string): unknown => {

    switch(route) {

      case "/getOptions":

        return realCatalog();

      case STATUS_ADDRESSES_ROUTE:

        return addresses;

      case STATUS_PROBE_ROUTE:

        // An unstaged probe answers unreachable, which is the honest answer for a fixture that described no device at that address.
        return probe ? probe() : { kind: "error", reason: "unreachable" };

      default:

        return null;
    }
  };

  // One toast channel, recording each message the page raises on it into the host's list. The optional title the bridge also accepts is left unrecorded, since what a
  // test reads is where the message was raised and what it said.
  const raiseOn = (channel: keyof FakeToast): ((message: string) => void) => (message: string): void => {

    host.toasts.push({ channel, message });
  };

  const host: FakeHost = {

    addEventListener: (type, listener) => {

      recordListener(host, type, listener);
    },
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
    toast: { error: raiseOn("error"), info: raiseOn("info"), success: raiseOn("success"), warning: raiseOn("warning") },
    toasts: [],
    updatePluginConfig: async (next) => {

      held = next.map((entry) => ({ ...entry }));
      host.updates.push(held);
    },
    updates: []
  };

  return host;
};

/* Build the fake document the page mounts its Add Device card into.
 *
 * The seeded ids are the page markup Config UI X serves: the sidebar the button mounts inside, the sidebar content it mounts ahead of, and the device-stats region
 * a takeover's container stands before. They are seeded rather than created on demand so that a page reaching for an id the real markup does not carry reads null
 * and the mount has to cope, exactly as it would in a browser.
 *
 * Only the DOM surface the card actually uses is modelled. Anything else the page reaches for is undefined and throws inside the test, which is the whole point:
 * this file is a drift check on what the page is allowed to do, not a re-implementation of the DOM.
 */
/* Each element's live child list, keyed by the element. It sits beside the factory rather than on the element because `children` must hand back a frozen view - the
 * insertion methods need the real array, and nothing outside this file may have it.
 */
const liveChildren = new WeakMap<FakeElement, FakeElement[]>();

// The live child list of one element, which every insertion goes through. An element this file did not build has none, and an empty array keeps the walk total.
const childrenOf = (element: FakeElement): FakeElement[] => liveChildren.get(element) ?? [];

export const makeDocument = (): FakeDom => {

  const seeded = new Map<string, FakeElement>();

  const makeElement = (tag: string): FakeElement => {

    // The live child list. It is held in the closure rather than on the element, so the only way out of it is the frozen view `children` hands back - which is what
    // makes `children.length = 0` throw here exactly as it throws against a real HTMLCollection.
    const kids: FakeElement[] = [];

    // Detach a node from wherever it currently sits before it is inserted somewhere else, the way every DOM insertion does.
    const detach = (node: FakeElement): void => {

      const from = node.parentElement;

      if(!from) {

        return;
      }

      const siblings = childrenOf(from);
      const at = siblings.indexOf(node);

      if(at !== -1) {

        siblings.splice(at, 1);
      }

      node.parentElement = null;
    };

    const element: FakeElement = {

      addEventListener: (type, listener) => {

        recordListener(element, type, listener);
      },
      append: (...nodes) => {

        for(const node of nodes) {

          detach(node);
          node.parentElement = element;
          kids.push(node);
        }
      },
      attributes: {},
      before: (...nodes) => {

        const parent = element.parentElement;

        if(!parent) {

          return;
        }

        const siblings = childrenOf(parent);
        const at = siblings.indexOf(element);

        for(const node of nodes) {

          detach(node);
          node.parentElement = parent;
        }

        siblings.splice((at === -1) ? siblings.length : at, 0, ...nodes);
      },

      /* A frozen snapshot, not the live array. The real `children` is an HTMLCollection whose `length` is a getter-only accessor, so assigning to it throws in strict
       * mode; freezing reproduces that, and page code that wants to empty a node has to reach for `replaceChildren` as it would in a browser.
       */
      get children(): readonly FakeElement[] {

        return Object.freeze([...kids]);
      },
      className: "",
      id: "",
      parentElement: null,
      prepend: (...nodes) => {

        for(const node of nodes) {

          detach(node);
          node.parentElement = element;
        }

        kids.unshift(...nodes);
      },

      // Element.remove: the element leaves its parent, and an element with no parent is left as it is.
      remove: () => {

        detach(element);
      },
      replaceChildren: (...nodes) => {

        for(const node of kids.splice(0, kids.length)) {

          node.parentElement = null;
        }

        for(const node of nodes) {

          detach(node);
          node.parentElement = element;
          kids.push(node);
        }
      },
      setAttribute: (name, value) => {

        element.attributes[name] = value;
      },
      tagName: tag,
      textContent: "",
      value: ""
    };

    liveChildren.set(element, kids);

    return element;
  };

  // Depth-first walk from every seeded root, which is how a lookup or a test search reaches an element the page built at any depth.
  const walk = (element: FakeElement, visit: (node: FakeElement) => boolean): Nullable<FakeElement> => {

    if(visit(element)) {

      return element;
    }

    for(const child of element.children) {

      const found = walk(child, visit);

      if(found) {

        return found;
      }
    }

    return null;
  };

  const search = (predicate: (element: FakeElement) => boolean): Nullable<FakeElement> => {

    for(const root of seeded.values()) {

      const found = walk(root, predicate);

      if(found) {

        return found;
      }
    }

    return null;
  };

  const document: FakeDocument = {

    addEventListener: (type, listener) => {

      recordListener(document, type, listener);
    },
    createElement: makeElement,
    getElementById: (id) => seeded.get(id) ?? search((element) => (element.id === id)),

    /* The one selector shape the page's own harness uses: a class or a tag. The card mounts against the sidebar's own content wrapper, which the real markup
     * identifies by class rather than by id, so modelling those two keeps the double honest about what may be reached for.
     */
    querySelector: (selector) => search((element) => (element.className.split(" ").includes(selector.replace(".", "")) || (element.tagName === selector))),
    visibilityState: "visible"
  };

  // Seed one element the framework's own markup carries, addressable by id. Local rather than a member of the document, because it describes the fixture rather than
  // anything a page could ask a real document for.
  const seed = (id: string): FakeElement => {

    const element = makeElement("div");

    element.id = id;
    seeded.set(id, element);

    return element;
  };

  /* The markup Config UI X serves, in the shape index.html declares it: one feature-content row holding the sidebar and the main region side by side, the sidebar
   * holding its own content wrapper, and the main region holding the three framework content regions in order. The NESTING is what matters here rather than the
   * completeness - the launcher and a takeover's container mount by inserting beside these elements, so a flat set of roots would let an insertion pass that a real
   * document would refuse.
   */
  const row = seed("feature-main-content");
  const sidebar = seed("sidebar");
  const sidebarContent = makeElement("div");
  const main = makeElement("main");
  const stats = seed("deviceStatsContainer");
  const searchRegion = seed("search");
  const options = seed("optionsContainer");

  row.className = "feature-main-content";
  sidebarContent.className = "sidebar-content";
  main.className = "feature-content";
  sidebar.append(sidebarContent);
  main.append(stats, searchRegion, options);
  row.append(sidebar, main);

  return { document, find: search };
};

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
 *
 * The content-area takeover follows the framework's lifecycle as well. A cycle that establishes is the live one a takeover can be granted in; every `show()` ends a
 * standing takeover before anything else, a failed cycle included, and leaves no live cycle until one establishes; a later takeover ends the standing one, the latest
 * call winning; and `navigate()` ends it the way the user moving the sidebar selection does. What the framework does to its own regions' display while a takeover
 * stands is not modelled, because the page never reads it.
 *
 * The class carries no listener registration of its own, because the framework offers none: the page registers each listener on the host, the document, or the
 * element it listens to, and the fake it registers on records it for `fire` to drive.
 */
export class webUi {

  // The feature-options facade the page reads through.
  readonly featureOptions: FeatureOptionsDouble;

  // The framework's clock-gap detector, holding the handlers the page registered against it.
  readonly liveness: { onResume: (handler: () => void) => void };

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

  // Whether a show cycle has established the page and is still standing, which is what a takeover needs to be granted. False before the first show() and from the
  // start of every later one until it establishes.
  #cycleLive = false;

  // The standing takeover - the controller behind its handle's signal and the container holding the plugin's element - or null while the page holds its own area.
  #takeover: Nullable<{ container: FakeElement; controller: AbortController }> = null;

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

      /* The framework's coordinated configuration write. The composer is handed the fixture's primary platform entry - the live one, as the real contract hands the
       * live entry - and whatever it composes is merged onto that entry, so a later read by the page sees the write exactly as it would after a real commit. The
       * composed patch and the answer are both recorded, which is what lets a test assert the call count and the resulting options in one place.
       */
      commitConfig: async (compose) => {

        const primary = this.featureOptions.editedConfig[0];

        if(!primary) {

          throw new Error("commitConfig requires a primary platform entry, which the fixture did not supply.");
        }

        const patch = compose(primary);
        const result = this.featureOptions.nextCommit;

        this.featureOptions.commits.push({ patch, result });

        // Only an outcome that changed the configuration writes, which is the difference the two failure kinds describe.
        if((result.kind === "committed") || (result.kind === "staged")) {

          Object.assign(primary, patch);
        }

        return result;
      },
      commits: [],
      editedConfig: fixture.config,
      getHomebridgeDevices: async () => ({ devices: fixture.devices.map((device) => ({ ...device })), error: "" }),
      nextCommit: { kind: "committed" },
      statusPanel: {

        resetStaleGuards: () => {

          this.featureOptions.statusPanel.resets += 1;
        },
        resets: 0,
        watchRequest: (request) => {

          this.featureOptions.statusPanel.watched.push(request);
        },
        watched: []
      },

      /* The framework's content-area takeover. With no live cycle behind the call, or no device-stats region to stand ahead of, there is no area to give, and the
       * answer is a handle that is already released. Otherwise the standing takeover ends first, and the element is mounted in a container built through the page's
       * own document - read off the global scope, where the framework reads it too - carrying `data-fo-takeover` and inserted immediately ahead of
       * `#deviceStatsContainer`. The handle's release does nothing once its signal has aborted, and otherwise ends the takeover.
       */
      takeover: (element) => {

        const pageDocument = (globalThis as unknown as { document: FakeDocument }).document;
        const anchor = pageDocument.getElementById("deviceStatsContainer");

        if(!this.#cycleLive || !anchor) {

          return { release: (): void => undefined, signal: AbortSignal.abort() };
        }

        this.#endTakeover();

        const container = pageDocument.createElement("div");
        const controller = new AbortController();

        container.setAttribute("data-fo-takeover", "");
        container.append(element);
        anchor.before(container);
        this.#takeover = { container, controller };

        return {

          release: (): void => {

            if(controller.signal.aborted) {

              return;
            }

            this.#endTakeover();
          },
          signal: controller.signal
        };
      }
    };

    fixture.onConstructed(this);
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

    // The framework's show() tears the prior cycle down before anything else, so a cycle that goes on to fail has still ended the standing takeover, and no cycle is
    // live again until one establishes.
    this.#endTakeover();
    this.#cycleLive = false;

    if(this.failNextShow) {

      this.failNextShow = false;

      return;
    }

    this.#cycleLive = true;
    this.params.onLoaded?.();
  }

  // Move the sidebar selection the way a user's click on a navigation row does. The content area belongs to the selection the user chose, so the framework ends a
  // standing takeover; nothing else of a navigation is modelled, because the page reads nothing else of one.
  navigate(): void {

    this.#endTakeover();
  }

  // Fire every resume handler the page registered, the way the framework's clock-gap detector does on a page that froze and woke.
  resume(): void {

    for(const handler of this.resumeHandlers) {

      handler();
    }
  }

  // End the standing takeover, if one stands: its signal aborts and its container leaves the page, taking the plugin's element with it. A release, a later takeover,
  // a navigation, and a new show cycle all end a takeover this one way, as they do in the framework.
  #endTakeover(): void {

    if(!this.#takeover) {

      return;
    }

    this.#takeover.controller.abort();
    this.#takeover.container.remove();
    this.#takeover = null;
  }
}
