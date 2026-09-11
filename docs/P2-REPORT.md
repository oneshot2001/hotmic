# P2 report — single-session vertical slice

Date: 2026-09-11. P2 implementation and offline verification are complete. Live end-to-end acceptance remains unrun. No paid service, `hotmic wake`, microphone/speaker session, interactive Claude session, sub-agent, or commit was run by this implementation/fix pass. The only real Claude invocation in the fix pass was the permitted `claude --version` (directly and through doctor). No runtime dependency was added.

## Verification

| Check | Result |
| --- | --- |
| `bun test` | PASS — 153 tests, 1,504 assertions, 0 failures, 12 files. Includes the existing 106 P1 tests. |
| `bunx tsc --noEmit` | PASS — strict typecheck, exit 0. |
| `./bin/hotmic doctor` | Ran successfully. Bun, sox/play, installed Claude version 2.1.269, and key presence passed. Policy validity passed; socket reachability was false in this fix pass. Only key presence was printed, never the key. Doctor now invokes only `claude --version` and compares its output to the exact pin. |
| `git diff --check` | PASS. |
| Bun build of CLI, channel, hook and smoke entry points | PASS — temporary output only; no built entry point executed. |
| Targeted mutation checks | PASS — 18/18 deliberate regressions triggered test assertion failures; all production files restored afterward. |
| Real Unix socket listener | BLOCKED — sandbox `EPERM`. Production connection handling was subsequently tested using in-memory byte transports; no socket tests are silently skipped. Actual bind/chmod behavior was not rerun here. The supplied `docs/P2-REVIEW.md` separately records Claude's successful real socket/broker/status/doctor checks outside the sandbox; those are reviewer-reported evidence, not this pass's observations. |
| Paid smoke | NOT RUN, as instructed. |

The launcher test exposed that Bun 1.3.5 does not implement `process.execve`, despite its presence in the installed TypeScript definitions. The launcher now uses Bun's built-in FFI to invoke POSIX `execve` when necessary. A test actually replaces a harmless Bun child with another Bun invocation, verifies its stdout and exit status, and never starts Claude. Initial socket-listener tests failed with EPERM; the shared production parser/authentication handler is now exercised directly instead. No P1 expectations were changed.

## Module map

| Module | Responsibility |
| --- | --- |
| `src/egress.ts` | Pure policy decision plus constructor-injected private sender. Checks alias, current revision, realpath containment, deny roots, source, templates, release hash, and summary scrubbing. Rechecks before every chunk. |
| `src/credentials.ts` | Reads credential names, fetches values into memory, obtains the OpenAI key from env or `cred get`, suppresses credential subprocess output. Failed credential inventory disables summary exports. |
| `src/live.ts` | Private WebSocket, P0 session-start contract, client delegation, `store:false`, prompt loading, audio connection, append acknowledgement correlation, usage events and ten-second close grace. Only its Egress instance receives the private content sender. Audio input uses its separate PCM transport path. |
| `src/audio.ts` | Sox native CoreAudio capture followed by explicit 24 kHz mono PCM16 resampling; 20 ms framing; local RMS silence; playback queue capped at 200 ms; speech onset kills playback and clears its queue. |
| `src/broker.ts` | Owns P1 RequestMachine/Ledger, transcript reducer and Live port; one-entry session registry; delivery ownership; hook lifecycle; local results, TTY-gated release approval/rejection and export; 250 ms ticks. Adds the sessions table without changing the P1 tables. |
| `src/sock.ts` | Private Unix listener, JSON-line channel/control commands and authenticated HTTP hook POSTs on the same socket. Shared handler validates real byte streams in offline tests. Authenticated tool errors retain call IDs and keep the channel open; authentication/framing errors close it. No control approval/rejection command exists. |
| `src/cli.ts`, `src/exec.ts`, `bin/hotmic` | Serve, interactive Claude launcher, wake/sleep, status, usage and doctor; no CLI approve/reject commands. Generates additive exec-hook settings and MCP config, registers before process replacement, strips the OpenAI key from the child environment. |
| `src/terminal.ts` | Serve-pane raw stdin handling: TTY keystroke only, approval bound to the displayed candidate, no-TTY status, and raw-mode cleanup. Rendering copies the request array before sorting. |
| `shim/channel.ts` | Authenticated connect, MCP notification forwarding and broker-confirmed tool forwarding by call ID. P0 no-token probe compatibility remains; the production broker rejects unauthenticated channel commands. |
| `shim/hook.ts` | Metadata filter, socket path/alias/token arguments, parses all ten planned lifecycle events, unconditional exit 0 and `{}` on broker failure. |
| `config/policy.example.json` | Explicit single sandbox at release level. Does not install or modify the user's policy. |
| `scripts/smoke.ts` | Human-run gated smoke procedure, temporary outside-root canary, broker cap/policy preflight, event-log/SQLite acceptance checks and cleanup. |

