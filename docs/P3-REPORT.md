# P3 report — registry, net control, and speech queue

Date: 2026-09-11. P3 implementation and offline verification are complete. Paid smoke #3 is prepared for a human and **has not been run**. No paid API call, `hotmic wake` command, real Claude process/session, sub-agent, or commit was run. Existing doctor tests execute temporary version stubs, not the installed Claude binary. No dependency or user configuration was changed.

## Verification

| Check | Observed result |
| --- | --- |
| `bun test` | **PASS: 202 tests, 1,805 assertions, 0 failures, 18 files.** Includes P1/P2 regressions. |
| `bunx tsc --noEmit` | **PASS**, strict typecheck, exit 0. |
| Entry-point bundles | **PASS**: CLI, channel, hook, smoke, and mutation runner compiled with `Bun.build` (target `bun`). Five outputs under `/tmp/hotmic-p3-review-build`; none executed. |
| Mutation checks | **PASS: 77/77 targeted mutations caused assertion failures**, including the original 64 guards and 13 review cases. Reproduce with `bun scripts/mutate.ts`; full baseline and per-case output: `docs/P3-MUTATIONS.log`. Only a disposable copy is mutated; each source is restored in `finally`. |
| `git diff --check` | **PASS**. |
| Paid smoke / real cmux / actual Unix listener / audio | **NOT RUN** in this phase. Transport integration uses the production socket handler with in-memory byte streams. |

## Module map

| Module | Responsibility |
| --- | --- |
| `src/registry.ts` | Idempotent migration of P2's sessions table; eight-session limit; token hashes, connected-token exclusivity, and disconnected capability rotation; opaque cmux refs; persisted heartbeat/connected state; disconnected startup. |
| `src/netcontrol.ts` | Pure net control resolution: exact leading aliases and policy pronunciations, pin commands/expiry, captured focus, live-session asks, and correction/new-task response classification. |
| `src/cmux.ts` | Read-only `identify` caller lookup for launch; `identify --no-caller` with every `CMUX_*` variable stripped for focus. Missing command, failed lookup, malformed refs, or browser focus fail closed. |
| `src/broker.ts` | Registry ownership, two-second focus polling, focus/pin capture at first fragment, clarification resolution, dispatch readiness, retained work on disconnect, public session status, and one shared speech queue. |
| `src/requests.ts` | Structured route result strips the leading address; dispatch availability gate retains queued corrections; queued corrections keep their superseded delivery ID. Destination-only resolution preserves the existing follow-up hold rule. Explicit intent confirmation can supersede a previously exported revision. |
| `src/speech.ts` | Stable priority queue: questions/permissions, results, then statuses. An entire egress operation owns its turn, including all chunks. Per-alias progress coalesces for 60 seconds. |
| `src/egress.ts`, `src/live.ts` | Fixed, typed net control notices pass through egress. No arbitrary notice text is authorized. Result revisions/policy/approval are rechecked at queue execution and before each chunk. Local outbound audit adds source and alias for grading; provider frame schema is unchanged. |
| `src/sock.ts`, `shim/channel.ts` | Authenticated heartbeat lines every two seconds; connection-generation checks prevent an old transport from reviving or disconnecting its replacement. Existing tool and delivery ownership checks remain. |
| `src/cli.ts`, `src/terminal.ts` | Launcher registers caller refs. Serve's existing text display lists every alias, state, connection, focused `*`, and pending approval count. Status JSON includes `pinned`, `focused`, and per-session connection/state/focus/pending fields. |
| `scripts/mutate.ts` | Reproducible offline mutation checks in a disposable copy, baseline verification, assertion-only kills, and repository log. |
| `scripts/smoke.ts`, `scripts/smoke-multi.ts` | Human-only multi scenario, disposable repositories and temporary release policy, preflight, ten-step destination table, and read-only grading. Existing single-session scenario is retained. |
| `prompts/live.txt`, `docs/plan.md` | Explicit pin confirmation and correction question; enumerated fixed availability notices and expanded live-session ask. Plan uses net control and opaque refs. |

