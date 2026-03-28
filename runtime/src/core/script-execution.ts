/**
 * Script execution result types.
 *
 * The shell-native executor (`shell-executor.ts`) is the execution backend.
 * This module provides the shared result types used across the tick pipeline.
 *
 * ADR-214 Wave B: ScriptExecutionResult 是唯一的执行结果类型。
 * ExecutableResult / RecordedAction 已删除——shell-native 架构下 Telegram 动作
 * 通过容器内 Engine API HTTP 直接执行，结果以 completedActions 字符串追踪。
 */

/** Unified script execution result used across the tick pipeline. */
export interface ScriptExecutionResult {
  logs: string[];
  errors: string[];
  instructionErrors: string[];
  duration: number;
  thinks: string[];
  queryLogs: Array<{ fn: string; result: string }>;
  contextVars?: Record<string, unknown>;
  /** 已完成的动作（shell 脚本输出的 __ALICE_ACTION__ 行）。格式: "sent:chatId=X:msgId=Y" 等。 */
  completedActions: string[];
  /** LLM 主动选择沉默的原因（null = 非沉默）。 */
  silenceReason: string | null;
}

// ── completedActions 解析工具 ─────────────────────────────────────────────

/**
 * completedActions 是否包含消息发送动作（"sent:" 前缀）。
 * 替代旧 hasMessageAction()——从真实 Telegram 执行结果推导，而非始终为空的 RecordedAction[]。
 */
export function hasCompletedSend(result: { completedActions: string[] }): boolean {
  return result.completedActions.some((a) => a.startsWith("sent:"));
}
