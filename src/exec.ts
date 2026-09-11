// Bun 1.3.5 lacks process.execve. Use its built-in FFI for actual POSIX process
// replacement: inherited terminal descriptors and signals, no wrapper parent.
export async function execInteractive(executable: string, args: string[], env: Record<string, string>): Promise<never> {
  if ([executable, ...args, ...Object.entries(env).flat()].some(s => s.includes("\0"))) throw new Error("NUL in launch arguments");
  if (process.execve) { process.execve(executable, [executable, ...args], env); throw new Error("execve returned"); }
  const { dlopen, ptr, FFIType } = await import("bun:ffi");
  const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const path = Buffer.from(executable + "\0");
  const argv = [executable, ...args].map(a => Buffer.from(a + "\0"));
  const envp = Object.entries(env).map(([key, value]) => Buffer.from(`${key}=${value}\0`));
  const pointers = (values: Buffer[]) => new BigUint64Array([...values.map(v => BigInt(ptr(v))), 0n]);
  const argvPointers = pointers(argv), envPointers = pointers(envp);
  try { libc.symbols.execve(ptr(path), ptr(argvPointers), ptr(envPointers)); }
  finally {
    // Keep the buffers alive across the native call, including an error return.
    for (const buffer of [path, ...argv, ...envp]) buffer.fill(0);
    libc.close();
  }
  throw new Error("Unable to exec interactive child");
}
