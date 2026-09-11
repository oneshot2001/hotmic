import { chunkFrames, rms, SILENCE_RMS } from "./p0-audio";
export interface AudioIO { start(): void; output(bytes: Buffer): void; stop(): void }
export class Audio implements AudioIO {
  #rec?: Bun.Subprocess<"ignore", "pipe", "ignore">;
  #play?: Bun.Subprocess<"pipe", "ignore", "ignore">;
  #queue: Buffer[] = [];
  #timer?: ReturnType<typeof setInterval>;
  #silent = true;
  #stopped = false;
  constructor(private input: (frame: Buffer, silent: boolean) => void, private fail: () => void) {}
  start() {
    // CoreAudio chooses the native input rate (e.g. 48 kHz); resample the output.
    this.#rec = Bun.spawn(["sox", "-q", "-t", "coreaudio", "default", "-t", "raw", "-r", "24000", "-e", "signed", "-b", "16", "-c", "1", "-", "rate", "24000"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    void this.#rec.exited.then(() => setImmediate(() => { if (!this.#stopped) this.fail(); }));
    this.#timer = setInterval(() => {
      const frame = this.#queue.shift();
      if (!frame || !this.#silent) return;
      this.#play ??= Bun.spawn(["play", "-q", "--buffer", "2048", "-t", "raw", "-r", "24000", "-e", "signed", "-b", "16", "-c", "1", "-"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      try { this.#play.stdin.write(frame); this.#play.stdin.flush(); } catch { this.fail(); }
    }, 20);
    void (async () => {
      let pending = Buffer.alloc(0);
      for await (const bytes of this.#rec!.stdout) {
        if (this.#stopped) break;
        const split = chunkFrames(pending, bytes); pending = split.pending;
        for (const frame of split.frames) {
          const silent = rms(frame) < SILENCE_RMS;
          if (!silent && this.#silent) { this.#queue = []; this.#play?.kill(); this.#play = undefined; }
          this.#silent = silent;
          this.input(frame, silent);
        }
      }
    })().catch(() => { if (!this.#stopped) this.fail(); });
  }
  output(bytes: Buffer) {
    if (!this.#silent || this.#stopped) return;
    for (let i = 0; i < bytes.length; i += 960) this.#queue.push(bytes.subarray(i, i + 960));
    // Bound the local queue to 200 ms; measured playback latency remains a smoke check.
    if (this.#queue.length > 10) this.#queue.splice(0, this.#queue.length - 10);
  }
  stop() { this.#stopped = true; clearInterval(this.#timer); this.#queue = []; this.#rec?.kill(); this.#play?.kill(); }
}
