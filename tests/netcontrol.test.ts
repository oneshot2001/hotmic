import { test, expect } from "bun:test";
import { resolve, clarification, focusedAlias, type RoutingContext } from "../src/netcontrol";
import { cmuxEnv, identifyRefs } from "../src/cmux";
const registry = [
  { alias: "aar", aliases: ["a a r"], level: "release" as const, connected: true, workspace_ref: "workspace:1", surface_ref: "surface:1" },
  { alias: "edgeproof", aliases: ["edge proof"], level: "summary" as const, connected: true, workspace_ref: "workspace:2", surface_ref: "surface:2" },
  { alias: "vault", level: "status" as const, connected: true, workspace_ref: "workspace:3", surface_ref: "surface:3" },
  { alias: "off", level: "off" as const, connected: true, workspace_ref: "workspace:4", surface_ref: "surface:4" },
];
const ctx = (): RoutingContext => ({ registry, pinned: null, focused: null });
const route = (text: string, context = ctx(), spokenAt = 1000) => resolve({ text, spokenAt }, context);
test("explicit leading alias overrides pin and focus, exact variants strip only the leading name", () => {
  for (const text of ["EDGE   PROOF run the tests", "edge proof, run the tests", "edge proof… run the tests", "edge proof\nrun the tests"]) {
    expect(route(text, { ...ctx(), pinned: { alias: "aar", lastRequestAt: 0 }, focused: registry[2]! })).toEqual({ alias: "edgeproof", text: "run the tests" });
  }
  expect(route("vault, ask aar to run tests")).toEqual({ alias: "vault", text: "ask aar to run tests" });
  expect(route("a a r, run tests")).toEqual({ alias: "aar", text: "run tests" });
});
test("STT periods and ellipses separate an alias from arbitrary task text", () => {
  for (const text of ["Aar. Run the tests", "Aar... Run the tests", "a a r. Run the tests", "Aar. The tests need attention"]) {
    expect(route(text)).toEqual({ alias: "aar", text: text.includes("The tests") ? "The tests need attention" : "Run the tests" });
  }
});
test("this one is stripped under a pin without overriding the pin with focus", () => {
  expect(route("this one, run tests", { ...ctx(), pinned: { alias: "aar", lastRequestAt: 1000 }, focused: registry[1]! }))
    .toEqual({ alias: "aar", text: "run tests" });
});
test("focusedAlias includes off only when requested and still requires a unique match", () => {
  expect(focusedAlias(registry, registry[3]!)).toBeNull();
  expect(focusedAlias(registry, registry[3]!, true)).toBe("off");
  expect(focusedAlias([...registry, { ...registry[3]!, alias: "other" }], registry[3]!, true)).toBeNull();
  expect(focusedAlias(registry, { workspace_ref: "workspace:4", surface_ref: "unknown" }, true)).toBeNull();
});
test("no fuzzy, prefix, interior or unseparated non-verb name matching", () => {
  for (const text of ["aaron run tests", "edge proofing run tests", "edg proof run tests", "ask aar to run tests", "aar is mentioned in this text"]) expect(route(text)).toHaveProperty("ask");
  const collision = [...registry, { ...registry[0]!, alias: "other", aliases: ["edge proof"] }];
  expect(route("edge proof, run tests", { ...ctx(), registry: collision })).toHaveProperty("ask");
  expect(route("edge proof, run tests", { ...ctx(), registry: collision, pinned: { alias: "aar", lastRequestAt: 0 } })).toHaveProperty("ask");
});
test("pin commands confirm, pinned destination precedes focus and expires at five minutes", () => {
  for (const text of ["talk to a a r", "SWITCH TO aar."]) expect(route(text)).toEqual({ alias: "aar", text: "", pinned: { alias: "aar", lastRequestAt: 1000 }, confirmation: "Talking to aar." });
  const context = { ...ctx(), pinned: { alias: "aar", lastRequestAt: 1000 }, focused: registry[1]! };
  expect(route("run tests", context, 300999)).toEqual({ alias: "aar", text: "run tests" });
  expect(route("run tests", context, 301000)).toEqual({ alias: "edgeproof", text: "run tests" });
  expect(route("talk to vault", context)).toHaveProperty("alias", "vault");
  expect(route("talk to unknown", context)).toHaveProperty("ask");
});
test("focus matches surface before workspace; unregistered and ambiguous workspace never inherit a sibling", () => {
  expect(route("this one, run tests", { ...ctx(), focused: registry[1]! })).toEqual({ alias: "edgeproof", text: "run tests" });
  expect(focusedAlias(registry, { surface_ref: null, workspace_ref: "workspace:1" })).toBe("aar");
  expect(focusedAlias(registry, { surface_ref: "surface:serve", workspace_ref: "workspace:1" })).toBeNull();
  expect(focusedAlias([...registry, { ...registry[0]!, alias: "sibling", surface_ref: "surface:other" }], { surface_ref: null, workspace_ref: "workspace:1" })).toBeNull();
});
test("off destinations refuse explicit and pin targeting, focus falls through to live ask", () => {
  for (const text of ["off, run tests", "talk to off"]) expect(route(text)).toEqual({ ask: "That session is not available by voice." });
  expect(route("run tests", { ...ctx(), focused: registry[3]! })).toEqual({ ask: "Which session? Live: aar, edgeproof, vault" });
  expect(route("run tests", { ...ctx(), pinned: { alias: "off", lastRequestAt: 0 } })).toHaveProperty("ask");
  expect(route("run tests", { ...ctx(), registry: [] })).toEqual({ ask: "Which session? Live: none" });
  expect(route("run tests", { ...ctx(), registry: registry.map(s => ({ ...s, connected: false })) })).toEqual({ ask: "Which session? Live: none" });
});
test("clarification grammar accepts only the specified leading phrases", () => {
  for (const s of ["correction", "yes, correction", "instead use blue"]) expect(clarification(s)).toBe("correction");
  for (const s of ["new task", "separate task", "no, new task"]) expect(clarification(s)).toBe("new");
  for (const s of ["I said correction", "yesterday", "nothing", "separately", "yes"]) expect(clarification(s)).toBeNull();
});
test("cmux caller and focused refs stay opaque, caller environment is stripped only for focus", () => {
  const value = { caller: registry[0], focused: registry[1] };
  expect(identifyRefs(value, false)).toEqual({ workspace_ref: "workspace:1", surface_ref: "surface:1" });
  expect(identifyRefs(value, true)).toEqual({ workspace_ref: "workspace:2", surface_ref: "surface:2" });
  for (const v of [null, { focused: { surface_ref: 42 } }, { focused: { ...registry[1], is_browser_surface: true } }]) expect(identifyRefs(v, true)).toEqual({ workspace_ref: null, surface_ref: null });
  const env = { CMUX_WORKSPACE_ID: "caller", CMUX_SURFACE_ID: "caller", PATH: "/bin", KEEP: "yes" };
  expect(cmuxEnv(env, true)).toEqual({ PATH: "/bin", KEEP: "yes" });
  expect(cmuxEnv(env, false)).toEqual(env);
});
test("leading-name checks reject interior comma addresses and attached verbs, longest exact name wins", () => {
  for (const text of ["run run aar, tests", "aarrun tests", "edge proofread tests"]) expect(route(text)).toHaveProperty("ask");
  expect(route("aar.")).toEqual({ alias: "aar", text: "" });
  expect(route("aar run, tests", { ...ctx(), registry: [...registry, { ...registry[0]!, alias: "long", aliases: ["aar run"] }] })).toEqual({ alias: "long", text: "tests" });
});
