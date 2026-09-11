import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { object } from "../shim/protocol";
import { emptyRefs, validRefs, type Refs } from "./registry";
const run = promisify(execFile);
export function cmuxEnv(env: NodeJS.ProcessEnv, focus: boolean) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !focus || !key.startsWith("CMUX_")));
}
export function identifyRefs(value: unknown, focus: boolean): Refs {
  const fields = object(value) ? value[focus ? "focused" : "caller"] : null;
  if (!object(fields) || (focus && fields.is_browser_surface === true)) return emptyRefs();
  const refs = { workspace_ref: fields.workspace_ref ?? null, surface_ref: fields.surface_ref ?? null } as Refs;
  return validRefs(refs) ? refs : emptyRefs();
}
export async function identify(focus = false): Promise<Refs> {
  try {
    const { stdout } = await run("cmux", focus ? ["identify", "--no-caller"] : ["identify"], { env: cmuxEnv(process.env, focus), timeout: 1500, maxBuffer: 65536 });
    return identifyRefs(JSON.parse(stdout), focus);
  } catch { return emptyRefs(); }
}
