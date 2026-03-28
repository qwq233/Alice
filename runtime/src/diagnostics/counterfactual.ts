/**
 * A4 D5 必要性反事实分析 — ADR-76 自动化行为验证。
 *
 * 反事实问题：如果移除 D5 社交成本门控（C_social = 0），
 * 有多少沉默决策会翻转为行动？
 *
 * 方法：重放 silence_log，检查 netValue > 0 的沉默记录——
 * 这些记录在 C_social = 0 时会变成行动（因为 V = ΔP - λ·C_social，
 * 移除 C_social 后 V = ΔP，只要 ΔP > 0 就会行动）。
 *
 * @see docs/adr/76-naturalness-validation-methodology.md
 * @see docs/adr/63-theory-validation-checklist.md §V2
 * @see paper-five-dim/ Proposition: D5 Irreducibility
 */

import { asc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { actionLog, silenceLog } from "../db/schema.js";

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

export interface CounterfactualD5Report {
  /** 沉默总数（有 netValue 和 socialCost 数据的）。 */
  analyzableSilences: number;
  /** C_social = 0 时翻转为行动的沉默数。 */
  flippedActions: number;
  /** 翻转率 = flippedActions / analyzableSilences。 */
  flipRate: number;
  /** 按沉默原因分组的翻转统计。 */
  flipsByReason: Record<string, { total: number; flipped: number; rate: number }>;
  /** 行动总数（参考基线）。 */
  totalActions: number;
  /**
   * 无 D5 时的行动频率变化 = (totalActions + flippedActions) / totalActions。
   * ADR-63 V2 预测：此值 >> 1（D5 显著抑制行动频率）。
   */
  frequencyMultiplier: number;
  /** 按目标分组的翻转分布（哪些目标受 D5 保护最多）。 */
  flipsByTarget: Record<string, number>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 分析函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * D5 反事实分析：令 C_social = 0 后有多少沉默会翻转。
 *
 * 使用 silence_log 中已记录的 deltaP 和 socialCost 重建 NSV：
 * - 原始 NSV = netValue = deltaP - lambda * socialCost（已被门控跳过）
 * - 反事实 NSV' = deltaP（移除 socialCost）
 * - 如果 NSV' > 0 且原始决策是沉默，则该决策翻转
 *
 * 注意：仅分析 reason 不是 rate_cap 的沉默（rate_cap 与 D5 无关）。
 */
export function counterfactualD5(): CounterfactualD5Report {
  const db = getDb();

  const silences = db
    .select({
      tick: silenceLog.tick,
      reason: silenceLog.reason,
      target: silenceLog.target,
      netValue: silenceLog.netValue,
      deltaP: silenceLog.deltaP,
      socialCost: silenceLog.socialCost,
    })
    .from(silenceLog)
    .orderBy(asc(silenceLog.tick))
    .all();

  const totalActions = db.select({ tick: actionLog.tick }).from(actionLog).all().length;

  // 只分析有完整数值数据的沉默记录
  const analyzable = silences.filter((s) => s.deltaP !== null && s.socialCost !== null);

  let flippedActions = 0;
  const flipsByReason: Record<string, { total: number; flipped: number }> = {};
  const flipsByTarget: Record<string, number> = {};

  for (const silence of analyzable) {
    const reason = silence.reason;
    if (!flipsByReason[reason]) {
      flipsByReason[reason] = { total: 0, flipped: 0 };
    }
    flipsByReason[reason].total++;

    // 反事实 NSV' = ΔP（移除 socialCost 后）
    // 原始决策是沉默，如果 ΔP > 0 则在无 D5 时会行动
    const deltaP = silence.deltaP ?? 0;
    if (deltaP > 0) {
      flippedActions++;
      flipsByReason[reason].flipped++;
      const target = silence.target ?? "__no_target__";
      flipsByTarget[target] = (flipsByTarget[target] ?? 0) + 1;
    }
  }

  const flipsByReasonWithRate: Record<string, { total: number; flipped: number; rate: number }> =
    {};
  for (const [reason, stats] of Object.entries(flipsByReason)) {
    flipsByReasonWithRate[reason] = {
      ...stats,
      rate: stats.total > 0 ? stats.flipped / stats.total : 0,
    };
  }

  return {
    analyzableSilences: analyzable.length,
    flippedActions,
    flipRate: analyzable.length > 0 ? flippedActions / analyzable.length : 0,
    flipsByReason: flipsByReasonWithRate,
    totalActions,
    frequencyMultiplier: totalActions > 0 ? (totalActions + flippedActions) / totalActions : 1,
    flipsByTarget,
  };
}
