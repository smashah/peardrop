import { describe, expect, it } from "vitest";
import TestNcCommand from "../src/commands/test/nc.js";

describe("test nc command", () => {
  it("accepts the verbose diagnostics flag", () => {
    expect(TestNcCommand.flags).toHaveProperty("verbose");
  });
});