The state directory is created/chmodded 0700; socket and database are set to 0600; configs, control capability and event journal are private. An exclusive broker lock prevents a second writer. A stale lock requires manual recovery; automatic crash/reconnect management remains P4 work.

The launcher uses the P0 interactive flags and leaves real Claude tools enabled. It rejects print mode and overrides of the channel/settings flags. Doctor executes `claude --version` with ignored stdin and checks the exact `2.1.269` pin; it does not start an interactive session. Generated settings are separate from the user's existing settings. The generator emits only the eight P0 events; `PostToolUseFailure` and `StopFailure` remain accepted by the metadata parser but are omitted from settings because their compatibility was not established.

Policy `aliases` and `statusTemplates` are parsed from JSON, but P2 does not use them for alias routing or template customization. Status output uses five hard-coded templates.

## Egress test matrix

All rows passed. Assertions inspect the injected sender or production socket-handler output, not just an `allowed` flag.

| Case | Verified outcome |
| --- | --- |
| Known credential split at every UTF-8 byte boundary | Reassembled credential is removed before chunking, including a split inside a multibyte character. |
| Known credential split across two terminal replies | Every proper split of the test credential redacts fragments of at least eight characters; shorter fragments remain unchanged. A complete known value is still removed at any length. |
| Ordinary text and key boundaries | `All tests pass`, `c is done`, and `task-based approach` stay unchanged; every key shape requires a non-alphanumeric left boundary. |
| Hook source at summary level | Hook content sends zero bytes even when the identical reply text would be allowed. |
| Malformed authenticated tool call | Error preserves `call_id`; a valid retry succeeds on the same channel. Bad authentication, malformed JSON/UTF-8 and oversized framing close it. |
| Control approval and public status | Even the control capability gets unknown-command errors for approve/reject; status and the event journal disclose no approval hashes. |
| Serve TTY | Fake raw TTY approves the displayed exact payload; unseen/superseded revisions and piped input cannot approve. No-TTY status explicitly reports release unavailable. |
| Rotated session capability | A valid replacement token cannot claim the previous channel's delivery; it can answer its own new delivery. |
| Reply JSON delivered one byte at a time | Zero export before the complete JSON line; complete result is scrubbed before sending. |
| Outside-root canary via reply and hook at off/status/unapproved release | Zero canary-bearing exports. Hook payload fields are discarded again by the broker. |
| Hook POST split at every byte boundary | Valid metadata accepted only after complete framing; unknown content never reaches the journal or Live sender. |
| Symlink into denied root | Refused after realpath resolution. |
| Sibling-prefix path (`aar2` versus `aar`) | Refused by component-wise containment. |
| Denied session root | Refused even when the alias exists in policy. Unresolvable deny roots also fail closed. |
| Forged alias, cross-session reply, wrong token/request/revision | Rejected before result storage/export. Delivery ownership is bound to the registered capability. |
| Malformed UTF-8 / surrogate alias / oversized JSON line | No protected content exported; invalid socket bytes close the transport. |
| Off or unknown session; missing/malformed policy | No session content exported. Off routing emits the local ask “That session is not available by voice.” |
| Status level | Only the five fixed prompt templates can leave. Arbitrary thinking/instruction/reply text is denied. |
| Release approval | Exact SHA-256, request ID and revision required; changed text, revoked approval and superseded revisions cannot reuse approval. |
| Revocation between chunks | No subsequent chunk sent after revocation. An already authorized first chunk cannot be recalled. |
| Key shapes, configured redact values, denied paths | Removed before the complete result is capped and chunked. |
| Credential inventory failure | Summary content export denied. |
| Sleep / next explicit wake | Result remains local while asleep and is reauthorized on wake. Old-epoch delegation IDs are not reused. |
| Stop without reply | One fixed status after three seconds; no assistant-text fallback or fabricated result. |
| Live append acknowledgements | Wrong event ID or append kind cannot resolve pending work; server error rejects it without journaling server error text. |

