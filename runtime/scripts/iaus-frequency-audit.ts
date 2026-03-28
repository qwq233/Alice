/**
 * IAUS 触发频率审计 — 基于真实 tick_log 数据的离线模拟。
 *
 * 用途：诊断 IAUS → LLM 调用链的有效利用率，模拟不同门控阈值下的效果。
 *
 * 运行方式：npx tsx runtime/scripts/iaus-frequency-audit.ts
 *
 * @see docs/adr/191-anomaly-thread-elimination.md
 */

import { resolve } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = resolve(import.meta.dirname ?? ".", "../alice.db");
const db = new Database(DB_PATH, { readonly: true });

// ── 数据提取 ────────────────────────────────────────────────────────

interface TickRow {
  tick: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  p5: number;
  p6: number;
  api: number;
  /** ADR-195: Peak-based API（驱动 tick 间隔）。 */
  api_peak: number | null;
  action: string | null;
  target: string | null;
  net_value: number | null;
  selected_probability: number | null;
  gate_verdict: string;
  mode: string;
  created_at: number;
}

interface ActionRow {
  tick: number;
  action_type: string;
  success: number;
}

const ticks: TickRow[] = db
  .prepare(
    `SELECT tick, p1, p2, p3, p4, p5, p6, api, api_peak, action, target,
            net_value, selected_probability, gate_verdict, mode, created_at
     FROM tick_log ORDER BY tick`,
  )
  .all() as TickRow[];

const actions: ActionRow[] = db
  .prepare(`SELECT tick, action_type, success FROM action_log`)
  .all() as ActionRow[];

const actionByTick = new Map<number, ActionRow[]>();
for (const a of actions) {
  const arr = actionByTick.get(a.tick) ?? [];
  arr.push(a);
  actionByTick.set(a.tick, arr);
}

// ── 分析 ──────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════");
console.log("  IAUS 触发频率审计报告");
console.log("═══════════════════════════════════════════════════════════════");
console.log();

// 1. 基本统计
const totalTicks = ticks.length;
const enqueueTicks = ticks.filter((t) => t.gate_verdict === "enqueue");
const silentTicks = ticks.filter((t) => t.gate_verdict.startsWith("silent:"));
const skipTicks = ticks.filter((t) => t.gate_verdict.startsWith("system1:skip"));

console.log("§1. 漏斗统计");
console.log("─────────────────────────────────────────────────────────────");
console.log(`  总 tick:              ${totalTicks}`);
console.log(
  `  enqueue（入队 LLM）:  ${enqueueTicks.length} (${pct(enqueueTicks.length, totalTicks)})`,
);
console.log(
  `  silent（门控拦截）:   ${silentTicks.length} (${pct(silentTicks.length, totalTicks)})`,
);
console.log(`  system1:skip:         ${skipTicks.length} (${pct(skipTicks.length, totalTicks)})`);
console.log();

// 1b. ADR-195: API vs API_peak 对比
const peakTicks = ticks.filter((t) => t.api_peak !== null);
if (peakTicks.length > 0) {
  const apiPeakValues = peakTicks.map((t) => t.api_peak!);
  const apiValues = peakTicks.map((t) => t.api);
  console.log("§1b. ADR-195: API vs API_peak 对比");
  console.log("─────────────────────────────────────────────────────────────");
  console.log(`  采样 tick 数:         ${peakTicks.length}`);
  console.log(
    `  API      中位/平均:   ${median(apiValues).toFixed(2)} / ${mean(apiValues).toFixed(2)}`,
  );
  console.log(
    `  API_peak 中位/平均:   ${median(apiPeakValues).toFixed(2)} / ${mean(apiPeakValues).toFixed(2)}`,
  );
  console.log(`  压缩比 (peak/api):    ${(mean(apiPeakValues) / mean(apiValues)).toFixed(3)}`);
  console.log();
}

// 2. Enqueue 质量分析
const enqueueWithAction = enqueueTicks.filter((t) => actionByTick.has(t.tick));
const enqueueNoAction = enqueueTicks.filter((t) => !actionByTick.has(t.tick));

let llmFailed = 0;
let llmSilence = 0;
let realAction = 0;
let internalAction = 0;

for (const t of enqueueWithAction) {
  const acts = actionByTick.get(t.tick)!;
  for (const a of acts) {
    if (a.action_type === "llm_failed") llmFailed++;
    else if (a.action_type === "silence") llmSilence++;
    else if (
      [
        "message",
        "telegram:react",
        "telegram:mark_read",
        "telegram:leave_chat",
        "telegram:send_sticker",
        "telegram:save_note",
      ].includes(a.action_type)
    )
      realAction++;
    else internalAction++;
  }
}

const totalLLMCalls = llmFailed + llmSilence + realAction + internalAction;

