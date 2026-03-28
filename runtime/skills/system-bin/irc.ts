/**
 * irc — IRC-native Telegram system client (CLI 入口)。
 *
 * citty 严格解析 → Engine API 调用 → __ALICE_ACTION__ 输出。
 * 成功的发送动作输出 action 控制行，shell-executor 可追踪已完成操作。
 */

import { defineCommand, runMain } from "citty";
import {
  inOption,
  parseMsgId,
  rejectExtraArgs,
  resolveTarget,
  stripFlags,
} from "../../src/system/chat-client.ts";
import { engineGet, enginePost } from "../_lib/engine-client.ts";

const ACTION_PREFIX = "__ALICE_ACTION__:";

// ── 工具函数 ──

function die(msg: string): never {
  process.stderr.write(`irc: ${msg}\n`);
  process.exitCode = 1;
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
}

// ── Subcommands ──

const say = defineCommand({
  meta: { name: "say", description: "Send a message" },
  args: {
    in: inOption,
    text: { type: "positional", description: "Message text", required: true },
  },
  async run({ args, rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 1, "say");
    const chatId = resolveTarget(args.in);
    const text = args.text as string;
    if (!text.trim()) die("say requires non-empty text");
    const result = (await enginePost("/telegram/send", { chatId, text })) as {
      msgId?: number;
    } | null;
    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}sent:chatId=${chatId}:msgId=${result.msgId}`);
    }
    console.log(JSON.stringify(result, null, 2));
  },
});

const reply = defineCommand({
  meta: { name: "reply", description: "Reply to a message" },
  args: {
    in: inOption,
    msgId: { type: "positional", description: "Message ID to reply to", required: true },
    text: { type: "positional", description: "Reply text", required: true },
  },
  async run({ args, rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 2, "reply");
    const chatId = resolveTarget(args.in);
    const replyTo = parseMsgId(args.msgId as string);
    const text = args.text as string;
    if (!text.trim()) die("reply requires non-empty text");
    const result = (await enginePost("/telegram/send", { chatId, text, replyTo })) as {
      msgId?: number;
    } | null;
    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}sent:chatId=${chatId}:msgId=${result.msgId}`);
    }
    console.log(JSON.stringify(result, null, 2));
  },
});

const react = defineCommand({
  meta: { name: "react", description: "React to a message" },
  args: {
    in: inOption,
    msgId: { type: "positional", description: "Message ID to react to", required: true },
    emoji: { type: "positional", description: "Emoji", required: true },
  },
  async run({ args, rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 2, "react");
    const chatId = resolveTarget(args.in);
    const msgId = parseMsgId(args.msgId as string);
    const emoji = args.emoji as string;
    const result = await enginePost("/telegram/react", { chatId, msgId, emoji });
    console.log(JSON.stringify(result, null, 2));
  },
});

const sticker = defineCommand({
  meta: { name: "sticker", description: "Send a sticker by keyword" },
  args: {
    in: inOption,
    keyword: {
      type: "positional",
      description: "Sticker keyword (emotion/action)",
      required: true,
    },
  },
  async run({ args, rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 1, "sticker");
    const chatId = resolveTarget(args.in);
    const keyword = args.keyword as string;
    const result = (await enginePost("/telegram/sticker", { chatId, sticker: keyword })) as {
      msgId?: number;
    } | null;
    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}sticker:chatId=${chatId}:msgId=${result.msgId}`);
    }
    console.log(JSON.stringify(result, null, 2));
  },
});

const voice = defineCommand({
  meta: { name: "voice", description: "Send a voice message (text-to-speech)" },
  args: {
    in: inOption,
    emotion: { type: "string", description: "Emotion: happy, sad, angry, calm, whisper, ..." },
    ref: { type: "string", description: "Message ID to reply to" },
    text: { type: "positional", description: "Text to speak", required: true },
  },
  async run({ args, rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in", "--emotion", "--ref"]);
    rejectExtraArgs(positionals, 1, "voice");
    const chatId = resolveTarget(args.in);
    const text = (args.text as string).trim();
    if (!text) die("voice requires non-empty text");
    const body: Record<string, unknown> = { chatId, text };
    if (args.emotion) body.emotion = args.emotion;
    if (args.ref) body.replyTo = parseMsgId(args.ref as string);
    const result = (await enginePost("/telegram/voice", body)) as {
      msgId?: number;
    } | null;
    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}voice:chatId=${chatId}:msgId=${result.msgId}`);
    }
    console.log(JSON.stringify(result, null, 2));
  },
});

