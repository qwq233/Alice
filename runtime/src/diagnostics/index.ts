/**
 * ADR-76 诊断工具集 — 行为验证自动化。
 *
 * 从现有 DB 数据计算行为指标，验证理论预测。
 *
 * @see docs/adr/76-naturalness-validation-methodology.md
 */

export { type CounterfactualD5Report, counterfactualD5 } from "./counterfactual.js";
export { analyzeVoiceDiversity, type VoiceDiversityReport } from "./diversity.js";
export { analyzeRhythm, type RhythmReport } from "./rhythm.js";
export { analyzeSilenceQuality, type SilenceQualityReport } from "./silence-quality.js";