The five P2 status templates remain hard-coded; policy `statusTemplates` is not used for customization. Policy `aliases` now drives pronunciation matching. The prompt makes four additions/changes: the `Talking to {alias}.` acknowledgement; the `Is that a correction or a new task for {alias}?` acknowledgement/question; the rewritten `Which session? Live: {aliases}` ask; and the two availability notices (`{alias} is not responding` and `That session is not available by voice.`). All are retained; the availability notices are required by the heartbeat/off rules. The brief's “ONLY two” instruction is corrected by its errata line.

## Net control precedence and tests

| Rule | Behavior | Test names |
| --- | --- | --- |
| 1. Leading alias | Case-insensitive, normalized whitespace, exact tokens; policy pronunciations accepted. Only the leading address is stripped. | `explicit leading alias overrides pin and focus, exact variants strip only the leading name`; `no fuzzy, prefix, interior or unseparated non-verb name matching` |
| Alias boundaries | Interior names never redirect. Longest exact pronunciation wins; a collision asks even with a pin. | `leading-name checks reject interior comma addresses and attached verbs, longest exact name wins`; `three authenticated shims receive only their destinations, strip aliases, reject cross-session replies` |
| 2. Pinned destination | Talk/switch commands confirm without dispatching a task. Pin precedes focus; each request refreshes inactivity; expiry is five minutes. | `pin commands confirm, pinned destination precedes focus and expires at five minutes`; `pin confirmation is not a task, pins refresh on requests and expire without requests` |
| 3. Captured focus | First fragment's local arrival captures focus and pin. A pane switch or pin expiry during settling cannot redirect it. | `focus captured at first fragment, not delegation; ask resolves by resampled that one or explicit alias`; pin boundary test above |
| Focus matching | Surface is authoritative when present. Workspace fallback applies only without a surface and only for a unique session. A serve/browser sibling never inherits another pane's destination. | `focus matches surface before workspace; unregistered and ambiguous workspace never inherit a sibling`; `cmux caller and focused refs stay opaque, caller environment is stripped only for focus` |
| 4. Ask | Lists connected non-off aliases, or `none`. Task stays WAITING_ROUTE. Only a bare alias or “that one”/“the focused one” resolves the retained task using the new utterance's focus; “cancel” cancels it. A full addressed request routes independently and the old ask is repeated once after dispatch. | `focus captured at first fragment, not delegation; ask resolves by resampled that one or explicit alias`; `resolving an unknown destination can ask the separate correction question without dropping the task` |
| Off sessions | Explicit/pin targeting speaks the fixed refusal; focused off sessions fall through to ask. | `off destinations refuse explicit and pin targeting, focus falls through to live ask`; `queued correction retains supersedes reference and off/unregistered destinations never dispatch` |
| Follow-up intent | Exact question says “Is **that** a correction or a new task for {alias}?” All six specified response forms resolve once. Correction bumps revision; fresh task preserves the earlier request. | `held follow-up asks correction versus new task and next utterance resolves once`; `clarification grammar accepts only the specified leading phrases` |
| Exported correction | Automatic corrections still ask. Explicit confirmation permits the new revision and retires the old exported voice epoch without reopening. | `explicit correction confirmation can supersede an exported result and retires its voice epoch`; inherited P1 correction-at-exported/uncertain-state tests |

Comma/pause targeting accepts arbitrary task text. Delimiter-free targeting uses the explicit command-verb list in `netcontrol.ts`; it is not an NLP/fuzzy matcher. Bare names, including terminal punctuation, can resolve a pending destination. Control/clarification utterances retain cancelled provisional delegation records rather than creating extra Claude deliveries.

## Retention, speech, and authentication

- At six seconds since the last heartbeat, a session becomes disconnected and emits one fixed “{alias} is not responding” notice per connection loss while voice is awake. Repeated ticks do not repeat it. Socket close also marks it unavailable immediately.
- Queued work stays READY; in-flight deliveries are retained. Reconnect with the same capability restores connected state; `channel_ready` dispatches only queued work. A resumed heartbeat on an initialized transport also resumes its queue. In-flight work is never automatically resent.
- A different token is rejected while the alias is connected. After disconnect or broker restart, a new capability replaces the token hash, cwd, and refs without retaining the old transport or readiness. Identity/cwd/refs cannot change under the same capability. A stale transport cannot disconnect the replacement, and a replacement capability cannot claim old deliveries. The launcher records null refs outside cmux.
- Integration uses three active fake shims plus an off session. Cross-session ownership is tested both with different capabilities and deliberately matching capabilities. Replacing the in-memory identity cannot transfer old delivery ownership.
- Questions and permission notices precede simultaneous completed/failed results; statuses come last. Higher-priority arrivals wait for the current complete payload's chunks. The queue does not claim to control the model's acoustic rendering.
- Results arriving while voice is closed remain local and are reauthorized at the next explicit wake, as in P2. Release approval remains exact-text, serve-TTY-only. Status JSON does not expose approval hashes or session capabilities.