const read = defineCommand({
  meta: { name: "read", description: "Mark chat as read" },
  args: { in: inOption },
  async run({ args, rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 0, "read");
    const chatId = resolveTarget(args.in);
    const result = await enginePost("/telegram/read", { chatId });
    console.log(JSON.stringify(result, null, 2));
  },
});

const tail = defineCommand({
  meta: { name: "tail", description: "Show recent messages" },
  args: {
    in: inOption,
    count: { type: "positional", description: "Number of messages", default: "20" },
  },
  async run({ args, rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 1, "tail");
    const chatId = resolveTarget(args.in);
    const count = Number(args.count);
    if (!Number.isFinite(count)) die("tail count must be a number");
    const result = await engineGet(`/chat/${chatId}/tail?limit=${count}`);
    // ADR-221: 标注来源 chatId，防止 LLM 跨 round 时搞混群组 ID
    const isRemote = args.in != null;
    if (isRemote) {
      console.log(`[tail @${chatId}]`);
    }
    console.log(JSON.stringify(result, null, 2));
  },
});

// ── whois: 统一查人/查房间（IRC /whois）──

/** 从 graph 属性响应中提取 value。 */
function gval(res: unknown): unknown {
  return (res as { value?: unknown } | null)?.value ?? null;
}

const whois = defineCommand({
  meta: { name: "whois", description: "Look up a contact or the current chat room" },
  args: {
    in: inOption,
    target: { type: "positional", description: "Contact @ID (omit for room info)", default: "" },
  },
  async run({ args, rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 1, "whois");
    const target = (args.target as string | undefined)?.trim() || undefined;

    if (target) {
      // whois @ID → 联系人画像（/query/contact_profile）
      const stripped = target.startsWith("@") || target.startsWith("~") ? target.slice(1) : target;
      const contactId = `contact:${stripped}`;
      const result = await enginePost("/query/contact_profile", { contactId });
      console.log(JSON.stringify(result, null, 2));
    } else {
      // whois（无参数）→ 聊天室信息（原 irc who）
      const chatId = resolveTarget(args.in);
      const [name, chatType, topic, unread, pendingDirected, aliceRole] = await Promise.all([
        engineGet(`/graph/channel:${chatId}/display_name`),
        engineGet(`/graph/channel:${chatId}/chat_type`),
        engineGet(`/graph/channel:${chatId}/topic`),
        engineGet(`/graph/channel:${chatId}/unread`),
        engineGet(`/graph/channel:${chatId}/pending_directed`),
        engineGet(`/graph/channel:${chatId}/alice_role`),
      ]);
      console.log(
        JSON.stringify(
          {
            chatId,
            name: gval(name),
            chatType: gval(chatType),
            topic: gval(topic),
            unread: gval(unread) ?? 0,
            pendingDirected: gval(pendingDirected) ?? 0,
            role: gval(aliceRole),
          },
          null,
          2,
        ),
      );
    }
  },
});

// ── motd: 聊天室氛围（IRC /motd）──

const motd = defineCommand({
  meta: { name: "motd", description: "Show chat mood and atmosphere" },
  args: { in: inOption },
  async run({ args, rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 0, "motd");
    const chatId = resolveTarget(args.in);
    const result = await enginePost("/query/chat_mood", { chatId: `channel:${chatId}` });
    console.log(JSON.stringify(result, null, 2));
  },
});

// ── threads: 未结话题（Discord/Slack 风格）──

const threads = defineCommand({
  meta: { name: "threads", description: "Show open discussion threads" },
  async run() {
    const result = await enginePost("/query/open_topics", {});
    console.log(JSON.stringify(result, null, 2));
  },
});

const topicCmd = defineCommand({
  meta: { name: "topic", description: "Show chat topic" },
  args: { in: inOption },
  async run({ args, rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 0, "topic");
    const chatId = resolveTarget(args.in);
    const topicResult = await engineGet(`/graph/channel:${chatId}/topic`);
    console.log(
      JSON.stringify(
        {
          chatId,
          topic: (topicResult as { value?: unknown } | null)?.value ?? null,
        },
        null,
        2,
      ),
    );
  },
});

const join = defineCommand({
  meta: { name: "join", description: "Join a chat" },
  args: {
    target: {
      type: "positional",
      description: "Chat ID, @username, or invite link",
      required: true,
    },
  },
  async run({ args, rawArgs }) {
    rejectExtraArgs(rawArgs, 1, "join");
    const chatIdOrLink = (args.target as string).trim();
    if (!chatIdOrLink) die("join requires a target");
    const result = await enginePost("/telegram/join", { chatIdOrLink });
    console.log(JSON.stringify(result, null, 2));
  },
});

