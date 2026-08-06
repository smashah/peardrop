import { describe, expect, it } from "vitest";
import { expect as effectExpect, it as effectIt } from "@effect/vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import { DiskSink, PdwpSink } from "../src/bridge/BridgeServer.js";
import { connectDhtSender, createKeyPair, runDhtReceiver } from "../src/dht/DhtTransport.js";
import { FrameType, PdwpCodec } from "../src/protocol/pdwp.js";
import { resolveTargetLocation, sanitizeFilename } from "../src/storage/targetPath.js";
import { signRelayTicketSync, verifyRelayTicketSync } from "../src/tickets/RelayTicket.node.js";
import { signRelayTicket, verifyRelayTicket } from "../src/tickets/RelayTicket.js";

describe("@peardrop/core/node", () => {
  effectIt.effect("delivers headless DHT bytes only after receiver DONE acknowledgement", () =>
    Effect.scoped(Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "peardrop-dht-")), catch: (cause) => cause }),
        (path) => Effect.tryPromise({ try: () => rm(path, { recursive: true, force: true }), catch: () => undefined })
      );
      const ready = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<ReadonlyArray<unknown>>();
      const completionOrder = yield* Ref.make<ReadonlyArray<string>>([]);
      const abort = new AbortController();
      const keyPair = createKeyPair(Buffer.alloc(32, 7));
      yield* runDhtReceiver({
        keyPair,
        sink: new DiskSink(`${directory}/`),
        signal: abort.signal,
        onReady: () => Effect.runFork(Deferred.succeed(ready, undefined)),
        onDelivered: async (files) => {
          await Effect.runPromise(Ref.update(completionOrder, (events) => [...events, "persisted"]));
          abort.abort();
          await Effect.runPromise(Deferred.succeed(delivered, files));
        },
      }).pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      const sender = yield* connectDhtSender({ publicKeyHex: keyPair.publicKeyHex });
      sender.socket.on("error", () => undefined);
      const content = Buffer.from("receiver-done-gates-delivery");
      const sha256 = createHash("sha256").update(content).digest("hex");
      const sink = new PdwpSink(sender.socket);
      yield* Effect.tryPromise({ try: () => sink.onStart("files", [{ name: "ack.txt", bytes: content.length, sha256 }]), catch: (cause) => cause });
      yield* Effect.tryPromise({ try: () => sink.onChunk(0, 0, content), catch: (cause) => cause });
      yield* Effect.tryPromise({ try: () => sink.onFileEnd(0, sha256), catch: (cause) => cause });
      const acknowledged = yield* Effect.tryPromise({ try: () => sink.onDone(), catch: (cause) => cause });
      yield* Ref.update(completionOrder, (events) => [...events, "acknowledged"]);
      effectExpect(acknowledged).toHaveLength(1);
      effectExpect(yield* Deferred.await(delivered)).toHaveLength(1);
      effectExpect(yield* Ref.get(completionOrder)).toEqual(["persisted", "acknowledged"]);
      effectExpect(yield* Effect.tryPromise({ try: () => readFile(join(directory, "ack.txt"), "utf8"), catch: (cause) => cause })).toBe("receiver-done-gates-delivery");
      yield* Effect.sync(() => sender.close());
    }))
  );
  effectIt.effect("waits for receiver ACCEPT and DONE before sender delivery", () =>
    Effect.gen(function* () {
      const frames: Buffer[] = [];
      const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { frames.push(Buffer.from(chunk)); done(); } });
      const sink = new PdwpSink(socket, "1234");
      const start = sink.onStart("files", [{ name: "a.txt", bytes: 1, sha256: "a" }]);
      yield* Effect.sync(() => effectExpect(frames).toHaveLength(2));
      socket.emit("data", PdwpCodec.encodeJsonFrame(FrameType.ACCEPT, { ok: true }));
      yield* Effect.tryPromise({ try: () => start, catch: (cause) => cause });
      const done = sink.onDone();
      socket.emit("data", PdwpCodec.encodeJsonFrame(FrameType.DONE, { ok: true, files: [{ name: "a.txt", bytes: 1, sha256: "a" }] }));
      const files = yield* Effect.tryPromise({ try: () => done, catch: (cause) => cause });
      effectExpect(files).toEqual([{ name: "a.txt", bytes: 1, sha256: "a" }]);
    })
  );

  effectIt.effect("rotates DiskSink files and rejects bad offsets or hashes", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "peardrop-pdwp-")), catch: (cause) => cause }),
        (path) => Effect.tryPromise({ try: () => rm(path, { recursive: true, force: true }), catch: () => undefined })
      );
      const first = Buffer.from("first");
      const second = Buffer.from("second");
      const firstHash = createHash("sha256").update(first).digest("hex");
      const secondHash = createHash("sha256").update(second).digest("hex");
      const sink = new DiskSink(`${directory}/`);
      yield* Effect.tryPromise({ try: () => sink.onStart("files", [{ name: "one.txt", bytes: first.length, sha256: firstHash }, { name: "two.txt", bytes: second.length, sha256: secondHash }]), catch: (cause) => cause });
      yield* Effect.tryPromise({ try: () => sink.onChunk(0, 0, first), catch: (cause) => cause });
      yield* Effect.tryPromise({ try: () => sink.onFileEnd(0, firstHash), catch: (cause) => cause });
      yield* Effect.tryPromise({ try: () => sink.onChunk(1, 0, second), catch: (cause) => cause });
      yield* Effect.tryPromise({ try: () => sink.onFileEnd(1, secondHash), catch: (cause) => cause });
      effectExpect(yield* Effect.tryPromise({ try: () => readFile(join(directory, "one.txt"), "utf8"), catch: (cause) => cause })).toBe("first");
      effectExpect(yield* Effect.tryPromise({ try: () => readFile(join(directory, "two.txt"), "utf8"), catch: (cause) => cause })).toBe("second");
      const invalid = new DiskSink(`${directory}/invalid/`);
      yield* Effect.tryPromise({ try: () => invalid.onStart("files", [{ name: "bad.txt", bytes: 1, sha256: "bad" }]), catch: (cause) => cause });
      const offsetFailure = yield* Effect.tryPromise({ try: () => invalid.onChunk(0, 1, Buffer.from("x")), catch: (cause) => cause }).pipe(Effect.exit);
      effectExpect(Exit.isFailure(offsetFailure)).toBe(true);
      const mismatch = new DiskSink(`${directory}/mismatch/`);
      yield* Effect.tryPromise({ try: () => mismatch.onStart("files", [{ name: "hash.txt", bytes: 1, sha256: "expected" }]), catch: (cause) => cause });
      yield* Effect.tryPromise({ try: () => mismatch.onChunk(0, 0, Buffer.from("x")), catch: (cause) => cause });
      const hashFailure = yield* Effect.tryPromise({ try: () => mismatch.onFileEnd(0, "different"), catch: (cause) => cause }).pipe(Effect.exit);
      effectExpect(Exit.isFailure(hashFailure)).toBe(true);
      const published = yield* Effect.tryPromise({ try: () => access(join(directory, "mismatch", "hash.txt")), catch: (cause) => cause }).pipe(Effect.exit);
      effectExpect(Exit.isFailure(published)).toBe(true);
    })
  );
  describe("Target path safety", () => {
    it("sanitizes filenames and blocks path traversal", () => {
      expect(sanitizeFilename("../secret.txt")).toBe("secret.txt");
      expect(sanitizeFilename("foo/bar/key.p8")).toBe("key.p8");
      expect(() => sanitizeFilename("..")).toThrow();
    });

    it("resolves single file vs directory target specs", () => {
      const fileTarget = resolveTargetLocation("/tmp/output.p8");
      expect(fileTarget.resolveFilePath("anything.txt")).toBe("/tmp/output.p8");

      const dirTarget = resolveTargetLocation("/tmp/inbox/");
      expect(dirTarget.isDir).toBe(true);
      expect(dirTarget.resolveFilePath("key.p8")).toContain("key.p8");
    });
  });

  describe("Relay ticket node sync path", () => {
    it("interoperates with platform-neutral web crypto tickets", async () => {
      const claims = {
        slug: "relay-slug",
        publicKey: "ff00",
        capBytes: 2048,
        exp: Math.floor(Date.now() / 1000) + 120,
      };
      const webTicket = await signRelayTicket(claims, "shared-secret");
      const nodeVerified = verifyRelayTicketSync(webTicket, "shared-secret");
      expect(nodeVerified.slug).toBe("relay-slug");

      const nodeTicket = signRelayTicketSync(claims, "shared-secret");
      const webVerified = await verifyRelayTicket(nodeTicket, "shared-secret");
      expect(webVerified.publicKey).toBe("ff00");
    });
  });
});
