import { describe, expect, it } from "vitest";
import { parseMsgId, rejectExtraArgs, resolveTarget } from "../src/system/chat-client.js";

describe("resolveTarget", () => {
  it("resolves @ID prefix", () => {
    expect(resolveTarget("@1000000004")).toBe(1000000004);
  });

  it("resolves ~ID prefix (backward compat)", () => {
    expect(resolveTarget("~1000000004")).toBe(1000000004);
  });

  it("resolves bare number", () => {
    expect(resolveTarget("123")).toBe(123);
  });

  it("throws when no target provided", () => {
    expect(() => resolveTarget()).toThrow("missing target");
  });

  it("throws on invalid target", () => {
    expect(() => resolveTarget("not-a-number")).toThrow('invalid target: "not-a-number"');
  });
});

describe("parseMsgId", () => {
  it("parses bare number", () => {
    expect(parseMsgId("5791")).toBe(5791);
  });

  it("tolerates # prefix", () => {
    expect(parseMsgId("#5791")).toBe(5791);
  });

  it("throws on invalid input", () => {
    expect(() => parseMsgId("abc")).toThrow("invalid message ID");
  });
});

describe("rejectExtraArgs", () => {
  it("passes when args count matches", () => {
    expect(() => rejectExtraArgs(["hello"], 1, "say")).not.toThrow();
  });

  it("passes when fewer args", () => {
    expect(() => rejectExtraArgs([], 1, "say")).not.toThrow();
  });

  it("throws on extra args", () => {
    expect(() => rejectExtraArgs(["hello", "~123"], 1, "say")).toThrow(
      "say: unexpected extra argument: ~123",
    );
  });
});