const leave = defineCommand({
  meta: { name: "leave", description: "Leave current chat" },
  args: { in: inOption },
  async run({ args, rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--in"]);
    rejectExtraArgs(positionals, 0, "leave");
    const chatId = resolveTarget(args.in);
    const result = await enginePost("/telegram/leave", { chatId });
    console.log(JSON.stringify(result, null, 2));
  },
});

const download = defineCommand({
  meta: { name: "download", description: "Download a file attachment from a message" },
  args: {
    in: inOption,
    ref: { type: "string", description: "Message ID containing the attachment", required: true },
    output: {
      type: "string",
      description: "Output path (must be under $ALICE_HOME)",
      required: true,
    },
  },
  async run({ args }) {
    const chatId = resolveTarget(args.in);
    const msgId = parseMsgId(args.ref as string);
    const output = (args.output as string).trim();
    if (!output) die("download requires --output path");
    const result = (await enginePost("/telegram/download", { chatId, msgId, output })) as {
      path?: string;
      mime?: string;
      size?: number;
    } | null;
    if (result?.path) {
      console.log(`${ACTION_PREFIX}downloaded:chatId=${chatId}:msgId=${msgId}:path=${result.path}`);
    }
    console.log(JSON.stringify(result, null, 2));
  },
});

const sendFile = defineCommand({
  meta: { name: "send-file", description: "Send a local file to a chat" },
  args: {
    in: inOption,
    path: { type: "string", description: "File path (must be under $ALICE_HOME)", required: true },
    caption: { type: "string", description: "Optional caption" },
    ref: { type: "string", description: "Message ID to reply to" },
  },
  async run({ args }) {
    const chatId = resolveTarget(args.in);
    const filePath = (args.path as string).trim();
    if (!filePath) die("send-file requires --path");
    const body: Record<string, unknown> = { chatId, path: filePath };
    if (args.caption) body.caption = args.caption;
    if (args.ref) body.replyTo = parseMsgId(args.ref as string);
    const result = (await enginePost("/telegram/upload", body)) as {
      msgId?: number;
    } | null;
    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}sent-file:chatId=${chatId}:path=${filePath}`);
    }
    console.log(JSON.stringify(result, null, 2));
  },
});

// ── ADR-206 W8: 跨聊天转发 + 可选附加评论 ──

const forward = defineCommand({
  meta: {
    name: "forward",
    description: "Forward a message to another chat (with optional comment)",
  },
  args: {
    from: {
      type: "string" as const,
      description: "Source chat (@ID or numeric)",
      required: true,
    },
    ref: { type: "string", description: "Message ID to forward", required: true },
    to: {
      type: "string" as const,
      description: "Destination chat (@ID or numeric). Omit to use current chat context.",
    },
    text: {
      type: "positional",
      description: "Optional comment (attached as reply to forwarded message)",
      default: "",
    },
  },
  async run({ args, rawArgs }) {
    const positionals = stripFlags(rawArgs, ["--from", "--ref", "--to"]);
    rejectExtraArgs(positionals, 1, "forward");
    const fromChatId = resolveTarget(args.from);
    const msgId = parseMsgId(args.ref as string);
    const toChatId = resolveTarget(args.to);
    const comment = (args.text as string | undefined)?.trim() || undefined;
    const result = (await enginePost("/telegram/forward", {
      fromChatId,
      msgId,
      toChatId,
      ...(comment && { comment }),
    })) as { forwardedMsgId?: number; commentMsgId?: number } | null;
    if (result?.forwardedMsgId != null) {
      console.log(
        `${ACTION_PREFIX}forwarded:from=${fromChatId}:to=${toChatId}:msgId=${result.forwardedMsgId}`,
      );
    }
    if (result?.commentMsgId != null) {
      console.log(`${ACTION_PREFIX}sent:chatId=${toChatId}:msgId=${result.commentMsgId}`);
    }
    console.log(JSON.stringify(result, null, 2));
  },
});

// ── Main ──

const main = defineCommand({
  meta: {
    name: "irc",
    description: "Telegram system chat client for Alice",
  },
  subCommands: {
    say,
    reply,
    react,
    sticker,
    voice,
    read,
    tail,
    whois,
    motd,
    threads,
    topic: topicCmd,
    join,
    leave,
    download,
    "send-file": sendFile,
    forward,
  },
});

runMain(main);
