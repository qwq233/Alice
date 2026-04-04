import { describe, expect, it } from "vitest";
import {
  TELEGRAM_OFFICIAL_ACCOUNT_ID,
  getIgnoredPrivateChatReason,
  getIgnoredTelegramPeerReason,
  isTelegramRepliesPeerId,
} from "../src/telegram/session-filters.js";

describe("telegram session filters", () => {
  const selfId = "123456";

  it("过滤 Saved Messages 私聊", () => {
    expect(
      getIgnoredTelegramPeerReason({ peerId: selfId, kind: "user", isBot: false }, selfId),
    ).toBe("saved_messages");
  });

  it("过滤 Telegram 官方账号 777000", () => {
    expect(
      getIgnoredTelegramPeerReason(
        { peerId: TELEGRAM_OFFICIAL_ACCOUNT_ID, kind: "user", isBot: false },
        selfId,
      ),
    ).toBe("telegram_official");
  });

  it("过滤 bot 私聊", () => {
    expect(getIgnoredTelegramPeerReason({ peerId: "42", kind: "user", isBot: true }, selfId)).toBe(
      "bot_account",
    );
  });

  it("不过滤普通用户私聊和群组", () => {
    expect(
      getIgnoredTelegramPeerReason({ peerId: "42", kind: "user", isBot: false }, selfId),
    ).toBeNull();
    expect(getIgnoredTelegramPeerReason({ peerId: "99", kind: "chat" }, selfId)).toBeNull();
  });

  it("仅基于 chatId 的私聊过滤涵盖 self 与 777000", () => {
    expect(getIgnoredPrivateChatReason(selfId, selfId)).toBe("saved_messages");
    expect(getIgnoredPrivateChatReason(TELEGRAM_OFFICIAL_ACCOUNT_ID, selfId)).toBe(
      "telegram_official",
    );
    expect(getIgnoredPrivateChatReason("42", selfId)).toBeNull();
  });

  it("识别 Replies 系统实体", () => {
    expect(isTelegramRepliesPeerId("1271266957")).toBe(true);
    expect(isTelegramRepliesPeerId("42")).toBe(false);
  });
});