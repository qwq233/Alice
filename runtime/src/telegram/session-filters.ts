/**
 * Telegram 会话过滤器。
 *
 * 目标：忽略不应进入 Alice 社交图/事件流的私聊实体：
 * - Saved Messages（self 私聊）
 * - Telegram 官方通知账号 777000
 * - bot 私聊
 *
 * 注意：这里只过滤“会话/私聊入口”。群里 bot 发言仍由上层策略处理，
 * 不在这里粗暴丢弃，以免误伤正常群上下文。
 */

export const TELEGRAM_OFFICIAL_ACCOUNT_ID = "777000";
export const TELEGRAM_REPLIES_ACCOUNT_ID = "1271266957";

export type TelegramPeerKind = "user" | "chat";

export interface TelegramPeerDescriptor {
  peerId: string | number;
  kind: TelegramPeerKind;
  isBot?: boolean;
}

export type IgnoredTelegramPeerReason =
  | "saved_messages"
  | "telegram_official"
  | "bot_account";

/** 返回应忽略的会话原因；否则返回 null。 */
export function getIgnoredTelegramPeerReason(
  peer: TelegramPeerDescriptor,
  selfId: string,
): IgnoredTelegramPeerReason | null {
  if (peer.kind !== "user") return null;

  const peerId = String(peer.peerId);
  if (peerId === selfId) return "saved_messages";
  if (peerId === TELEGRAM_OFFICIAL_ACCOUNT_ID) return "telegram_official";
  if (peer.isBot) return "bot_account";
  return null;
}

/** 仅基于私聊 userId 可判断的过滤（self / 777000）。 */
export function getIgnoredPrivateChatReason(
  peerId: string | number,
  selfId: string,
): Exclude<IgnoredTelegramPeerReason, "bot_account"> | null {
  const id = String(peerId);
  if (id === selfId) return "saved_messages";
  if (id === TELEGRAM_OFFICIAL_ACCOUNT_ID) return "telegram_official";
  return null;
}

export function isTelegramRepliesPeerId(peerId: string | number | null | undefined): boolean {
  return String(peerId ?? "") === TELEGRAM_REPLIES_ACCOUNT_ID;
}