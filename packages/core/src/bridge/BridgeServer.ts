import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { generateSingleUseToken } from "../tunnel/crypto.js";
import { DiskWriter, type ReceivedFileResult } from "../storage/diskWriter.js";
import { DonePayloadSchema, FrameType, PdwpCodec, PdwpFrameParser } from "../protocol/pdwp.js";
import * as Schema from "effect/Schema";
import { TransportError } from "../effect/errors.js";
import { parseMultipartUpload, setSecureFileMode } from "./uploadParser.js";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);

export interface BridgeSink {
  onStart(kind: "files" | "text", files: ReadonlyArray<{ name: string; bytes: number; sha256: string }>): Promise<void>;
  onChunk(fileIndex: number, offset: number, chunk: Buffer): Promise<void>;
  onFileEnd(fileIndex: number, sha256: string): Promise<void>;
  onDone(): Promise<ReadonlyArray<DeliveredFile>>;
  onError(err: Error): Promise<void>;
}

export interface DeliveredFile {
  readonly name: string;
  readonly path?: string;
  readonly bytes: number;
  readonly sha256: string;
}

export class PdwpSink implements BridgeSink {
  private socket: Duplex;
  private readonly receiverDone = Deferred.makeUnsafe<ReadonlyArray<DeliveredFile>, Error>();
  private readonly receiverAccepted = Deferred.makeUnsafe<void, Error>();
  private readonly parser = new PdwpFrameParser();

  constructor(socket: Duplex, private readonly pin?: string) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const frame of this.parser.append(chunk)) {
          if (frame.type === FrameType.ACCEPT) Effect.runFork(Deferred.succeed(this.receiverAccepted, undefined));
          if (frame.type === FrameType.DONE) {
            const done = Schema.decodeUnknownSync(DonePayloadSchema)(frame.payload);
            Effect.runFork(Deferred.succeed(this.receiverDone, done.files ?? []));
          }
          if (frame.type === FrameType.ERR) {
            const error = new Error("Receiver rejected PDWP transfer");
            Effect.runFork(Deferred.fail(this.receiverAccepted, error));
            Effect.runFork(Deferred.fail(this.receiverDone, error));
          }
        }
      } catch (cause) {
        Effect.runFork(Deferred.fail(this.receiverDone, cause instanceof Error ? cause : new Error(String(cause))));
      }
    });
    socket.once("close", () => {
      const error = new Error("Receiver connection closed before delivery acknowledgement");
      Effect.runFork(Deferred.fail(this.receiverAccepted, error));
      Effect.runFork(Deferred.fail(this.receiverDone, error));
    });
  }

  async onStart(kind: "files" | "text", files: ReadonlyArray<{ name: string; bytes: number; sha256: string }>): Promise<void> {
    const totalBytes = files.reduce((acc, f) => acc + f.bytes, 0);
    this.socket.write(PdwpCodec.encodeJsonFrame(FrameType.HELLO, { v: 1, pin: this.pin }));
    const manifestBuf = PdwpCodec.encodeJsonFrame(FrameType.MANIFEST, { files, totalBytes, kind });
    this.socket.write(manifestBuf);
    await Effect.runPromise(Deferred.await(this.receiverAccepted));
  }

  async onChunk(fileIndex: number, offset: number, chunk: Buffer): Promise<void> {
    const chunkBuf = PdwpCodec.encodeFileChunkFrame(fileIndex, offset, chunk);
    this.socket.write(chunkBuf);
  }

  async onFileEnd(fileIndex: number, sha256: string): Promise<void> {
    const endBuf = PdwpCodec.encodeJsonFrame(FrameType.FILE_END, { fileIndex, sha256 });
    this.socket.write(endBuf);
  }

  async onDone(): Promise<ReadonlyArray<DeliveredFile>> {
    return Effect.runPromise(Deferred.await(this.receiverDone));
  }

  async onError(err: Error): Promise<void> {
    const errBuf = PdwpCodec.encodeJsonFrame(FrameType.ERR, { code: "UNKNOWN", message: err.message });
    this.socket.write(errBuf);
  }
}

export class DiskSink implements BridgeSink {
  private writer: DiskWriter;
  private currentFiles: ReadonlyArray<{ name: string; bytes: number; sha256: string }> = [];
  private currentFileIndex = -1;
  private currentOffset = 0;

  constructor(targetSpec: string) {
    this.writer = new DiskWriter(targetSpec);
  }

  async onStart(_kind: "files" | "text", files: ReadonlyArray<{ name: string; bytes: number; sha256: string }>): Promise<void> {
    this.currentFiles = files;
    this.currentFileIndex = -1;
    this.currentOffset = 0;
    if (files.length > 0) this.openFile(0);
  }