console.log("§2. LLM 调用质量");
console.log("─────────────────────────────────────────────────────────────");
console.log(`  入队 tick:            ${enqueueTicks.length}`);
console.log(`  实际执行（有 action_log）: ${enqueueWithAction.length}`);
console.log(`  队列丢弃（无 action_log）: ${enqueueNoAction.length}`);
console.log();
console.log(`  LLM 调用结果分布（${totalLLMCalls} 条 action_log）:`);
console.log(`    LLM 失败:           ${llmFailed} (${pct(llmFailed, totalLLMCalls)}) ← 浪费`);
console.log(
  `    LLM 选择沉默:       ${llmSilence} (${pct(llmSilence, totalLLMCalls)}) ← IAUS 认为值得，LLM 否决`,
);
console.log(`    真实 Telegram 行动:  ${realAction} (${pct(realAction, totalLLMCalls)})`);
console.log(`    内部行动:           ${internalAction} (${pct(internalAction, totalLLMCalls)})`);
console.log();
console.log(`  ⚡ 有效利用率 = 真实行动 / LLM 调用 = ${pct(realAction, totalLLMCalls)}`);
console.log(
  `  ⚡ IAUS-LLM 校准偏差 = LLM 沉默 / (LLM 沉默 + 真实行动) = ${pct(llmSilence, llmSilence + realAction)}`,
);
console.log();

// 3. Net Value 分布
const nvBuckets = [
  { label: "< 0.3 (低)", min: -Infinity, max: 0.3 },
  { label: "0.3-0.5 (中低)", min: 0.3, max: 0.5 },
  { label: "0.5-0.7 (中)", min: 0.5, max: 0.7 },
  { label: "0.7-0.9 (高)", min: 0.7, max: 0.9 },
  { label: ">= 0.9 (极高)", min: 0.9, max: Infinity },
];

console.log("§3. Net Value 分布（enqueue tick）");
console.log("─────────────────────────────────────────────────────────────");
for (const b of nvBuckets) {
  const inBucket = enqueueTicks.filter(
    (t) => t.net_value !== null && t.net_value >= b.min && t.net_value < b.max,
  );
  // 统计该 bucket 中有多少产生了真实行动
  let bucketReal = 0;
  let bucketSilence = 0;
  let bucketFailed = 0;
  for (const t of inBucket) {
    const acts = actionByTick.get(t.tick);
    if (!acts) continue;
    for (const a of acts) {
      if (a.action_type === "silence") bucketSilence++;
      else if (a.action_type === "llm_failed") bucketFailed++;
      else if (
        ["message", "telegram:react", "telegram:mark_read", "telegram:leave_chat"].includes(
          a.action_type,
        )
      )
        bucketReal++;
    }
  }
  console.log(
    `  ${b.label.padEnd(20)} ${String(inBucket.length).padStart(4)} enqueue → ${bucketReal} 行动 / ${bucketSilence} 沉默 / ${bucketFailed} 失败`,
  );
}
console.log();

// 4. LLM 故障期间的 tick 风暴检测
console.log("§4. LLM 故障 tick 风暴检测");
console.log("─────────────────────────────────────────────────────────────");
let stormStart = -1;
let stormLen = 0;
let maxStormLen = 0;
let maxStormStart = -1;
const storms: Array<{ start: number; len: number }> = [];

for (let i = 0; i < enqueueTicks.length; i++) {
  const t = enqueueTicks[i];
  const acts = actionByTick.get(t.tick);
  const isFailed = acts?.some((a) => a.action_type === "llm_failed") ?? false;

  if (isFailed) {
    if (stormStart < 0) stormStart = t.tick;
    stormLen++;
  } else {
    if (stormLen >= 3) {
      storms.push({ start: stormStart, len: stormLen });
      if (stormLen > maxStormLen) {
        maxStormLen = stormLen;
        maxStormStart = stormStart;
      }
    }
    stormStart = -1;
    stormLen = 0;
  }
}
if (stormLen >= 3) storms.push({ start: stormStart, len: stormLen });

console.log(`  连续 LLM 失败风暴（≥3 次连续）: ${storms.length} 次`);
for (const s of storms) {
  console.log(`    tick ${s.start} ~ ${s.start + s.len - 1}: ${s.len} 次连续失败`);
}
console.log(`  最长风暴: ${maxStormLen} ticks (从 tick ${maxStormStart})`);
console.log();