## Mutation results

Each row below is an actual failing test run with the named protection removed or weakened. “KILLED” means an assertion failed, not merely a typecheck or syntax error. Initial survivors exposed test masking or redundant checks; targeted tests were added and the final mutations rerun. For token-boundary and connection-transition protections, redundant checks implementing the same guard were removed together. The final results are all KILLED.

| # | Protection mutated | Test file | Result |
| --- | --- | --- | --- |
| 1 | registry token identity | `tests/registry.test.ts` | KILLED |
| 2 | registry limit eight | `tests/registry.test.ts` | KILLED |
| 3 | registry immutable cwd/refs | `tests/registry.test.ts` | KILLED |
| 4 | registry input validation | `tests/registry.test.ts` | KILLED |
| 5 | registry heartbeat six-second boundary | `tests/registry.test.ts` | KILLED |
| 6 | registry announce only on connected transition | `tests/registry.test.ts` | KILLED |
| 7 | registry heartbeat restores connected | `tests/registry.test.ts` | KILLED |
| 8 | registry restart resets connection | `tests/registry.test.ts` | KILLED |
| 9 | registry migration idempotence | `tests/registry.test.ts` | KILLED |
| 10 | shim heartbeat interval | `tests/registry.test.ts` | KILLED |
| 11 | leading only | `tests/netcontrol.test.ts` | KILLED |
| 12 | exact token boundary | `tests/netcontrol.test.ts` | KILLED |
| 13 | verb or punctuation boundary | `tests/netcontrol.test.ts` | KILLED |
| 14 | strip leading alias | `tests/netcontrol.test.ts` | KILLED |
| 15 | explicit precedes pin | `tests/netcontrol.test.ts` | KILLED |
| 16 | off explicit forbidden | `tests/netcontrol.test.ts` | KILLED |
| 17 | off pin forbidden | `tests/netcontrol.test.ts` | KILLED |
| 18 | pin expires after five minutes | `tests/netcontrol.test.ts` | KILLED |
| 19 | pin precedes focus | `tests/netcontrol.test.ts` | KILLED |
| 20 | pin policy still routable | `tests/netcontrol.test.ts` | KILLED |
| 21 | focus unknown surface never inherits workspace | `tests/netcontrol.test.ts` | KILLED |
| 22 | focus must be unique | `tests/netcontrol.test.ts` | KILLED |
| 23 | focus off excluded | `tests/netcontrol.test.ts` | KILLED |
| 24 | live list excludes unavailable | `tests/netcontrol.test.ts` | KILLED |
| 25 | ambiguous pronunciation collision | `tests/netcontrol.test.ts` | KILLED |
| 26 | cmux uses caller fields at launch | `tests/netcontrol.test.ts` | KILLED |
| 27 | cmux caller vars stripped for focus | `tests/netcontrol.test.ts` | KILLED |
| 28 | cmux invalid refs fail closed | `tests/netcontrol.test.ts` | KILLED |
| 29 | cmux browser never routes | `tests/netcontrol.test.ts` | KILLED |
| 30 | capture focus at first fragment | `tests/p3-broker.test.ts` | KILLED |
| 31 | capture pin at first fragment | `tests/p3-broker.test.ts` | KILLED |
| 32 | clarification dispatch retained task | `tests/p3-broker.test.ts` | KILLED |
| 33 | that-one uses new focused pane | `tests/p3-broker.test.ts` | KILLED |
| 34 | no disconnected dispatch, including correction | `tests/p3-broker.test.ts` | KILLED |
| 35 | queued correction retains supersedes | `tests/p3-broker.test.ts` | KILLED |
| 36 | delivery ownership cross-session | `tests/p3-broker.test.ts` | KILLED |
| 37 | delivery capability ownership | `tests/p3-broker.test.ts` | KILLED |
| 38 | old transport cannot heartbeat after replacement | `tests/p3-broker.test.ts` | KILLED |
| 39 | stale disconnect cannot close replacement | `tests/p3-broker.test.ts` | KILLED |
| 40 | speech priorities | `tests/speech.test.ts` | KILLED |
| 41 | speech payload atomicity | `tests/speech.test.ts` | KILLED |
| 42 | progress sixty-second coalescing | `tests/speech.test.ts` | KILLED |
| 43 | progress boundary at sixty seconds | `tests/speech.test.ts` | KILLED |
| 44 | egress fixed notice content | `tests/p3-egress.test.ts` | KILLED |
| 45 | egress notice kind | `tests/p3-egress.test.ts` | KILLED |
| 46 | egress notice alias list | `tests/p3-egress.test.ts` | KILLED |
| 47 | egress notice alias identity | `tests/p3-egress.test.ts` | KILLED |
| 48 | egress notice session policy | `tests/p3-egress.test.ts` | KILLED |
| 49 | queued result revision authorization | `tests/p3-broker.test.ts` | KILLED |
| 50 | smoke exactly ten destinations | `tests/smoke-multi.test.ts` | KILLED |
| 51 | smoke destination match | `tests/smoke-multi.test.ts` | KILLED |
| 52 | smoke require resolved ask | `tests/smoke-multi.test.ts` | KILLED |
| 53 | smoke registered delivery only | `tests/smoke-multi.test.ts` | KILLED |
| 54 | smoke prefix correctness | `tests/smoke-multi.test.ts` | KILLED |
| 55 | smoke final usage required | `tests/smoke-multi.test.ts` | KILLED |
| 56 | smoke total cost cap | `tests/smoke-multi.test.ts` | KILLED |
| 57 | longest exact pronunciation wins | `tests/netcontrol.test.ts` | KILLED |
| 58 | correction response grammar | `tests/netcontrol.test.ts` | KILLED |
| 59 | new-task response grammar | `tests/netcontrol.test.ts` | KILLED |
| 60 | correction question exact wording | `tests/p3-broker.test.ts` | KILLED |
| 61 | retained work not resent after reconnect | `tests/requests.test.ts` | KILLED |
| 62 | destination clarification may ask a distinct intent question | `tests/p3-broker.test.ts` | KILLED |
| 63 | confirmed correction can supersede an exported result | `tests/p3-broker.test.ts` | KILLED |
| 64 | confirmed correction retires exported epoch | `tests/p3-broker.test.ts` | KILLED |
| 65 | disconnected alias accepts a new capability | `tests/registry.test.ts` | KILLED |
| 66 | rotation replaces stale token and transport | `tests/registry.test.ts` | KILLED |
| 67 | pending route accepts bare aliases only | `tests/p3-broker.test.ts` | KILLED |
| 68 | pending route re-asked after independent dispatch | `tests/p3-broker.test.ts` | KILLED |
| 69 | cancel consumes the pending route ask | `tests/p3-broker.test.ts` | KILLED |
| 70 | STT single period separator | `tests/netcontrol.test.ts` | KILLED |
| 71 | only still_working coalesces | `tests/p3-broker.test.ts` | KILLED |
| 72 | this-one stripped under pin | `tests/netcontrol.test.ts` | KILLED |
| 73 | consumed fragment focus released | `tests/p3-broker.test.ts` | KILLED |
| 74 | includeOff opt-in recognizes focused off session | `tests/netcontrol.test.ts` | KILLED |
| 75 | old registration cannot disconnect new identity | `tests/p3-broker.test.ts` | KILLED |
| 76 | serve rejects minimum activation budget | `tests/cli.test.ts` | KILLED |
| 77 | smoke rejects minimum activation budget | `tests/smoke-multi.test.ts` | KILLED |

