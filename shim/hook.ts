import { request } from "node:http";
import { object } from "./protocol";

export const metadataKeys = ["session_id", "hook_event_name", "tool_name", "turn_id", "message_id", "parent_message_id", "tool_use_id"];
export const hookEvents = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "StopFailure", "PermissionRequest", "Notification", "Stop", "SessionEnd"];

export function hookMetadata(input: unknown) {
  if (!object(input) || typeof input.hook_event_name !== "string" || !hookEvents.includes(input.hook_event_name) || typeof input.session_id !== "string" || !input.session_id) {
    throw new Error("Invalid hook metadata");
  }
  return Object.fromEntries(metadataKeys.flatMap((key) => typeof input[key] === "string" ? [[key, input[key]]] : []));
}

async function main() {
  try {
    const body = JSON.stringify(hookMetadata(JSON.parse(await Bun.stdin.text())));
    const sock = process.argv[2] ?? process.env.HOTMIC_SOCK;
    if (!sock) throw new Error("socket path argument or HOTMIC_SOCK is required");
    await new Promise<void>((resolve, reject) => {
      const req = request({ socketPath: sock, path: "/hook", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
          ...(process.argv[3] && process.argv[4] ? { "X-Hotmic-Alias": process.argv[3], "X-Hotmic-Token": process.argv[4] } : {}) },
      }, (res) => { res.resume(); res.on("end", () => res.statusCode === 200 ? resolve() : reject(new Error("Hook POST rejected"))); });
      req.setTimeout(2000, () => req.destroy(new Error("Hook POST timed out")));
      req.on("error", reject);
      req.end(body);
    });
  } catch { /* Hooks never block Claude, including broker-down and malformed inputs. */ }
  finally { console.log("{}"); }
}

if (import.meta.main) await main();
