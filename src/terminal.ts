import type { Broker } from "./broker";
import type { Candidate } from "./egress";

type Input = {
  isTTY?: boolean; isRaw?: boolean;
  setRawMode(raw: boolean): void; resume(): void; pause(): void;
  on(event: "data", listener: (bytes: Buffer) => void): void;
  off(event: "data", listener: (bytes: Buffer) => void): void;
};
// Production always uses the serve process's own stdin; injection is for offline tests.
export function serveTerminal(broker: Broker, input: Input = process.stdin, write = (line: string) => console.log(line)) {
  let displayed: Candidate | undefined, previous = "";
  const raw = !!input.isRaw, tty = !!input.isTTY;
  const keys = (bytes: Buffer) => {
    if (displayed && bytes.toString() === "a") {
      try { broker.approve(displayed.hash, displayed.request_id, displayed.revision); }
      catch { write("Approval expired; review the current payload."); }
    }
    if (displayed && bytes.toString() === "r") broker.reject(displayed.request_id, displayed.revision);
    if (bytes.includes(3)) process.emit("SIGINT");
  };
  if (tty) { input.setRawMode(true); input.resume(); input.on("data", keys); }
  broker.approvalTTY = tty;
  return {
    render() {
      const status = broker.status(), candidate = broker.pending()[0];
      const latest = [...status.requests].sort((a, b) => b.updated_at - a.updated_at)[0];
      const line = `${status.sessions[0]?.alias ?? "No session"} | ${latest?.state ?? "idle"} | ${status.voice} | $${status.usage.reduce((sum, u) => sum + u.usd, 0).toFixed(4)}\nLast request: ${JSON.stringify(latest?.text ?? "")}\nApproval: ${status.approval}\n${candidate ? `${JSON.stringify(candidate.text)}\n${candidate.request_id} rev ${candidate.revision}\n${tty ? "[a]pprove / [r]eject" : "Release held: serve requires a TTY."}` : ""}`;
      if (line !== previous) { write(line); previous = line; displayed = candidate; }
    },
    close() {
      broker.approvalTTY = false;
      displayed = undefined;
      if (tty) { input.off("data", keys); input.setRawMode(raw); input.pause(); }
    },
  };
}
