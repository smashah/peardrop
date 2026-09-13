import { describe, expect, it } from "vitest";
import { normalizeCliArgv } from "../src/argv.js";

describe("default send invocation", () => {
  it("maps a slug and text payload to the send command", () => {
    expect(normalizeCliArgv(["early-kayak-fvz", "peardrop-relay-test"])).toEqual([
      "send",
      "early-kayak-fvz",
      "--text",
      "peardrop-relay-test",
    ]);
  });

  it("leaves explicit commands unchanged", () => {
    expect(normalizeCliArgv(["receive", "--json"])).toEqual(["receive", "--json"]);
    expect(normalizeCliArgv(["agent", "--install"])).toEqual(["agent", "--install"]);
    expect(normalizeCliArgv(["wait", "silent-moss-7f2"])).toEqual(["wait", "silent-moss-7f2"]);
    expect(normalizeCliArgv(["hook", "test", "--store", "file"])).toEqual(["hook:test", "--store", "file"]);
    expect(normalizeCliArgv(["spec", "check", "--spec", "d.toml"])).toEqual(["spec:check", "--spec", "d.toml"]);
    expect(normalizeCliArgv(["doctor", "--json"])).toEqual(["doctor", "--json"]);
    expect(normalizeCliArgv(["send", "early-kayak-fvz", "--text", "hello"])).toEqual([
      "send",
      "early-kayak-fvz",
      "--text",
      "hello",
    ]);
  });

  it("keeps global help and version flags at the root", () => {
    expect(normalizeCliArgv(["--help"])).toEqual(["--help"]);
    expect(normalizeCliArgv(["--version"])).toEqual(["--version"]);
  });

  it("routes shorthand flags to send without treating them as text", () => {
    expect(normalizeCliArgv(["early-kayak-fvz", "--browser"])).toEqual([
      "send",
      "early-kayak-fvz",
      "--browser",
    ]);
  });

  it("maps the first-class test nc spelling to the oclif topic command", () => {
    expect(normalizeCliArgv(["test", "nc", "--timeout", "30s"])).toEqual([
      "test:nc",
      "--timeout",
      "30s",
    ]);
  });
});