The reproducible runner is `scripts/mutate.ts` (left uncommitted as requested); run `bun scripts/mutate.ts` for all cases or append case numbers for a subset. The complete baseline, commands, exit codes, assertion output, and summary are saved in `docs/P3-MUTATIONS.log`; selected runs use `docs/P3-MUTATIONS-selected.log`. Missing targets, surviving mutations, and non-assertion errors fail the run. Tests run sequentially in a disposable copy; the working tree is never mutated.

## Review fixes

All eleven findings in `docs/P3-REVIEW.md` are addressed:

| Review item | Fix and regression evidence |
| --- | --- |
| P1 #1 | Restore disconnected capability rotation with replacement refs/cwd and cleared transport/readiness; keep connected-token rejection and same-capability identity checks. Restore the P2 delivery-ownership test. New registry and broker tests cover rotation across disconnect/restart and stale transport rejection. |
| P1 #2 | Require a bare alias for a pending destination answer; retain pointing answers and add bare cancel. Full addressed tasks dispatch independently; repeat the old ask once after successful dispatch, including queued reconnect, unless already resolved/cancelled. Tests cover each path and dispatch/ask order. |
| P2 #3 | Correct the regression ledger and name the missing relaunch coverage. Add `scripts/mutate.ts` and its full log with the original 64 guards and 13 review cases. No git commit made. |
| P2 #4 | Accept a single STT period as an alias separator while retaining ellipses. Tests use `Aar. Run the tests`, pronunciation variants, ellipses, and arbitrary task wording. |
| P2 #5 | Document all four prompt changes (the fourth contains two availability notices) here and in the P3-BRIEF errata; retain every required form. |
| P2 #6 | Classify only `still_working` as progress; waiting/unconfirmed remain status. The broker action-to-egress regression checks waiting at 2 s and unconfirmed at 20 s both append, followed by coalesced still-working updates. |
| P3 #7 | Strip “this one,” before pin/focus routing; test confirms pin still wins over focus. |
| P3 #8 | Delete each consumed fragment-focus entry immediately after capture. Test observes deletion and verifies captured focus plus subsequent routing. |
| P3 #9 | Describe the smoke off/unregistered check as a tripwire; direct refusal evidence comes from offline broker tests. |
| P3 #10 | Add `focusedAlias(..., includeOff)` for status display instead of inventing policy levels. Tests preserve unique matching, off exclusion during routing, and focused-off display. |
| P3 #11 | Define `MIN_ACTIVATION_USD` once in `src/ledger.ts`, import it in CLI and smoke. Boundary tests reject the minimum before credentials or scenario execution. |

