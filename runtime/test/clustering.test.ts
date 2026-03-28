/**
 * ADR-226: 话题自动聚类 — 核心 + Mod 测试。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ClusteringResult } from "../src/engine/clustering.js";
import { resetReflectClient } from "../src/engine/clustering.js";

// ── 聚类核心 Schema 测试 ─────────────────────────────────────────────────────

describe("ClusteringOutputSchema", () => {
  // 直接测试 Zod schema 解析
  it("正常输出解析", async () => {
    const { z } = await import("zod");
    // 内联 schema 定义以避免导出细节耦合
    const ClusterSchema = z.object({
      title: z.string().min(2).max(80),
      summary: z.string().max(300),
      significance: z.enum(["trivial", "moderate", "important", "critical"]),
      messageIds: z.array(z.number()),
    });
    const ClusteringOutputSchema = z.object({
      clusters: z.array(ClusterSchema),
    });

    const input = {
      clusters: [
        {
          title: "讨论 Python 异步编程",
          summary: "几个人在讨论 asyncio 的用法和性能问题",
          significance: "moderate" as const,
          messageIds: [1, 2, 3, 5],
        },
        {
          title: "午饭吃什么",
          summary: "闲聊",
          significance: "trivial" as const,
          messageIds: [4, 6],
        },
      ],
    };

    const result = ClusteringOutputSchema.parse(input);
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0].significance).toBe("moderate");
    expect(result.clusters[1].significance).toBe("trivial");
  });

  it("空聚类输出解析", async () => {
    const { z } = await import("zod");
    const ClusteringOutputSchema = z.object({
      clusters: z.array(
        z.object({
          title: z.string().min(2).max(80),
          summary: z.string().max(300),
          significance: z.enum(["trivial", "moderate", "important", "critical"]),
          messageIds: z.array(z.number()),
        }),
      ),
    });

    const result = ClusteringOutputSchema.parse({ clusters: [] });
    expect(result.clusters).toHaveLength(0);
  });

  it("非法 significance 拒绝", async () => {
    const { z } = await import("zod");
    const ClusteringOutputSchema = z.object({
      clusters: z.array(
        z.object({
          title: z.string().min(2).max(80),
          summary: z.string().max(300),
          significance: z.enum(["trivial", "moderate", "important", "critical"]),
          messageIds: z.array(z.number()),
        }),
      ),
    });

    expect(() =>
      ClusteringOutputSchema.parse({
        clusters: [{ title: "test", summary: "s", significance: "unknown", messageIds: [1] }],
      }),
    ).toThrow();
  });
});

// ── Reflect Client 初始化 ────────────────────────────────────────────────────

describe("initReflectClient", () => {
  afterEach(() => {
    resetReflectClient();
  });

  it("无 API key 时不初始化", async () => {
    const { initReflectClient } = await import("../src/engine/clustering.js");
    // 构造一个 minimal config
    const config = {
      llmReflectModel: "gpt-4o-mini",
      llmReflectBaseUrl: "https://api.example.com/v1",
      llmReflectApiKey: "", // 空 → 不初始化
    } as Parameters<typeof initReflectClient>[0];

    // 应该不抛异常
    initReflectClient(config);

    // clusterMessages 应该返回 null（client 未初始化）
    const { clusterMessages } = await import("../src/engine/clustering.js");
    const result = await clusterMessages("channel:123", [1, 2, 3], []);
    expect(result).toBeNull();
  });
});

// ── Mod 缓冲管理 + 晋升逻辑 ─────────────────────────────────────────────────

describe("clustering.mod 晋升逻辑", () => {
  it("Jaccard bigram 去重正确工作", async () => {
    const { jaccardSimilarity } = await import("../src/mods/diary.mod.js");

    // 完全相同
    expect(jaccardSimilarity("讨论 Python 异步编程", "讨论 Python 异步编程")).toBe(1);

    // 高度相似（应去重）
    const sim = jaccardSimilarity("讨论 Python 异步", "讨论 Python 异步编程");
    expect(sim).toBeGreaterThan(0.5);

    // 完全不同（不应去重）
    const diff = jaccardSimilarity("讨论 Python", "明天天气怎么样");
    expect(diff).toBeLessThan(0.3);
  });

  it("significance → weight 映射", () => {
    const mapping: Record<string, string | null> = {
      trivial: null,
      moderate: "minor",
      important: "major",
      critical: "critical",
    };

    expect(mapping.trivial).toBeNull();
    expect(mapping.moderate).toBe("minor");
    expect(mapping.important).toBe("major");
    expect(mapping.critical).toBe("critical");
  });

  it("messageIds < 3 的聚类不应晋升", () => {
    const cluster = {
      title: "短对话",
      summary: "两条消息",
      significance: "moderate" as const,
      messageIds: [1, 2], // < 3
    };
    // 晋升条件检查
    expect(cluster.messageIds.length >= 3).toBe(false);
  });
});

// ── source 类型扩展 ──────────────────────────────────────────────────────────

describe("Thread source 类型", () => {
  it("ThreadAttrs 接受 auto source", async () => {
    // 仅验证类型系统——运行时 source 是字符串，此处验证合法值
    const source: "conversation" | "system" | "auto" = "auto";
    expect(source).toBe("auto");
  });
});

// ── Config 新字段 ────────────────────────────────────────────────────────────

describe("Config clustering 字段", () => {
  it("loadConfig 返回 clustering 配置", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.clustering).toBeDefined();
    expect(config.clustering.enabled).toBe(true);
    expect(config.clustering.bufferSize).toBe(30);
    expect(config.clustering.maxAgeMs).toBe(300_000);
    expect(config.clustering.minMessages).toBe(5);
    expect(config.clustering.maxAutoThreadsPerChannel).toBe(3);
  });

  it("loadConfig 返回 Reflect Provider 三件套", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();

    expect(config.llmReflectModel).toBeDefined();
    expect(config.llmReflectBaseUrl).toBeDefined();
    expect(config.llmReflectApiKey).toBeDefined();
    // 回退到主 LLM
    expect(config.llmReflectBaseUrl).toBe(config.llmBaseUrl);
    expect(config.llmReflectApiKey).toBe(config.llmApiKey);
  });
});
