import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { object } from "../shim/protocol";

export type Level = "off" | "status" | "release" | "summary";
export type SessionPolicy = { root: string; level: Level; aliases?: string[]; redact?: string[] };
export type Policy = { default: "off"; denyRoots: string[]; sessions: Record<string, SessionPolicy> };
export const validAlias = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v);
export const expand = (path: string) => path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
export const policyPath = () => process.env.HOTMIC_POLICY ?? resolve(homedir(), ".config/hotmic/policy.json");
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === "string" && s.length > 0);
export function loadPolicy(path = policyPath()): Policy | null {
  try {
    const p: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!object(p) || p.default !== "off" || !strings(p.denyRoots) || !object(p.sessions)) return null;
    for (const [alias, s] of Object.entries(p.sessions)) {
      if (!validAlias(alias) || !object(s) || typeof s.root !== "string" || !isAbsolute(expand(s.root)) ||
        !["off", "status", "release", "summary"].includes(String(s.level)) ||
        (s.redact !== undefined && !strings(s.redact)) || (s.aliases !== undefined && !strings(s.aliases))) return null;
    }
    if (!p.denyRoots.every(p => isAbsolute(expand(p)))) return null;
    return p as Policy;
  } catch { return null; }
}
export function contains(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export function sessionPolicy(policy: Policy | null, alias: string, cwd: string): SessionPolicy | null {
  try {
    if (!policy || !validAlias(alias) || !Object.hasOwn(policy.sessions, alias)) return null;
    const s = policy.sessions[alias]!;
    const root = realpathSync(expand(s.root)), actual = realpathSync(cwd);
    // An unresolved deny root also fails closed: never silently discard a rule.
    const denied = policy.denyRoots.map(p => realpathSync(expand(p)));
    if (!contains(root, actual) || denied.some(d => contains(d, actual) || contains(d, root))) return null;
    return s;
  } catch { return null; }
}
export const templates = ["Sent to {alias}.", "{alias} is still working.", "{alias} needs approval in its terminal.",
  "{alias} has a result ready in the terminal.", "Which session?"] as const;
export const statusText = (index: number, alias: string) => templates[index]!.replaceAll("{alias}", alias);
export const releasePayload = (alias: string, text: string) => Array.from(`${alias}: ${text}`).slice(0, 2000).join("");
export const payloadHash = (payload: string) => createHash("sha256").update(payload).digest("hex");
export type Ref = { request_id: string; revision: number; session_alias: string };
export type Candidate = Ref & { text: string; hash: string };
export type Kind = "thinking" | "commentary" | "instructions";
export type Context = Ref & { cwd: string; policy: Policy | null; secrets: readonly string[];
  current: boolean; secretsReady?: boolean; source: "reply" | "status" | "hook"; approvedHash?: string };
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function scrub(text: string, secrets: readonly string[], denyRoots: string[], redact: string[]) {
  let clean = text;
  for (const secret of [...secrets, ...redact].filter(Boolean).sort((a, b) => b.length - a.length)) {
    clean = clean.split(secret).join("[redacted]");
    // Only substantial boundary fragments: short matches corrupt ordinary prose.
    // Deliberate splitting across three or more replies is outside this heuristic.
    for (let n = secret.length - 1; n >= 8; n--) {
      if (clean.endsWith(secret.slice(0, n))) { clean = clean.slice(0, -n) + "[redacted]"; break; }
    }
    for (let n = secret.length - 1; n >= 8; n--) {
      if (clean.startsWith(secret.slice(-n))) { clean = "[redacted]" + clean.slice(n); break; }
    }
  }
  clean = clean.replace(/(?<![A-Za-z0-9])(?:sk-(?:proj-)?[A-Za-z0-9_-]+|AKIA[A-Z0-9]+|ghp_[A-Za-z0-9]+|xox[abp]-[A-Za-z0-9-]+|eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,2})/g, "[redacted]");
  for (const root of denyRoots) {
    for (const path of new Set([expand(root), realpathSync(expand(root))])) {
      clean = clean.replace(new RegExp(escape(path) + "(?=$|[/\\s\"'])[^\\n\"']*", "g"), "[redacted path]");
    }
  }
  return clean;
}
export function egress(kind: Kind, text: string, sessionAlias: string, ctx: Context) {
  const deny = (reason: string) => ({ allowed: false, payloads: [] as string[], reason });
  if (!["thinking", "commentary", "instructions"].includes(kind) || !ctx.current || sessionAlias !== ctx.session_alias) return deny("identity or revision");
  const s = sessionPolicy(ctx.policy, sessionAlias, ctx.cwd);
  if (!s || s.level === "off") return deny("off");
  if (ctx.source === "hook") return deny("hook content");
  if (ctx.source === "status") return templates.some((_, i) => statusText(i, sessionAlias) === text)
    ? { allowed: true, payloads: [text], reason: "template" } : deny("not a template");
  if (kind !== "commentary") return deny("results are commentary only");
  if (s.level === "status") return deny("status only");
  if (s.level === "summary" && ctx.secretsReady === false) return deny("credential inventory unavailable");
  const full = releasePayload(sessionAlias, text);
  if (s.level === "release" && ctx.approvedHash !== payloadHash(full)) return deny("release required");
  const payload = s.level === "summary" ? `${sessionAlias}: ${scrub(text, ctx.secrets, ctx.policy!.denyRoots, s.redact ?? [])}` : full;
  // Cap the complete result to ~500 tokens, then chunk without splitting code points.
  const chars = Array.from(payload).slice(0, 2000);
  const payloads: string[] = [];
  while (chars.length) payloads.push(chars.splice(0, 1000).join(""));
  return { allowed: true, payloads, reason: s.level };
}
export type Append = Ref & { kind: Kind; content: string; delegation_id: string | null };
export type Sender = (append: Append) => Promise<void>;
export class Egress {
  #send: Sender;
  #approvals = new Map<string, string>();
  constructor(send: Sender) { this.#send = send; }
  approve(hash: string, requestId: string, revision: number) { this.#approvals.set(`${requestId}:${revision}`, hash); }
  revoke(requestId: string, revision: number) { this.#approvals.delete(`${requestId}:${revision}`); }
  async emit(kind: Kind, text: string, alias: string, context: () => Context, delegation_id: string | null = null, authorized?: () => void) {
    const ctx = context(), key = `${ctx.request_id}:${ctx.revision}`;
    const decide = () => egress(kind, text, alias, { ...context(), approvedHash: this.#approvals.get(key) });
    const decision = decide();
    if (!decision.allowed) return decision;
    authorized?.();
    for (const content of decision.payloads) {
      const fresh = decide();
      if (!fresh.allowed || JSON.stringify(fresh.payloads) !== JSON.stringify(decision.payloads)) return { allowed: false, payloads: [], reason: "revoked" };
      await this.#send({ kind, content, delegation_id, request_id: ctx.request_id, revision: ctx.revision, session_alias: alias });
    }
    return decision;
  }
}
