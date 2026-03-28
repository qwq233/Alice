/**
 * Entity ID 转换工具测试 — constants.ts 的 ID 转换函数。
 */
import { describe, expect, it } from "vitest";
import {
  chatIdToContactId,
  ensureChannelId,
  ensureContactId,
  extractNumericId,
  resolveContactAndChannel,
} from "../src/graph/constants.js";

describe("extractNumericId", () => {
  it("channel: 前缀", () => expect(extractNumericId("channel:123")).toBe(123));
  it("contact: 前缀", () => expect(extractNumericId("contact:456")).toBe(456));
  it("纯数字字符串", () => expect(extractNumericId("789")).toBe(789));
  it("负数 ID", () => expect(extractNumericId("channel:-1001234")).toBe(-1001234));
  it("非法 channel:abc → null", () => expect(extractNumericId("channel:abc")).toBeNull());
  it("空字符串 → null", () => expect(extractNumericId("")).toBeNull());
  it("无前缀非数字 → null", () => expect(extractNumericId("abc")).toBeNull());
});

describe("ensureChannelId", () => {
  it("channel: 透传", () => expect(ensureChannelId("channel:123")).toBe("channel:123"));
  it("contact: → channel:", () => expect(ensureChannelId("contact:456")).toBe("channel:456"));
  it("纯数字 → channel:", () => expect(ensureChannelId("789")).toBe("channel:789"));
  it("非法 → null", () => expect(ensureChannelId("abc")).toBeNull());
  it("空串 → null", () => expect(ensureChannelId("")).toBeNull());
});

describe("ensureContactId", () => {
  it("contact: 透传", () => expect(ensureContactId("contact:123")).toBe("contact:123"));
  it("channel: → contact:", () => expect(ensureContactId("channel:456")).toBe("contact:456"));
  it("纯数字 → contact:", () => expect(ensureContactId("789")).toBe("contact:789"));
  it("非法 → null", () => expect(ensureContactId("abc")).toBeNull());
});

describe("resolveContactAndChannel", () => {
  const has = (ids: string[]) => (id: string) => ids.includes(id);

  it("两个节点都存在", () => {
    const result = resolveContactAndChannel("channel:100", has(["channel:100", "contact:100"]));
    expect(result.channelId).toBe("channel:100");
    expect(result.contactId).toBe("contact:100");
  });

  it("只有 channel 存在", () => {
    const result = resolveContactAndChannel("channel:200", has(["channel:200"]));
    expect(result.channelId).toBe("channel:200");
    expect(result.contactId).toBeNull();
  });

  it("只有 contact 存在", () => {
    const result = resolveContactAndChannel("contact:300", has(["contact:300"]));
    expect(result.contactId).toBe("contact:300");
    expect(result.channelId).toBeNull();
  });

  it("都不存在", () => {
    const result = resolveContactAndChannel("channel:999", has([]));
    expect(result.channelId).toBeNull();
    expect(result.contactId).toBeNull();
  });

  it("从 contact 输入推断 channel", () => {
    const result = resolveContactAndChannel("contact:400", has(["channel:400", "contact:400"]));
    expect(result.channelId).toBe("channel:400");
    expect(result.contactId).toBe("contact:400");
  });
});

describe("chatIdToContactId 向后兼容", () => {
  it("channel: → contact:", () => expect(chatIdToContactId("channel:123")).toBe("contact:123"));
  it("contact: 透传", () => expect(chatIdToContactId("contact:456")).toBe("contact:456"));
  it("无前缀 → null", () => expect(chatIdToContactId("789")).toBeNull());
});
