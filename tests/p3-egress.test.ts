import { test, expect } from "bun:test";
import { egress, noticeText, type Context, type Notice } from "../src/egress";
import { sandbox } from "./p2-helpers";
test("net control notices are an explicit grammar, never arbitrary session text", () => {
  const f = sandbox("status");
  const context: Context = { request_id: "r", revision: 1, session_alias: "sandbox", cwd: f.root, policy: f.policy, secrets: [], source: "notice", current: true };
  try {
    const notices: Notice[] = [{ type: "route", aliases: ["sandbox", "other"] }, { type: "unavailable" }, { type: "pin", alias: "sandbox" }, { type: "clarify", alias: "sandbox" }, { type: "offline", alias: "sandbox" }];
    for (const notice of notices) {
      const ctx = { ...context, notice }, text = noticeText(notice);
      expect(egress("commentary", text, "sandbox", ctx).allowed).toBe(true);
      expect(egress("commentary", "PRIVATE", "sandbox", ctx).allowed).toBe(false);
      expect(egress("instructions", text, "sandbox", ctx).allowed).toBe(false);
      expect(egress("commentary", text, "sandbox", { ...ctx, current: false }).allowed).toBe(false);
      expect(egress("commentary", text, "sandbox", { ...ctx, source: "hook" }).allowed).toBe(false);
    }
    for (const alias of ["PRIVATE SPACE", "unregistered"]) {
      const notice: Notice = { type: "route", aliases: [alias] };
      expect(egress("commentary", noticeText(notice), "sandbox", { ...context, notice }).allowed).toBe(false);
    }
    const other: Notice = { type: "pin", alias: "other" };
    expect(egress("commentary", noticeText(other), "sandbox", { ...context, notice: other }).allowed).toBe(false);
    f.policy.sessions.sandbox!.level = "off";
    for (const notice of [notices[0]!, notices[2]!]) expect(egress("commentary", noticeText(notice), "sandbox", { ...context, notice }).allowed).toBe(false);
    expect(egress("commentary", "PRIVATE", "sandbox", context).allowed).toBe(false);
  } finally { f.cleanup(); }
});
