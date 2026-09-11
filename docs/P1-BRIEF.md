# P1 — Request correctness, offline (build brief for Codex)

Read `docs/plan.md` (state machine, privacy, router sections) and `docs/P0-REPORT.md` (measured facts). P1 is **offline only**: no network, no audio, no Claude. Pure state machines over SQLite plus a replay harness. Bun + TypeScript strict, Bun built-ins only (`bun:sqlite`, `bun:test`). Do not copy anything from any other project.

## Measured facts to design against (from P0)
- The model delegates 0.2 s BEFORE to 2.0 s AFTER the last input-transcript fragment ends (median ~0.8 s), 1.4–3.5 s after local silence begins. Mid-sentence pauses up to 4 s did not split a request. A fragment can span `offset_ms` (the word "about" case: offset 31600, fragment 31600–31800).
- Two requests spoken back to back with a 1.8 s pause became ONE delegation. That is correct behavior; do not try to split it.
- Transcript fragments carry `start_ms`/`end_ms` on the server timeline; `offset_ms` is on the same timeline. Client arrival is 0.8–2.3 s later.
- Channel: Claude called `acknowledge` 3.9 s and `reply` 7.6 s after delivery (interactive). Duplicate `reply` for the same delivery must be a no-op.

## Deliverables

### 1. `src/db.ts`
`bun:sqlite`, WAL, one writer. Tables (minimal columns; add only what P1 uses): `requests(id, session_alias, revision, state, text, created_at, updated_at)`, `deliveries(id, request_id, revision, delegation_id, state, created_at)`, `results(request_id, revision, status, text, source, created_at, UNIQUE(request_id, revision))`, `delegations(id, voice_epoch, offset_ms, state, request_id NULL, created_at)`, `usage(voice_epoch, seconds, usd, finalized)`. Migrations in code, idempotent. In-memory path for tests.

