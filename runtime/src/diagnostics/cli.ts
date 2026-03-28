/**
 * ADR-76 诊断 CLI — 从 alice.db 生成完整行为验证报告。
 *
 * 用法：pnpm run diagnose [db-path]
 *
 * @see docs/adr/76-naturalness-validation-methodology.md
 */

import { closeDb, initDb } from "../db/connection.js";
import { ALICE_DB_PATH } from "../runtime-paths.js";
import { counterfactualD5 } from "./counterfactual.js";
import { analyzeVoiceDiversity } from "./diversity.js";
import { analyzeRhythm } from "./rhythm.js";
import { analyzeSilenceQuality } from "./silence-quality.js";

const dbPath = process.argv[2] ?? ALICE_DB_PATH;

console.log(`\n═══ ADR-76 行为验证报告 ═══`);
console.log(`数据库: ${dbPath}\n`);

try {
  initDb(dbPath);

  // A1: 节律分析
  console.log("── A1: 行动/沉默节律 ──");
  const rhythm = analyzeRhythm();
  console.log(
    `行动间隔: 中位数=${rhythm.actionIntervals.median} P90=${rhythm.actionIntervals.p90} (n=${rhythm.actionIntervals.count})`,
  );
  console.log(
    `锯齿波: ${rhythm.sawtoothDetection.cycleCount} 周期, 中位长度=${rhythm.sawtoothDetection.medianCycleLength}, 符合率=${(rhythm.sawtoothDetection.sawtoothRatio * 100).toFixed(1)}%`,
  );
  console.log("Circadian 热图 (UTC):");
  const maxHourCount = Math.max(1, ...Object.values(rhythm.circadianHeatmap));
  for (let h = 0; h < 24; h++) {
    const count = rhythm.circadianHeatmap[h];
    const bar = "█".repeat(Math.round((count / maxHourCount) * 20));
    console.log(`  ${String(h).padStart(2, "0")}:00  ${bar} ${count}`);
  }
  if (Object.keys(rhythm.actionIntervals.byTarget).length > 0) {
    console.log("按目标分组:");
    for (const [target, stats] of Object.entries(rhythm.actionIntervals.byTarget)) {
      const label = target.length > 20 ? `${target.slice(0, 17)}...` : target;
      console.log(`  ${label.padEnd(20)} 中位=${stats.median} P90=${stats.p90} (n=${stats.count})`);
    }
  }

  // A2: 声部多样性
  console.log("\n── A2: 声部多样性 ──");
  const diversity = analyzeVoiceDiversity();
  console.log(
    `Shannon 熵: H=${diversity.shannonEntropy.toFixed(3)} / H_max=${diversity.maxEntropy.toFixed(3)} (归一化=${(diversity.normalizedEntropy * 100).toFixed(1)}%)`,
  );
  console.log(
    `连续重复率: ${(diversity.consecutiveRepeatRate * 100).toFixed(1)}% (ADR-75 voice fatigue 目标: < 50%)`,
  );
  console.log("声部频率:");
  for (const [voice, freq] of Object.entries(diversity.voiceFrequencies)) {
    const bar = "█".repeat(Math.round(freq * 30));
    console.log(`  ${voice.padEnd(12)} ${bar} ${(freq * 100).toFixed(1)}%`);
  }
  if (diversity.personalityDrift) {
    const pd = diversity.personalityDrift;
    console.log(
      `人格漂移: ${pd.meanDriftPerTick.toExponential(2)}/tick, 振荡周期=${pd.pressureOscillationPeriod}, 比值=${pd.driftToOscillationRatio.toFixed(1)} (V5 预测: >> 1)`,
    );
  }

  // A3: 不行动质量
  console.log("\n── A3: 不行动质量 ──");
  const silence = analyzeSilenceQuality();
  console.log(`沉默总数: ${silence.totalSilences}`);
  console.log("原因分布:");
  for (const [reason, stats] of Object.entries(silence.reasonDistribution)) {
    console.log(`  ${reason.padEnd(28)} ${stats.count} (${(stats.ratio * 100).toFixed(1)}%)`);
  }
  if (Object.keys(silence.silenceLevelDistribution).length > 0) {
    console.log("D5 五级谱:");
    for (const [level, stats] of Object.entries(silence.silenceLevelDistribution)) {
      console.log(`  ${level.padEnd(20)} ${stats.count} (${(stats.ratio * 100).toFixed(1)}%)`);
    }
  }
  const voi = silence.voiDeferredFollowup;
  console.log(
    `VoI-deferred: ${voi.count} 次, 后续行动延迟中位=${voi.medianDelayToAction} P90=${voi.p90DelayToAction}`,
  );
  const runs = silence.consecutiveSilenceRuns;
  console.log(
    `连续沉默: ${runs.runCount} 段, 最长=${runs.maxRunLength}, 均长=${runs.meanRunLength.toFixed(1)}`,
  );

  // A4: D5 反事实
  console.log("\n── A4: D5 反事实分析 ──");
  const cf = counterfactualD5();
  console.log(
    `可分析沉默: ${cf.analyzableSilences}, 翻转: ${cf.flippedActions} (${(cf.flipRate * 100).toFixed(1)}%)`,
  );
  console.log(
    `行动总数: ${cf.totalActions}, 无 D5 时行动频率倍数: ${cf.frequencyMultiplier.toFixed(2)}x`,
  );
  if (Object.keys(cf.flipsByReason).length > 0) {
    console.log("按原因的翻转率:");
    for (const [reason, stats] of Object.entries(cf.flipsByReason)) {
      console.log(
        `  ${reason.padEnd(28)} ${stats.flipped}/${stats.total} (${(stats.rate * 100).toFixed(1)}%)`,
      );
    }
  }

  // 总结
  console.log("\n═══ 验证结论 ═══");
  const dataVolume = rhythm.actionIntervals.count + 1;
  console.log(`数据量: ${dataVolume} 行动${dataVolume < 200 ? " ⚠️ 不足（需 ≥ 200）" : " ✅ 充足"}`);
  console.log(
    `V1 锯齿波: ${rhythm.sawtoothDetection.cycleCount > 5 ? "✅" : "⏳"} ${rhythm.sawtoothDetection.cycleCount} 周期`,
  );
  console.log(
    `V2 D5 必要性: ${cf.flipRate > 0.3 ? "✅" : "⏳"} 翻转率 ${(cf.flipRate * 100).toFixed(1)}%${cf.flipRate > 0.3 ? " (D5 显著抑制行动)" : ""}`,
  );
  console.log(
    `V3 Tier 节律: ${Object.keys(rhythm.actionIntervals.byTarget).length >= 3 ? "✅" : "⏳"} ${Object.keys(rhythm.actionIntervals.byTarget).length} 个目标分组`,
  );
  console.log(
    `V5 慢变量: ${diversity.personalityDrift ? (diversity.personalityDrift.driftToOscillationRatio > 10 ? "✅" : "⏳") : "⏳"} ${diversity.personalityDrift ? `比值=${diversity.personalityDrift.driftToOscillationRatio.toFixed(1)}` : "无数据"}`,
  );
  console.log(
    `声部多样性: ${diversity.normalizedEntropy > 0.7 ? "✅" : "⚠️"} H/H_max=${(diversity.normalizedEntropy * 100).toFixed(1)}%`,
  );

  console.log();
} catch (e) {
  console.error("诊断失败:", e);
  process.exit(1);
} finally {
  closeDb();
}
