/**
 * P6 好奇心 (Curiosity) — Surprise-driven Curiosity。
 *
 * ADR-112 D1+D2: 从静态画像缺口重写为预测误差驱动。
 *
 * P6(c) = w_tier(c) × surprise(c) × γ(c)
 *
 * surprise 基于 2 个正交的结构性信号（"语义归 LLM，结构归代码"原则）：
 *   1. 沉默偏差: |actual_silence - tier_expected_silence| / tier_expected_silence
 *      — 当前沉默是否偏离该 tier 的自然节奏？（时间维度）
 *   2. 活跃率偏差: |log(actual_rate / tier_expected_rate)|
 *      — 总交互量是否偏离该 tier 的典型频率？（量级维度，Weber-Fechner 对数律）
 *
 * surprise 有界 ∈ [0, 1]:
 *   surprise = σ + (1 - σ) × tanh(signalMean)
 *   σ 高（新联系人）→ 认识论好奇心主导（我还不了解你）
 *   σ 低（老联系人）→ 偶然好奇心主导（你的行为出乎我意料）
 *
 * D2: Ambient Curiosity 解决冷启动停滞。
 *   P6_ambient = η × (1 - familiarity(G))
 *   P6_total = max(P6_surprise, P6_ambient)
 *
 * @see docs/adr/112-pressure-dynamics-rehabilitation/ §D1, §D2
 * @see paper/ Definition 3.3 (Information Curiosity Pressure)
 */

import { DUNBAR_TIER_WEIGHT } from "../graph/constants.js";
import type { ContactAttrs, DunbarTier } from "../graph/entities.js";
import type { WorldModel } from "../graph/world-model.js";
import { elapsedS, readNodeMs } from "./clock.js";
import type { PressureResult } from "./p1-attention.js";

// -- ADR-206 W4: 频道好奇心常量 -----------------------------------------------

/**
 * 频道信息饥渴时间常数 τ（秒）：hunger = 1 - exp(-t/τ)。
 * τ=21600s (6h) 时，6h 不看 → ~63% 饥渴恢复，12h → ~86%。
 * @see docs/adr/206-channel-information-flow/206-channel-information-flow.md §5
 */
const CHANNEL_HUNGER_TAU_S = 21_600; // 6h

/**
 * 频道好奇心权重：相对于联系人好奇心的基础系数。
 * 频道是信息源不是社交对等体，好奇心贡献低于联系人。
 */
const CHANNEL_CURIOSITY_WEIGHT = 0.3;

// -- 常量 -------------------------------------------------------------------

/** 信息增益折扣时间常数（秒）：最近交互过的联系人好奇心打折。 */
export const TAU_CURIOSITY = 3000;

/** 最大 tier 权重（用于归一化 w_tier ∈ (0, 1]）。 */
const MAX_TIER_WEIGHT = Math.max(...Object.values(DUNBAR_TIER_WEIGHT));

/**
 * 冷启动 σ_prediction：新联系人的预测不确定性。
 * 随 interaction_count 递减：σ = 1 / (1 + interaction_count / SIGMA_HALF_LIFE)
 * 10 次交互后 σ ≈ 0.5。
 */
const SIGMA_HALF_LIFE = 10;

/** Dunbar 150 常量（ambient curiosity 归一化用）。 */
const DUNBAR_150 = 150;

/** 环境熟悉度时间窗口（天）：7 天达到完全熟悉。 */
const FAMILIARITY_DAYS = 7;

/**
 * Tier → 期望沉默间隔（秒）。
 *
 * 为**线上即时通讯**场景标定（非面对面社交）。
 * Dunbar 层级结构保持不变，但频率按 IM 行为重新估计：
 * - 亲密圈（5）：约每 4 小时消息一次（一天多轮对话）
 * - 同情圈（15）：约每天一次
 * - 亲友圈（50）：约每 3 天一次
 * - 认识圈（150）：约每 2 周一次
 * - 面熟圈（500）：约每 2 月一次
 *
 * @see Dunbar (2016) "Do online social media cut through the constraints
 *      that limit the size of offline social networks?"
 */
const TIER_EXPECTED_SILENCE_S: Record<DunbarTier, number> = {
  5: 14_400, // 4 小时
  15: 86_400, // 1 天
  50: 259_200, // 3 天
  150: 1_209_600, // 14 天
  500: 5_184_000, // 60 天
};

