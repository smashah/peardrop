import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { extname, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, ".artifacts");
await rm(artifacts, { force: true, recursive: true });
await mkdir(artifacts, { recursive: true });

for (const packageDirectory of ["packages/core", "packages/cli"]) {
  const packed = spawnSync("pnpm", ["pack", "--pack-destination", artifacts], {
    cwd: resolve(root, packageDirectory),
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    process.stderr.write(packed.stderr || packed.stdout);
    process.exit(packed.status ?? 1);
  }
}

const archives = await readdir(artifacts);
if (archives.length !== 2 || archives.some((name) => !name.endsWith(".tgz"))) {
  throw new Error(`Expected two package archives, found: ${archives.join(", ")}`);
}

const cliManifest = JSON.parse(await readFile(resolve(root, "packages/cli/package.json"), "utf8"));
const serializedManifest = JSON.stringify(cliManifest);
const forbiddenTokens = [
  "@peardrop/" + "mcp",
  "../" + "mcp",
  "apps/" + "api",
  "apps/" + "webapp",
  "credentials." + "manifest",
  "owner" + "Auth",
  "peardrop.fyi.git",
];
for (const token of forbiddenTokens) {
  if (serializedManifest.includes(token)) throw new Error(`CLI manifest contains private token: ${token}`);
}

const extracted = resolve(artifacts, "extracted");
await mkdir(extracted, { recursive: true });
for (const archive of archives) {
  const destination = resolve(extracted, archive.replace(/\.tgz$/, ""));
  await mkdir(destination, { recursive: true });
  const unpacked = spawnSync("tar", ["-xzf", resolve(artifacts, archive), "-C", destination], { encoding: "utf8" });
  if (unpacked.status !== 0) {
    process.stderr.write(unpacked.stderr || unpacked.stdout);
    process.exit(unpacked.status ?? 1);
  }
}

const scannedExtensions = new Set([".cjs", ".js", ".json", ".mjs", ".ts"]);
const scan = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!scannedExtensions.has(extname(entry.name))) continue;
    const contents = await readFile(path, "utf8");
    for (const token of forbiddenTokens) {
      if (contents.includes(token)) throw new Error(`${relative(extracted, path)} contains private token: ${token}`);
    }
  }
};

await scan(extracted);

const installDirectory = resolve(artifacts, "install");
await mkdir(installDirectory, { recursive: true });
const initialize = spawnSync("npm", ["init", "--yes"], {
  cwd: installDirectory,
  encoding: "utf8",
});
if (initialize.status !== 0) {
  process.stderr.write(initialize.stderr || initialize.stdout);
  process.exit(initialize.status ?? 1);
}

const install = spawnSync(
  "npm",
  ["install", "--ignore-scripts", ...archives.map((archive) => resolve(artifacts, archive))],
  { cwd: installDirectory, encoding: "utf8" },
);
if (install.status !== 0) {
  process.stderr.write(install.stderr || install.stdout);
  process.exit(install.status ?? 1);
}

const cliHelp = spawnSync(resolve(installDirectory, "node_modules/.bin/peardrop"), ["--help"], {
  cwd: installDirectory,
  encoding: "utf8",
});
if (cliHelp.status !== 0) {
  process.stderr.write(cliHelp.stderr || cliHelp.stdout);
  process.exit(cliHelp.status ?? 1);
}
if (!cliHelp.stdout.includes("PearDrop")) {
  throw new Error("Installed peardrop executable did not render its help output");
}

const ncHelp = spawnSync(resolve(installDirectory, "node_modules/.bin/peardrop"), ["test", "nc", "--help"], {
  cwd: installDirectory,
  encoding: "utf8",
});
if (ncHelp.status !== 0) {
  process.stderr.write(ncHelp.stderr || ncHelp.stdout);
  process.exit(ncHelp.status ?? 1);
}
if (!ncHelp.stdout.includes("--verbose")) {
  throw new Error("Installed test nc command did not expose --verbose");
}

for (const runtime of [
  "node_modules/@peardrop/core/dist/relay/dhtRelayRuntime.js",
  "node_modules/@peardrop/cli/dist/commands/test/nc.js",
]) {
  const installedRelayRuntime = await readFile(resolve(installDirectory, runtime), "utf8");
  const completedHandshakeGuards = installedRelayRuntime.match(/if \(this\.complete\) return/g) ?? [];
  if (completedHandshakeGuards.length !== 2) {
    throw new Error(
      `${runtime} must contain both completed-handshake guards; found ${completedHandshakeGuards.length}`,
    );
  }
}