### 2. `src/transcripts.ts` (pure)
Utterance assembly. Input: input-transcript fragments `{start_ms,end_ms,delta}`, local silence signal `{at_ms, silent:boolean}` (from P0's RMS detector), and delegation events `{id, offset_ms}`. Output: for a delegation, the assembled utterance text and the fragment range it consumed, or `NOT_READY`. Rules (plan §state machine): boundary = 650 ms local silence then 250 ms with no new fragment; fragment spanning `offset_ms` stays whole; fragments already consumed by an earlier delegation are never re-used; fragments arriving after a delegation's boundary belong to the next one; a delegation with no text stays `WAITING_TRANSCRIPT` and is re-evaluated on every later fragment (2 s → `waiting` status, 8 s → `ask` status; NEVER discarded).

### 3. `src/requests.ts` (pure machine + SQLite persistence)
States exactly as in `docs/plan.md`: `WAITING_TRANSCRIPT → WAITING_ROUTE → READY → DISPATCHING → DELIVERED → ACKNOWLEDGED → (WAITING_USER) → RESULT_LOCAL → {EXPORT_BLOCKED | RESULT_AVAILABLE} → SPOKEN`, plus `SUPERSEDED`, `RECONCILE_REQUIRED`, `FAILED`, `CANCELLED`. Event-in / action-out: the machine returns actions (`deliver`, `append_status`, `append_result`, `ask`, `reconcile`) and never performs I/O. Routing is a stub in P1: a `route(text) → alias | AMBIGUOUS` callback; default returns a fixed alias.
- Corrections: leading "actually / instead / replace / cancel / stop / never mind" on the same active alias while a request is in `DISPATCHING..RESULT_LOCAL` → ONE transaction: bump revision, mark old `SUPERSEDED`, invalidate its results, emit `deliver` with `supersedes: <old delivery_id>`. "New task" prefix forces a fresh request. Other follow-ups to the same active alias → `ask` (held, not guessed).
- `reply(completed|failed|question)` terminal per `(request_id, revision)`; repeat = no-op; conflicting terminal replies → diagnostic, first wins. `Stop` hook without a reply within 3 s → `append_status` only ("<alias> finished, result is in the terminal"), never content.
- Every `append_result` action carries `request_id + revision`; a consumer must drop it if the request's current revision is newer. Implement that check in the machine so the action is never emitted stale.
- Timeouts as plan: 20 s no ack → status; 60 s → `reconcile`; 120 s no result → "still working" once. Timers are inputs (`tick(now_ms)`), not real timers.
- Crash safety: a delivery is written to SQLite in `DISPATCHING` before the `deliver` action is emitted; on restart, any `DISPATCHING` row → `RECONCILE_REQUIRED` (never auto-resend).

### 4. `src/ledger.ts`
Usage snapshots REPLACE (never sum); cost at $0.05/min per second; `finalized` only on `session.closed`; caps as inputs (per-activation usd, daily usd, idle ms) returning `close` actions. Fixture: 96 s → $0.08; 78 s → $0.065.

### 5. `scripts/replay.ts`
Feeds a fixture JSONL (`tests/fixtures/*.jsonl`, real P0 runs reduced to transcript/delegation/usage events, plus synthetic files you author) through transcripts + requests + ledger with a fake clock, optional `--delay-ms N` to delay transcript fragments after their delegation (0/250/650/2000/10000), `--dup` to duplicate delegation and reply events, `--reorder` to swap adjacent events, `--crash-at <state>` to simulate restart at a durable boundary. Prints a table: delegation → request → revision → final state, and asserts the P1 invariants below. Exit 1 on any violation.

### 6. Tests (`tests/transcripts.test.ts`, `tests/requests.test.ts`, `tests/ledger.test.ts`, `tests/recovery.test.ts`)
Invariants, each with a failing-then-passing case:
- Zero lost delegations under every `--delay-ms` value, including 10000.
- The "about" case: fragment spanning `offset_ms` is included whole.
- Correction before dispatch, during execution, before export: old revision `SUPERSEDED`, its result never emitted as `append_result`.
- Duplicate `reply` is a no-op; duplicate delegation id is a no-op.
- Crash at `DISPATCHING` → `RECONCILE_REQUIRED`, no `deliver` re-emitted on restart.
- Stop-without-reply → status only, no content.
- Ledger: snapshots replace; 96 s = $0.08; finalized only on close.
Run both real fixtures through replay with default settings: expect 4 and 5 requests, all `READY` at minimum, texts matching the P0 report exactly.

### 7. Carry-overs from the P0 review (small, do them)
- `scripts/spike-audio.ts`: SIGINT race (defer the child-exit check one tick during shutdown); set `finalized` before validating `usage.seconds`; refuse to start if `.env` exists next to the repo root and `--no-env-file` is not in `process.execArgv`; handle the 48 kHz device case explicitly (pass `rate` through sox with an explicit `-r 24000` on the OUTPUT side and log the device rate).
- `shim/channel.ts`: pin `protocolVersion` to the value Claude sent in P0 (read it from `.runs/p0/channel-1789160429562.jsonl` if present; otherwise "2025-06-18") and reject others with -32602.
- `prompts/live.txt`: draft the live prompt with an ALLOWED-phrase list (P0 showed prohibitions don't work): exactly these acknowledgements are permitted: "Sent to {alias}." / "{alias} is still working." / "{alias} needs approval in its terminal." / "{alias} has a result ready in the terminal." / "Which session?" Everything else is either a spoken result or silence.

## What you may run
`bun test`, `bunx tsc --noEmit`, `bun scripts/replay.ts …`. Nothing paid, nothing that spawns `claude`.

## Done means
All tests green, typecheck clean, `bun scripts/replay.ts tests/fixtures/p0-speaker-5-requests.jsonl --delay-ms 10000 --dup --reorder` exits 0 and prints 5 requests with exact texts. Write `docs/P1-REPORT.md`: what each invariant test proves, the replay table for both fixtures, and an honesty ledger (`changed / related_untouched / noticed_not_fixed / residual_uncertainty / verification_gap`). Do not commit (sandbox can't); list the logical commit groups at the end of the report.
