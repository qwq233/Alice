/**
 * irc — IRC-native Telegram system client.
 *
 * citty subcommand 架构，严格解析，杜绝 rest.join(" ") 宽容吞参数。
 *
 * 命令签名设计（IRC 直觉 + POSIX 严格）：
 *   irc say [--in TARGET] <text>
 *   irc reply [--in TARGET] <msgId> <text>
 *   irc react [--in TARGET] <msgId> <emoji>
 *   irc sticker [--in TARGET] <keyword>
 *   irc read [--in TARGET]
 *   irc tail [--in TARGET] [count]
 *   irc whois [--in TARGET] [@ID]
 *   irc motd [--in TARGET]
 *   irc threads
 *   irc topic [--in TARGET]
 *   irc join <target>
 *   irc leave [--in TARGET]
 *   irc forward --from SOURCE --ref <msgId> --to TARGET [comment]
 *
 * --in TARGET = "在哪个聊天室操作"（空间介词，IRC "I'm in #channel"）。
 * --to TARGET 仅用于 forward（方向介词，"转发到"）。
 * TARGET 支持 @ID（聊天平台惯例）、~ID（向后兼容）和裸数字。
 * 省略时自动从 ALICE_CTX_TARGET_CHAT 环境变量获取当前聊天上下文。
 */

import { defineCommand } from "citty";

// ── 共享解析工具 ──

/**
 * 解析 --in TARGET（或 forward 的 --to/--from TARGET）。
 * 接受 @ID（聊天平台惯例）、~ID（向后兼容）和裸数字。
 * 省略时自动从 ALICE_CTX_TARGET_CHAT 环境变量获取当前聊天上下文。
 */
export function resolveTarget(raw?: string): number {
  const effective = raw || process.env.ALICE_CTX_TARGET_CHAT;
  if (!effective) {
    throw new Error("missing target: use --in @ID");
  }
  const stripped =
    effective.startsWith("@") || effective.startsWith("~") ? effective.slice(1) : effective;
  const n = Number(stripped);
  if (!Number.isFinite(n)) throw new Error(`invalid target: "${effective}"`);
  return n;
}

/**
 * 解析 msgId，容忍 # 前缀（LLM 从 prompt 中 (#5791) 复制）。
 */
export function parseMsgId(raw: string): number {
  const stripped = raw.startsWith("#") ? raw.slice(1) : raw;
  const n = Number(stripped);
  if (!Number.isFinite(n))
    throw new Error(`invalid message ID: "${raw}" (expected a number like 5791)`);
  return n;
}

/** 检查多余参数，多余则报错。 */
export function rejectExtraArgs(args: string[], expected: number, cmdName: string): void {
  if (args.length > expected) {
    const extra = args.slice(expected).join(" ");
    throw new Error(`${cmdName}: unexpected extra argument: ${extra}`);
  }
}

// ── --in 选项定义（所有需要 target 的 subcommand 共用）──
// "in" = 空间介词（"在哪个聊天室操作"），区别于 forward 的 --to（方向介词）。

export const inOption = {
  type: "string" as const,
  description: "Target chat (@ID or numeric). Omit to use current chat context.",
};

// ── Subcommand 定义 ──

export const sayCmd = defineCommand({
  meta: { name: "say", description: "Send a message" },
  args: {
    in: inOption,
    text: { type: "positional", description: "Message text", required: true },
  },
  run({ rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 1, "say");
  },
});

export const replyCmd = defineCommand({
  meta: { name: "reply", description: "Reply to a message" },
  args: {
    in: inOption,
    msgId: { type: "positional", description: "Message ID to reply to", required: true },
    text: { type: "positional", description: "Reply text", required: true },
  },
  run({ rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 2, "reply");
  },
});

export const reactCmd = defineCommand({
  meta: { name: "react", description: "React to a message with emoji" },
  args: {
    in: inOption,
    msgId: { type: "positional", description: "Message ID to react to", required: true },
    emoji: { type: "positional", description: "Emoji reaction", required: true },
  },
  run({ rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 2, "react");
  },
});

export const stickerCmd = defineCommand({
  meta: { name: "sticker", description: "Send a sticker by keyword" },
  args: {
    in: inOption,
    keyword: {
      type: "positional",
      description: "Sticker keyword (emotion/action)",
      required: true,
    },
  },
  run({ rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 1, "sticker");
  },
});

export const readCmd = defineCommand({
  meta: { name: "read", description: "Mark chat as read" },
  args: { in: inOption },
  run({ rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 0, "read");
  },
});

export const tailCmd = defineCommand({
  meta: { name: "tail", description: "Show recent messages" },
  args: {
    in: inOption,
    count: { type: "positional", description: "Number of messages (default 20)" },
  },
  run({ rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 1, "tail");
  },
});

export const whoisCmd = defineCommand({
  meta: { name: "whois", description: "Look up a contact or the current chat room" },
  args: {
    in: inOption,
    target: { type: "positional", description: "Contact @ID (omit for room info)" },
  },
  run({ rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 1, "whois");
  },
});

export const topicCmd = defineCommand({
  meta: { name: "topic", description: "Show chat topic" },
  args: { in: inOption },
  run({ rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 0, "topic");
  },
});

export const joinCmd = defineCommand({
  meta: { name: "join", description: "Join a chat" },
  args: {
    target: {
      type: "positional",
      description: "Chat ID, @username, or invite link",
      required: true,
    },
  },
  run({ rawArgs }) {
    rejectExtraArgs(rawArgs, 1, "join");
  },
});

export const leaveCmd = defineCommand({
  meta: { name: "leave", description: "Leave current chat" },
  args: { in: inOption },
  run({ rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 0, "leave");
  },
});

// ── 工具函数 ──

/** 从 rawArgs 中去除已知 flag 及其值，返回纯 positional 列表。 */
export function stripFlags(rawArgs: string[], flags: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < rawArgs.length) {
    if (flags.includes(rawArgs[i])) {
      i += 2; // 跳过 flag 和它的值
      continue;
    }
    if (rawArgs[i].startsWith("-")) {
      // 未知 flag — 报错由 citty 或 rejectExtraArgs 处理
      result.push(rawArgs[i]);
      i++;
      continue;
    }
    result.push(rawArgs[i]);
    i++;
  }
  return result;
}

export const mainCommand = defineCommand({
  meta: {
    name: "irc",
    description: "Telegram system chat client for Alice",
  },
  subCommands: {
    say: sayCmd,
    reply: replyCmd,
    react: reactCmd,
    sticker: stickerCmd,
    read: readCmd,
    tail: tailCmd,
    whois: whoisCmd,
    topic: topicCmd,
    join: joinCmd,
    leave: leaveCmd,
  },
});