/**
 * Tier → 期望每日消息率。
 * 与 TIER_EXPECTED_SILENCE_S 互为倒数，用于活跃率偏差计算。
 * 注意 interaction_count 追踪的是**单条消息**，不是"对话次数"。
 */
const TIER_EXPECTED_DAILY_RATE: Record<DunbarTier, number> = {
  5: 6.0, // ~6 条/天（一天多轮对话）
  15: 1.0, // ~1 条/天
  50: 0.33, // ~1 条/3 天
  150: 0.07, // ~1 条/2 周
  500: 0.016, // ~1 条/2 月
};

// -- Surprise 信号 -----------------------------------------------------------

/**
 * σ_prediction: 预测不确定性（认识论不确定性）。
 * 新联系人 σ=1.0（最大不确定性），随交互次数递减。
 */
function sigmaPrediction(interactionCount: number): number {
  return 1.0 / (1.0 + interactionCount / SIGMA_HALF_LIFE);
}

/**
 * 信号 1: 沉默偏差（时间维度）。
 *
 * 当前沉默时长与该 tier 期望沉默的归一化偏差。
 * 亲密联系人沉默一周 → 高偏差。
 * 疏远联系人沉默一周 → 正常，低偏差。
 *
 * @see Dunbar (2010) "How Many Friends Does One Person Need?"
 */
function silenceDeviation(attrs: ContactAttrs, nowMs: number): number {
  const lastActiveMs = attrs.last_active_ms ?? 0;
  if (lastActiveMs === 0) return 0;

  const actualSilenceS = elapsedS(nowMs, lastActiveMs);
  const expectedSilenceS = TIER_EXPECTED_SILENCE_S[attrs.tier] ?? 604_800;

  return Math.abs(actualSilenceS - expectedSilenceS) / expectedSilenceS;
}

/**
 * 信号 2: 活跃率偏差（量级维度，Weber-Fechner 对数律）。
 *
 * 该联系人的实际交互频率与 tier 期望频率的对数比。
 * 使用图年龄作为关系持续时间的保守估计。
 *
 * log-ratio 保证对称性：交互量是期望的 2 倍 和 期望的 1/2 产生相同偏差。
 *
 * @see Weber-Fechner law: 感知量与刺激强度的对数成正比
 */
function activityRateDeviation(attrs: ContactAttrs, graphAgeDays: number): number {
  const interactionCount = attrs.interaction_count ?? 0;
  if (interactionCount < 2 || graphAgeDays < 1) return 0;

  const actualDailyRate = interactionCount / graphAgeDays;
  const expectedDailyRate = TIER_EXPECTED_DAILY_RATE[attrs.tier] ?? 0.14;

  // Weber-Fechner 对数律：对称偏差
  const ratio = actualDailyRate / expectedDailyRate;
  return Math.abs(Math.log(Math.max(ratio, 0.01)));
}

/**
 * 综合 surprise 值（有界 ∈ [0, 1]）。
 *
 * surprise = σ + (1 - σ) × tanh(signalMean)
 *
 * 这是认识论不确定性与偶然不确定性的凸插值：
 * - σ=1（新联系人）→ surprise = 1.0（纯认识论好奇心："我还不了解你"）
 * - σ=0（老联系人）→ surprise = tanh(signals)（纯偶然好奇心："你的行为出乎意料"）
 * - tanh 保证输出有界，避免极端信号值主导系统
 *
 * @see Friston (2010) "The free-energy principle: a unified brain theory?"
 */
function computeSurprise(attrs: ContactAttrs, nowMs: number, graphAgeDays: number): number {
  const sigma = sigmaPrediction(attrs.interaction_count ?? 0);

  const s1 = silenceDeviation(attrs, nowMs);
  const s2 = activityRateDeviation(attrs, graphAgeDays);

  const signalMean = (s1 + s2) / 2;

  // 有界插值：σ 提供认识论基线，(1-σ)×tanh 提供信号驱动的偶然好奇心
  return sigma + (1 - sigma) * Math.tanh(signalMean);
}

// -- P6 主函数 ---------------------------------------------------------------

/**
 * P6 好奇心压力（ADR-112 重写版）。
 *
 * @param G - 伴侣图
 * @param nowMs - 当前墙钟时间（毫秒）
 * @param eta - 环境好奇心基线（config.eta，默认 0.6）
 */
