import type { Level } from "./egress";
import type { Refs } from "./registry";
export type Destination = Refs & { alias: string; level: Level; connected: boolean; aliases?: readonly string[] };
export type Pin = { alias: string; lastRequestAt: number };
export type RoutingContext = { registry: readonly Destination[]; pinned: Pin | null; focused: Refs | null };
export type Resolution = { alias: string; text: string; pinned?: Pin; confirmation?: string } | { ask: string };
const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
const verbs = /^(?:ask|run|read|write|add|remove|delete|fix|test|build|check|show|tell|explain|summarize|open|rename|commit|create|update|list|find|make|review|implement|change|new\s+task|actually|instead|replace|cancel|stop)\b/i;
const separator = /^[,，:;\n\r…—–.]|^\.\.\./;
export function leading(text: string, registry: readonly Destination[], bare = false) {
  const input = text.trim();
  const matches = registry.flatMap(row => [...new Set([row.alias, ...(row.aliases ?? [])].map(normalize))].flatMap(name => {
    if (!name) return [];
    const tokens = name.split(" ").map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const match = input.match(new RegExp(`^${tokens}(?=$|[\\s,，:;…—–.!?])`, "i"));
    if (!match) return [];
    const rest = input.slice(match[0].length);
    const bareName = bare && /^[.!?]*$/.test(rest.trim());
    if (!bareName && !separator.test(rest.trimStart()) && !/^\s+/.test(rest)) return [];
    if (!bareName && !separator.test(rest.trimStart()) && !verbs.test(rest.trim())) return [];
    return [{ row, length: match[0].length, text: bareName ? "" : rest.replace(/^[\s,，:;…—–.]+/, "").trim() }];
  }));
  matches.sort((a, b) => b.length - a.length);
  const best = matches[0];
  if (!best) return null;
  if (matches.some(m => m.length === best.length && m.row.alias !== best.row.alias)) return "AMBIGUOUS";
  return best;
}
export function focusedAlias(registry: readonly Destination[], focused: Refs | null, includeOff = false) {
  if (!focused) return null;
  // A known surface is authoritative: a sibling serve/browser pane must not inherit its workspace's session.
  const matches = focused.surface_ref ? registry.filter(s => s.surface_ref === focused.surface_ref)
    : focused.workspace_ref ? registry.filter(s => s.workspace_ref === focused.workspace_ref) : [];
  return matches.length === 1 && (includeOff || matches[0]!.level !== "off") ? matches[0]!.alias : null;
}
export const liveAsk = (registry: readonly Destination[]) => `Which session? Live: ${registry.filter(s => s.connected && s.level !== "off").map(s => s.alias).join(", ") || "none"}`;
export const unavailable = "That session is not available by voice.";
export function resolve(utterance: { text: string; spokenAt: number }, ctx: RoutingContext): Resolution {
  const { text, spokenAt } = utterance;
  const explicit = leading(text, ctx.registry, true);
  if (explicit === "AMBIGUOUS") return { ask: liveAsk(ctx.registry) };
  if (explicit) return explicit.row.level === "off" ? { ask: unavailable } : { alias: explicit.row.alias, text: explicit.text };
  const command = normalize(text).match(/^(?:talk to|switch to) (.+?)[.!?]?$/i);
  if (command) {
    const target = leading(command[1]!, ctx.registry, true);
    if (!target || target === "AMBIGUOUS" || target.text) return { ask: liveAsk(ctx.registry) };
    if (target.row.level === "off") return { ask: unavailable };
    return { alias: target.row.alias, text: "", pinned: { alias: target.row.alias, lastRequestAt: spokenAt }, confirmation: `Talking to ${target.row.alias}.` };
  }
  const task = text.replace(/^this one\s*[,，:]\s*/i, "");
  const pin = ctx.pinned;
  if (pin && spokenAt - pin.lastRequestAt < 300000 && ctx.registry.some(s => s.alias === pin.alias && s.level !== "off")) return { alias: pin.alias, text: task };
  const alias = focusedAlias(ctx.registry, ctx.focused);
  return alias ? { alias, text: task } : { ask: liveAsk(ctx.registry) };
}
export function clarification(text: string): "correction" | "new" | null {
  if (/^(?:correction|yes\s*,?\s*correction|instead)\b/i.test(text.trim())) return "correction";
  if (/^(?:new\s+task|separate|no)\b/i.test(text.trim())) return "new";
  return null;
}
