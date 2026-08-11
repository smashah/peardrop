#!/usr/bin/env node
// relay-e2e-send — browser-equivalent relay-path sender for end-to-end tests.
//
// Speaks the EXACT protocol the drop page speaks: Worker relay-ticket → WS to
// the relay → dht-relay client Node over the socket → PdwpSink (manifest /
// ACCEPT / chunks / DONE) against a real receiver. Exists because on
// 2026-08-11 the only true test of this path was a human pasting a credential
// into a page — twice, onto two different broken relays. Run this before any
// relay deploy is called verified, and never hand a drop page to a human
// without a pass from it against the same relay build.
//
//   node scripts/relay-e2e-send.mjs <slug> [worker-url]
//
// Exit codes: 0 delivered+confirmed · 2 ws/connect failure · 3 accept/transfer failure
import WebSocket from "ws";
import DhtRelayNode from "@hyperswarm/dht-relay";
import Stream from "@hyperswarm/dht-relay/ws";
import { PdwpSink } from "@peardrop/core/node";
import { createHash } from "node:crypto";

const slug = process.argv[2];
const workerUrl = (process.argv[3] ?? "https://peardrop.fyi").replace(/\/$/, "");
if (!slug) {
  console.error("usage: relay-e2e-send.mjs <slug> [worker-url]");
  process.exit(2);
}

const step = (name) => console.log(`[relay-e2e] ${name}`);

const desc = await (await fetch(`${workerUrl}/api/tunnels/${slug}`)).json();
if (!desc?.publicKey) {
  console.error("[relay-e2e] no publicKey in tunnel descriptor — receiver down?");
  process.exit(2);
}
step(`descriptor ok (fingerprint-bearing pubkey ${desc.publicKey.slice(0, 8)}…)`);

const ticketRes = await (
  await fetch(`${workerUrl}/api/tunnels/${slug}/relay-ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
).json();
if (!ticketRes?.ticket || !ticketRes?.relayUrl) {
  console.error("[relay-e2e] ticket issuance failed:", JSON.stringify(ticketRes).slice(0, 200));
  process.exit(2);
}
step(`ticket issued for ${ticketRes.relayUrl}`);

const regionParam = ticketRes.region ? `&region=${encodeURIComponent(ticketRes.region)}` : "";
const ws = new WebSocket(`${ticketRes.relayUrl}?ticket=${encodeURIComponent(ticketRes.ticket)}${regionParam}`);
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WS open timeout (15s)")), 15_000);
    ws.once("open", () => { clearTimeout(t); resolve(); });
    ws.once("error", (e) => { clearTimeout(t); reject(e); });
    ws.once("close", (code) => { clearTimeout(t); reject(new Error(`WS closed pre-open code=${code}`)); });
  });
} catch (e) {
  console.error("[relay-e2e] RELAY WS FAILED:", e.message);
  process.exit(2);
}
step("relay WS open");
let delivered = false;
ws.once("close", (code) => {
  step(`ws close code=${code}`);
  if (!delivered) {
    // Commissioning run 2026-08-11: relay crashed post-open (code 1006) and the
    // pending onStart promise never settled, so node exited 0 — a green exit on
    // a dead transfer. Never let that happen again.
    console.error("[relay-e2e] RELAY CLOSED BEFORE DELIVERY — treating as failure");
    process.exit(3);
  }
});

const dht = new DhtRelayNode(new Stream(true, ws), { custodial: false });
const socket = dht.connect(Buffer.from(desc.publicKey, "hex"));
socket.once("error", (e) => { console.error("[relay-e2e] socket error:", e.message); });

const text = Buffer.from(`relay-e2e proof ${new Date().toISOString()}\n`);
const sha256 = createHash("sha256").update(text).digest("hex");
const sink = new PdwpSink(socket, undefined);
try {
  await sink.onStart("files", [{ name: "relay-e2e.txt", bytes: text.length, sha256 }]);
  step("manifest ACCEPTed by receiver");
  await sink.onChunk(0, 0, text);
  await sink.onFileEnd(0, sha256);
  const received = await sink.onDone();
  delivered = true;
  step(`DONE — receiver confirmed ${received.length} file(s)`);
  process.exit(0);
} catch (e) {
  console.error("[relay-e2e] TRANSFER FAILED:", e.message);
  process.exit(3);
}
