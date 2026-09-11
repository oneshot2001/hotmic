import { expect, test } from "bun:test";
import { openDB } from "../src/db";
import { Ledger, ledgerStep } from "../src/ledger";

const caps = { activation_usd: 0.5, daily_usd: 3, idle_ms: 180000 };
test("usage snapshots replace, 96s=$0.08 and 78s=$0.065; only close finalizes", () => {
  const db = openDB(); const ledger = new Ledger(db, caps);
  try {
    ledger.handle({ type: "session.started", voice_epoch: "v" }, 0);
    ledger.handle({ type: "session.usage.updated", voice_epoch: "v", seconds: 78 }, 1);
    expect(ledger.snapshot()[0]).toMatchObject({ seconds: 78, finalized: 0 });
    expect(ledger.snapshot()[0]?.usd).toBeCloseTo(0.065, 12);
    ledger.handle({ type: "session.usage.updated", voice_epoch: "v", seconds: 96 }, 2);
    ledger.handle({ type: "session.usage.updated", voice_epoch: "v", seconds: 96 }, 3);
    expect(ledger.snapshot()[0]).toMatchObject({ seconds: 96, finalized: 0 });
    expect(ledger.snapshot()[0]?.usd).toBeCloseTo(0.08, 12);
    ledger.handle({ type: "session.closed", voice_epoch: "v", seconds: 96 }, 4);
    ledger.handle({ type: "session.usage.updated", voice_epoch: "v", seconds: 78 }, 5);
    expect(ledger.snapshot()[0]).toMatchObject({ seconds: 96, finalized: 1 });
  } finally { db.close(); }
});

test("caps return close once, preserve unfinalized spend across duplicate start and restart", () => {
  const db = openDB(); let ledger = new Ledger(db, { ...caps, activation_usd: 0.08 });
  try {
    ledger.handle({ type: "session.started", voice_epoch: "v" }, 0);
    expect(ledger.handle({ type: "session.usage.updated", voice_epoch: "v", seconds: 95 }, 1)).toEqual([]);
    expect(ledger.handle({ type: "session.usage.updated", voice_epoch: "v", seconds: 96 }, 2)).toEqual([{ type: "close", voice_epoch: "v", reason: "activation" }]);
    ledger = new Ledger(db, { ...caps, activation_usd: 0.08 });
    expect(ledger.handle({ type: "session.started", voice_epoch: "v" }, 3)).toEqual([]);
    expect(ledger.snapshot()[0]).toMatchObject({ seconds: 96, finalized: 0, close_requested: 1 });
    ledger.handle({ type: "session.closed", voice_epoch: "v" }, 4);
    expect(ledger.snapshot()[0]?.finalized).toBe(1);
  } finally { db.close(); }
});

test("daily cap adds epochs once; old days excluded; idle resets only on activity", () => {
  const db = openDB(); const ledger = new Ledger(db, { ...caps, daily_usd: 0.13 });
  try {
    ledger.handle({ type: "session.started", voice_epoch: "a" }, 0);
    ledger.handle({ type: "session.closed", voice_epoch: "a", seconds: 78 }, 1);
    ledger.handle({ type: "session.started", voice_epoch: "b" }, 2);
    expect(ledger.handle({ type: "session.usage.updated", voice_epoch: "b", seconds: 78 }, 3))
      .toEqual([{ type: "close", voice_epoch: "b", reason: "daily" }]);
    const day = 86400000;
    expect(ledger.handle({ type: "session.started", voice_epoch: "c" }, day)).toEqual([]);
    expect(ledger.handle({ type: "tick", voice_epoch: "c" }, day + 179999)).toEqual([]);
    ledger.handle({ type: "activity", voice_epoch: "c" }, day + 179999);
    expect(ledger.handle({ type: "tick", voice_epoch: "c" }, day + 180000)).toEqual([]);
    expect(ledger.handle({ type: "tick", voice_epoch: "c" }, day + 359999)).toEqual([{ type: "close", voice_epoch: "c", reason: "idle" }]);
    expect(ledger.snapshot().find((u) => u.voice_epoch === "c")?.finalized).toBe(0);
  } finally { db.close(); }
});

test("invalid usage rolls back and pure reducer leaves input intact", () => {
  const db = openDB(); const ledger = new Ledger(db, caps);
  try {
    ledger.handle({ type: "session.started", voice_epoch: "v" }, 0);
    const before = ledger.snapshot();
    expect(() => ledger.handle({ type: "session.usage.updated", voice_epoch: "v", seconds: -1 }, 1)).toThrow();
    expect(ledger.snapshot()).toEqual(before);
    ledgerStep(before, { type: "session.usage.updated", voice_epoch: "v", seconds: 96 }, 2, caps);
    expect(ledger.snapshot()).toEqual(before);
  } finally { db.close(); }
});

test("an epoch spanning midnight cannot escape the new day's cap", () => {
  const db = openDB(); const ledger = new Ledger(db, { ...caps, daily_usd: 0.1 });
  const midnight = 86400000;
  try {
    ledger.handle({ type: "session.started", voice_epoch: "overnight" }, midnight - 2000);
    ledger.handle({ type: "session.closed", voice_epoch: "overnight", seconds: 96 }, midnight + 1);
    ledger.handle({ type: "session.started", voice_epoch: "next" }, midnight + 2);
    expect(ledger.handle({ type: "session.usage.updated", voice_epoch: "next", seconds: 30 }, midnight + 3))
      .toEqual([{ type: "close", voice_epoch: "next", reason: "daily" }]);
  } finally { db.close(); }
});
