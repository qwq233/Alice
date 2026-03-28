/**
 * Clustering Mod — ADR-226 话题自动聚类。
 *
 * 缓冲 per-channel 消息 ID → 达到阈值时调用 Reflect Provider（cheap model）聚类
 * → 显著话题自动晋升为 thread 图节点（source: "auto"）。
 *
 * 不做 Triage：响应决策完全交给压力场。
 *
 * @see docs/adr/226-auto-clustering.md
 */

import { and, eq, gt, inArray } from "drizzle-orm";
import { createMod } from "../core/mod-builder.js";
import { getDb } from "../db/connection.js";
import { messageLog, narrativeThreads } from "../db/schema.js";
import type { ClusteringResult } from "../engine/clustering.js";
import { clusterMessages } from "../engine/clustering.js";
import { createThreadInGraph } from "../engine/generators.js";
import { createLogger } from "../utils/logger.js";
import { jaccardSimilarity } from "./diary.mod.js";

const log = createLogger("clustering.mod");

// -- 常量 --------------------------------------------------------------------

/** 去重阈值：标题 Jaccard bigram 相似度超过此值视为重复。 */
const DEDUP_SIMILARITY_THRESHOLD = 0.5;

/** Significance → thread weight 映射。trivial 不晋升。 */
const SIGNIFICANCE_TO_WEIGHT: Record<string, "minor" | "major" | "critical" | null> = {
  trivial: null,
  moderate: "minor",
  important: "major",
  critical: "critical",
};

// -- 状态 --------------------------------------------------------------------

interface ChannelBuffer {
  /** 缓冲的 messageLog.id 列表。 */
  msgIds: number[];
  /** 上次 flush 的墙钟时间（ms）。 */
  lastFlushMs: number;
}

interface ClusteringState {
  /** Per-channel 消息缓冲。key = chatId。 */
  buffers: Record<string, ChannelBuffer>;
  /** 上次处理的 messageLog.id（全局高水位线，避免重复缓冲）。 */
  lastProcessedId: number;
}

// -- 运行时（非持久化） -------------------------------------------------------

/**
 * 异步 LLM 调用的 Promise。不序列化到 mod_states。
 * key = chatId。
 */
const _pendingCalls = new Map<string, Promise<ClusteringResult | null>>();

/**
 * 已完成的聚类结果，等待下一个 tick 消费。
 * key = chatId。
 */
const _completedResults = new Map<string, ClusteringResult>();

// -- Mod 定义 ----------------------------------------------------------------

