export const FRAME_BYTES = 960;
export const FRAME_MS = 20;
export const SILENCE_RMS = 0.015; // Normalized PCM16 amplitude; experimental, not a VAD.
export const SILENCE_MS = 300;
export const CLOSE_GRACE_SECONDS = 10;

export function chunkFrames(pending: Buffer, chunk: Uint8Array) {
  const bytes = Buffer.concat([pending, chunk]);
  const frames: Buffer[] = [];
  let offset = 0;
  for (; offset + FRAME_BYTES <= bytes.length; offset += FRAME_BYTES) frames.push(bytes.subarray(offset, offset + FRAME_BYTES));
  return { frames, pending: Buffer.from(bytes.subarray(offset)) };
}

export function rms(frame: Buffer): number {
  if (!frame.length || frame.length % 2) throw new Error("Expected complete PCM16 samples");
  let sum = 0;
  for (let offset = 0; offset < frame.length; offset += 2) sum += (frame.readInt16LE(offset) / 32768) ** 2;
  return Math.sqrt(sum / (frame.length / 2));
}

export function silenceFrame(previous: number | null, level: number, frameEndMs: number) {
  const since = level < SILENCE_RMS ? previous ?? frameEndMs - FRAME_MS : null;
  return { since, silent: since !== null && frameEndMs - since >= SILENCE_MS };
}

export function costUSD(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid duration");
  return seconds / 60 * 0.05;
}

export function audioLimits(maxSeconds: number, maxUSD: number) {
  if (![maxSeconds, maxUSD].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Caps must be positive finite numbers");
  // Reserve the entire close handshake plus 1 second before either ceiling.
  const hardSeconds = Math.min(maxSeconds, maxUSD / 0.05 * 60);
  const captureSeconds = hardSeconds - CLOSE_GRACE_SECONDS - 1;
  if (captureSeconds <= 0) throw new Error("Caps must allow more than 11 seconds for startup/close");
  return { hardSeconds, captureSeconds };
}

export function echoWords(text: string) { return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []; }

// Keep incomplete words across deltas so 'hel' + 'lo' matches 'hello'.
export function transcriptWords(previous: string, delta: string) {
  const text = previous + delta;
  const tail = text.match(/[\p{L}\p{N}']+$/u)?.[0] ?? "";
  return { words: echoWords(text.slice(0, text.length - tail.length)), pending: tail };
}
