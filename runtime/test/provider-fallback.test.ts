/**
 * D5: Provider Fallback 链 — 单元测试。
 *
 * 测试覆盖：
 * 1. 多 provider 初始化 + 默认选择
 * 2. breaker open → fallback 到下一个 provider
 * 3. 全部 breaker open → 退回第一个
 * 4. 单 provider 向后兼容
 *
 * @see docs/adr/123-crystallization-substrate-generalization.md §D5
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";

// mock @ai-sdk/openai-compatible（避免真实 HTTP 连接）
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn((opts: { name: string }) => {
    const providerFn = (model: string) => `${opts.name}:${model}`;
    providerFn._name = opts.name;
    return providerFn;
  }),
}));

import { getAvailableProvider, initProviders, resetProviders } from "../src/llm/client.js";
import {
  type BreakerEventType,
  onBreakerStateChange,
  resetCircuitBreaker,
  withResilience,
} from "../src/llm/resilience.js";

// 制造 breaker open 状态的辅助函数
async function tripBreaker(providerName: string, failures = 5): Promise<void> {
  for (let i = 0; i < failures; i++) {
    try {
      await withResilience(
        () => Promise.reject(Object.assign(new Error("503"), { status: 503 })),
        { maxRetries: 0, circuitThreshold: failures },
        providerName,
      );
    } catch {
      // 预期失败
    }
  }
}

function mockConfig(providers: Config["providers"]): Pick<Config, "providers"> {
  return { providers };
}

afterEach(() => {
  resetProviders();
  resetCircuitBreaker();
});

describe("D5: Provider Fallback", () => {
  it("多 provider 初始化 + 默认选择第一个", () => {
    initProviders(
      mockConfig([
        { name: "primary", baseUrl: "https://a.io/v1", apiKey: "k1", model: "m1" },
        { name: "secondary", baseUrl: "https://b.io/v1", apiKey: "k2", model: "m2" },
      ]) as Config,
    );

    const result = getAvailableProvider();
    expect(result.name).toBe("primary");
    expect(result.model).toBe("m1");
  });

  it("primary breaker open → fallback 到 secondary", async () => {
    initProviders(
      mockConfig([
        { name: "primary", baseUrl: "https://a.io/v1", apiKey: "k1", model: "m1" },
        { name: "secondary", baseUrl: "https://b.io/v1", apiKey: "k2", model: "m2" },
      ]) as Config,
    );

    // 让 primary 的 breaker open
    await tripBreaker("primary");

    const result = getAvailableProvider();
    expect(result.name).toBe("secondary");
    expect(result.model).toBe("m2");
  });

  it("全部 breaker open → 退回第一个", async () => {
    initProviders(
      mockConfig([
        { name: "primary", baseUrl: "https://a.io/v1", apiKey: "k1", model: "m1" },
        { name: "secondary", baseUrl: "https://b.io/v1", apiKey: "k2", model: "m2" },
      ]) as Config,
    );

    await tripBreaker("primary");
    await tripBreaker("secondary");

    const result = getAvailableProvider();
    expect(result.name).toBe("primary");
  });

  it("单 provider 向后兼容", () => {
    initProviders(
      mockConfig([
        {
          name: "default",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          model: "gpt-4o",
        },
      ]) as Config,
    );

    const result = getAvailableProvider();
    expect(result.name).toBe("default");
    expect(result.model).toBe("gpt-4o");
  });

  it("未初始化时 getAvailableProvider 抛出", () => {
    expect(() => getAvailableProvider()).toThrow("No providers initialized");
  });
});

// ADR-129: 熔断器状态变化监听器
describe("ADR-129: breaker state change listener", () => {
  it("breaker open 时触发 listener", async () => {
    const events: Array<{ name: string; event: BreakerEventType }> = [];
    onBreakerStateChange((name, event) => events.push({ name, event }));

    await tripBreaker("test-provider", 5);

    expect(events).toContainEqual({ name: "test-provider", event: "open" });
  });

  it("breaker 恢复（half-open → closed）时触发 listener", async () => {
    const events: Array<{ name: string; event: BreakerEventType }> = [];
    onBreakerStateChange((name, event) => events.push({ name, event }));

    // 先让 breaker open
    await tripBreaker("recover-test", 5);

    // 等待 resetMs 过期（默认 60s，但 tripBreaker 用 circuitThreshold=5）
    // 直接做一次成功调用来触发 half-open → closed
    // 需要先让 breaker 进入 half-open（手动用短 resetMs）
    try {
      await withResilience(
        () => Promise.reject(Object.assign(new Error("503"), { status: 503 })),
        { maxRetries: 0, circuitThreshold: 1, circuitResetMs: 0 },
        "fast-recover",
      );
    } catch {
      // open
    }

    // resetMs=0 → 立即 half-open，下一次请求放行
    const result = await withResilience(
      () => Promise.resolve("ok"),
      { circuitResetMs: 0 },
      "fast-recover",
    );
    expect(result).toBe("ok");
    expect(events).toContainEqual({ name: "fast-recover", event: "closed" });
  });

  it("listener 异常不影响 breaker 工作", async () => {
    onBreakerStateChange(() => {
      throw new Error("listener error");
    });

    // 应该不抛出
    await tripBreaker("error-listener", 5);
    // breaker 仍然正常 open
  });
});