// 5. 沉默率 vs 模态
console.log("§5. 按模态分析");
console.log("─────────────────────────────────────────────────────────────");
const modes = ["wakeup", "patrol", "conversation", "consolidation"];
for (const m of modes) {
  const modeTicks = ticks.filter((t) => t.mode === m);
  const modeEnqueue = modeTicks.filter((t) => t.gate_verdict === "enqueue");
  if (modeTicks.length === 0) continue;

  let modeRealAction = 0;
  let modeLLMSilence = 0;
  for (const t of modeEnqueue) {
    const acts = actionByTick.get(t.tick);
    if (!acts) continue;
    for (const a of acts) {
      if (a.action_type === "silence") modeLLMSilence++;
      else if (
        ["message", "telegram:react", "telegram:mark_read", "telegram:leave_chat"].includes(
          a.action_type,
        )
      )
        modeRealAction++;
    }
  }

  console.log(
    `  ${m.padEnd(16)} ${modeTicks.length} ticks → ${modeEnqueue.length} enqueue (${pct(modeEnqueue.length, modeTicks.length)}) → ${modeRealAction} 行动 / ${modeLLMSilence} 沉默`,
  );
}
console.log();

// 6. 模拟：如果提高 net_value 阈值会怎样
console.log("§6. 模拟：提高入队 NV 阈值的效果");
console.log("─────────────────────────────────────────────────────────────");
const thresholds = [0.0, 0.3, 0.5, 0.6, 0.7];
for (const threshold of thresholds) {
  const wouldEnqueue = enqueueTicks.filter((t) => (t.net_value ?? 0) >= threshold);
  let simReal = 0;
  let simSilence = 0;
  let simFailed = 0;
  for (const t of wouldEnqueue) {
    const acts = actionByTick.get(t.tick);
    if (!acts) continue;
    for (const a of acts) {
      if (a.action_type === "silence") simSilence++;
      else if (a.action_type === "llm_failed") simFailed++;
      else if (
        ["message", "telegram:react", "telegram:mark_read", "telegram:leave_chat"].includes(
          a.action_type,
        )
      )
        simReal++;
    }
  }
  const simTotal = simReal + simSilence + simFailed;
  const efficiency = simTotal > 0 ? ((simReal / simTotal) * 100).toFixed(1) : "N/A";
  console.log(
    `  NV ≥ ${threshold.toFixed(1)}: ${wouldEnqueue.length} enqueue → ${simReal} 行动 / ${simSilence} 沉默 / ${simFailed} 失败 | 效率 ${efficiency}%`,
  );
}
console.log();

// 7. 每 target 的 LLM 调用频率
console.log("§7. Per-target LLM 调用频率（Top 10）");
console.log("─────────────────────────────────────────────────────────────");
const targetCounts = new Map<string, { enqueue: number; real: number; silence: number }>();
for (const t of enqueueTicks) {
  const key = t.target ?? "(no target)";
  const entry = targetCounts.get(key) ?? { enqueue: 0, real: 0, silence: 0 };
  entry.enqueue++;
  const acts = actionByTick.get(t.tick);
  if (acts) {
    for (const a of acts) {
      if (a.action_type === "silence") entry.silence++;
      else if (
        ["message", "telegram:react", "telegram:mark_read", "telegram:leave_chat"].includes(
          a.action_type,
        )
      )
        entry.real++;
    }
  }
  targetCounts.set(key, entry);
}

const sortedTargets = [...targetCounts.entries()]
  .sort((a, b) => b[1].enqueue - a[1].enqueue)
  .slice(0, 10);
for (const [target, stats] of sortedTargets) {
  const eff = stats.real + stats.silence > 0 ? pct(stats.real, stats.real + stats.silence) : "N/A";
  console.log(
    `  ${target.padEnd(30)} ${String(stats.enqueue).padStart(4)} enqueue → ${stats.real} 行动 / ${stats.silence} 沉默 (效率 ${eff})`,
  );
}
console.log();

// 8. 时间分布——识别 burst 模式
console.log("§8. Tick 间隔分布");
console.log("─────────────────────────────────────────────────────────────");
const intervals: number[] = [];
for (let i = 1; i < ticks.length; i++) {
  const dt = ticks[i].created_at - ticks[i - 1].created_at;
  if (dt > 0 && dt < 600) intervals.push(dt);
}
const dtBuckets = [
  { label: "< 2s", max: 2 },
  { label: "2-5s", max: 5 },
  { label: "5-10s", max: 10 },
  { label: "10-30s", max: 30 },
  { label: "30-60s", max: 60 },
  { label: "60-300s", max: 300 },
  { label: "> 300s", max: Infinity },
];
for (const b of dtBuckets) {
  const prev = dtBuckets[dtBuckets.indexOf(b) - 1]?.max ?? 0;
  const cnt = intervals.filter((d) => d >= prev && d < b.max).length;
  console.log(`  ${b.label.padEnd(10)} ${String(cnt).padStart(5)} (${pct(cnt, intervals.length)})`);
}
console.log(`  中位数: ${median(intervals).toFixed(1)}s  平均: ${mean(intervals).toFixed(1)}s`);

console.log();
console.log("═══════════════════════════════════════════════════════════════");
console.log("  审计完成");
console.log("═══════════════════════════════════════════════════════════════");

db.close();

// ── 辅助函数 ──────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0%";
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
