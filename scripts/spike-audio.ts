import { appendFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { audioLimits, chunkFrames, CLOSE_GRACE_SECONDS, costUSD, rms, SILENCE_MS, SILENCE_RMS, silenceFrame, transcriptWords } from "../src/p0-audio";
import { object } from "../shim/protocol";

async function main() {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
    "max-seconds": { type: "string", default: "90" }, "max-usd": { type: "string", default: "0.15" }, "echo-test": { type: "boolean", default: false },
  }, strict: true, allowPositionals: false });
  const limits = audioLimits(Number(values["max-seconds"]), Number(values["max-usd"]));
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY must be supplied in the environment. Run bun --no-env-file scripts/spike-audio.ts …");
  if (!Bun.which("rec") || !Bun.which("play")) throw new Error("sox rec and play are required");
  const dir = resolve(import.meta.dir, "../.runs/p0");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = `${dir}/audio-${Date.now()}.jsonl`;
  const origin = performance.now();
  const now = () => performance.now() - origin;
  const log = (event: unknown) => appendFileSync(path, JSON.stringify({ at: now(), event }) + "\n", { mode: 0o600 });
  log({ type: "spike_config", ...limits, max_seconds: Number(values["max-seconds"]), max_usd: Number(values["max-usd"]), rate_usd_per_minute: 0.05,
    silence_rms: SILENCE_RMS, silence_ms: SILENCE_MS, echo_test: values["echo-test"] });
  console.log(`Log: ${path}\nCapture window ≤${limits.captureSeconds.toFixed(1)}s; close grace ≤10s. RMS threshold ${SILENCE_RMS} for ${SILENCE_MS}ms.`);

  let started = false, closing = false, finalized = false;
  let usageSeconds: number | null = null;
  let lastFragmentAt: number | null = null, lastFragmentEnd: number | null = null;
  let silenceSince: number | null = null, silent = false;
  let transcript = "";
  let inputTail = "", outputTail = "";
  let outputWords: { word: string; at: number }[] = [];
  const echoHits: { at: number; word: string }[] = [];
  const rows: Record<string, unknown>[] = [];
  const commentaryTimers = new Set<ReturnType<typeof setTimeout>>();
  let rec: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
  let play: Bun.Subprocess<"pipe", "ignore", "inherit"> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const ws = new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${key}` } });
  const send = (event: Record<string, unknown>) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (event.type !== "session.input_audio.append") log({ dir: "out", ...event });
    ws.send(JSON.stringify(event));
  };
  const stopAudio = () => {
    rec?.kill(); play?.kill();
    for (const timer of commentaryTimers) clearTimeout(timer);
    commentaryTimers.clear();
  };
  const finish = () => { clearTimeout(closeTimer); stopAudio(); done(); };
  const close = (reason: string) => {
    if (closing) return;
    closing = true; log({ type: "close_requested", reason }); stopAudio();
    send({ type: "session.close" });
    closeTimer = setTimeout(() => {
      log({ type: "close_timeout", final_usage_confirmed: false });
      process.exitCode = 1; ws.terminate(); finish();
    }, CLOSE_GRACE_SECONDS * 1000);
  };
  // Both clocks start before connecting: startup and close time consume the cap.
  const capTimer = setTimeout(() => close("duration/cost cap"), limits.captureSeconds * 1000);
  const hardTimer = setTimeout(() => {
    if (!finalized) { process.exitCode = 1; log({ type: "hard_cap", final_usage_confirmed: false }); }
    ws.terminate(); finish();
  }, (limits.hardSeconds - 0.5) * 1000);
  const interrupt = () => close("SIGINT");
  const terminate = () => close("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  ws.addEventListener("open", () => {
    // Even during an early close, session.start remains the first message.
    send({ type: "session.start", event_id: "p0_start", session: {
      model: "gpt-live-1", delegation: { type: "client" }, store: false,
      audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } },
      instructions: "You are a test harness voice. No filler phrases. When the user asks you to do something, delegate it. Keep replies under two sentences.",
    } });
    if (closing) send({ type: "session.close" });
  });
  ws.addEventListener("message", (message) => {
    try {
      const event: unknown = JSON.parse(String(message.data));
      if (!object(event) || typeof event.type !== "string") throw new Error("Invalid Live event");
      if (event.type !== "session.output_audio.delta") log(event);
      if (event.type === "error") {
        console.error(String(message.data)); process.exitCode = 1; close("server error"); return;
      }
      if (event.type === "session.usage.updated" || event.type === "session.closed") {
        if (!object(event.usage) || typeof event.usage.seconds !== "number" || !Number.isFinite(event.usage.seconds) || event.usage.seconds < 0) throw new Error("Missing usage.seconds");
        usageSeconds = event.usage.seconds; // Cumulative snapshot: replace, never sum.
        if (event.type === "session.closed") {
          finalized = true; closing = true; ws.close(); finish(); return;
        }
        if (usageSeconds >= limits.captureSeconds) close("usage cap");
      }
      if (closing) return;
      if (event.type === "session.started" && !started) {
        started = true;
        play = Bun.spawn(["play", "-q", "-t", "raw", "-r", "24000", "-e", "signed", "-b", "16", "-c", "1", "-"], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
        rec = Bun.spawn(["rec", "-q", "-t", "raw", "-r", "24000", "-e", "signed", "-b", "16", "-c", "1", "-"], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
        for (const child of [rec, play]) void child.exited.then(() => { if (!closing) { process.exitCode = 1; close("sox exited"); } });
        void (async () => {
          let pending = Buffer.alloc(0);
          for await (const chunk of rec!.stdout) {
            if (closing) break;
            const split = chunkFrames(pending, chunk); pending = split.pending;
            for (const [index, frame] of split.frames.entries()) {
              const frameAt = now() - (split.frames.length - index - 1) * 20;
              const state = silenceFrame(silenceSince, rms(frame), frameAt);
              silenceSince = state.since; silent = state.silent;
              send({ type: "session.input_audio.append", audio: frame.toString("base64") });
            }
          }
        })().catch(() => { process.exitCode = 1; close("capture failed"); });
      } else if (event.type === "session.output_audio.delta") {
        if (typeof event.delta !== "string") throw new Error("Invalid audio delta");
        play?.stdin.write(Buffer.from(event.delta, "base64"));
        play?.stdin.flush();
      } else if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") {
        if (typeof event.delta !== "string" || typeof event.end_ms !== "number") throw new Error("Invalid transcript delta");
        const at = now();
        if (event.type === "session.input_transcript.delta") {
          transcript += event.delta; lastFragmentAt = at; lastFragmentEnd = event.end_ms;
          if (values["echo-test"]) {
            const words = transcriptWords(inputTail, event.delta); inputTail = words.pending;
            outputWords = outputWords.filter((word) => at - word.at <= 3000);
            for (const word of words.words) {
              if (outputWords.some((output) => output.word === word)) { echoHits.push({ at, word }); log({ type: "echo_candidate", word }); }
            }
          }
        } else if (values["echo-test"]) {
          const words = transcriptWords(outputTail, event.delta); outputTail = words.pending;
          outputWords = outputWords.filter((word) => at - word.at <= 3000);
          outputWords.push(...words.words.map((word) => ({ word, at })));
        }
      } else if (event.type === "session.delegation.created") {
        if (!object(event.delegation) || typeof event.delegation.id !== "string" || typeof event.offset_ms !== "number") throw new Error("Invalid delegation event");
        const at = now();
        const row = { delegation_id: event.delegation.id, at, offset_ms: event.offset_ms,
          since_last_fragment_ms: lastFragmentAt === null ? null : at - lastFragmentAt,
          offset_minus_last_fragment_end_ms: lastFragmentEnd === null ? null : event.offset_ms - lastFragmentEnd,
          since_silence_ms: silent && silenceSince !== null ? at - silenceSince : null };
        rows.push(row); log({ type: "delegation_timing", ...row });
        // This is a spike: consume only text already observed at delegation time.
        const captured = transcript; transcript = "";
        const delegationId = event.delegation.id;
        const timer = setTimeout(() => {
          commentaryTimers.delete(timer);
          if (!closing) send({ type: "session.commentary.append", event_id: crypto.randomUUID(), delegation_id: delegationId, content: `Got it: ${captured}` });
        }, 900);
        commentaryTimers.add(timer);
      }
    } catch (error) { log({ type: "contract_error", error: String(error) }); console.error(String(error)); process.exitCode = 1; close("contract error"); }
  });
  ws.addEventListener("error", () => { console.error("Live WebSocket failed"); log({ type: "transport_error" }); process.exitCode = 1; close("transport error"); });
  ws.addEventListener("close", () => { if (!finalized) { process.exitCode = 1; log({ type: "unconfirmed_close" }); } finish(); });
  await finished;
  clearTimeout(capTimer); clearTimeout(hardTimer);
  process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
  const seconds = usageSeconds ?? now() / 1000;
  const summary = { type: "summary", usage_seconds: seconds, cost_usd: costUSD(seconds), final_usage_confirmed: finalized,
    usage_source: usageSeconds === null ? "wall_clock_estimate" : "server_snapshot", delegation_count: rows.length,
    echo: values["echo-test"] ? (echoHits.length ? "possible feedback" : "no repeated words observed; human listening verdict required") : "not tested", echo_candidates: echoHits.length };
  log(summary); console.log(JSON.stringify(summary, null, 2)); console.table(rows);
}

if (import.meta.main) main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
