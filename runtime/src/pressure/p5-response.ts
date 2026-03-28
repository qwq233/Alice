/**
 * P5 回应义务 (Response Obligation) — Channel×Contact 驱动。
 * 对应 Python pressure.py P5_response_obligation()。
 *
 * P5(n) = Σ_h directed(h) · w_tier(h) · w_chat(h) · decay(age(h))
 *
 * ADR-157: 衰减核统一为指数核 2^(-ageS/τ)，与 signal-decay.ts 的
 * effectiveObligation 使用相同的物理模型（一阶动力学）和参数。
 * 旧版使用双曲线 1/(1+t/τ)，在 10τ 处残余 9.1%（指数核 0.1%），
 * 为已过期义务持续产生虚高 P5 压力。
 *
 * chat_type 调制（#2.1）：
 * 私聊中的 directed 消息回应义务更强——不回私聊比不回群聊更严重。
 *
 * Wave 6: Tier Overestimate Bias Correction — σ² 高时向基线 150 回归。
 * @see paper/ §Social POMDP "Tier Overestimate Bias Correction"
 * @see docs/adr/157-signal-decay-integrity.md §Fix 1
 */

import {
  CHAT_TYPE_WEIGHTS,
  chatIdToContactId,
  DUNBAR_TIER_WEIGHT,
  tierBiasCorrection,
} from "../graph/constants.js";
import { readSocialReception } from "../graph/dynamic-props.js";
import { findActiveConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { elapsedS, readNodeMs } from "./clock.js";
import { getDefaultParams, type HawkesState, queryIntensity } from "./hawkes.js";
import type { PressureResult } from "./p1-attention.js";
import {
  decaySignal,
  OBLIGATION_HALFLIFE_GROUP,
  OBLIGATION_HALFLIFE_PRIVATE,
} from "./signal-decay.js";

// ADR-222: CONVERSATION_INERTIA_BOOST (×1.5) 和 CONVERSATION_INERTIA_WINDOW (300s)
// 已删除——反物理的正反馈。适应性衰减 ρ_H 在 evolve.ts 张力层替代其功能。
// @see docs/adr/222-habituation-truth-model.md

/** alice_turn 时的额外回应义务加成（30%）。 */
const TURN_OBLIGATION_BOOST = 1.3;

export function p5ResponseObligation(G: WorldModel, _n: number, nowMs: number): PressureResult {
  const contributions: Record<string, number> = {};
  const beliefs = G.beliefs;

  for (const hid of G.getEntitiesByType("channel")) {
    const attrs = G.getChannel(hid);
    const directed = attrs.pending_directed;
    if (directed <= 0) continue;

    // Wave 6: Tier bias correction — 通过 channel 的 tier_contact 推断 contactId，
    // 读取 BeliefStore 中 tier 信念的 σ²，σ² 高时向基线回归。
    // @see paper/ §Social POMDP "Tier Overestimate Bias Correction"
    const contactId = chatIdToContactId(hid);
    // ADR-91 Layer 2: Bot directed 消息降权 ×0.1
    const isBot = contactId != null && G.has(contactId) && G.getContact(contactId).is_bot === true;
    const botWeight = isBot ? 0.1 : 1.0;
    const b = contactId ? beliefs.get(contactId, "tier") : undefined;
    const effectiveTier = tierBiasCorrection(attrs.tier_contact, b?.sigma2);
    const w = DUNBAR_TIER_WEIGHT[effectiveTier] ?? 0.8;
    const chatType = attrs.chat_type;
    const chatW = CHAT_TYPE_WEIGHTS[chatType]?.response ?? 1.0;
    const lastDirectedMs = readNodeMs(G, hid, "last_directed_ms");
    const ageS = Math.max(elapsedS(nowMs, lastDirectedMs), 1.0);
    // ADR-157: 统一使用 signal-decay.ts 的指数核和半衰期常量。
    // 半衰期：私聊 3600s，群聊 2400s（与 effectiveObligation 一致）。
    // 旧版使用双曲线 1/(1+ageS/τ)，指数核 2^(-ageS/τ) 自然消退更符合事件信号物理。
    // @see docs/adr/157-signal-decay-integrity.md §Fix 1
    const isPrivate = chatType === "private";
    const decayHalfLife = isPrivate ? OBLIGATION_HALFLIFE_PRIVATE : OBLIGATION_HALFLIFE_GROUP;
    const rawDecay = decaySignal(1.0, ageS, decayHalfLife);
    // ADR-153 Phase 2: λ(t) 高 → 衰减减慢（对方仍在活跃，义务持续）
    // k_p5 = 0.5, clamp [1, 2]。仿真验证：活跃期 2× 基线，沉默后收敛。
    // @see simulation/experiments/exp_hawkes_phase2_validation.py 验证 1
    let decay = rawDecay;
    const cId = chatIdToContactId(hid);
    if (cId && G.has(cId)) {
      const c = G.getContact(cId);
      if (c.hawkes_last_event_ms && c.hawkes_last_event_ms > 0) {
        const hp = getDefaultParams(c.tier, false);
        const hs: HawkesState = {
          lambdaCarry: c.hawkes_carry ?? 0,
          lastEventMs: c.hawkes_last_event_ms,
        };
        const hi = queryIntensity(hp, hs, nowMs);
        const modulation = Math.min(
          2,
          1 + 0.5 * Math.max(0, (hi.lambda - hp.mu) / Math.max(hp.mu, 1e-10)),
        );
        decay = rawDecay * modulation;
      }
    }

    // ADR-156: social reception 独立调制（与 ADR-222 habituation 正交）。
    // reception 是他人对 Alice 的社交反馈；habituation 是 Alice 自身的适应性衰减。
    // reception=0（默认/未设置）→ 1.0（不惩罚无数据状态）。
    const reception = readSocialReception(G, hid);
    const receptionFactor =
      reception >= 0 ? 1.0 : reception > -0.3 ? 0.7 : reception > -0.6 ? 0.3 : 0.1;

    // ADR-70 P0.5: Alice 正在为此频道思考 → 抑制 P5 累积
    const thinkingSince = G.getChannel(hid).alice_thinking_since;
    if (thinkingSince != null) {
      contributions[hid] = directed * w * chatW * decay * receptionFactor * 0.1 * botWeight;
      continue;
    }

    // M4: conversation turn awareness — 轮到 Alice 回复 → 额外义务
    let turnBoost = 1.0;
    const convId = findActiveConversation(G, hid);
    if (convId && G.has(convId)) {
      const convAttrs = G.getConversation(convId);
      if (convAttrs.turn_state === "alice_turn") {
        turnBoost = TURN_OBLIGATION_BOOST;
      }
    }

    const basePressure = directed * w * chatW * decay;
    contributions[hid] = basePressure * turnBoost * botWeight * receptionFactor;
  }

  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  return { total, contributions };
}