export const clusteringMod = createMod<ClusteringState>("clustering", {
  category: "mechanic",
  description: "话题自动聚类（ADR-226）",
  topics: ["threads"],
  initialState: { buffers: {}, lastProcessedId: 0 },
})
  // ── onTickStart: 消费异步聚类结果 → 晋升为 thread ──────────────────────
  .onTickStart((ctx) => {
    const config = (
      ctx as unknown as {
        config?: { clustering?: { enabled?: boolean; maxAutoThreadsPerChannel?: number } };
      }
    ).config;
    if (config?.clustering?.enabled === false) return;

    // 异步结果在 Promise.then() 回调中写入 _completedResults，
    // onTickStart 直接消费已完成的结果。
    if (_completedResults.size === 0) return;

    const db = getDb();
    const maxAutoThreads = config?.clustering?.maxAutoThreadsPerChannel ?? 3;

    for (const [chatId, result] of _completedResults.entries()) {
      // 获取当前 open threads 用于去重
      const openThreads = db
        .select({
          id: narrativeThreads.id,
          title: narrativeThreads.title,
          source: narrativeThreads.source,
        })
        .from(narrativeThreads)
        .where(inArray(narrativeThreads.status, ["open", "active"]))
        .all();

      // 计算此 channel 当前 auto-thread 数量
      const autoThreadCount = openThreads.filter((t) => t.source === "auto").length;

      for (const cluster of result.clusters) {
        const weight = SIGNIFICANCE_TO_WEIGHT[cluster.significance];
        if (weight == null) continue; // trivial → 跳过

        if (cluster.messageIds.length < 3) continue;

        if (autoThreadCount >= maxAutoThreads) {
          log.debug("auto-thread 上限已达", { chatId, max: maxAutoThreads });
          break;
        }

        // Jaccard bigram 去重
        const isDuplicate = openThreads.some(
          (t) => t.title && jaccardSimilarity(cluster.title, t.title) > DEDUP_SIMILARITY_THRESHOLD,
        );
        if (isDuplicate) {
          log.debug("话题与已有 thread 重复，跳过", { title: cluster.title });
          continue;
        }

        // 晋升为 thread 图节点
        const threadId = createThreadInGraph(db, ctx.graph, ctx.tick, ctx.nowMs, {
          title: cluster.title,
          weight,
          source: "auto",
          sourceChannel: chatId,
          frame: cluster.summary,
        });

        log.info("auto-thread 创建", {
          threadId,
          title: cluster.title,
          significance: cluster.significance,
          weight,
          chatId,
          msgCount: cluster.messageIds.length,
        });
      }
    }

    _completedResults.clear();
  })

  // ── onTickEnd: 缓冲消息 + 检查 flush 条件 ─────────────────────────────
  .onTickEnd((ctx) => {
    const config = (
      ctx as unknown as {
        config?: {
          clustering?: {
            enabled?: boolean;
            bufferSize?: number;
            maxAgeMs?: number;
            minMessages?: number;
          };
        };
      }
    ).config;
    if (config?.clustering?.enabled === false) return;

    const bufferSize = config?.clustering?.bufferSize ?? 30;
    const maxAgeMs = config?.clustering?.maxAgeMs ?? 300_000;
    const minMessages = config?.clustering?.minMessages ?? 5;

    const db = getDb();

    // 收集本 tick 以来的新消息（全 channel，非 outgoing）
    const newMessages = db
      .select({
        id: messageLog.id,
        chatId: messageLog.chatId,
      })
      .from(messageLog)
      .where(and(gt(messageLog.id, ctx.state.lastProcessedId), eq(messageLog.isOutgoing, false)))
      .orderBy(messageLog.id)
      .all();

    if (newMessages.length > 0) {
      ctx.state.lastProcessedId = newMessages[newMessages.length - 1].id;
    }

    // 按 channel 分组追加到缓冲
    for (const msg of newMessages) {
      const chatId = msg.chatId;
      if (!ctx.state.buffers[chatId]) {
        ctx.state.buffers[chatId] = { msgIds: [], lastFlushMs: ctx.nowMs };
      }
      ctx.state.buffers[chatId].msgIds.push(msg.id);
    }

    // 检查每个 channel 的 flush 条件
    for (const [chatId, buffer] of Object.entries(ctx.state.buffers)) {
      if (buffer.msgIds.length === 0) continue;

      // 如果已有进行中的调用，跳过
      if (_pendingCalls.has(chatId)) continue;

      const countTrigger = buffer.msgIds.length >= bufferSize;
      const ageTrigger =
        ctx.nowMs - buffer.lastFlushMs >= maxAgeMs && buffer.msgIds.length >= minMessages;

      if (!countTrigger && !ageTrigger) continue;

      // 获取 open thread 标题用于上下文
      const openThreadTitles = db
        .select({ title: narrativeThreads.title })
        .from(narrativeThreads)
        .where(inArray(narrativeThreads.status, ["open", "active"]))
        .all()
        .map((r) => r.title)
        .filter(Boolean) as string[];

      // 收集要聚类的 msgIds，保留末尾 5 条用于下次重叠
      const flushIds = [...buffer.msgIds];
      const overlapCount = Math.min(5, buffer.msgIds.length);
      buffer.msgIds = buffer.msgIds.slice(-overlapCount);
      buffer.lastFlushMs = ctx.nowMs;

      // 异步 LLM 调用（fire-and-forget，结果写入 _completedResults）
      const promise = clusterMessages(chatId, flushIds, openThreadTitles);
      _pendingCalls.set(chatId, promise);

      promise
        .then((result) => {
          if (result && result.clusters.length > 0) {
            _completedResults.set(chatId, result);
          }
        })
        .catch((err) => {
          log.warn("聚类异步调用失败", { chatId, error: String(err) });
        })
        .finally(() => {
          _pendingCalls.delete(chatId);
        });

      log.debug("flush 触发", {
        chatId,
        msgCount: flushIds.length,
        reason: countTrigger ? "count" : "age",
      });
    }
  })
  .build();

// 导出用于测试
export type { ClusteringState, ChannelBuffer };
