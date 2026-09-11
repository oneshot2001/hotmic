# P2 review findings (Claude reviewer, 2026-09-11) — FIX BEFORE COMMIT

Verified OK: egress is the only content path to the live socket; smoke asserts canary absence over outbound frames; release-hash, sibling-prefix and forged-alias guards are load-bearing; real socket/broker/status/doctor verified by Claude outside the sandbox.

## P1 — RULING: approval is TTY-only
`hotmic approve` over the control socket lets the Claude child (same UID, real Bash tool) approve its own `release` payload: read `~/.local/state/hotmic/control.token`, `hotmic status` for the hash, `hotmic approve`. That defeats the confinement layer. Fix:
- Remove `approve`/`reject` from the socket control command set and from the CLI. The ONLY approval path is the keystroke in the `hotmic serve` pane, read from the serve process's own TTY (`process.stdin` raw mode, isatty required; if serve has no TTY, release payloads can never be approved and status says so).
- Keep `hotmic status` but drop `pending[].hash` from its output (the hash lives only in the serve process).
- Test: a control-socket `approve` command is rejected as unknown; approval through the serve keystroke path works in-process with a fake TTY.
- Update `docs/P2-REPORT.md` and the plan's privacy section text to say "TTY keystroke only".

## P2
1. `scrub` boundary heuristic mangles ordinary text (`src/egress.ts:58-63`): `"All tests pass"` → `"All tests pas[redacted]"`. Require fragment length ≥ 8 for prefix/suffix matching, and document that a secret deliberately split across 3+ replies is out of scope. Fix the test at `tests/egress.test.ts:29` to assert the new behavior, plus a regression that `"All tests pass"` and `"c is done"` are unchanged.
2. Hook-source deny untested: add a `summary`-level test with `source: "hook"` that fails when `src/egress.ts:78` is removed.
3. One malformed tool call ends the channel (`src/sock.ts:65`): for authenticated `tool_call` rejections reply `{ok:false, call_id, error}` and keep the connection; still close on auth failure or malformed framing. Test both.
4. Key-shape regex over-redacts (`src/egress.ts:65`): add a left boundary `(?<![A-Za-z0-9])` to every shape; regression: `"task-based approach"` unchanged.
5. `shim/hook.ts:5` added `PostToolUseFailure`/`StopFailure`, which P0 never exercised. Keep them, but the settings generator must only emit events Claude 2.1.269 accepts; if unsure, drop the two and note it. Ledger must name this.
6. Ledger: `noticed_not_fixed` must list the self-approve path (now fixed), over-redaction (fixed), and the hook-event set.

## P3 (do if cheap)
- `src/broker.ts:72` and `:164` double calls; `src/cli.ts:88` sort mutates the snapshot; `#owners` check redundant or untested (test it).
- `doctor.claude` is `false` with "unverified": run `claude --version` (it is not a session, it is allowed) and compare to the pinned `2.1.269`.
- Report: say that policy `aliases`/`statusTemplates` are parsed but templates are hard-coded in P2.
