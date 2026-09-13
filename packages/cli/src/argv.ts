export function normalizeCliArgv(argv: ReadonlyArray<string>): string[] {
  const [first, payload, ...rest] = argv;
  if (first === "test" && payload === "nc") return ["test:nc", ...rest];
  if (first === "hook" && payload === "test") return ["hook:test", ...rest];
  if (first === "spec" && payload === "check") return ["spec:check", ...rest];
  if (!first || first.startsWith("-") || EXPLICIT_COMMANDS.has(first)) return [...argv];
  if (payload === undefined) return ["send", first];
  if (payload.startsWith("-")) return ["send", first, payload, ...rest];
  return ["send", first, "--text", payload, ...rest];
}

const EXPLICIT_COMMANDS = new Set(["agent", "cancel", "doctor", "help", "hook", "hook:test", "spec", "spec:check", "local", "receive", "send", "status", "test", "test:nc", "wait", "wallet"]);
