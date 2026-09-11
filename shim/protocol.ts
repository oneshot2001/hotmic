export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// MCP stdio and the prototype socket both use newline-delimited JSON.
export function jsonLines(receive: (value: unknown) => void, invalid: () => void) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  return (bytes: Uint8Array) => {
    try {
      pending += decoder.decode(bytes, { stream: true });
      if (pending.length > 1_048_576) throw new Error("Oversized line");
    } catch {
      pending = "";
      invalid();
      return;
    }
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { invalid(); continue; }
      receive(value);
    }
  };
}

export const identityProperties = {
  request_id: { type: "string", minLength: 1 },
  revision: { type: "string", pattern: "^[1-9][0-9]*$", description: "Copy the revision attribute from the channel tag verbatim." },
  delivery_id: { type: "string", minLength: 1 },
  session_alias: { type: "string", minLength: 1 },
};

export function identity(value: unknown): value is Record<string, unknown> {
  return object(value) && ["request_id", "delivery_id", "session_alias"].every(
    (key) => typeof value[key] === "string" && value[key].length > 0,
  ) && typeof value.revision === "string" && /^[1-9][0-9]*$/.test(value.revision);
}

export function validTool(name: unknown, args: unknown): boolean {
  if (!identity(args)) return false;
  const keys = Object.keys(identityProperties);
  if (name === "reply") {
    keys.push("status", "text");
    if (typeof args.status !== "string" || !["completed", "failed", "question"].includes(args.status) || typeof args.text !== "string") return false;
  } else if (name !== "acknowledge") return false;
  return Object.keys(args).every((key) => keys.includes(key));
}