Release approval is **TTY keystroke only** in the `hotmic serve` pane, using its own raw-mode stdin. Without a TTY, release payloads cannot be approved and status says so. The hash stays in serve-process memory, omitted from status, pane output and the approval journal. Release approval hashes the exact alias-prefixed candidate after its approximately 500-token cap (2,000 code points). The displayed candidate and concatenated outgoing chunks match. Summary scrubs the complete reply before the same cap, then chunks into at most 1,000 code points each. Known-secret prefix/suffix matching requires at least eight characters. Shorter boundary fragments remain visible; a secret deliberately split across three or more replies is out of scope, as are arbitrary encodings and secret paraphrases. Summary remains an opt-in convenience layer.

The broker marks authorized results `RESULT_AVAILABLE` before transport, so a crash or lost acknowledgement cannot automatically resend an uncertain export. A successful append acknowledgement leaves that state unchanged: it proves estimated context injection, not audible speech. Cancellation/revocation after an export closes the voice epoch without a paid automatic reopen. P1's conservative rules still require clarification for automatic corrections of already exported results.

## Human-run paid smoke

Not executed. Run `bun scripts/smoke.ts --paid --max-usd 0.20` only when paid testing is authorized. The sandbox policy must already point to `~/Projects/voice-sandbox` at release level.

The script creates `~/hotmic-canary.txt` exclusively and removes it in `finally`. It prints the exact pane commands: capped `hotmic serve`, interactive `hotmic claude -n sandbox` from the sandbox, then `hotmic wake`. Before wake, preflight checks the registered connection, release policy and activation cap. It prints the five P0 tasks plus the outside-root canary request. Subsequent independent requests use “New task” to respect the existing P1 follow-up rules. The disposable smoke sandbox must be suitable for the fifth task, which asks Claude to commit there.

After the operator approves a non-canary reply with `[a]` in the serve TTY, performs a deliberate Stop-without-reply case and sleeps voice, the script checks the current run's journal and local results for:

- At least five non-canary deliveries with acknowledgements and replies.
- Canary present in a local result and a release-denied egress decision, absent from concatenated outbound content.
- Matching approval and confirmed append for a non-canary result.
- Stop status without a corresponding reply.
- Final server usage and cost at or below the requested cap.

Audibility requires an explicit operator “yes” plus output-transcript activity after approval; this is not an automatic acoustic measurement. Appended text may be paraphrased by Live. Actual device behavior, spontaneous voice output, interactive hook compatibility and final charges are what this run must establish. Cleanup is best-effort under normal exit/errors; SIGKILL cannot run `finally`.

## Review fixes

Applied every P1/P2 finding and all listed cheap P3 items from `docs/P2-REVIEW.md`.

- P1: removed approve/reject from the CLI and control protocol. Approval is TTY keystroke only, bound to the payload actually displayed in the serve pane. No-TTY approval fails closed. Public status omits hashes, and approval hashes are no longer printed or journaled.
- P2: boundary-fragment scrubbing now requires eight characters; key shapes require a left boundary. Added the summary-level hook denial regression. Authenticated tool-call errors preserve `call_id` and allow retries; authentication and framing failures still close the channel. Settings omit the two unverified failure events while retaining metadata parsing for both.
- P3: eliminated the duplicate delivery-policy and export-context reads, copied status requests before sorting, and proved delivery ownership survives token replacement. Doctor runs only `claude --version`; observed output was `2.1.269 (Claude Code)`, matching the pin. Documented the hard-coded status templates and unused alias customization.

The baseline was 137 passing tests. Added 16 tests without changing any P1 expectations. The two-reply scrub test now asserts the requested exact eight-character threshold at every split, and the settings test asserts the explicit eight-event generator set while retaining both failure-event parser checks. Existing release tests now exercise the real serve keystroke handler with a fake TTY. New behavior tests first reproduced the original failures. Targeted mutation checks then removed/reverted 18 guards and fixes (including the previously untested hook-source and ownership checks); every mutation caused an assertion failure. These temporary changes were restored before the final test/typecheck/build runs.

## Honesty ledger

