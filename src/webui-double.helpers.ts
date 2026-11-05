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
import type { CommitConfigResult, FeatureCategoryEntry, FeatureOptionEntry, Nullable } from "homebridge-plugin-utils";
import { STATUS_ADDRESSES_ROUTE, STATUS_PROBE_ROUTE } from "./webui/status-routes.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { readFileSync } from "node:fs";

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
  onOptionsRolledBack?: () => void;
  sidebar?: { deviceContent?: (device: FakeDevice) => FakeElement | string | null; deviceLabel?: string; groupOrder?: (a: string, b: string) => number };
  statusPanel?: StatusPanelParams;

  /* The framework's two visibility hooks as the page hands them over: one asked whether a device's page should render a given option, the other whether it should
   * render a given category. Both receive no device at the global scope, which is the case that offers everything.
   */
  ui?: {

    validOption?: (device: FakeDevice | undefined, option: FeatureOptionEntry) => boolean;
    validOptionCategory?: (device: FakeDevice | undefined, category: FeatureCategoryEntry) => boolean;
  };
}

/* One recorded `commitConfig` call: the patch the page's composer produced against the fixture's primary entry, and what the double answered. Recording the composed
 * patch rather than the composer itself is what lets a test assert WHAT would be written without running the write twice.
 */
export interface RecordedCommit {

  patch: unknown;
  result: CommitConfigResult;
}

// The feature-options facade the page reaches through `ui.featureOptions`.
export interface FeatureOptionsDouble {

  catalog: () => Promise<FakeCatalog>;
  commitConfig: (compose: (platform: FakeConfigEntry) => Nullable<Record<string, unknown>>, options?: { rename?: unknown }) => Promise<CommitConfigResult>;
  commits: RecordedCommit[];
  editedConfig: FakeConfigEntry[];
  getHomebridgeDevices: () => Promise<DeviceListResult>;
  // What the next commitConfig call answers. A test sets it to drive the staged and failed arms the page renders differently. `unchanged` is never driven through it,
  // because that answer comes from a composer returning null.
  nextCommit: CommitConfigResult;
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

/* One recorded DOM element. The page's markup is parsed into these, and the page clones its Add Device card from that markup and fills its readout through plain DOM
 * calls, so this records exactly the calls the page is allowed to make and nothing more - a member the page reaches that this does not carry throws inside the test,
 * which is what makes the harness a drift check rather than a mirror.
 *
 * Every member here is spelled the way the DOM spells it, and that spelling is the whole point. A double carrying a convenience member of its own - a `parent` where
 * the DOM says `parentElement` - accepts page code no browser would run, and the suite then goes green on a card that cannot open. So the names are the DOM's, the
 * behavior is the DOM's wherever it is observable, and anything the DOM does not offer is deliberately absent so that reaching for it throws here instead.
 *
 * `disabled` follows that rule: it stands only on the form controls, and an element of any other tag carries no such member, so reading it off a `div` answers
 * undefined as a browser does. The library's save flow accepts a control by its boolean `disabled`, so a card that handed it a `div` must fail here as it fails in a
 * browser. `value` follows it too: it stands only on the controls a form reads a value from, so a card that read its address off the field's wrapper gets undefined
 * here, as it would in a browser, rather than an empty string that reads as a field left blank. `type` stands only on an input and a button, reflecting the attribute
 * as the DOM does, and `content` only on a template, holding the elements its markup declares rather than its own children, as a browser's parser places them.
 *
 * `children` is a frozen view rather than the live array for that same reason: the real thing is an HTMLCollection whose `length` is a getter, so `children.length = 0`
 * throws in a browser and has to throw here too. The tree is mutated through `append`, `appendChild`, `before`, `remove`, and `replaceChildren`, exactly as it is in a
 * browser, and `classList` and `dataset` read and write the class attribute and the data attributes they stand for. `focus` moves the document's `activeElement` only
 * to an element standing in the page, as a browser's does.
 * There is deliberately no innerHTML and no insertAdjacentHTML: the card renders values that came from a user and from a device, so an HTML-string sink is a member
 * the page must not have.
 */
export interface FakeElement {

