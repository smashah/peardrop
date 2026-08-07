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
import { type DropSpec, isMasked } from "../spec/dropSpec.js";
import { parseSpecUpload } from "./specUpload.js";
import { runOnReceiveHook, type OnReceiveHookResult } from "../hooks/onReceive.js";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);

// PearDrop's monochrome identity, restated for the CLI bridge. This page is
// rendered by Node with no build step, so it can't import the webapp's
// stylesheet — the token values here must be kept in step with DESIGN.md
// (peardrop.fyi) by hand. Both drop pages share this block so they can't drift
// from each other. Near-black on white, square corners, hairline rules; the
// only non-neutral value is --danger, and it never appears without text.
const DROP_PAGE_STYLES = `
    :root {
      color-scheme: light dark;
      --surface: #ffffff; --surface-raised: #fafafa; --surface-deep: #f5f5f5; --surface-invert: #171717;
      --text: #0c0a09; --text-muted: #525252; --text-quiet: #737373; --text-invert: #f5f5f5;
      --line: #e5e5e5; --line-strong: #d4d4d4; --danger: #b42318;
      --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --surface: #0a0a0a; --surface-raised: #121212; --surface-deep: #171717; --surface-invert: #fafafa;
        --text: #fafafa; --text-muted: #a3a3a3; --text-quiet: #8a8a8a; --text-invert: #0a0a0a;
        --line: #262626; --line-strong: #404040; --danger: #f97066;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1rem; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--surface); color: var(--text); }
    .card { width: min(100%, 32rem); padding: 1.75rem; border: 1px solid var(--line); background: var(--surface-raised); }
    .header { display: flex; align-items: center; gap: .6rem; padding-bottom: 1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--line); }
    .mark { flex: none; width: .65rem; height: .65rem; background: var(--text); }
    h1 { margin: 0; font-size: 1.05rem; font-weight: 600; letter-spacing: -.015em; }
    .muted { margin: .5rem 0 0; color: var(--text-muted); font-size: .85rem; line-height: 1.6; }
    .mono { color: var(--text); font-family: var(--mono); }
    .field { margin-top: 1.25rem; }
    label { display: block; margin-bottom: .35rem; color: var(--text-quiet); font: .7rem var(--mono); letter-spacing: .09em; text-transform: uppercase; }
    input, textarea { width: 100%; padding: .7rem; border: 1px solid var(--line-strong); background: var(--surface); color: var(--text); font-family: var(--mono); font-size: .8rem; }
    input:focus, textarea:focus { border-color: var(--text); outline: 2px solid var(--text); outline-offset: -1px; }
    .drop { margin-top: 1.25rem; padding: 1.75rem; border: 1px dashed var(--line-strong); color: var(--text-muted); text-align: center; cursor: pointer; transition: border-color .18s ease, background .18s ease; }
    .drop p { margin: 0; }
    .drop:hover, .drop.is-active { border-color: var(--text); background: var(--surface-deep); }
    .error { margin-top: .3rem; min-height: 1rem; color: var(--danger); font-size: .75rem; }
    button { width: 100%; margin-top: 1.5rem; padding: .8rem; border: 1px solid var(--surface-invert); background: var(--surface-invert); color: var(--text-invert); font: inherit; font-weight: 500; cursor: pointer; transition: opacity .18s ease; }
    button:hover:not(:disabled) { opacity: .84; }
    button:disabled { opacity: .48; cursor: not-allowed; }
    #status { margin-top: 1rem; min-height: 1.25rem; color: var(--text-muted); font: .8rem var(--mono); text-align: center; }
    #status.is-error { color: var(--danger); }
    #status.is-done { color: var(--text); font-weight: 500; }
`;

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

/** Post-receive hook wiring: the command plus the resolved path it is told about. */
export interface BridgeOnReceiveHook {
  readonly command: string;
  readonly targetPath: string;
}

