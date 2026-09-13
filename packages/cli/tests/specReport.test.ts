import { describe, expect, it } from "vitest";
import { parseDropSpecToml } from "@peardrop/core";
import { describeSpec, formatSpecReport } from "../src/specReport.js";

describe("spec check report", () => {
  it("lists fields, labels, links, and delivered filenames deterministically", () => {
    const spec = parseDropSpecToml(`title = "T"
[hooks]
on_receive = "./store.sh"
[[fields]]
name = "api_token"
type = "token"
label = "API token"
link = { url = "https://console.example.com/tokens" }
[[fields]]
name = "certs"
type = "file"
count = 2
required = false
`);
    const report = describeSpec(spec);
    expect(report).toMatchObject({ title: "T", fieldCount: 2, needsDirectoryTarget: true, hook: "./store.sh", links: ["https://console.example.com/tokens"] });
    expect(report.fields.map((f) => f.deliveredAs)).toEqual(["api_token.txt", "certs-<n>-<original name>"]);
    expect(report.fields[0]).toMatchObject({ masked: true, required: true, label: "API token" });
    expect(formatSpecReport(report)).toContain('api_token (token, masked) "API token" -> api_token.txt  link https://console.example.com/tokens');
  });
});