- **changed:** nine new production modules, CLI entry point, example policy, smoke script, channel/hook promotion, six P2 test files plus helpers, the plan's privacy/command text, and this report. Review changes cover TTY-only approval, status/journal hash removal, scrubbing, recoverable tool errors, hook-settings compatibility, doctor and the cheap cleanup items. No P1 machine, fixture, prompt, dependency, lockfile or user configuration changes.
- **related_untouched:** existing P1 database/request/transcript/ledger code and replay fixtures, P0 probes and private logs, README/NOTICE, cmux integration. P3 multi-session/focus/pinned routing and P4 installation/reconnect remain deferred.
- **noticed_not_fixed:** review history retained explicitly: the same-UID control-token self-approve path is **now fixed** by removing its commands; short-fragment/key-shape over-redaction is **now fixed**. The hook-event set remains partly unverified: the parser retains all ten planned events, but generated settings omit `PostToolUseFailure`/`StopFailure` and emit the eight P0 events. P0's existing-user-hook count assertion and interactive hook re-verification remain outstanding. Stale broker locks and lost channel connections require operator recovery. Session capability ownership is in memory; reconnecting after a broker restart does not automatically restore old delivery ownership or rerun work. Full transcript crash recovery is not implemented. The plain pane prints local asks; no new spoken clarification grammar was added beyond P1. Policy aliases/statusTemplates are parsed but unused for customization in P2.
- **residual_uncertainty:** inherited MCP version allowlist is still not an observed interactive protocol pin. Sox playback gating, queue drops under bursty audio, resampling and latency are unmeasured on this production path. Approximate token caps are not a tokenizer guarantee. TTY keystroke only removes control-token approval authority; it is not an OS sandbox against arbitrary same-user process/TTY manipulation. Protected data approved deliberately can leave. Summary is opt-in convenience: boundary fragments shorter than eight characters and deliberate splitting across three or more replies are outside its guarantee. Conservative wall-clock estimates are retained for unconfirmed closes; final charges require server confirmation.
- **verification_gap:** this fix pass did not run a real Unix listener, launcher-to-broker-to-Claude session, private-socket mode observation or real HTTP hook round trip. The supplied review records successful outside-sandbox socket/broker/status/doctor verification by Claude, but the amended code has only the offline transport/TTY checks here. No paid WebSocket, microphone, speaker, interactive Claude review, smoke run or acoustic proof was performed. Live tests use injected WebSocket/audio transports. Real POSIX process replacement was tested with Bun, not Claude. Entry points were bundled to temporary files; no distribution was installed. No paid API request was made.

## Logical commit groups (not committed)

1. Policy, scrub/release egress and credential inventory with privacy tests.
2. Live transport/audio, broker wiring and usage lifecycle with fake-transport tests.
3. Authenticated socket and channel/hook promotion with byte-framing tests.
4. CLI, POSIX process replacement, policy example and launcher tests.
5. Human-run smoke procedure and P2 report.

Live wire semantics were checked against the repository's P0 references and the official [session guide](https://developers.openai.com/api/docs/guides/live-conversations) and [delegation guide](https://developers.openai.com/api/docs/guides/live-delegation). Those references describe acknowledgements as context-injection estimates rather than proof of speech; the implementation and report preserve that distinction.

## Paid smoke #2 — RESULT (2026-09-11 17:07, human-run, graded with `--grade`)

7 of 8 checks PASS; the eighth (`stop_status_only`) was deliberately skipped (offline coverage exists). Cost **$0.19** (within the $0.20 cap), finalized.

| Check | Result |
|---|---|
| five_replied (5 non-canary requests delivered → acknowledged → replied) | PASS (4 completed + 1 `question`: "There is no test in this repo… want me to write one?") |
| canary_held (Claude read `~/hotmic-canary.txt` outside the sandbox root, replied with its contents, egress denied: "release required") | PASS |
| zero_canary_outbound | PASS |
| approved_append (one non-canary reply approved by TTY keystroke, appended, confirmed) | PASS |
| spoken (operator heard it) | PASS |
| finalized / within_cap | PASS / PASS |

**Every frame that left the machine during the run (9 total):** "Sent to sandbox." ×6, "Which session?" ×1, "sandbox has a result ready in the terminal." ×1, and the one approved reply ("sandbox: Added subtract(a, b) to calc.py…"). Nothing else. The canary text, README summary, rename, commit hash, and Claude's question all stayed local.

Observed behaviors worth keeping: the operator's mid-sentence self-correction ("Read me the add function to plus. Sorry, rename the add function…") was delivered whole and Claude did the right thing; a re-spoken duplicate of request 1 without "New task" was held and produced exactly one "Which session?"-class ask (the P1 hold rule working as designed, though the phrasing should say "correction or new task?" aloud — P3 item).

Script fixes after the run: `--grade` mode (grade the last registered epoch without prompts), prompt wording moved to after the run, `five_completed` → `five_replied` (a `question` reply is terminal), canary detection by prefix in grade mode.

**P2 exit: PASS.** The privacy boundary held under a real read outside the root. Approval is TTY-only.