// The relay runtime is pre-bundled for browsers before it is packed. Exercise
// its first non-custodial Noise send from the clean install: dependency export
// conditions can differ here even when the workspace's Node runtime is green.
const installedRuntimePath = resolve(installDirectory, "node_modules/@peardrop/core/dist/relay/dhtRelayRuntime.js");
const installedRuntime = await import(`${pathToFileURL(installedRuntimePath).href}?smoke=${Date.now()}`);
class OpenWebSocket extends EventTarget {
  binaryType = "arraybuffer";
  readyState = 1;
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}
const relaySocket = new OpenWebSocket();
const relayStream = new installedRuntime.Stream(true, relaySocket);
let runtimeFailure;
relayStream.on("error", (cause) => {
  runtimeFailure = cause;
});
const relayDht = new installedRuntime.default(relayStream, { custodial: false });
const relayPeer = relayDht.connect(relayDht.defaultKeyPair.publicKey);
const connectingAlias = relayDht._connecting.keys().next().value;
try {
  relayDht._protocol.emit("noiseSend", {
    id: 1,
    isInitiator: true,
    payload: new Uint8Array(),
    remoteStreamAlias: connectingAlias,
  });
} catch (cause) {
  runtimeFailure = cause;
} finally {
  relayPeer.destroy();
  await relayDht.destroy({ force: true });
}
if (runtimeFailure) {
  throw new Error(`Installed browser relay runtime failed its first Noise send: ${runtimeFailure}`);
}

// Compare the exact function shipped in the clean-installed browser bundle to
// sodium-native. The positive set exercises arbitrary no-clamp scalars; the
// negative set guards the untrusted remote-key validation contract.
const requireFromCore = createRequire(resolve(root, "packages/core/package.json"));
const nativeSodium = requireFromCore("sodium-native");
const deterministicBytes = (label) => createHash("sha256").update(label).digest();
for (let index = 0; index < 64; index++) {
  const seed = deterministicBytes(`peardrop-ed25519-seed-${index}`);
  const scalar = deterministicBytes(`peardrop-ed25519-scalar-${index}`);
  const publicKey = Buffer.alloc(32);
  const secretKey = Buffer.alloc(64);
  nativeSodium.crypto_sign_seed_keypair(publicKey, secretKey, seed);
  const expected = Buffer.alloc(32);
  const actual = Buffer.alloc(32);
  nativeSodium.crypto_scalarmult_ed25519_noclamp(expected, scalar, publicKey);
  installedRuntime.cryptoScalarmultEd25519Noclamp(actual, scalar, publicKey);
  if (!actual.equals(expected)) {
    throw new Error(`Installed browser Ed25519 DH diverged from sodium-native at vector ${index}`);
  }
}

const rejectedPublicKeys = [
  "0100000000000000000000000000000000000000000000000000000000000000",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  "98519eadf35b995233b51b5cd23e9cc5a28b639b5a4af0ec903cb960d81b7819",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
];
const nonzeroScalar = Buffer.alloc(32);
nonzeroScalar[0] = 5;
for (const encodedPublicKey of rejectedPublicKeys) {
  const publicKey = Buffer.from(encodedPublicKey, "hex");
  for (const [implementation, multiply] of [
    ["sodium-native", nativeSodium.crypto_scalarmult_ed25519_noclamp],
    ["installed browser runtime", installedRuntime.cryptoScalarmultEd25519Noclamp],
  ]) {
    let rejected = false;
    try {
      multiply(Buffer.alloc(32), nonzeroScalar, publicKey);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`${implementation} accepted invalid Ed25519 point ${encodedPublicKey}`);
  }
}

const validPublicKey = Buffer.alloc(32);
const validSecretKey = Buffer.alloc(64);
nativeSodium.crypto_sign_seed_keypair(validPublicKey, validSecretKey, deterministicBytes("peardrop-ed25519-zero"));
for (const [implementation, multiply] of [
  ["sodium-native", nativeSodium.crypto_scalarmult_ed25519_noclamp],
  ["installed browser runtime", installedRuntime.cryptoScalarmultEd25519Noclamp],
]) {
  let rejected = false;
  try {
    multiply(Buffer.alloc(32), Buffer.alloc(32), validPublicKey);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`${implementation} accepted the zero Ed25519 scalar`);
}

const importCore = spawnSync(
  "node",
  ["--input-type=module", "--eval", 'await import("@peardrop/core"); await import("@peardrop/core/node");'],
  { cwd: installDirectory, encoding: "utf8" },
);
if (importCore.status !== 0) {
  process.stderr.write(importCore.stderr || importCore.stdout);
  process.exit(importCore.status ?? 1);
}

const browserEntry = resolve(installDirectory, "browser-relay-entry.mjs");
await writeFile(browserEntry, 'export { sendRelay } from "@peardrop/core/relay";\n');
const bundleRelay = spawnSync(
  resolve(root, "packages/cli/node_modules/.bin/esbuild"),
  [browserEntry, "--bundle", "--platform=browser", "--format=esm", `--outfile=${resolve(installDirectory, "browser-relay-bundle.mjs")}`],
  { cwd: root, encoding: "utf8" },
);
if (bundleRelay.status !== 0) {
  process.stderr.write(bundleRelay.stderr || bundleRelay.stdout);
  process.exit(bundleRelay.status ?? 1);
}

process.stdout.write(`Package install and smoke check passed: ${archives.join(", ")}\n`);