  addEventListener: (type: string, listener: FakeListener) => void;
  append: (...nodes: FakeElement[]) => void;
  appendChild: (node: FakeElement) => FakeElement;
  attributes: Record<string, string>;
  before: (...nodes: FakeElement[]) => void;
  readonly children: readonly FakeElement[];
  readonly classList: FakeClassList;
  className: string;
  cloneNode: (deep?: boolean) => FakeElement;
  closest: (selector: string) => Nullable<FakeElement>;
  content?: FakeFragment;
  readonly dataset: Record<string, string | undefined>;
  disabled?: boolean;
  focus: () => void;
  id: string;
  namespaceURI: string;
  parentElement: Nullable<FakeElement>;
  querySelector: (selector: string) => Nullable<FakeElement>;
  querySelectorAll: (selector: string) => readonly FakeElement[];
  remove: () => void;
  replaceChildren: (...nodes: FakeElement[]) => void;
  setAttribute: (name: string, value: string) => void;
  tagName: string;
  textContent: string;
  type?: string;
  value?: string;
}

// An element's class list, as the DOM's token list offers it: the members the page and the library's secret reveal call.
export interface FakeClassList {

  add: (...names: string[]) => void;
  contains: (name: string) => boolean;
  remove: (...names: string[]) => void;
  toggle: (name: string, force?: boolean) => boolean;
}

// The fragment a template holds its markup's elements in, carrying what the page reads off it: its elements, and the first of them, which is what it clones.
export interface FakeFragment {

  readonly children: readonly FakeElement[];
  readonly firstElementChild: Nullable<FakeElement>;
}

// A fake element of a tag that carries `value`, which is how a row holds a field it types into and reads back.
export type FakeValueControl = FakeElement & { value: string };

// Whether an element the page built is a control that holds a value. A row asks this of a field before driving it, so a card that built the field as any other
// element fails where the row opens the card.
export const isValueControl = (element: Nullable<FakeElement>): element is FakeValueControl => typeof element?.value === "string";

/* The fake document the page reads off the global scope. Every member is one the real document has, so a page reaching for anything else throws here rather than in a
 * browser - the same rule FakeElement follows, for the same reason. The test-facing search lives on the harness handle instead of on this object, because a
 * convenience member hanging off the document is exactly the sort of thing page code could reach for and get away with.
 */
export interface FakeDocument {