export function p6Curiosity(G: WorldModel, nowMs: number, eta = 0.6): PressureResult {
  // ── D2: Ambient Curiosity（冷启动兜底）──────────────────────────
  const contacts = G.getEntitiesByType("contact");
  const contactCount = contacts.length;

  const graphAgeDays = G.getGraphAgeMs(nowMs) / 86_400_000;
  const contactFamiliarity = Math.min(1, contactCount / DUNBAR_150);
  const timeFamiliarity = Math.min(1, graphAgeDays / FAMILIARITY_DAYS);
  const familiarity = contactFamiliarity * timeFamiliarity;
  const ambientCuriosity = eta * (1 - familiarity);

  if (contactCount === 0) {
    return { total: ambientCuriosity, contributions: {} };
  }

  // ── D1: Per-contact Surprise-driven Curiosity ──────────────────
  const contributions: Record<string, number> = {};
  let totalSurprise = 0;

  for (const cid of contacts) {
    const attrs = G.getContact(cid);

    // w_tier: 高 tier 联系人更值得了解（归一化到 (0, 1]）
    const wTier = DUNBAR_TIER_WEIGHT[attrs.tier] / MAX_TIER_WEIGHT;

    // surprise: 预测误差（有界 [0, 1]）
    const surprise = computeSurprise(attrs, nowMs, graphAgeDays);

    // γ: 信息增益折扣（最近交互过的联系人打折，避免重复探索）
    // 审计修复: 从未交互的联系人（lastActive=0）γ=0（不产生好奇心驱动的行动）。
    // 旧代码 elapsedS(nowMs, 0) 返回 ~56 年 → γ≈1.0 → 大量 tier-500 新联系人
    // 累积可使 P6 爆炸到 3.0+，tanh 饱和。
    // "从未交互" ≠ "很久没交互"。没有关系基线的人不触发好奇心压力。
    // Ambient Curiosity 已覆盖冷启动场景。
    const lastActiveMs = readNodeMs(G, cid, "last_active_ms");
    if (lastActiveMs <= 0) continue; // 从未交互 → 跳过（好奇心需要预测基线）
    const timeSinceLastS = elapsedS(nowMs, lastActiveMs);
    const gamma = 1 - Math.exp(-timeSinceLastS / TAU_CURIOSITY);

    const curiosity = wTier * surprise * gamma;
    if (curiosity > 0) {
      contributions[cid] = curiosity;
      totalSurprise += curiosity;
    }
  }

  // P6 raw total = Σ per-contact curiosity（不除以联系人数量，与 P1-P5 一致）。
  // κ₆ 负责 tanh 归一化，不需要在此处归一化。

  // ── ADR-206 W4: 频道好奇心（信息饥渴）──────────────────────────
  // 频道好奇心 = 未读信号 × 时间饥渴度 × 基础权重
  // 不同于联系人的预测误差模型——频道是信息源，好奇心来自"好久没看了"
  let channelCuriosity = 0;
  for (const chId of G.getEntitiesByType("channel")) {
    const attrs = G.getChannel(chId);
    if (attrs.chat_type !== "channel") continue; // 只处理 Telegram 频道

    const unread = attrs.unread ?? 0;
    if (unread === 0) continue; // 没有未读 → 不产生好奇心

    // 信息饥渴度：距上次阅读越久，好奇心越高
    const lastReadMs = Number(attrs.last_read_ms ?? 0);
    const sinceReadS = lastReadMs > 0 ? elapsedS(nowMs, lastReadMs) : 0;
    // 从未阅读过的频道 → 使用 last_activity_ms 作为 fallback
    const effectiveSinceS =
      sinceReadS > 0 ? sinceReadS : elapsedS(nowMs, Number(attrs.last_activity_ms ?? 0));
    if (effectiveSinceS <= 0) continue;

    const hunger = 1 - Math.exp(-effectiveSinceS / CHANNEL_HUNGER_TAU_S);
    // unread 信号用 log 压缩（10 条 vs 100 条差距不大，但 0 vs 10 差距大）
    const unreadSignal = Math.log1p(unread);

    const chCuriosity = CHANNEL_CURIOSITY_WEIGHT * hunger * unreadSignal;
    if (chCuriosity > 0) {
      contributions[chId] = chCuriosity;
      channelCuriosity += chCuriosity;
    }
  }

  // D2: P6_total = max(P6_surprise + P6_channel, P6_ambient)
  const total = Math.max(totalSurprise + channelCuriosity, ambientCuriosity);

  return { total, contributions };
}
