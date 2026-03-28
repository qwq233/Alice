/**
 * Blackboard Tick 核心循环 — buildPrompt → callLLM → script execution → updateBoard。
 *
 * ADR-214 Wave A: resolveQueries 已删除（shell-native 架构下 actions 始终为空）。
 *
 * 核心循环语义：
 * 1. buildPrompt → callLLM → executeScript（不变）
 * 2. updateBoard：脚本结果写入 Blackboard（不变）
 * 3. 脚本输出（stdout）→ observations（BT 原生结果回流）
 * 4. 脚本错误 → observations（LLM 自纠）
 * 5. continuation：有新 observations → while 循环自然继续
 *
 * 终止条件（ADR-216: afterward 信号驱动）：
 * - isTerminal(board) 非 null（budget 耗尽）
 * - afterward = done / fed_up / cooling_down / waiting_reply → 始终终止
 * - afterward = watching → 继续循环（外层 subcycle 信号）
 *
 * @see docs/adr/169-fire-query-auto-continuation.md
 * @see docs/adr/142-action-space-architecture/README.md
 */

import type { ActionRuntimeConfig } from "../../core/action-executor.js";
import type { Dispatcher } from "../../core/dispatcher.js";
import { presentToolResult } from "../../core/output-presenter.js";
import { logPromptSnapshot } from "../../diagnostics/prompt-log.js";
import type { WorldModel } from "../../graph/world-model.js";
import { drainBoard, isTerminal, updateBoard } from "./blackboard.js";
import { buildTickPrompt, type TickPromptContext } from "./prompt-builder.js";
import type {
  Blackboard,
  ScriptExecutionResult,
  TickOutcome,
  TickResult,
  TickStepOutput,
  UnifiedTool,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// 依赖注入接口
// ═══════════════════════════════════════════════════════════════════════════

/** Tick 循环的外部依赖（测试可 mock）。 */
export interface TickDeps {
  callLLM: (system: string, user: string) => Promise<TickStepOutput | null>;
  executeScript: (
    script: string,
    opts: { dispatcher: Dispatcher; graph: WorldModel; contextVars?: Record<string, unknown> },
  ) => Promise<ScriptExecutionResult>;

  /** Prompt 构建覆盖（eval 消融实验用）。省略时使用 buildTickPrompt。 */
  buildPrompt?: (
    board: Blackboard,
    allTools: readonly UnifiedTool[],
    ctx: TickPromptContext,
  ) => Promise<{ system: string; user: string }> | { system: string; user: string };

  /** 每步完成后回调（eval 诊断用）。在 LLM 调用后触发。 */
  onStep?: (info: { round: number; system: string; user: string; script: string | null }) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// 核心 tick 循环
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Blackboard Tick 循环 — 主入口。
 *
 * 每步：buildTickPrompt → callLLM → executeScript → updateBoard → inject errors
 * 续轮：有新 observations（结果 / 错误）→ while 循环自然继续
 * 终止：isTerminal(board) 非 null，或信号中断，或无新 observations
 */
export async function tick(
  board: Blackboard,
  allTools: readonly UnifiedTool[],
  deps: TickDeps,
  ctx: TickPromptContext & {
    client: unknown;
    runtimeConfig: ActionRuntimeConfig;
  },
): Promise<TickResult> {
  const startTime = Date.now();
  let outcome: TickOutcome = "terminal";
  let lastResidue: TickResult["llmResidue"];

  while (true) {
    // 检查终止条件
    const terminal = isTerminal(board);
    if (terminal != null) {
      outcome = terminal;
      break;
    }

    const round = board.budget.usedSteps;
    const obsBefore = board.observations.length;

    // ── 构建 prompt ──
    const promptCtx: TickPromptContext = {
      ...ctx,
      messages: ctx.messages,
      observations: board.observations,
      round,
    };
    const { system, user } = await (deps.buildPrompt ?? buildTickPrompt)(
      board,
      allTools,
      promptCtx,
    );

    // ── LLM 调用 ──
    const stepResult = await deps.callLLM(system, user);
    deps.onStep?.({ round, system, user, script: stepResult?.script ?? null });
    if (!stepResult) {
      logPromptSnapshot({
        tick: ctx.tick,
        target: ctx.item.target,
        voice: ctx.item.action,
        round,
        system,
        user,
        script: null,
      });
      outcome = "empty";
      break;
    }

    // ── 脚本执行 ──
    const preparedBefore = board.preparedCategories.size;
    const scriptResult = await deps.executeScript(stepResult.script, {
      dispatcher: ctx.dispatcher,
      graph: ctx.G,
      contextVars: board.contextVars as Record<string, unknown>,
    });

    // ADR-78: prompt 快照落盘
    logPromptSnapshot({
      tick: ctx.tick,
      target: ctx.item.target,
      voice: ctx.item.action,
      round,
      system,
      user,
      script: stepResult.script,
      execution: {
        thinks: scriptResult.thinks,
        queryLogs: scriptResult.queryLogs,
        errors: scriptResult.errors,
      },
    });

    // ── 更新 Blackboard ──
    updateBoard(board, scriptResult);

    // ── ADR-213: 执行结果 → observations（分形坍缩：round → 事实节点）──
    if (scriptResult.logs.length > 0) {
      board.observations.push(`(Command output:\n${presentToolResult(scriptResult)})`);
    }

    // ── ADR-169: 脚本错误 → observations（LLM 自纠）──
    if (scriptResult.errors.length > 0) {
      const errLines = scriptResult.errors.map((e) => `- ${e}`).join("\n");
      let obs = `(Script errors — review and adjust:\n${errLines})`;
      if (scriptResult.completedActions.length > 0) {
        const doneLines = scriptResult.completedActions.map((a) => `- ✓ ${a}`).join("\n");
        obs += `\n(Already completed — do NOT repeat:\n${doneLines})`;
      }
      board.observations.push(obs);
    }

    // 指令错误（无效 consult category、参数 arity 等）——非致命但 LLM 应知晓
    if (scriptResult.instructionErrors.length > 0) {
      const errLines = scriptResult.instructionErrors.map((e) => `- ${e}`).join("\n");
      board.observations.push(`(Instruction issues:\n${errLines})`);
    }

    const hasNewObs = board.observations.length > obsBefore;
    const revealedNewCategories = board.preparedCategories.size > preparedBefore;

    // ADR-215: 捕获最后一步的 residue
    if (stepResult.residue) lastResidue = stepResult.residue;

    // ── ADR-216: afterward 信号驱动续轮 ──
    const afterward = stepResult.afterward;
    if (afterward === "done") {
      outcome = "terminal";
      break;
    }
    if (afterward === "fed_up") {
      outcome = "fed_up";
      break;
    }
    if (afterward === "cooling_down") {
      outcome = "cooling_down";
      break;
    }
    if (afterward === "waiting_reply") {
      outcome = "waiting_reply";
      break;
    }
    if (afterward === "watching") {
      outcome = "watching";
      continue;
    }
    // fallback（zod required 不该到这里，defensive）
    if (hasNewObs || revealedNewCategories) continue;
    outcome = "terminal";
    break;
  }

  const result = drainBoard(board, outcome, Date.now() - startTime);
  if (lastResidue) result.llmResidue = lastResidue;
  return result;
}
