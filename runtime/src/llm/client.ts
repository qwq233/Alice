/**
 * Vercel AI SDK — 多 provider fallback 链。
 *
 * D5（ADR-123 §D5）：将单一 provider 单例扩展为有序 provider 数组。
 * 每个 provider 拥有独立的熔断器（via resilience.ts per-provider breaker）。
 * `getAvailableProvider()` 按序返回第一个熔断器非 open 的 provider，
 * 全部 open 时退回第一个（等待半开放试探）。
 *
 * 使用 @ai-sdk/openai-compatible（而非 @ai-sdk/openai），
 * 因为 Alice 连接的是 OpenAI 兼容代理（如 ohmygpt），不是 OpenAI 原生 API。
 *
 * @see docs/adr/123-crystallization-substrate-generalization.md §D5
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Config, ProviderConfig } from "../config.js";
import { getBreakerState } from "./resilience.js";

// -- 类型 -------------------------------------------------------------------

interface ProviderEntry {
  config: ProviderConfig;
  provider: ReturnType<typeof createOpenAICompatible>;
}

export interface AvailableProvider {
  provider: ReturnType<typeof createOpenAICompatible>;
  model: string;
  name: string;
}

// -- 状态 -------------------------------------------------------------------

let _providers: ProviderEntry[] = [];

// -- 公共 API ---------------------------------------------------------------

/** 从 Config.providers 初始化 provider 链。启动时调用一次。 */
export function initProviders(config: Config): void {
  _providers = config.providers.map((pc) => ({
    config: pc,
    provider: createOpenAICompatible({
      name: pc.name,
      baseURL: pc.baseUrl,
      apiKey: pc.apiKey,
      // 启用 json_schema 模式，让 generateObject 发送完整 schema 给 API，
      // 服务端强制 structured output。否则只发 { type: "json_object" }，
      // LLM 返回自由格式 JSON → Zod 验证系统性失败。
      // @see https://github.com/vercel/ai/issues/5197
      supportsStructuredOutputs: true,
    }),
  }));
}

/**
 * 返回当前可用的 provider（跳过熔断器 open 的）。
 * 全部 open 时退回第一个，等待半开放试探。
 */
export function getAvailableProvider(): AvailableProvider {
  if (_providers.length === 0) {
    throw new Error("No providers initialized — call initProviders() first");
  }
  for (const entry of _providers) {
    if (getBreakerState(entry.config.name) !== "open") {
      return { provider: entry.provider, model: entry.config.model, name: entry.config.name };
    }
  }
  // 全部 open → 强制使用第一个（等待半开放试探）
  const first = _providers[0];
  return { provider: first.provider, model: first.config.model, name: first.config.name };
}

/**
 * 是否有任何 provider 的熔断器不在 open 状态。
 *
 * evolve 层在 directed_override 前调用此函数——
 * 全部 provider 熔断时强制行动只会空转浪费 tick。
 *
 * @see docs/adr/156-emotional-reactivity-damping.md — 级联故障修复
 */
export function isAnyProviderHealthy(): boolean {
  if (_providers.length === 0) return false;
  return _providers.some((entry) => getBreakerState(entry.config.name) !== "open");
}

/** 重置 provider 列表（用于测试）。 */
export function resetProviders(): void {
  _providers = [];
}
