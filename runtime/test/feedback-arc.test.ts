/**
 * ADR-185 §3: applyOutcomeMoodNudge 单元测试。
 *
 * ADR-214 Wave B: 参数改为 ScriptExecutionResult。
 * shell-native 下 rate_outcome 不在 completedActions 中追踪，
 * applyOutcomeMoodNudge 退化到 NUDGE_SENT_FALLBACK（0.3）。
 *
 * @see docs/adr/185-cross-pollination-from-llm-agent-landscape.md §3
 */
import { describe, expect, it } from "vitest";
import type { ScriptExecutionResult } from "../src/core/script-execution.js";
import { applyOutcomeMoodNudge } from "../src/engine/react/feedback-arc.js";
import { WorldModel } from "../src/graph/world-model.js";

// -- 辅助工厂 ----------------------------------------------------------------

/** 构建 minimal ScriptExecutionResult。 */
function makeResult(completedActions: string[] = []): ScriptExecutionResult {
  return {
    logs: [],
    errors: [],
    instructionErrors: [],
    duration: 0,
    thinks: [],
    queryLogs: [],
    completedActions,
    silenceReason: null,
  };
}

/** 创建包含 self agent 的 WorldModel，可指定初始 mood_valence。 */
function makeGraph(moodValence = 0): WorldModel {
  const G = new WorldModel();
  G.addAgent("self", { mood_valence: moodValence, mood_set_ms: 0 });
  return G;
}

const SCALE = 0.05;

describe("ADR-185 §3: applyOutcomeMoodNudge (shell-native)", () => {
  // -- shell-native: rate_outcome 不可用，退化到 fallback ----------------------

  it("消息已发送（无 rate_outcome）→ mood_valence 轻微增加 (scale × 0.3)", () => {
    const G = makeGraph(0);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, true, false, SCALE);
    expect(G.getAgent("self").mood_valence).toBeCloseTo(SCALE * 0.3);
  });

  it("LLM 失败 → mood_valence 轻微减少 (scale × -0.5)", () => {
    const G = makeGraph(0);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, false, true, SCALE);
    expect(G.getAgent("self").mood_valence).toBeCloseTo(SCALE * -0.5);
  });

  it("主动沉默 → mood_valence 不变", () => {
    const G = makeGraph(0.2);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, false, false, SCALE);
    // messageSent=false, llmFailed=false → silence → delta=0
    expect(G.getAgent("self").mood_valence).toBe(0.2);
  });

  // -- 深度对话额外加成 -------------------------------------------------------

  it("深度对话 (subcycles=4) → 额外正向加成", () => {
    const G = makeGraph(0);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, true, false, SCALE, 4);
    // delta = scale * 0.3 + scale * 0.3 = scale * 0.6
    expect(G.getAgent("self").mood_valence).toBeCloseTo(SCALE * 0.6);
  });

  it("subcycles=2（边界值）→ 不触发深度对话奖励", () => {
    const G = makeGraph(0);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, true, false, SCALE, 2);
    // subcycles <= 2 → 无额外加成
    expect(G.getAgent("self").mood_valence).toBeCloseTo(SCALE * 0.3);
  });

  // -- clamp 边界 -------------------------------------------------------------

  it("clamp: mood_valence=0.99 + positive nudge → 不超过 1.0", () => {
    const G = makeGraph(0.99);
    const sr = makeResult();
    // delta = SCALE * 0.3 = 0.015, 0.99 + 0.015 = 1.005 → clamp to 1.0
    applyOutcomeMoodNudge(G, sr, true, false, SCALE);
    expect(G.getAgent("self").mood_valence).toBe(1.0);
  });

  it("clamp: mood_valence=-0.98 + negative nudge → 不低于 -1.0", () => {
    const G = makeGraph(-0.98);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, false, true, SCALE);
    expect(G.getAgent("self").mood_valence).toBe(-1.0);
  });

  // -- 禁用 -------------------------------------------------------------------

  it("nudgeScale=0 → 无影响", () => {
    const G = makeGraph(0.5);
    const sr = makeResult();
    applyOutcomeMoodNudge(G, sr, true, false, 0);
    // delta = 0 * 0.3 = 0 → 不更新
    expect(G.getAgent("self").mood_valence).toBe(0.5);
  });

  // -- mood_set_ms 更新 -------------------------------------------------------

  it("非零 delta 时 mood_set_ms 被重置", () => {
    const G = makeGraph(0);
    const sr = makeResult();
    const before = Date.now();
    applyOutcomeMoodNudge(G, sr, true, false, SCALE);
    const after = Date.now();
    const ms = G.getAgent("self").mood_set_ms;
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  // -- 无 self agent → 安全退出 ------------------------------------------------

  it("无 self agent → 不崩溃", () => {
    const G = new WorldModel(); // 无 self
    const sr = makeResult();
    expect(() => {
      applyOutcomeMoodNudge(G, sr, true, false, SCALE);
    }).not.toThrow();
  });
});
