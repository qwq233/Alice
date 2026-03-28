/**
 * 话题自动聚类 — ADR-226。
 *
 * 用 Reflect Provider（cheap model）从消息缓冲中识别话题集群。
 * 仅做聚类+摘要，不做 Triage（响应决策交给压力场）。
 *
 * @see docs/adr/226-auto-clustering.md
 * @see CyberGroupmate RecordingPipeline（设计参考，AGPL 不可复制代码）
 */

import Instructor from "@instructor-ai/instructor";
import { and, eq, inArray } from "drizzle-orm";
import OpenAI from "openai";
import { z } from "zod";
import type { Config } from "../config.js";
import { getDb } from "../db/connection.js";
import { messageLog } from "../db/schema.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("clustering");

// -- Schema ------------------------------------------------------------------

const ClusterSchema = z.object({
  title: z.string().min(2).max(80).describe("话题标题（用对话语言）"),
  summary: z.string().max(300).describe("2-3 句摘要"),
  significance: z
    .enum(["trivial", "moderate", "important", "critical"])
    .describe("trivial=闲聊寒暄, moderate=有实质内容, important=重要事项, critical=紧急"),
  messageIds: z.array(z.number()).describe("属于此话题的消息 ID"),
});

const ClusteringOutputSchema = z.object({
  clusters: z.array(ClusterSchema),
});

export type ClusteringResult = z.infer<typeof ClusteringOutputSchema>;
export type Cluster = z.infer<typeof ClusterSchema>;

// -- Reflect Provider client (lazy init) -------------------------------------

let _reflectInstructor: ReturnType<typeof Instructor> | null = null;
let _reflectModel = "";

/**
 * 初始化 Reflect Provider instructor 客户端。
 * 与 Vision/TTS 同构：独立三件套，回退到主 LLM。
 */
export function initReflectClient(config: Config): void {
  if (!config.llmReflectApiKey) {
    log.warn("Reflect Provider API key 为空，clustering 将被跳过");
    return;
  }
  const oai = new OpenAI({
    baseURL: config.llmReflectBaseUrl,
    apiKey: config.llmReflectApiKey,
  });
  // Gemini 用 MD_JSON，其他用 TOOLS
  const lower = config.llmReflectModel.toLowerCase();
  const mode = lower.includes("gemini") || lower.includes("vertex") ? "MD_JSON" : "TOOLS";
  _reflectInstructor = Instructor({ client: oai, mode });
  _reflectModel = config.llmReflectModel;
  log.info("Reflect client 初始化完成", { model: _reflectModel, mode });
}

/** 测试用重置。 */
export function resetReflectClient(): void {
  _reflectInstructor = null;
  _reflectModel = "";
}

// -- 聚类核心 ----------------------------------------------------------------

/**
 * 从 messageLog 批量读取消息，调用 cheap model 做话题聚类。
 *
 * @param chatId      channel node ID（如 "channel:123"）
 * @param msgIds      消息 DB ID 列表
 * @param openThreads 当前打开的 thread 标题列表（用于避免重复聚类）
 * @returns 聚类结果，或 null（Reflect Provider 不可用 / LLM 失败）
 */
export async function clusterMessages(
  chatId: string,
  msgIds: number[],
  openThreads: string[],
): Promise<ClusteringResult | null> {
  if (!_reflectInstructor || !_reflectModel) {
    return null;
  }

  if (msgIds.length === 0) return null;

  // 从 DB 读取消息文本
  const db = getDb();
  const rows = db
    .select({
      id: messageLog.id,
      senderName: messageLog.senderName,
      text: messageLog.text,
      createdAt: messageLog.createdAt,
    })
    .from(messageLog)
    .where(and(eq(messageLog.chatId, chatId), inArray(messageLog.id, msgIds)))
    .orderBy(messageLog.id)
    .all();

  if (rows.length === 0) return null;

  // 格式化消息为 IRC 风格
  const formatted = rows
    .map((r) => {
      const time = r.createdAt
        ? new Date(r.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
        : "??:??";
      const text = (r.text ?? "").slice(0, 200);
      return `[${time}] ${r.senderName ?? "?"}: ${text}`;
    })
    .join("\n");

  // 构建 prompt
  const threadContext =
    openThreads.length > 0
      ? `\n\n当前已有的话题：\n${openThreads.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
      : "";

  const systemPrompt = `你是话题分析助手。分析以下对话消息，识别有实质内容的话题集群。

规则：
- 闲聊、寒暄、单条无关消息标记为 trivial 或不归入任何话题
- 每个话题至少包含 2 条相关消息
- 标题和摘要使用对话中的语言
- 如果消息与已有话题重叠，仍然归类但使用相似的标题
- significance 判断标准：trivial=日常寒暄/表情包, moderate=有实质讨论内容, important=涉及决策/计划/求助, critical=紧急事项${threadContext}`;

  try {
    const result = await _reflectInstructor.chat.completions.create({
      model: _reflectModel,
      max_retries: 1,
      response_model: { schema: ClusteringOutputSchema, name: "TopicClusters" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: formatted },
      ],
    });

    log.debug("聚类完成", {
      chatId,
      msgCount: rows.length,
      clusterCount: result.clusters.length,
    });

    return result;
  } catch (err) {
    log.warn("聚类 LLM 调用失败", { chatId, error: String(err) });
    return null;
  }
}
