/**
 * ADR-220: 频道场景渲染器。
 *
 * 频道是信息流实体——阅读 + react + 转发给朋友。
 * 不出现 bot/awareness/feedback/threads/conversation state。
 *
 * Sections（按顺序）：
 * 1. 时间 + 心情 — LLM 感知当前时刻和情绪状态
 * 2. 转发目标 — 联系人（@id + 兴趣）+ 群组（@id + topic），频道核心
 * 3. 消息流（带 #msgId）— 频道核心，msgId 用于 irc forward --ref
 * 4. 内心低语 — 从 facetId 获取的 whisper
 */

import type { UserPromptSnapshot } from "../types.js";

export function renderChannel(snapshot: UserPromptSnapshot): string {
  const lines: string[] = [];

  // ── Section 1: 时间 + 心情 ──
  // LLM 需要知道当前时刻来判断内容时效性，心情影响转发决策
  const now = new Date(snapshot.nowMs);
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  lines.push(`${timeStr}. Current mood: ${snapshot.moodLabel}.`);

  // ── Section 2: 转发目标 ──
  // 联系人 @id + 兴趣 — LLM 决定 "谁会喜欢这个内容"
  // 群组 @id + topic — LLM 决定 "哪个群适合转发"
  if (snapshot.contacts.length > 0 || snapshot.groups.length > 0) {
    lines.push("");
    lines.push("## People you might share with");

    for (const c of snapshot.contacts) {
      const tierInfo = c.topTrait ? `${c.tierLabel}, ${c.topTrait}` : c.tierLabel;
      const parts: string[] = [`${c.ref.displayName} @${c.ref.id} (${tierInfo})`];
      if (c.interests.length > 0) parts.push(`— ${c.interests.join(", ")}`);
      if (c.bio) parts.push(`[${c.bio.slice(0, 60)}]`);
      lines.push(`- ${parts.join(" ")}`);
    }

    for (const g of snapshot.groups) {
      const parts: string[] = [`[group] ${g.ref.displayName} @${g.ref.id}`];
      if (g.interests.length > 0) parts.push(`— ${g.interests.join(", ")}`);
      if (g.bio) parts.push(`— ${g.bio.slice(0, 60)}`);
      if (g.topic) parts.push(`(topic: ${g.topic})`);
      lines.push(`- ${parts.join(" ")}`);
    }
  }

  // ── Section 3: 消息流 ──
  // 带 #msgId — LLM 用 irc forward --ref #msgId 引用特定内容
  if (snapshot.timeline.lines.length > 0) {
    lines.push("");
    lines.push("## Recent posts (channel, you can read but not post)");
    for (const line of snapshot.timeline.lines) {
      lines.push(line);
    }
  }

  // ── Section 4: 全局感知（层③）──
  // 频道场景只显示"谁等你回复"（urgent signals），不显示漂移联系人（频道无关）
  const urgentSignals = snapshot.situationSignals.filter(
    (s) => s.includes("waiting") || s.includes("lively") || s.includes("directed"),
  );
  if (urgentSignals.length > 0) {
    lines.push("");
    lines.push("## What's happening");
    for (const sig of urgentSignals) {
      lines.push(`- ${sig}`);
    }
  }

  // ── Section 5: 日记（层④）──
  // ADR-225: diary 注入已统一到 diary.mod.ts contribute()（system prompt）。

  // ── Section 6: Feed 条目（层① 互联网内容源）──
  // LLM 用 feed 内容补充转发素材
  if (snapshot.feedItems.length > 0) {
    lines.push("");
    lines.push("## From the web");
    for (const item of snapshot.feedItems) {
      lines.push(`- ${item.title}: ${item.snippet}`);
    }
  }

  // ── Section 7: 内心低语 ──
  // 从 facet 获取的情境化 whisper，引导 LLM 的行为倾向
  if (snapshot.whisper) {
    lines.push("");
    lines.push(capitalizeFirst(snapshot.whisper));
  }

  return lines.join("\n");
}

function capitalizeFirst(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}
