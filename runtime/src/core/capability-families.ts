import type { ToolCategory } from "../engine/tick/types.js";

export interface CapabilityFamily {
  /** Capability Guide 中显示的「何时激活」描述 */
  whenToUse: string;
  /** Activated Tools 段头部的简短描述 */
  label: string;
  /** 展开态教程示例 */
  tutorials?: readonly string[];
}

/**
 * Category-level metadata for capability families (discoverable via `<command> --help`).
 * @see docs/adr/216-cli-help-unification.md
 */
export const CAPABILITY_FAMILIES: Partial<Record<ToolCategory, CapabilityFamily>> = {
  mood: {
    whenToUse: "深度情绪分析/反馈",
    label: "环境/状态感知",
    tutorials: [
      "// self --help -> rate_outcome, flag_risk...",
      '// rate_outcome({ quality: "good", reason: "她笑了" })',
    ],
  },
  social: {
    whenToUse: "关系档案管理",
    label: "人际认知",
    tutorials: [
      "// self --help -> note_active_hour, tag_interest...",
      "// note_active_hour({ contactId: TARGET_CONTACT, hour: 14 })",
    ],
  },
  threads: {
    whenToUse: "线程生命周期管理",
    label: "线程管理",
    tutorials: [
      "// self --help -> intend, resolve_topic...",
      '// intend({ intent: "下次见面时问问结果" })',
    ],
  },
  memory: {
    whenToUse: "知识维护与反思",
    label: "知识持久化",
    tutorials: [
      "// self --help -> diary, recall_fact...",
      '// diary("今天聊了很多 感觉关系更近了")',
    ],
  },
  scheduler: {
    whenToUse: "任务调度",
    label: "任务调度",
    tutorials: [
      "// self --help -> schedule_task, cancel_task...",
      '// schedule_task({ type: "at", delay: 5, action: "remind about meeting" })  // 5 minutes from now',
    ],
  },
  skills: {
    whenToUse:
      "Discover and install new capabilities - search the Skill Store when you need a tool you don't have",
    label: "Skill 管理",
    tutorials: [
      'alice-pkg search "天气"     # 搜索可用 Skill',
      "alice-pkg search            # 列出全部 Skill",
      "alice-pkg install weather   # 安装指定 Skill",
      "alice-pkg list              # 查看已安装 Skill",
      "alice-pkg info weather      # 查看 Skill 详情",
    ],
  },
  chat_history: {
    whenToUse: "搜索聊天记录/日记/线程",
    label: "聊天记录搜索",
    tutorials: [
      '// search("餐厅", { chatId: TARGET_CHAT })',
      "// tail(10)",
      "// whois()",
      "// topic()",
      "// -> results appear automatically in next round",
    ],
  },
  contact_info: {
    whenToUse: "Bot 交互/联系人查询",
    label: "联系人与 Bot",
    tutorials: [
      '// inline_query("musicbot", "lofi beats")',
      '// send_inline_result("query_abc", "result_0")',
      "// bestTimeToChat()  // 查看最佳联系时间",
    ],
  },
  sticker: {
    whenToUse: "浏览/管理贴纸集",
    label: "贴纸",
    tutorials: [
      "// list_stickers()  // 列出所有可用贴纸集",
      '// get_sticker_set("sticker_set_name")',
    ],
  },
  media: {
    whenToUse: "发送图片/文件/媒体",
    label: "媒体",
    tutorials: [
      '// send_media({ fileId: "CAACAgI..." })  // forward existing media by file ID',
      "// download + process + send-file: irc download → convert → irc send-file",
    ],
  },
  group_admin: {
    whenToUse: "群组发现/加入/管理",
    label: "群组管理",
    tutorials: [
      '// search_public("tech community")',
      '// preview_chat("@channel_name")',
      '// join("@channel_name")',
      "// part()",
      "// create_invite_link(chatId)",
    ],
  },
};

export function registerCapabilityFamily(category: string, family: CapabilityFamily): void {
  (CAPABILITY_FAMILIES as Record<string, CapabilityFamily>)[category] = family;
}

export function unregisterCapabilityFamily(category: string): void {
  delete (CAPABILITY_FAMILIES as Record<string, CapabilityFamily>)[category];
}
