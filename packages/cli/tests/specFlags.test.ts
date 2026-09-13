import { describe, expect, it } from "vitest";
import { parseDropSpecToml } from "@peardrop/core";
import { loadSpecFromFlags, rawSpecFromFlags } from "../src/specFlags.js";

describe("inline spec flags", () => {
  const flags = {
    title: "Starling personal access token",
    request: "Create the token, copy it, paste it below.",
    field: ["starling_pat:token:Starling personal access token"],
    "field-link": ["starling_pat=Create the token|https://developer.starlingbank.com/personal/token"],
    "field-min-length": ["starling_pat=20"],
    "field-shown-once": ["starling_pat"],
  };

  it("builds a validated spec without any TOML file", () => {
    const loaded = loadSpecFromFlags(flags);
    expect(loaded?.spec.title).toBe("Starling personal access token");
    expect(loaded?.spec.fields).toHaveLength(1);
    expect(loaded?.spec.fields[0]).toMatchObject({
      name: "starling_pat", type: "token", label: "Starling personal access token", required: true, shown_once: true, minLength: 20,
      link: { label: "Create the token", url: "https://developer.starlingbank.com/personal/token" },
    });
  });

  it("prints TOML that round-trips through --spec", () => {
    const loaded = loadSpecFromFlags(flags);
    expect(loaded?.toml).toContain("[[fields]]");
    expect(loaded?.toml).toContain('name = "starling_pat"');
    expect(parseDropSpecToml(loaded!.toml)).toEqual(loaded!.spec);
  });

  it("returns nothing when no spec flags are given", () => {
    expect(loadSpecFromFlags({})).toBeUndefined();
    expect(rawSpecFromFlags({ spec: "./drop.toml" })).toBeUndefined();
  });

  it("rejects mixing TOML and inline flags, unknown field names, and bad types", () => {
    expect(() => rawSpecFromFlags({ spec: "./drop.toml", title: "x" })).toThrow(/not both/);
    expect(() => rawSpecFromFlags({ field: ["a:token"], "field-link": ["b=https://x"] })).toThrow(/unknown field "b"/);
    expect(() => rawSpecFromFlags({ field: ["a:password"] })).toThrow(/type must be/);
    expect(() => rawSpecFromFlags({ title: "x" })).toThrow(/at least one --field/);
    expect(() => loadSpecFromFlags({ field: ["a:token"], "field-link": ["a=http://insecure"] })).toThrow(/https/);
  });

  it("supports optional, unmasked, scopes, and multiple fields", () => {
    const loaded = loadSpecFromFlags({
      field: ["client_id:text:OAuth client ID", "client_secret:secret"],
      "field-optional": ["client_id"],
      "field-scope": ["client_id=openid, email"],
      "field-unmasked": ["client_secret"],
      "on-receive": "./store.sh",
    });
    expect(loaded?.spec.fields.map((f) => [f.name, f.required, f.masked])).toEqual([["client_id", false, undefined], ["client_secret", true, false]]);
    expect(loaded?.spec.fields[0]?.scope).toEqual(["openid", "email"]);
    expect(loaded?.spec.hooks.on_receive).toBe("./store.sh");
  });
});
