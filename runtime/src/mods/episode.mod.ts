/**
 * Episode Mod — ADR-215 Cognitive Episode Graph 的 LLM 可见层。
 *
 * 1. contribute(): 当前 episode 有 caused_by 时注入 carry-over 指针
 * 2. query: episodeContext — 查看指定 episode 的上下文
 * 3. query: recentEpisodes — 最近 N 个 episode 的摘要
 *
 * @see docs/adr/215-cognitive-episode-graph.md
 */
import { desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { episodes } from "../db/schema.js";
import { type EpisodeResidue, recordConsults } from "../engine/episode.js";
import { safeDisplayName } from "../graph/display.js";

// biome-ignore lint/complexity/noBannedTypes: 无状态 Mod
export const episodeMod = createMod<{}>("episode", {
  category: "mechanic",
  description: "认知片段因果图 — carry-over 指针 + episode 查询",
  initialState: {},
})
  .contribute((ctx): ContributionItem[] => {
    // 直接查 DB 获取最近的 episode（无需跨 mod 状态读取）
    let currentEpisode: {
      id: string;
      causedBy: string | null;
      target: string | null;
    } | null = null;

    try {
      currentEpisode =
        getDb()
          .select({
            id: episodes.id,
            causedBy: episodes.causedBy,
            target: episodes.target,
          })
          .from(episodes)
          .where(isNotNull(episodes.tickStart))
          .orderBy(desc(episodes.tickStart))
          .limit(1)
          .get() ?? null;
    } catch {
      return [];
    }

    if (!currentEpisode?.causedBy) return [];

    // 解析 caused_by IDs
    let causedByIds: string[];
    try {
      causedByIds = JSON.parse(currentEpisode.causedBy);
    } catch {
      return [];
    }
    if (causedByIds.length === 0) return [];

    // 获取 caused_by episode 的信息
    const pb = new PromptBuilder();
    pb.heading("Carry-over");

    for (const cbId of causedByIds.slice(0, 2)) {
      try {
        const row = getDb().select().from(episodes).where(eq(episodes.id, cbId)).get();
        if (!row) continue;

        const targetName = row.target ? safeDisplayName(ctx.graph, row.target) : "(somewhere)";
        const residue: EpisodeResidue | null = row.residue ? JSON.parse(row.residue) : null;

        // 用原始信号构造可理解的文本，不用语义分类硬编码
        if (residue) {
          const parts: string[] = [];
          parts.push(`你刚从 ${targetName} 过来`);
          // 用 outcome 原始信号（不用 type 分类）
          if (residue.outcome === "error") parts.push("但消息没发出去");
          else if (residue.outcome === "silence") parts.push("你选择了沉默");
          else if (residue.outcome === "preempted") parts.push("但被打断了");
          if (residue.toward) {
            const towardName = safeDisplayName(ctx.graph, residue.toward);
            parts.push(`心里还惦记着 ${towardName}`);
          }
          pb.line(`- ${parts.join("，")}。`);
          pb.line(`  如需回顾: self episode-context id=${cbId}`);
        } else {
          pb.line(`- 你刚从 ${targetName} 过来。`);
          pb.line(`  如需回顾: self episode-context id=${cbId}`);
        }
      } catch {}
    }

    const lines = pb.build();
    if (lines.length === 0) return [];

    // order=5.5 → situation(5) 之后、awareness(6) 之前
    return [section("carry-over", lines, "Carry-over", 5.5, 74)];
  })
  .query("episode_context", {
    params: z.object({
      id: z.string().describe("episode ID (e.g. episode:32311)"),
    }),
    description: "查看指定 episode 的上下文",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "When you need to recall what happened in a past episode",
      whenNotToUse: "When the carry-over hint already gives you enough context",
    },
    returns: "{ id, target, voice, outcome, residue, causedBy, resolves, tickRange }",
    returnHint: "{id, target, outcome, residue, causedBy}",
    impl(ctx, args) {
      const row = getDb().select().from(episodes).where(eq(episodes.id, args.id)).get();
      if (!row) return { error: "Episode not found" };

      // 记录 consults 边——获取当前 episode ID
      try {
        const current = getDb()
          .select({ id: episodes.id })
          .from(episodes)
          .orderBy(desc(episodes.tickStart))
          .limit(1)
          .get();
        if (current && current.id !== args.id) {
          recordConsults(current.id, args.id);
        }
      } catch {
        /* ignore */
      }

      return {
        id: row.id,
        target: row.target ? safeDisplayName(ctx.graph, row.target) : null,
        voice: row.voice,
        outcome: row.outcome,
        tickRange: [row.tickStart, row.tickEnd],
        residue: row.residue ? JSON.parse(row.residue) : null,
        causedBy: row.causedBy ? JSON.parse(row.causedBy) : null,
        consults: row.consults ? JSON.parse(row.consults) : null,
        resolves: row.resolves ? JSON.parse(row.resolves) : null,
      };
    },
    format(result) {
      const r = result as Record<string, unknown>;
      if (r.error) return [String(r.error)];
      const parts = [`${r.id}: ${r.target ?? "?"} [${r.outcome}]`];
      if (r.voice) parts.push(`voice: ${r.voice}`);
      if (r.residue) {
        const res = r.residue as { type: string; toward?: string };
        parts.push(`residue: ${res.type}${res.toward ? ` → ${res.toward}` : ""}`);
      }
      if (r.causedBy) parts.push(`caused by: ${(r.causedBy as string[]).join(", ")}`);
      if (r.resolves) parts.push(`resolves: ${(r.resolves as string[]).join(", ")}`);
      return [parts.join(" | ")];
    },
  })
  .query("recent_episodes", {
    params: z.object({
      count: z.number().int().min(1).max(10).default(5).describe("number of episodes to return"),
    }),
    description: "最近 N 个 episode 的摘要",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "When you want to review recent cognitive episodes",
      whenNotToUse: "For trivial interactions or when carry-over is sufficient",
    },
    returns: "Array<{ id, target, outcome, residue }>",
    returnHint: "[{id, target, outcome}]",
    impl(ctx, args) {
      const rows = getDb()
        .select()
        .from(episodes)
        .orderBy(desc(episodes.tickStart))
        .limit(args.count)
        .all();
      return rows.map((r) => ({
        id: r.id,
        target: r.target ? safeDisplayName(ctx.graph, r.target) : null,
        outcome: r.outcome,
        residue: r.residue ? JSON.parse(r.residue) : null,
        causedBy: r.causedBy ? JSON.parse(r.causedBy) : null,
      }));
    },
    format(result) {
      const rows = result as Array<Record<string, unknown>>;
      if (rows.length === 0) return ["(no recent episodes)"];
      return rows.map((r) => {
        const parts = [`${r.id}: ${r.target ?? "?"} [${r.outcome ?? "open"}]`];
        if (r.residue) {
          const res = r.residue as { type: string };
          parts.push(`(${res.type})`);
        }
        return parts.join(" ");
      });
    },
  })
  .build();
