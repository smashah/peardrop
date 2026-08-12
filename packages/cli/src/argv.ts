export function normalizeCliArgv(argv: ReadonlyArray<string>): string[] {
  const [first, payload, ...rest] = argv;
  if (first === "test" && payload === "nc") return ["test:nc", ...rest];
  if (!first || first.startsWith("-") || EXPLICIT_COMMANDS.has(first)) return [...argv];
  if (payload === undefined) return ["send", first];
  if (payload.startsWith("-")) return ["send", first, payload, ...rest];
  return ["send", first, "--text", payload, ...rest];
}

const EXPLICIT_COMMANDS = new Set(["cancel", "help", "local", "receive", "send", "status", "test", "test:nc", "wallet"]);