The documentation corrections and constant extraction do not change the fixed prompt wording or budget threshold. Every behavioral regression above has a targeted mutation proving an assertion fails when its protection is removed.

## Human-run paid smoke #3

**Prepared, not executed.** When separately authorized, run:

```sh
bun scripts/smoke.ts --paid --scenario multi --max-usd 0.30
```

The script creates five fresh repositories, each containing `fixture.txt`, under `~/Projects/hotmic-smoke/{alpha,bravo,charlie,delta,echo}`. Existing destination directories cause refusal rather than overwrites. It creates a private temporary state directory and policy file, prints the exact `HOTMIC_STATE`/`HOTMIC_POLICY` exports, and prints the policy with all five aliases at `release`. It never writes `~/.config/hotmic/policy.json`.

Follow the printed exports in every pane. Start serve, then open five cmux panes and run the printed `hotmic claude -n <alias>` commands. Preflight requires all five connected, voice asleep, and the activation cap at or below half the total budget. The script launches no serve, Claude, or wake process itself.

Speak the printed table in order and fill its observed-destination column:

| Step | Expected | Route exercise |
| --- | --- | --- |
| 1 | alpha | Leading alias. |
| 2 | charlie | Leading alias. |
| 3 | bravo | First say “talk to bravo”; then an independent request. |
| 4 | bravo | Second independent request under the pin. |
| 5 | delta | After sleeping voice and waiting at least five minutes without requests, verify `pinned:null`, focus delta, explicitly wake, and use “this one, …”. |
| 6 | echo | Focus echo and speak with no target. |
| 7 | alpha | Focus unregistered serve pane, expect ask and no delivery, then answer “alpha”. |
| 8 | charlie | Leading charlie with bravo mentioned inside task content. |
| 9 | charlie | Repeat step 8 without “New task”; expect the intent question and no delivery, then answer “new task”. |
| 10 | echo | Leading alias with a two-second pause inside the request. |