  async onChunk(fileIndex: number, offset: number, chunk: Buffer): Promise<void> {
    const fileMeta = this.currentFiles[fileIndex];
    if (!fileMeta) throw new Error(`Invalid file index ${fileIndex}`);
    if (fileIndex !== this.currentFileIndex || offset !== this.currentOffset || this.currentOffset + chunk.length > fileMeta.bytes) {
      throw new Error("PDWP file chunk is out of order or exceeds its manifest size");
    }
    this.writer.writeChunk(chunk);
    this.currentOffset += chunk.length;
  }

  async onFileEnd(fileIndex: number, sha256: string): Promise<void> {
    const fileMeta = this.currentFiles[fileIndex];
    if (!fileMeta) throw new Error(`Invalid file index ${fileIndex}`);
    if (fileIndex !== this.currentFileIndex || this.currentOffset !== fileMeta.bytes) throw new Error("PDWP file length does not match manifest");
    if (sha256 !== fileMeta.sha256) throw new Error("PDWP FILE_END hash does not match manifest");
    await Effect.runPromise(this.writer.finalizeFile(fileMeta.name, sha256));
    this.currentFileIndex = -1;
    this.currentOffset = 0;
    if (fileIndex + 1 < this.currentFiles.length) this.openFile(fileIndex + 1);
  }

  async onDone(): Promise<ReceivedFileResult[]> {
    return this.writer.getReceivedFiles();
  }

  async onError(_err: Error): Promise<void> {
    this.writer.abortCurrentFile();
  }

  private openFile(fileIndex: number): void {
    const file = this.currentFiles[fileIndex];
    if (!file) throw new Error(`Invalid file index ${fileIndex}`);
    this.writer.startFile(file.name);
    this.currentFileIndex = fileIndex;
  }
}

export interface BridgeServerOptions {
  host?: string;
  port?: number;
  sink: BridgeSink;
  targetPathLabel?: string;
  maxSizeMB?: number;
  expectedFiles?: number;
}

export class BridgeServer {
  private readonly completion = Deferred.makeUnsafe<"delivered" | "failed">();
  private server: Server | null = null;
  private token: string;
  private tokenUsed = false;
  private sink: BridgeSink;
  private host: string;
  private port: number;
  private targetPathLabel: string;
  private maxSizeMB?: number;
  private expectedFiles?: number;

  constructor(options: BridgeServerOptions) {
    this.token = generateSingleUseToken();
    this.sink = options.sink;
    this.host = options.host || "127.0.0.1";
    this.port = options.port || 0; // 0 = random available port
    this.targetPathLabel = options.targetPathLabel || "Destination target";
    this.maxSizeMB = options.maxSizeMB;
    this.expectedFiles = options.expectedFiles;
  }

