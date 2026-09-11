import { appendFileSync } from "node:fs";
import { object } from "../shim/protocol";

export function recordChannelEvent(artifact: string, value: unknown, at = Date.now()) {
  const record = (event: unknown) => appendFileSync(artifact, JSON.stringify(event) + "\n", { mode: 0o600 });
  record({ at, type: "socket", event: value });
  if (object(value) && value.type === "channel_initialize")
    record({ at, type: "initialize", protocolVersion: value.protocolVersion });
}