  readonly activeElement: Nullable<FakeElement>;
  addEventListener: (type: string, listener: FakeListener) => void;
  createElement: (tag: string) => FakeElement;
  createElementNS: (namespace: string, tag: string) => FakeElement;
  getElementById: (id: string) => Nullable<FakeElement>;
  querySelector: (selector: string) => Nullable<FakeElement>;
  querySelectorAll: (selector: string) => readonly FakeElement[];
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
 * a dispatched event - a click sent to one button, a host broadcast, or a document event - and like one it reaches a disabled control's listeners where a user's
 * click would not. So a row that fires a click at a disabled button states a press that reached the handler anyway, which is how the suite exercises the flow's busy
 * answer behind the disabled Save button. A target with no listener for the type is a test's own mistake, or a page that registered on the wrong target, so it is
 * named rather than silently doing nothing.
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
  // fixture staged for it, and everything else answers null exactly as the plugin's own UI server does for its void-returning handlers. Each of ratgdo's routes is
  // matched by the constant the page and the server import rather than by a literal of its own, so each route is spelled out in exactly one file.
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

/* Each element's live child list, keyed by the element. It sits beside the factory rather than on the element because `children` must hand back a frozen view - the
 * insertion methods need the real array, and nothing outside this file may have it.
 */
const liveChildren = new WeakMap<FakeElement, FakeElement[]>();

// The live child list of one element, which every insertion goes through. An element this file did not build has none, and an empty array keeps the walk total.
const childrenOf = (element: FakeElement): FakeElement[] => liveChildren.get(element) ?? [];

// Each template's content, keyed by the template, held apart from its children for the reason `liveChildren` is: the markup parser fills it, and nothing else may.
const fragmentChildren = new WeakMap<FakeElement, FakeElement[]>();

// The tags of the form controls, the only elements whose fake carries `disabled`, under the rule FakeElement states.
const FORM_CONTROL_TAGS: ReadonlySet<string> = new Set([ "button", "fieldset", "input", "optgroup", "option", "select", "textarea" ]);

// The tags of the controls a form reads a value from, the only elements whose fake carries `value`, under the same rule.
const VALUE_CONTROL_TAGS: ReadonlySet<string> = new Set([ "button", "input", "option", "select", "textarea" ]);

// The tags whose fake carries `type`, each beside the type its element reads when its markup names none, as the DOM's reflection of the attribute answers.
const TYPE_DEFAULTS: ReadonlyMap<string, string> = new Map([ [ "button", "submit" ], [ "input", "text" ] ]);

// The namespace an element the markup parser or `createElement` builds is in.
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

// The settings page's own markup, read once from the file the plugin ships, so every document this file builds parses the same text a browser is served.
const PAGE_MARKUP = readFileSync(new URL("../homebridge-ui/public/index.html", import.meta.url), "utf8");

// The elements a browser's parser closes on their own, which take no closing tag.
const VOID_TAGS: ReadonlySet<string> = new Set([ "br", "hr", "img", "input", "link", "meta" ]);

// The character references the markup parser decodes, each beside the character it stands for.
const CHARACTER_REFERENCES: Readonly<Record<string, string>> = { "#39": "'", "amp": "&", "gt": ">", "lt": "<", "quot": "\"" };

/* One token of the page's markup at the parser's position: a comment, a closing tag, an opening tag with its attributes, or a run of text. An attribute is either bare
 * or carries a double-quoted value, which is the one spelling the page's markup uses, so markup in any other spelling matches no token, and the parse stops on it by
 * name rather than reading it some way a browser would not.
 */
const MARKUP_TOKEN = /<!--[\s\S]*?-->|<\/([a-z][a-z0-9-]*)\s*>|<([a-z][a-z0-9-]*)((?:\s+[^\s"'=/>]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/y;

// One attribute of an opening tag the token above read, bare or with its double-quoted value.
const MARKUP_ATTRIBUTE = /\s+([^\s"'=/>]+)(?:="([^"]*)")?/g;

// Decode the character references in a run of markup text or an attribute value. A reference this file does not decode throws rather than standing in the text as
// written, since a browser would read it as the character it names.
const decodeMarkup = (text: string): string => text.replace(/&([#\w]+);/g, (reference: string, name: string): string => {

  const character = CHARACTER_REFERENCES[name];

  if(character === undefined) {

    throw new Error("The fake document's parser decodes no character reference " + reference + ".");
  }

  return character;
});

// One compound of a selector: the tag, the id, the classes, and the attributes an element must carry to match it, each optional.
interface CompoundSelector {

  attributes: { name: string; value: string | undefined }[];
  classes: string[];
  id: string | undefined;
  tag: string | undefined;
}

// A compound selector as the double reads one, and each of its parts after the tag.
const COMPOUND_SELECTOR = /^([a-z][a-z0-9-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:=(?:'[^']*'|"[^"]*"))?\])*)$/;
const SELECTOR_PART = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:'([^']*)'|"([^"]*)"))?\]/g;

/* Parse a selector into its compounds, outermost first. The double models the shapes the page and the library's secret reveal send - compounds of a tag, an id,
 * classes, and attributes, joined by the descendant combinator - and any other shape throws, because a selector this file answered with a guess is one the suite
 * could pass on while a browser answers otherwise.
 */
const parseSelector = (selector: string): CompoundSelector[] => selector.trim().split(/\s+/).map((text) => {

  const match = COMPOUND_SELECTOR.exec(text);

  if(!text.length || !match) {

    throw new Error("The fake document models selectors of tags, ids, classes, and attributes joined by descendant combinators, which " + selector + " is not.");
  }

  const compound: CompoundSelector = { attributes: [], classes: [], id: undefined, tag: match[1] };

  for(const [ , id, className, name, single, double ] of (match[2] ?? "").matchAll(SELECTOR_PART)) {

    if(id !== undefined) {

      compound.id = id;
    } else if(className !== undefined) {

      compound.classes.push(className);
    } else if(name !== undefined) {

      compound.attributes.push({ name, value: single ?? double });
    }
  }

  return compound;
});

// Whether one element carries everything one compound names.
const matchesCompound = (element: FakeElement, { attributes, classes, id, tag }: CompoundSelector): boolean => ((tag === undefined) || (element.tagName === tag)) &&
  ((id === undefined) || (element.id === id)) && classes.every((name) => element.className.split(" ").includes(name)) &&
  attributes.every(({ name, value }) => Object.hasOwn(element.attributes, name) && ((value === undefined) || (element.attributes[name] === value)));

/* Whether one element matches a parsed selector: the innermost compound matches the element itself, and each compound outside it matches an ancestor further out than
 * the one before. Taking the nearest ancestor that matches is enough, because a descendant combinator asks only that some ancestor match, so the nearest one leaves
 * every further ancestor available to the compounds outside it.
 */
const matchesSelector = (element: FakeElement, compounds: readonly CompoundSelector[]): boolean => {

  const innermost = compounds.at(-1);

  if(!innermost || !matchesCompound(element, innermost)) {

    return false;
  }

  let remaining = compounds.length - 1;
  let ancestor = element.parentElement;

  while((remaining > 0) && ancestor) {

    const compound = compounds[remaining - 1];

    if(compound && matchesCompound(ancestor, compound)) {

      remaining -= 1;
    }

    ancestor = ancestor.parentElement;
  }

  return remaining === 0;
};

// Every descendant of one element, depth first, which is document order.
const descendantsOf = (element: FakeElement): FakeElement[] => element.children.flatMap((child) => [ child, ...descendantsOf(child) ]);

/* Build the fake document the page runs against, from the page's own markup.
 *
 * The page block and the Add Device card's template are parsed out of the shipped index.html, so the sidebar column the launcher sits in, the regions a takeover
 * stands among, and every element of the card are the file's own rather than a description of them kept here. The parse builds each element through the same factory
 * the page's own `createElement` calls reach, so a parsed element and a built one are the same kind of fake. A page reaching for an element the markup does not
 * carry reads null, exactly as it would in a browser.
 *
 * Only the DOM surface the page and the library modules it loads actually use is modelled. Anything else they reach for is undefined and throws inside the test,
 * which is the whole point: this file is a drift check on what the page is allowed to do, not a re-implementation of the DOM.
 */
export const makeDocument = (): FakeDom => {

  // The parsed page's roots, which every lookup and search walks, and the element the document's focus is on.
  const roots: FakeElement[] = [];
  let active: Nullable<FakeElement> = null;

  // Whether an element stands in the page, which is whether it or an ancestor of it is one of the roots.
  const isConnected = (element: FakeElement): boolean => {

    let node: Nullable<FakeElement> = element;

    while(node && !roots.includes(node)) {

      node = node.parentElement;
    }

    return node !== null;
  };

  const makeElement = (tag: string, namespaceURI: string = HTML_NAMESPACE): FakeElement => {

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
      appendChild: (node) => {

        element.append(node);

        return node;
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

      // The class list over the class attribute's words, read afresh at each call, so it always speaks for the element's className as it stands.
      get classList(): FakeClassList {

        const names = (): string[] => element.className.split(" ").filter((name) => name.length > 0);
        const add = (...added: string[]): void => {

          element.className = [...new Set([ ...names(), ...added ])].join(" ");
        };

        const remove = (...removed: string[]): void => {

          element.className = names().filter((name) => !removed.includes(name)).join(" ");
        };

        return {

          add,
          contains: (name) => names().includes(name),
          remove,
          toggle: (name, force): boolean => {

            const present = force ?? !names().includes(name);

            if(present) {

              add(name);
            } else {

              remove(name);
            }

            return present;
          }
        };
      },
      className: "",

      // Node.cloneNode: the element's attributes, classes, id, and text, and its form state where it carries one, with its children copied too when the clone is
      // deep. Listeners stay behind, as they do in a browser.
      cloneNode: (deep = false) => {

        const copy = makeElement(tag, namespaceURI);

        for(const [ name, value ] of Object.entries(element.attributes)) {

          copy.setAttribute(name, value);
        }

        copy.className = element.className;
        copy.id = element.id;
        copy.textContent = element.textContent;

        if(FORM_CONTROL_TAGS.has(tag)) {

          copy.disabled = element.disabled;
        }

        if(VALUE_CONTROL_TAGS.has(tag)) {

          copy.value = element.value;
        }

        if(deep) {

          copy.append(...kids.map((child) => child.cloneNode(true)));
        }

        return copy;
      },

      // Element.closest: the element itself or the nearest ancestor matching the selector.
      closest: (selector) => {

        const compounds = parseSelector(selector);
        let node: Nullable<FakeElement> = element;

        while(node && !matchesSelector(node, compounds)) {

          node = node.parentElement;
        }

        return node;
      },

      // The data attributes as the DOM's dataset maps them: a key's capitals become hyphenated lower case after the data- prefix, in each direction.
      get dataset(): Record<string, string | undefined> {

        const attributeOf = (key: string): string => "data-" + key.replace(/[A-Z]/g, (capital) => "-" + capital.toLowerCase());

        return new Proxy<Record<string, string | undefined>>({}, {

          get: (_target, key): string | undefined => (typeof key === "string") ? element.attributes[attributeOf(key)] : undefined,
          set: (_target, key, value: unknown): boolean => {

            if(typeof key === "string") {

              element.setAttribute(attributeOf(key), String(value));
            }

            return true;
          }
        });
      },
      ...FORM_CONTROL_TAGS.has(tag) ? { disabled: false } : {},

      // HTMLElement.focus: an element standing in the page takes the document's focus, and one that does not is left alone, as a browser leaves it.
      focus: () => {

        if(isConnected(element)) {

          active = element;
        }
      },
      id: "",
      namespaceURI,
      parentElement: null,
      querySelector: (selector) => {

        const compounds = parseSelector(selector);

        return descendantsOf(element).find((node) => matchesSelector(node, compounds)) ?? null;
      },
      querySelectorAll: (selector) => {

        const compounds = parseSelector(selector);

        return descendantsOf(element).filter((node) => matchesSelector(node, compounds));
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

      // The class and id attributes are reflected onto className and id, as the DOM reflects them.
      setAttribute: (name, value) => {

        element.attributes[name] = value;

        if(name === "class") {

          element.className = value;
        } else if(name === "id") {

          element.id = value;
        }
      },
      tagName: tag,
      textContent: "",
      ...VALUE_CONTROL_TAGS.has(tag) ? { value: "" } : {}
    };

    const typeDefault = TYPE_DEFAULTS.get(tag);

    // An input's and a button's type reflect the type attribute, reading the tag's own default where the markup names none.
    if(typeDefault !== undefined) {

      Object.defineProperty(element, "type", { enumerable: true, get: (): string => element.attributes["type"] ?? typeDefault,
        set: (type: string): void => element.setAttribute("type", type) });
    }

    // A template's content holds the elements its markup declares, which the markup parser places there rather than among the template's own children.
    if(tag === "template") {

      const content: FakeElement[] = [];

      fragmentChildren.set(element, content);
      element.content = {

        get children(): readonly FakeElement[] {

          return Object.freeze([...content]);
        },
        get firstElementChild(): Nullable<FakeElement> {

          return content[0] ?? null;
        }
      };
    }

    liveChildren.set(element, kids);

    return element;
  };

  /* Parse the element the shipped markup carries under one id, with everything inside it, into elements built by makeElement, as a browser's parser builds them:
   * every attribute set through setAttribute, a template's elements placed in its content rather than among its children, and an element holding only text given
   * that text. Comments and the whitespace between elements are dropped, since the page reads neither, and an element holding text beside elements throws, because
   * this double carries no text nodes to hold it in.
   */
  const parseMarkup = (id: string): FakeElement => {

    const start = new RegExp("<[a-z][a-z0-9-]*\\s(?:[^>]*\\s)?id=\"" + id + "\"").exec(PAGE_MARKUP)?.index;

    if(start === undefined) {

      throw new Error("The settings page's markup carries no element with the id " + id + ".");
    }

    const token = new RegExp(MARKUP_TOKEN);
    const open: { element: FakeElement; text: string }[] = [];

    token.lastIndex = start;

    for(;;) {

      const at = token.lastIndex;
      const match = token.exec(PAGE_MARKUP);

      if(!match) {

        throw new Error("The settings page's markup holds a shape the fake document's parser does not read, at offset " + String(at) + ".");
      }

      const [ , closing, opening, attributes, text ] = match;
      const current = open.at(-1);

      if(text !== undefined) {

        if(current) {

          current.text += text;
        }

        continue;
      }

      if(closing !== undefined) {

        if(current?.element.tagName !== closing) {

          throw new Error("The settings page's markup closes " + closing + " at offset " + String(at) + ", which is not the element open there.");
        }

        open.pop();

        const held = (current.element.tagName === "template") ? (fragmentChildren.get(current.element) ?? []) : current.element.children;

        if(!held.length) {

          current.element.textContent = decodeMarkup(current.text);
        } else if(current.text.trim().length) {

          throw new Error("The settings page's markup holds text beside elements inside " + closing + ", which the fake document carries no text node for.");
        }

        if(!open.length) {

          return current.element;
        }

        continue;
      }

      // A comment matches with no group, and the page reads nothing of one.
      if(opening === undefined) {

        continue;
      }

      const element = makeElement(opening);

      for(const [ , name, value ] of (attributes ?? "").matchAll(MARKUP_ATTRIBUTE)) {

        if(name !== undefined) {

          element.setAttribute(name, decodeMarkup(value ?? ""));
        }
      }

      if(current?.element.tagName === "template") {

        fragmentChildren.get(current.element)?.push(element);
      } else {

        current?.element.append(element);
      }

      if(!VOID_TAGS.has(opening)) {

        open.push({ element, text: "" });
      }
    }
  };

  // Depth-first walk from every root, which is how a lookup or a test search reaches an element at any depth.
  const search = (predicate: (element: FakeElement) => boolean): Nullable<FakeElement> => roots.flatMap((root) => [ root, ...descendantsOf(root) ]).find(predicate) ??
    null;

  const document: FakeDocument = {

    // The focused element while it stands in the page. One the page has since removed holds the focus no longer, as in a browser, where the focus returns to the
    // document itself, which this double reads as null.
    get activeElement(): Nullable<FakeElement> {

      return (active && isConnected(active)) ? active : null;
    },
    addEventListener: (type, listener) => {

      recordListener(document, type, listener);
    },
    createElement: (tag) => makeElement(tag),
    createElementNS: (namespace, tag) => makeElement(tag, namespace),
    getElementById: (id) => search((element) => (element.id === id)),
    querySelector: (selector) => {

      const compounds = parseSelector(selector);

      return search((element) => matchesSelector(element, compounds));
    },
    querySelectorAll: (selector) => {

      const compounds = parseSelector(selector);

      return roots.flatMap((root) => [ root, ...descendantsOf(root) ]).filter((element) => matchesSelector(element, compounds));
    },
    visibilityState: "visible"
  };

  /* The markup Config UI X serves this page, in the parts the page reads: the settings page block, holding the plugin's sidebar column with the launcher above
   * the framework's sidebar and the main region with the framework's content regions in order, and the Add Device card's template. The nesting is the file's own,
   * which is what matters here - the launcher sits where the markup puts it, a takeover's container mounts by inserting beside the device-stats region, and the
   * sidebar's repaint finds its device names beneath their container, so an insertion or a lookup a real document would refuse is refused here too.
   */
  roots.push(parseMarkup("pageFeatureOptions"), parseMarkup("ratgdoDeviceCard"));

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

    this.liveness = { onResume: (handler): void => {

      this.resumeHandlers.push(handler);
    } };

    this.featureOptions = {

      catalog: (): Promise<FakeCatalog> => {

        this.#catalogPromise ??= (fixture.catalog ?? (async (): Promise<FakeCatalog> => (await fixture.host.request("/getOptions")) as FakeCatalog))()
          .catch((error: unknown) => {

            this.#catalogPromise = null;

            throw error;
          });

        return this.#catalogPromise;
      },

      /* The framework's coordinated configuration write. The composer is handed the fixture's primary platform entry - the live one, as the real contract hands the
       * live entry - and whatever it composes is merged onto that entry, so a later read by the page sees the write exactly as it would after a real commit. The
       * composed patch and the answer are both recorded, which is what lets a test assert the call count and the resulting options in one place.
       *
       * A composer answering null writes nothing, whether its change was already in place or it refused the change, and the call answers unchanged at once, as the
       * framework's does: nothing is merged and nothing is recorded, because `commits` lists the writes the framework opened and that answer opens none. The
       * framework's optional second argument, the rename a write declares, has no parameter here, since the card's save declares no rename.
       */
      commitConfig: async (compose): Promise<CommitConfigResult> => {

        const primary = this.featureOptions.editedConfig[0];

        if(!primary) {

          throw new Error("commitConfig requires a primary platform entry, which the fixture did not supply.");
        }

        const patch = compose(primary);

        if(patch === null) {

          return { kind: "unchanged" };
        }

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
      getHomebridgeDevices: async (): Promise<DeviceListResult> => ({ devices: fixture.devices.map((device) => ({ ...device })), error: "" }),
      nextCommit: { kind: "committed" },
      statusPanel: {

        resetStaleGuards: (): void => {

          this.featureOptions.statusPanel.resets += 1;
        },
        resets: 0,
        watchRequest: (request): void => {

          this.featureOptions.statusPanel.watched.push(request);
        },
        watched: []
      },

      /* The framework's content-area takeover. With no live cycle behind the call, or no device-stats region to stand ahead of, there is no area to give, and the
       * answer is a handle that is already released. Otherwise the standing takeover ends first, and the element is mounted in a container built through the page's
       * own document - read off the global scope, where the framework reads it too - carrying `data-fo-takeover` and inserted immediately ahead of
       * `#deviceStatsContainer`. The handle's release does nothing once its signal has aborted, and otherwise ends the takeover.
       */
      takeover: (element): ReturnType<FeatureOptionsDouble["takeover"]> => {

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