  async start(): Promise<{ url: string; port: number; token: string }> {
    return Effect.runPromise(Effect.callback<{ url: string; port: number; token: string }, TransportError>((resume) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      this.server.listen(this.port, this.host, () => {
        const addr = this.server?.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : this.port;
        this.port = boundPort;
        const url = `http://${this.host}:${boundPort}/#${this.token}`;
        resume(Effect.succeed({ url, port: boundPort, token: this.token }));
      });

      const onError = (cause: Error) => resume(Effect.fail(new TransportError({ message: cause.message })));
      this.server.once("error", onError);
      return Effect.sync(() => this.server?.off("error", onError));
    }));
  }

  async stop(): Promise<void> {
    if (this.server) {
      const server = this.server;
      await Effect.runPromise(Effect.callback<void, TransportError>((resume) => {
        server.close((cause) => cause
          ? resume(Effect.fail(new TransportError({ message: cause.message })))
          : resume(Effect.void));
      }));
      this.server = null;
    }
  }

  awaitCompletion() {
    return Deferred.await(this.completion);
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Enable CORS for loopback
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token");
    res.setHeader("Content-Security-Policy", "default-src 'self' 'unsafe-inline'; img-src 'self' data:");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html")) {
      this.serveDropPage(res);
      return;
    }

    if (req.method === "POST" && reqUrl.pathname === "/upload") {
      // Validate token
      const reqToken = req.headers["x-bridge-token"] || reqUrl.searchParams.get("token");
      if (!reqToken || reqToken !== this.token) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing token" }));
        return;
      }
      if (this.tokenUsed) {
        res.writeHead(410, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Single-use token has already been consumed" }));
        return;
      }

      this.tokenUsed = true;
      this.handleUpload(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }

  private serveDropPage(res: ServerResponse): void {
    const targetLabel = escapeHtml(this.targetPathLabel);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PearDrop Local Bridge</title>
  <style>
    * { box-sizing: border-box; } body { margin: 0; min-height: 100vh; display:grid; place-items:center; padding:1rem; font-family:system-ui,-apple-system,sans-serif; background:#020617; color:#f8fafc; } .card { width:min(100%,32rem); padding:1.5rem; border:1px solid #1e293b; border-radius:.75rem; background:#0f172a; } .drop { border:2px dashed #334155; border-radius:.5rem; padding:2rem; text-align:center; cursor:pointer; } textarea,button { width:100%; margin-top:1rem; padding:.75rem; border-radius:.4rem; } textarea { color:#e2e8f0; background:#020617; border:1px solid #334155; } button { color:#022c22; border:0; background:#34d399; font-weight:700; } .muted { color:#94a3b8; } .mono { font-family:ui-monospace,monospace; color:#6ee7b7; }
  </style>
</head>
<body>
  <div class="card">
    <div class="flex items-center space-x-3 mb-4">
      <div class="w-3 h-3 rounded-full bg-emerald-500"></div>
      <h1 class="text-xl font-bold text-slate-100">PearDrop Drop Surface</h1>
    </div>
    <p class="muted">Target: <span class="mono">${targetLabel}</span></p>

    <div id="drop-zone" class="drop">
      <p class="text-slate-300 font-medium">Drag & drop files here or click to select</p>
      <input type="file" id="file-input" multiple class="hidden">
    </div>

    <div class="mb-4">
      <label class="block text-xs text-slate-400 mb-1">Or Paste Secret / Text</label>
      <textarea id="text-input" rows="4" class="w-full bg-slate-950 border border-slate-800 rounded-md p-3 text-sm text-slate-200 font-mono focus:outline-none focus:border-emerald-500" placeholder="Paste secret, token, or content..."></textarea>
    </div>

    <button id="send-btn" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-semibold rounded-md transition-colors shadow">
      Send Payload
    </button>
    <div id="status" class="mt-4 text-sm font-mono text-center min-h-[20px]"></div>
  </div>

  <script>
    const token = window.location.hash.substring(1);
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const textInput = document.getElementById('text-input');
    const sendBtn = document.getElementById('send-btn');
    const status = document.getElementById('status');
    let selectedFiles = [];

    dropZone.onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
      selectedFiles = Array.from(e.target.files);
      status.innerText = selectedFiles.length + ' file(s) selected';
    };
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('border-emerald-500'); };
    dropZone.ondragleave = () => dropZone.classList.remove('border-emerald-500');
    dropZone.ondrop = (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-emerald-500');
      selectedFiles = Array.from(e.dataTransfer.files);
      status.innerText = selectedFiles.length + ' file(s) selected';
    };

    sendBtn.onclick = async () => {
      if (!token) { status.className = 'text-red-400'; status.innerText = 'Error: Missing token'; return; }
      status.className = 'text-emerald-400';
      status.innerText = 'Preparing upload...';

      let files = [];
      const textVal = textInput.value.trim();

      if (selectedFiles.length > 0) {
        for (const file of selectedFiles) {
          const buf = await file.arrayBuffer();
          const hashBuf = await crypto.subtle.digest('SHA-256', buf);
          const sha256 = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
          files.push({ name: file.name, bytes: file.size, sha256, data: Array.from(new Uint8Array(buf)) });
        }
      } else if (textVal) {
        const encoder = new TextEncoder();
        const buf = encoder.encode(textVal);
        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        const sha256 = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
        files.push({ name: 'pasted-secret.txt', bytes: buf.byteLength, sha256, data: Array.from(buf) });
      } else {
        status.className = 'text-amber-400';
        status.innerText = 'Please select a file or paste text first.';
        return;
      }

      try {
        const res = await fetch('/upload?token=' + token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token },
          body: JSON.stringify({ kind: selectedFiles.length > 0 ? 'files' : 'text', files })
        });
        const data = await res.json();
        if (res.ok) {
          status.className = 'text-emerald-400 font-bold';
          status.innerText = '✓ Payload delivered! Link is now dead.';
          sendBtn.disabled = true;
          sendBtn.classList.add('opacity-50');
        } else {
          status.className = 'text-red-400';
          status.innerText = 'Error: ' + (data.error || 'Upload failed');
        }
      } catch (err) {
        status.className = 'text-red-400';
        status.innerText = 'Network error: ' + err.message;
      }
    };
  </script>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  }

  private async handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const upload = await parseMultipartUpload(req, this.maxSizeMB, this.expectedFiles);

      await this.sink.onStart(
        upload.kind,
        upload.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 }))
      );

      for (let idx = 0; idx < upload.files.length; idx++) {
        const file = upload.files[idx]!;
        await this.sink.onChunk(idx, 0, file.data);
        await this.sink.onFileEnd(idx, file.sha256);
      }

      const deliveredFiles = await this.sink.onDone();
      for (const f of deliveredFiles) {
        if (f.path) setSecureFileMode(f.path);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "delivered", files: deliveredFiles }));
      Effect.runFork(Deferred.succeed(this.completion, "delivered"));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload processing error";
      await this.sink.onError(err instanceof Error ? err : new Error(message));
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      Effect.runFork(Deferred.succeed(this.completion, "failed"));
    }
  }
}
