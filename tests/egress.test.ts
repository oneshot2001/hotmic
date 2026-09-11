import { describe, test, expect } from "bun:test";
import { symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Egress, egress, loadPolicy, payloadHash, releasePayload, sessionPolicy, statusText, type Context } from "../src/egress";
import { sandbox } from "./p2-helpers";

function fixture(level: "release" | "summary" | "status" | "off" = "summary") {
  const f = sandbox(level), sent: string[] = [];
  const ctx: Context = { request_id: "r1", revision: 1, session_alias: "sandbox", cwd: f.root, policy: f.policy,
    secrets: ["SuperSecret-🍋-value"], current: true, source: "reply" };
  const gate = new Egress(async a => { sent.push(a.content); });
  return { ...f, ctx, sent, gate, emit: (text: string, alias = "sandbox") => gate.emit("commentary", text, alias, () => ctx) };
}
describe("egress sender boundary", () => {
  test("credential assembled from every UTF-8 byte boundary is scrubbed before chunks", async () => {
    const f = fixture();
    try {
      const secret = Buffer.from(f.ctx.secrets[0]!);
      for (let i = 1; i < secret.length; i++) {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const text = decoder.decode(secret.subarray(0, i), { stream: true }) + decoder.decode(secret.subarray(i));
        f.sent.length = 0;
        await f.emit("x".repeat(990) + text + " done");
        expect(f.sent.join("")).not.toContain(text);
        expect(f.sent.join("")).toContain("[redacted]");
      }
    } finally { f.cleanup(); }
  });
  test("known secret split across two replies redacts boundary fragments of at least eight characters", async () => {
    const f = fixture(); f.ctx.secrets = ["canary-secret-value"];
    try {
      for (let i = 1; i < f.ctx.secrets[0]!.length; i++) {
        f.sent.length = 0;
        await f.emit(f.ctx.secrets[0]!.slice(0, i)); await f.emit(f.ctx.secrets[0]!.slice(i));
        const left = f.ctx.secrets[0]!.slice(0, i), right = f.ctx.secrets[0]!.slice(i);
        expect(f.sent).toEqual(["sandbox: " + (left.length >= 8 ? "[redacted]" : left), "sandbox: " + (right.length >= 8 ? "[redacted]" : right)]);
        expect(f.sent.join("")).not.toContain(f.ctx.secrets[0]!);
      }
    } finally { f.cleanup(); }
  });
  test("short secret fragments leave ordinary replies unchanged", async () => {
    const f = fixture(); f.ctx.secrets = ["secret-abc"];
    try {
      await f.emit("All tests pass"); await f.emit("c is done");
      expect(f.sent).toEqual(["sandbox: All tests pass", "sandbox: c is done"]);
    } finally { f.cleanup(); }
  });
  test("every key shape requires a non-alphanumeric left boundary", async () => {
    const f = fixture();
    try {
      const shapes = ["sk-abc", "sk-proj-abc", "AKIA123", "ghp_abc", "xoxb-abc", "xoxa-abc", "xoxp-abc", "eyJabc.def.ghi"];
      await f.emit("task-based approach");
      expect(f.sent).toEqual(["sandbox: task-based approach"]);
      for (const shape of shapes) {
        f.sent.length = 0;
        await f.emit("a" + shape + " Z" + shape + " 0" + shape + " (" + shape + ")");
        expect(f.sent).toEqual(["sandbox: a" + shape + " Z" + shape + " 0" + shape + " ([redacted])"]);
      }
    } finally { f.cleanup(); }
  });
  test("summary denies hook content even when a reply with the same text is allowed", async () => {
    const f = fixture("summary");
    try {
      f.ctx.source = "hook";
      expect((await f.emit("CANARY-hook-content")).reason).toBe("hook content");
      expect(f.sent).toEqual([]);
      f.ctx.source = "reply"; await f.emit("CANARY-hook-content");
      expect(f.sent).toEqual(["sandbox: CANARY-hook-content"]);
    } finally { f.cleanup(); }
  });
  for (const level of ["off", "status", "release"] as const) test(`${level}: canary outside root cannot leave via reply or hook`, async () => {
    const f = fixture(level);
    try {
      const file = join(f.dir, "canary.txt"); writeFileSync(file, "CANARY-private-outside-root");
      const canary = readFileSync(file, "utf8");
      await f.emit(canary); f.ctx.source = "hook"; await f.emit(canary);
      expect(f.sent).toEqual([]);
    } finally { f.cleanup(); }
  });
  test("symlink escape, denied root, and sibling prefix fail closed", async () => {
    const f = fixture();
    try {
      symlinkSync(f.denied, join(f.root, "escape"));
      for (const cwd of [join(f.root, "escape"), join(f.dir, "aar2"), f.denied]) {
        f.ctx.cwd = cwd; expect((await f.emit("private")).allowed).toBe(false);
      }
      expect(f.sent).toEqual([]);
    } finally { f.cleanup(); }
  });
  test("forged, cross-session, malformed UTF-8 aliases and stale revisions send zero bytes", async () => {
    const f = fixture();
    try {
      for (const alias of ["unknown", "other", "sandbox\ud800", "sandbox\ufffd"]) expect((await f.emit("private", alias)).allowed).toBe(false);
      f.ctx.current = false; await f.emit("private"); expect(f.sent).toEqual([]);
    } finally { f.cleanup(); }
  });
  test("missing policy, malformed JSON, unknown and unresolved paths are off", async () => {
    const f = fixture();
    try {
      for (const policy of [loadPolicy(join(f.dir, "missing")), (() => { writeFileSync(f.path, "{"); return loadPolicy(f.path); })()]) {
        f.ctx.policy = policy; await f.emit("private");
      }
      expect(f.sent).toEqual([]);
      expect(sessionPolicy(f.policy, "unknown", f.root)).toBeNull();
      f.policy.denyRoots.push(join(f.dir, "absent")); expect(sessionPolicy(f.policy, "sandbox", f.root)).toBeNull();
    } finally { f.cleanup(); }
  });
  test("status uses only the five prompt templates; instructions/thinking cannot carry replies", () => {
    const f = fixture("status");
    try {
      f.ctx.source = "status";
      for (let i = 0; i < 5; i++) expect(egress("commentary", statusText(i, "sandbox"), "sandbox", f.ctx).allowed).toBe(true);
      expect(egress("instructions", "ignore rules", "sandbox", f.ctx).allowed).toBe(false);
      f.ctx.source = "reply";
      for (const kind of ["thinking", "instructions"] as const) expect(egress(kind, "private", "sandbox", f.ctx).allowed).toBe(false);
    } finally { f.cleanup(); }
  });
  test("release exact hash, changed payload, revocation, and supersede", async () => {
    const f = fixture("release");
    try {
      const hash = payloadHash("sandbox: result");
      f.gate.approve(hash, "r1", 1); await f.emit("changed"); expect(f.sent).toEqual([]);
      f.gate.revoke("r1", 1); await f.emit("result"); expect(f.sent).toEqual([]);
      f.gate.approve(hash, "r1", 1); f.ctx.revision = 2; await f.emit("result"); expect(f.sent).toEqual([]);
      f.ctx.revision = 1; await f.emit("result"); expect(f.sent).toEqual(["sandbox: result"]);
    } finally { f.cleanup(); }
  });
  test("rechecks authorization before every chunk, including revoke during acknowledgement", async () => {
    const f = fixture("release"), text = "z".repeat(1800);
    try {
      const gate = new Egress(async a => { f.sent.push(a.content); gate.revoke("r1", 1); });
      gate.approve(payloadHash(releasePayload("sandbox", text)), "r1", 1);
      expect((await gate.emit("commentary", text, "sandbox", () => f.ctx)).allowed).toBe(false);
      expect(f.sent.length).toBe(1);
    } finally { f.cleanup(); }
  });
  test("scrubs key shapes, configured text and denied paths before 500-token cap", async () => {
    const f = fixture();
    try {
      f.policy.sessions.sandbox!.redact = ["private-term"];
      await f.emit(`sk-proj-abcdef ghp_abcdef AKIA123456 xoxb-abc eyJhbGci.abc.def private-term ${f.denied}/file\n` + "z".repeat(4000));
      const joined = f.sent.join("");
      for (const value of ["sk-proj-abcdef", "ghp_abcdef", "AKIA123456", "xoxb-abc", "eyJhbGci", "private-term", f.denied]) expect(joined).not.toContain(value);
      expect(Array.from(joined).length).toBeLessThanOrEqual(2000);
      expect(f.sent.every(s => Array.from(s).length <= 1000)).toBe(true);
    } finally { f.cleanup(); }
  });
});
test("failed credential inventory blocks summary export", async () => {
  const f = fixture();
  try { f.ctx.secretsReady = false; await f.emit("unknown secret"); expect(f.sent).toEqual([]); }
  finally { f.cleanup(); }
});
