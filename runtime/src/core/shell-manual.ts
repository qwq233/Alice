/**
 * Shell-native manual generator.
 *
 * ADR-217: 统一 self 命名空间 + irc 子命令签名。
 * 唯一事实来源：Mod definitions (指令/查询) + irc citty definitions (子命令)。
 */

import { probeCommandCatalog } from "./command-catalog.js";
import { registerKnownCommands } from "./script-validator.js";
import type { ModDefinition, ParamDefinition } from "./types.js";

function isOptionalParam(param: ParamDefinition): boolean {
  return param.schema.isOptional();
}

function renderParamPlaceholder(name: string, optional: boolean): string {
  return optional ? `[${name}=...]` : `${name}=...`;
}

/** snake_case → kebab-case for CLI display. */
function toKebab(snake: string): string {
  return snake.replace(/_/g, "-");
}

/** ADR-217: 按语义分组（不再按 self_ 前缀分组）。 */
function groupOf(name: string): string {
  // 感知族
  if (["feel", "sense", "sense_chemistry", "intend"].includes(name)) return "Perception";
  // 记忆族
  if (
    ["diary", "note", "recall_fact", "update_fact", "delete_fact", "consolidate_facts"].includes(
      name,
    )
  )
    return "Memory";
  // 评估族
  if (["rate_outcome", "flag_risk", "observe_activity"].includes(name)) return "Mood";
  // 社交族
  if (
    [
      "set_language",
      "set_relation_type",
      "note_active_hour",
      "tag_interest",
      "synthesize_portrait",
      "update_group_profile",
    ].includes(name)
  )
    return "Social";
  // 线程族
  if (
    ["begin_topic", "advance_topic", "resolve_topic", "thread_review", "affect_thread"].includes(
      name,
    )
  )
    return "Threads";
  // 调度族
  if (["schedule_task", "cancel_task"].includes(name)) return "Scheduler";
  return "Other";
}

// ─── IRC 子命令签名注册表 ────────────────────────────────────────────
// 从 irc.ts citty 定义提取，作为 irc 签名的唯一事实来源。

interface IrcCommandSig {
  name: string;
  signature: string;
  description: string;
}

const IRC_COMMANDS: readonly IrcCommandSig[] = [
  { name: "say", signature: "[--in @ID] <text>", description: "Send a message" },
  { name: "reply", signature: "[--in @ID] <msgId> <text>", description: "Reply to a message" },
  { name: "react", signature: "[--in @ID] <msgId> <emoji>", description: "React to a message" },
  { name: "sticker", signature: "[--in @ID] <keyword>", description: "Send a sticker by keyword" },
  {
    name: "voice",
    signature: "[--in @ID] [--emotion EMOTION] [--ref <msgId>] <text>",
    description: "Send a voice message (text-to-speech)",
  },
  { name: "read", signature: "[--in @ID]", description: "Mark chat as read" },
  { name: "tail", signature: "[--in @ID] [count]", description: "Show recent messages" },
  { name: "whois", signature: "[--in @ID] [@ID]", description: "Look up contact or room" },
  { name: "motd", signature: "[--in @ID]", description: "Show chat mood and atmosphere" },
  { name: "threads", signature: "", description: "Show open discussion threads" },
  { name: "topic", signature: "[--in @ID]", description: "Show chat topic" },
  { name: "join", signature: "<target>", description: "Join a chat" },
  { name: "leave", signature: "[--in @ID]", description: "Leave current chat" },
  {
    name: "download",
    signature: "[--in @ID] --ref <msgId> --output <path>",
    description: "Download attachment",
  },
  {
    name: "send-file",
    signature: "[--in @ID] --path <file> [--caption <text>] [--ref <msgId>]",
    description: "Upload file",
  },
  {
    name: "forward",
    signature: "--from @ID --ref #msgId --to @ID [comment]",
    description: "Forward message to another chat",
  },
];

function renderIrcSection(): string[] {
  const lines = ["## irc commands", ""];
  for (const cmd of IRC_COMMANDS) {
    const sig = cmd.signature ? `${cmd.name} ${cmd.signature}` : cmd.name;
    lines.push(`  ${sig.padEnd(52)} ${cmd.description}`);
  }
  lines.push("");
  return lines;
}

// ─── self 指令/查询渲染 ──────────────────────────────────────────────

