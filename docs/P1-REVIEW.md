# P1 review findings (Claude reviewer, 2026-09-11) — FIX BEFORE COMMIT

Verified OK: single-transaction correction; deliver-after-commit; DISPATCHING→RECONCILE_REQUIRED with no resend; reply dedupe/first-wins; Stop-without-reply status-only; ledger replace-not-sum + finalize-on-close; live prompt phrase list; no similarity to the reference repo.

## Must fix (P1)
1. **Correction targets the wrong request** — `src/requests.ts:98-101`. `active` is picked by `updated_at` desc and includes `READY` (never dispatched). Probe: d1 "Run tests" DISPATCHING → d2 "New task: write docs" READY → d3 "Actually run only unit tests" superseded d2; d1 kept running; no `deliver`. Fix: the correction target is the request for that alias in `DISPATCHING..RESULT_LOCAL`; fall back to READY only if nothing is in flight. Restore `tests/requests.test.ts:84` to expect `request:d1` rev 2 (the test was changed to bless the bug; the report's "most recently active" rationale was wrong).

## Should fix (P2)
2. **Stragglers injected into unrelated later requests** — `src/transcripts.ts:61-63`. A fragment arriving after its delegation's boundary is never consumed and gets glued into the next request minutes later ("wordcommit everything"). Fix: a fragment whose `end_ms` is more than one settle window (900 ms) before the next delegation's `offset_ms` is quarantined (recorded, not assembled) and surfaced as a diagnostic.
3. **Real-fixture exact-text pass leans on fabricated `silent:false` markers**. Fix: when no speech-resume marker exists, bound inclusion by `start_ms <= offset_ms + settle`; regenerate `tests/fixtures/p0-*.jsonl` WITHOUT synthetic resume markers (keep only what the logs contain: transcript ranges, delegation offsets, usage, and the recovered final-silence start) and make the 4/5 exact-text tests pass on that.
4. **"Replace …" / "Stop …" as sentence starts supersede a running task and auto-send** — `src/requests.ts:43,96`. Fix: correction words must be followed by a pronoun/"that"/"it"/"the last one" (e.g. "replace that", "stop it", "actually, …" with comma or pause); otherwise if the alias has a request `DELIVERED+`, emit `ask`, never `deliver`.
5. **protocolVersion pin is unobserved** — `shim/channel.ts:5`. No P0 log has `initialize`. Fix: accept an allowlist `["2025-06-18","2025-11-25"]` for now and have `scripts/probe-channel.ts` record the client's `protocolVersion` into the artifact so P2 can pin one observed value.
6. Report omission: the honesty ledger must list #1–#3 (a test expectation was changed to make #1 pass). Rewrite `residual_uncertainty` accordingly.
7. `scripts/replay.ts:65` staleness audit is tautological. Make it real: after every `append_result` action, assert the referenced revision equals the request's current revision in SQLite AND that no `append_result` was ever emitted for a revision that is `SUPERSEDED` at the time of emission (track emitted set).
8. `activeStates` (`src/requests.ts:42`) includes `RESULT_AVAILABLE` and `RECONCILE_REQUIRED` for corrections. Narrow to `DISPATCHING..RESULT_LOCAL`; a correction against `RECONCILE_REQUIRED` → `ask`.

## Leave for later (P3)
- `spike-audio.ts` hard-codes `-t coreaudio default` (honor `AUDIODEV`) — unverified on hardware.
- `RequestMachine.handle` rewrites four tables per event; fine for P1 scale.