The asleep interval is necessary: focus cannot outrank an active pin. It consumes no Live time. The printed serve cap is **$0.15 per activation** for a $0.30 run, with two explicit activations. Approve and listen to all ten short results in the serve TTY. End with `hotmic sleep`, wait for final usage, and answer the audible-prefix question. Later grading uses the printed temporary environment:

```sh
bun scripts/smoke.ts --scenario multi --grade --max-usd 0.30
```

`off_unregistered_never_delivered` is a tripwire, not evidence of exercised off-session refusal: all five smoke aliases are at `release`, and no step directly targets an off alias. Offline broker tests exercise actual off/unregistered routing refusal.

Grading requires exactly ten ordered correct destinations, acknowledgements/replies for all ten, resolution between each ask and its delivery, no off/unregistered delivery, ten correctly prefixed result payloads without interleaving, human confirmation plus output-transcript activity, and finalized SQLite usage totaling at most the cap across **all** run activations. Wrong destination, premature dispatch, missing/incorrect prefix, missing finalization, and excess aggregate cost have failing-fixture coverage. The script retains its temporary state, policy, and disposable repositories for review and prints cleanup paths. Extra wakes are not part of the procedure; grading counts their cost too.

## Honesty ledger

- **changed:** P3 registry/net control/cmux/speech modules; broker, request-machine, authenticated socket and shim integration; launcher refs; existing serve text/status fields; fixed prompt notices; source/alias audit metadata; human multi-smoke runner and grader; six new test files; necessary P2 fixture/expectation updates; plan terminology and this report. P3 regressed P2's disconnected token-rotation behavior and rewrote its test to bless the regression; this review restores the P2 ownership test, adds connected rejection/disconnected relaunch tests, and fixes rotation. The review also fixes independent requests during route asks, punctuation, status coalescing, fragment-focus cleanup, focus reporting, and the shared activation-budget constant; adds the reproducible mutation runner/log; and corrects the brief/report. No commits or new dependencies.
- **related_untouched:** P1 transcript assembly, ledger/cap algorithms, privacy scrubbing/release approvals, audio implementation, hook metadata contract, P0 artifacts, installation, README/NOTICE, and the existing single-session smoke scenario. No arbitrary content export or control-socket approval path was added.
- **noticed_not_fixed:** lifecycle management/removal of durable registrations remains P4 work. Disconnected relaunch with a new capability is now supported; rejecting it was a regression, not a design choice. Session ownership records for already delivered requests remain in broker memory: reconnect within the same broker preserves them, but broker restart does not reconstruct old delivery capabilities or automatically rerun work. P2's coarse status wording for timeout/Stop events and hook-event compatibility limitations remain; waiting/unconfirmed still use the existing fixed template but are no longer treated as coalescible progress. Stale broker-lock recovery is unchanged.
- **residual_uncertainty:** two-second cmux sampling can lag physical focus changes by one polling interval; the sampled value is locked at the first fragment. Surface/workspace ambiguity fails closed. The semantic command-verb list is finite; comma addressing remains available for other wording. Chunk serialization proves append order, not audible ordering or exact model recitation. Explicitly approved release content can leave; summary retains its documented scrub limitations. The smoke's two half-budget activations and final aggregate grade are not an acoustic or billing measurement until a human runs it.
- **verification_gap:** the original verification never exercised register → disconnect/exit/crash → launcher relaunch with a newly minted token, which allowed the regression to escape. Offline tests now exercise registration rotation, persistence, old-token rejection, and stale-transport/old-delivery ownership; the actual launcher-to-Claude relaunch path remains unexercised. No real five-pane cmux run, socket bind/chmod observation, launcher-to-Claude session, paid Live connection, microphone, speaker, cost finalization, or human review was performed here. Assertions cover injected transports/TTYs, real SQLite, fake clocks, production byte-stream handling, and real heartbeat timers. The smoke grader was tested with offline fixtures; the script's filesystem setup/preflight and printed commands were not executed as a paid scenario. P3 operational acceptance remains the human smoke.

## Logical commit groups — not committed

1. Durable registry, heartbeat transport, launcher refs, and cmux parsing/tests.
2. Pure net control, captured routing state, request clarification/revision changes, and routing integration tests.
3. Speech queue, fixed notice egress/prompt, outbound audit metadata, and status/display fields with tests.
4. Multi-session human smoke and grading fixtures; mutation runner/log; updated plan, brief errata, and this report.
