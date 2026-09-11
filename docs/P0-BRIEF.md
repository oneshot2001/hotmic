# P0 — Contract probes + audio spike (build brief for Codex)

Read `docs/plan.md` first (sections: architecture, delegation state machine, audio, phase 0). This phase produces PROBES and a SPIKE, not the product. Keep every file small. No abstractions beyond what P0 needs. Bun + TypeScript strict. Runtime deps: none (Bun built-ins only; the MCP shim uses raw JSON-RPC over stdio — no SDK yet). Do not copy anything from any other project.

## Deliverables

### 1. `scripts/probe-cmux.ts`
Runs `cmux identify` and `cmux identify --no-caller` (with `CMUX_*` caller env vars stripped for the second), plus `cmux workspace status`, `cmux list-windows`. Prints the JSON fields verbatim and a one-line summary: which fields identify the *focused* surface/workspace vs the *caller*. Writes `.runs/p0/cmux-<ts>.json`. Print instructions: "run this from three different cmux panes and once from a plain Terminal".

### 2. `shim/channel.ts` (prototype) + `scripts/probe-channel.ts`
- `shim/channel.ts`: minimal MCP stdio server: `initialize` advertising `capabilities.experimental["claude/channel"] = {}` and `tools`, `tools/list` with `acknowledge` and `reply` (schemas per plan), `tools/call` that forwards to a unix socket given by env `HOTMIC_SOCK` as JSON lines, and reads JSON lines from that socket to emit `notifications/claude/channel` with `{content, meta:{request_id, revision, delivery_id, session_alias}}`. Stdout is JSON-RPC only; logs to stderr.
- `scripts/probe-channel.ts`: creates a temp run dir with `mcp.json` (server `hotmic` → `bun shim/channel.ts`) and `settings.json` with exec-form hooks (`command` + `args`, `{}` reply) for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop, SessionEnd → `shim/hook.ts` which POSTs metadata-only fields (session_id, hook_event_name, tool_name, turn/message ids; NEVER prompt, delta, last_assistant_message, transcript_path) to the unix socket. Starts a unix socket listener, then spawns `claude -p --output-format json --settings <file> --mcp-config <file> --dangerously-load-development-channels server:hotmic --allowedTools mcp__hotmic__acknowledge,mcp__hotmic__reply` in a throwaway dir with a prompt like "Wait for a channel message, then call acknowledge and reply with its text verbatim and status completed." Sends ONE synthetic channel notification containing a marker string, and asserts: (a) the reply tool call arrives on the socket with the marker, (b) hook events arrive with no text fields, (c) Claude's JSON result mentions the marker. Also verifies the user's existing `~/.claude/settings.json` hooks still fire (SessionStart from the user's own config runs) — check by inspecting the effective settings if `claude` exposes it, otherwise document the limitation. Writes `.runs/p0/channel-<ts>.jsonl` and prints PASS/FAIL per assertion. Pin: print `claude --version`.

### 3. `scripts/spike-audio.ts`
Paid. Guarded by `--max-seconds` (default 90) and `--max-usd` (default 0.15, computed at $0.05/min; abort before exceeding). Requires `OPENAI_API_KEY` in env (the runner will supply it; never read `.env` files, never log the key).
- `sox`: capture `rec -q -t raw -r 24000 -e signed -b 16 -c 1 -` in 20 ms frames (960 bytes) → `session.input_audio.append` base64. Playback: `play -q -t raw -r 24000 -e signed -b 16 -c 1 -` fed by `session.output_audio.delta`. Only send audio after `session.started`.
- WS `wss://api.openai.com/v1/live/sessions`, header `Authorization: Bearer`, first message `session.start` with `model: gpt-live-1`, `delegation: {type:"client"}`, `store:false`, audio format pcm 24k, short instructions: "You are a test harness voice. No filler phrases. When the user asks you to do something, delegate it. Keep replies under two sentences." Consult `docs/refs/voice-websockets.md` and `docs/refs/live-conversations.md` for exact field names; if a field is uncertain, log the server's error verbatim and exit.
- Log every event except audio deltas to `.runs/p0/audio-<ts>.jsonl` with `at` ms. For every `session.delegation.created` also log `offset_ms`, ms since the last `session.input_transcript.delta`, and ms since local silence began (compute local RMS per frame; silence = RMS below a threshold for ≥300 ms; log the threshold used).
- On `session.delegation.created`: after 900 ms, append `session.commentary.append` with "Got it: <assembled transcript since last delegation>" so the loop closes and the user hears what was captured.
- `--echo-test`: also report whether words from `session.output_transcript.delta` reappear in `session.input_transcript.delta` within 3 s (speaker feedback).
- On close (Ctrl-C, max-seconds, or `session.closed`): send `session.close`, wait ≤10 s for `session.closed`, print usage seconds, cost, delegation count, and a table of delegation timing rows.

### 4. `docs/P0-REPORT.md`
Template with sections for each probe: command, what to look for, result (leave blank for the paid/mic runs the human will perform), and the P0 exit questions from the plan: delegation-offset-vs-last-fragment distribution; channel works on this Claude version with existing hooks intact; cmux focused-surface field; echo verdict.

### 5. Tests
`tests/p0.test.ts`: pure-function tests for frame chunking (960-byte boundaries), RMS silence detection with a synthetic signal, cost math (96 s → $0.08), and the channel shim's JSON-RPC framing (initialize/tools list round-trip via an in-process pipe). `bun test` and `bunx tsc --noEmit` must pass.

## What you may run
- `bun test`, `bunx tsc --noEmit`.
- `scripts/probe-cmux.ts` (it is read-only; if the cmux socket is denied, say so and leave results blank).
- `scripts/probe-channel.ts` (spawns `claude -p` once; allowed).
- NOT `scripts/spike-audio.ts` (needs mic + key; the human runs it).

## Done means
All five deliverables exist, tests and typecheck pass, probe-channel PASS/FAIL printed and recorded in `docs/P0-REPORT.md`, a `## How to run the paid spike` section with exact commands. Commit in logical units with clear messages. Do not push.