export interface BridgeServerOptions {
  host?: string;
  port?: number;
  sink: BridgeSink;
  targetPathLabel?: string;
  maxSizeMB?: number;
  expectedFiles?: number;
  spec?: DropSpec;
  onReceive?: BridgeOnReceiveHook;
  /** Sink for hook output; defaults to this process's stderr. */
  hookLog?: (chunk: string) => void;
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
  private spec?: DropSpec;
  private onReceive?: BridgeOnReceiveHook;
  private hookLog?: (chunk: string) => void;
  private lastHookResult: OnReceiveHookResult | null = null;

  constructor(options: BridgeServerOptions) {
    this.token = generateSingleUseToken();
    this.sink = options.sink;
    this.host = options.host || "127.0.0.1";
    this.port = options.port || 0; // 0 = random available port
    this.targetPathLabel = options.targetPathLabel || "Destination target";
    this.maxSizeMB = options.maxSizeMB;
    this.expectedFiles = options.expectedFiles;
    this.spec = options.spec;
    this.onReceive = options.onReceive;
    this.hookLog = options.hookLog;
  }

  /** Result of the post-receive hook, or null when no hook ran. */
  hookResult(): OnReceiveHookResult | null {
    return this.lastHookResult;
  }

  /**
   * Runs the post-receive hook after the delivery response has already gone out.
   * A failing hook is logged, never rethrown: the secret is written and the drop
   * stands regardless of what the side effect does.
   */
  private async runReceiveHook(deliveredFiles: ReadonlyArray<DeliveredFile>): Promise<void> {
    if (!this.onReceive) return;
    this.lastHookResult = await runOnReceiveHook({
      command: this.onReceive.command,
      targetPath: this.onReceive.targetPath,
      files: deliveredFiles,
      log: this.hookLog,
    });
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
      if (this.spec) {
        this.serveSpecDropPage(res, this.spec);
      } else {
        this.serveDropPage(res);
      }
      return;
    }

    if (req.method === "POST" && reqUrl.pathname === "/upload") {
      // Validate token. The token is only marked used on a *successful* delivery
      // (see handleUpload/handleSpecUpload) so a validation failure leaves the
      // form resubmittable rather than burning the single-use link.
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

      if (this.spec) {
        this.handleSpecUpload(req, res, this.spec);
      } else {
        this.handleUpload(req, res);
      }
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
${DROP_PAGE_STYLES}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <span class="mark"></span>
      <h1>PearDrop Drop Surface</h1>
    </div>
    <p class="muted">Target: <span class="mono">${targetLabel}</span></p>

    <div id="drop-zone" class="drop">
      <p>Drag &amp; drop files here or click to select</p>
      <input type="file" id="file-input" multiple hidden>
    </div>

    <div class="field">
      <label for="text-input">Or paste secret / text</label>
      <textarea id="text-input" rows="4" placeholder="Paste secret, token, or content..."></textarea>
    </div>

    <button id="send-btn">Send Payload</button>
    <div id="status"></div>
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
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('is-active'); };
    dropZone.ondragleave = () => dropZone.classList.remove('is-active');
    dropZone.ondrop = (e) => {
      e.preventDefault();
      dropZone.classList.remove('is-active');
      selectedFiles = Array.from(e.dataTransfer.files);
      status.innerText = selectedFiles.length + ' file(s) selected';
    };