function renderSelfCommands(mods: readonly ModDefinition[]): string[] {
  const groups = new Map<string, string[]>();
  const queryLines: string[] = [];

  for (const mod of mods) {
    // 只渲染有 affordance 的指令/查询（LLM 可见）
    const instructionEntries = Object.entries(mod.instructions ?? {}).filter(
      ([, def]) => def.affordance != null,
    );
    const queryEntries = Object.entries(mod.queries ?? {}).filter(
      ([, def]) => def.affordance != null,
    );

    for (const [name, def] of instructionEntries) {
      const group = groupOf(name);
      if (!groups.has(group)) groups.set(group, []);
      const derivedKeys = def.deriveParams
        ? new Set(Object.keys(def.deriveParams))
        : new Set<string>();
      const params = Object.entries(def.params)
        .filter(([paramName]) => !derivedKeys.has(paramName))
        .map(([paramName, param]) => renderParamPlaceholder(paramName, isOptionalParam(param)));
      // ADR-217: 全部 `self <kebab-name>`
      const cliName = `self ${toKebab(name)}`;
      groups.get(group)?.push(`- ${[cliName, ...params].join(" ")} — ${def.description}`);
    }

    for (const [name, def] of queryEntries) {
      const derivedKeys = def.deriveParams
        ? new Set(Object.keys(def.deriveParams))
        : new Set<string>();
      const params = Object.entries(def.params)
        .filter(([paramName]) => !derivedKeys.has(paramName))
        .map(([paramName, param]) => renderParamPlaceholder(paramName, isOptionalParam(param)));
      const cliName = `self ${toKebab(name)}`;
      const desc = def.description ? ` — ${def.description}` : "";
      queryLines.push(`- ${[cliName, ...params].join(" ")}${desc}`);
    }
  }

  const lines: string[] = [];

  // 按固定顺序输出语义分组
  for (const group of ["Perception", "Memory", "Mood", "Social", "Threads", "Scheduler", "Other"]) {
    const entries = groups.get(group);
    if (!entries || entries.length === 0) continue;
    lines.push(`## ${group}`);
    lines.push(...entries);
    lines.push("");
  }

  if (queryLines.length > 0) {
    lines.push("## Queries");
    lines.push(...queryLines);
    lines.push("");
  }

  return lines;
}

// ─── Command Catalog（系统命令 + Skill 命令发现）──────────────────────

async function renderCommandCatalog(): Promise<string[]> {
  const catalog = await probeCommandCatalog();
  registerKnownCommands(catalog.commands.map((c) => c.name));
  const lines = ["## Command Catalog", ""];
  lines.push("- This catalog is fetched through a live runtime command probe before prompt build.");
  lines.push("- Use `<command> --help` for usage details.");
  lines.push("- Use `command -v <command>` if you need to verify a binary on PATH.");
  lines.push("");

  const systemCommands = catalog.commands.filter((entry) => entry.kind === "system");
  const skillCommands = catalog.commands.filter((entry) => entry.kind === "skill");

  if (systemCommands.length > 0) {
    lines.push("## System commands");
    for (const entry of systemCommands) {
      lines.push(`- \`${entry.name}\` - ${entry.summary}`);
    }
    lines.push("");
  }

  if (skillCommands.length > 0) {
    // ADR-223: 扁平展示——summary + whenToUse 让 LLM 一眼知道何时用
    lines.push("## Installed skill commands");
    for (const entry of skillCommands) {
      const hint = entry.whenToUse ? ` | ${entry.whenToUse}` : "";
      lines.push(`- \`${entry.name}\` - ${entry.summary}${hint}`);
    }
    lines.push("");
  }

  lines.push("- Host CLI on PATH stays available after Alice commands.");
  lines.push("");
  return lines;
}

// ─── 入口 ────────────────────────────────────────────────────────────

export async function generateShellManual(mods: readonly ModDefinition[]): Promise<string> {
  const commandCatalog = await renderCommandCatalog();
  const parts = [
    "## Shell Contract",
    "",
    "Write a multi-line POSIX sh script file. One command per line, separated by newlines.",
    "Use `# ...` comments on their own line as your inner monologue — what you're thinking before you act.",
    "NEVER put multiple commands or comments on a single line — each must be on its own line.",
    "Prefer Alice commands on PATH over ad-hoc HTTP or JS.",
    "Discover command details with native tools, not a fake API layer.",
    "",
    "## Afterward — what happens to this chat after your turn",
    "",
    "The `run` tool requires an `afterward` field:",
    "- `done` — finished, nothing more to do. This is the default — use it most of the time.",
    "- `waiting_reply` — you JUST SAID something and are waiting for their response. If you asked a question, use this.",
    "- `watching` — something is unfolding, you want to observe before deciding.",
    "- `fed_up` — the room is draining or hostile. Penalty: closes the conversation.",
    "- `cooling_down` — the room is spammy or toxic. Penalty: freezes this chat for ~30 min.",
    "",
    "If you need command output before deciding, write the query as a standalone command.",
    "The result will appear in your next prompt as an observation — you can then decide what to do.",
    "",
    ...commandCatalog,
    ...renderIrcSection(),
    ...renderSelfCommands(mods),
  ];

  return parts.join("\n");
}