    sendBtn.onclick = async () => {
      if (!token) { status.className = 'is-error'; status.innerText = 'Error: Missing token'; return; }
      status.className = '';
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
        status.className = 'is-error';
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
          status.className = 'is-done';
          status.innerText = '✓ Payload delivered! Link is now dead.';
          sendBtn.disabled = true;
        } else {
          status.className = 'is-error';
          status.innerText = 'Error: ' + (data.error || 'Upload failed');
        }
      } catch (err) {
        status.className = 'is-error';
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

      this.tokenUsed = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "delivered", files: deliveredFiles }));
      // The hook runs after the sender is told the drop landed, but before the
      // session is reported complete, so the CLI doesn't exit out from under it.
      await this.runReceiveHook(deliveredFiles);
      Effect.runFork(Deferred.succeed(this.completion, "delivered"));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload processing error";
      await this.sink.onError(err instanceof Error ? err : new Error(message));
      this.tokenUsed = true;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      Effect.runFork(Deferred.succeed(this.completion, "failed"));
    }
  }

  private serveSpecDropPage(res: ServerResponse, spec: DropSpec): void {
    const targetLabel = escapeHtml(this.targetPathLabel);
    const clientSpec = {
      title: spec.title ?? "PearDrop Drop Surface",
      description: spec.description ?? "",
      copy: {
        request: spec.copy.request ?? "Fill in the fields below and submit.",
        success: spec.copy.success ?? "Delivered — you can close this tab.",
        failure: spec.copy.failure ?? "Submission failed — check the errors below and try again.",
      },
      fields: spec.fields.map((field) => ({
        name: field.name,
        type: field.type,
        label: field.label ?? field.name,
        required: field.required,
        masked: isMasked(field),
        placeholder: field.placeholder ?? "",
        minLength: field.minLength ?? null,
        maxLength: field.maxLength ?? null,
        format: field.format ?? null,
        count: field.count ?? 1,
      })),
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(clientSpec.title)}</title>
  <style>
${DROP_PAGE_STYLES}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <span class="mark"></span>
      <h1>${escapeHtml(clientSpec.title)}</h1>
    </div>
    ${clientSpec.description ? `<p class="muted">${escapeHtml(clientSpec.description)}</p>` : ""}
    <p class="muted">Target: <span class="mono">${targetLabel}</span></p>
    <p class="muted">${escapeHtml(clientSpec.copy.request)}</p>
    <form id="drop-form"></form>
    <button id="send-btn">Send Payload</button>
    <div id="status"></div>
  </div>
  <script id="peardrop-spec" type="application/json">${JSON.stringify(clientSpec)}</script>
  <script>
    const spec = JSON.parse(document.getElementById('peardrop-spec').textContent);
    const token = window.location.hash.substring(1);
    const form = document.getElementById('drop-form');
    const sendBtn = document.getElementById('send-btn');
    const status = document.getElementById('status');
    const fileSelections = {};

    for (const field of spec.fields) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const label = document.createElement('label');
      label.textContent = field.label + (field.required ? ' *' : '');
      wrap.appendChild(label);

      let input;
      if (field.type === 'file') {
        input = document.createElement('input');
        input.type = 'file';
        if (field.count > 1) input.multiple = true;
        input.onchange = (e) => { fileSelections[field.name] = Array.from(e.target.files); };
      } else {
        input = document.createElement('input');
        input.type = field.masked ? 'password' : 'text';
        input.placeholder = field.placeholder;
      }
      input.id = 'field-' + field.name;
      wrap.appendChild(input);

      const err = document.createElement('div');
      err.className = 'error';
      err.id = 'error-' + field.name;
      wrap.appendChild(err);

      form.appendChild(wrap);
    }

    async function sha256Hex(buf) {
      const hashBuf = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function validateClientSide(field, textValue, files) {
      if (field.type === 'file') {
        if (field.required && files.length === 0) return 'This field is required.';
        if (files.length > 0 && files.length !== field.count) return 'Expected exactly ' + field.count + ' file(s).';
        return null;
      }
      if (field.required && textValue.trim().length === 0) return 'This field is required.';
      if (textValue.length === 0) return null;
      if (field.minLength !== null && textValue.length < field.minLength) return 'Must be at least ' + field.minLength + ' characters.';
      if (field.maxLength !== null && textValue.length > field.maxLength) return 'Must be at most ' + field.maxLength + ' characters.';
      if (field.format !== null && !new RegExp(field.format).test(textValue)) return "This value doesn't match the expected format.";
      return null;
    }

    sendBtn.onclick = async () => {
      if (!token) { status.className = 'is-error'; status.textContent = 'Error: Missing token'; return; }
      document.querySelectorAll('.error').forEach((el) => (el.textContent = ''));

      const values = {};
      let hasClientError = false;
      for (const field of spec.fields) {
        const el = document.getElementById('field-' + field.name);
        const files = fileSelections[field.name] || [];
        const textValue = field.type === 'file' ? '' : el.value;
        const clientError = validateClientSide(field, textValue, files);
        if (clientError) {
          document.getElementById('error-' + field.name).textContent = clientError;
          hasClientError = true;
          continue;
        }
        if (field.type === 'file') {
          if (files.length === 0) continue;
          const encoded = [];
          for (const file of files) {
            const buf = await file.arrayBuffer();
            const sha256 = await sha256Hex(buf);
            encoded.push({ name: file.name, bytes: file.size, sha256, data: Array.from(new Uint8Array(buf)) });
          }
          values[field.name] = { kind: 'file', files: encoded };
        } else if (textValue.length > 0) {
          values[field.name] = { kind: 'text', text: textValue };
        }
      }
      if (hasClientError) {
        status.className = 'is-error';
        status.textContent = spec.copy.failure;
        return;
      }

      status.className = '';
      status.textContent = 'Sending...';
      try {
        const res = await fetch('/upload?token=' + token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token },
          body: JSON.stringify({ values }),
        });
        const data = await res.json();
        if (res.ok) {
          status.className = 'is-done';
          status.textContent = spec.copy.success;
          sendBtn.disabled = true;
        } else if (data.errors) {
          status.className = 'is-error';
          status.textContent = spec.copy.failure;
          for (const [name, message] of Object.entries(data.errors)) {
            const el = document.getElementById('error-' + name);
            if (el) el.textContent = message;
          }
        } else {
          status.className = 'is-error';
          status.textContent = data.error || spec.copy.failure;
        }
      } catch (err) {
        status.className = 'is-error';
        status.textContent = 'Network error: ' + err.message;
      }
    };
  </script>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  }

  private async handleSpecUpload(req: IncomingMessage, res: ServerResponse, spec: DropSpec): Promise<void> {
    let result: Awaited<ReturnType<typeof parseSpecUpload>>;
    try {
      result = await parseSpecUpload(req, spec, this.maxSizeMB);
    } catch (err) {
      // A structural error (e.g. body-size limit) — not a per-field validation
      // failure, but still recoverable: the token stays live for a retry.
      const message = err instanceof Error ? err.message : "Upload processing error";
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return;
    }

    if (!result.ok) {
      // Validation failed: re-render with field-level messages, nothing stored,
      // token stays live so the human/agent can fix and resubmit.
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, errors: result.errors }));
      return;
    }

    try {
      await this.sink.onStart(
        "files",
        result.files.map((f) => ({ name: f.filename, bytes: f.data.length, sha256: f.sha256 }))
      );
      for (let idx = 0; idx < result.files.length; idx++) {
        const file = result.files[idx]!;
        await this.sink.onChunk(idx, 0, file.data);
        await this.sink.onFileEnd(idx, file.sha256);
      }
      const deliveredFiles = await this.sink.onDone();
      for (const f of deliveredFiles) {
        if (f.path) setSecureFileMode(f.path);
      }

      this.tokenUsed = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "delivered", files: deliveredFiles }));
      await this.runReceiveHook(deliveredFiles);
      Effect.runFork(Deferred.succeed(this.completion, "delivered"));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload processing error";
      await this.sink.onError(err instanceof Error ? err : new Error(message));
      this.tokenUsed = true;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      Effect.runFork(Deferred.succeed(this.completion, "failed"));
    }
  }
}
