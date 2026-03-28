/**
 * Blackboard Tick LLM 调用 — instructor-js 结构化输出 + 脚本预验证。
 *
 * ADR-213: BT 通信协议升级。LLM 通过 instructor（TOOLS mode）输出 {script, flow}。
 * 引擎确定性执行 script，从 flow 字段读取控制信号。
 * 空 script = 保持沉默（自然终止协议）。
 *
 * 使用 instructor-js（TOOLS mode）而非 AI SDK generateObject：
 * - TOOLS mode 用 tool calling 协议做结构化提取，兼容性最好
 * - instructor 自带 max_retries + Zod 验证反馈闭环
 * - 避免 JSON mode 在某些 provider 上的解析失败
 *
 * @see docs/adr/213-tool-calling-act-thread.md
 * @see https://js.useinstructor.com/
 */

import { validateScript } from "../../core/script-validator.js";
import { writeAuditEvent } from "../../db/audit.js";
import { getAvailableInstructor } from "../../llm/instructor-client.js";
import { withResilience } from "../../llm/resilience.js";
import { normalizeScript, type TickStep, TickStepSchema } from "../../llm/schemas.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("tick/callLLM");

/** instructor 验证重试次数（Zod 错误反馈 → LLM 自我修正）。 */
const INSTRUCTOR_MAX_RETRIES = 2;

/**
 * 调用 LLM 生成 TickStep（shell script + flow 信号）。
 *
 * instructor-js TOOLS mode 提取 {script, flow}。
 * 空 script = 保持沉默 → 返回 null。
 *
 * 返回 null 表示 LLM 选择沉默或调用失败（已审计写入）。
 */
export async function callTickLLM(
  system: string,
  user: string,
  tick: number,
  target: string | null,
  voice: string,
  temperature?: number,
): Promise<TickStep | null> {
  try {
    const { client, model, name } = getAvailableInstructor();

    const extracted = await withResilience(
      () =>
        client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_model: { schema: TickStepSchema, name: "TickStep" },
          max_retries: INSTRUCTOR_MAX_RETRIES,
          temperature: temperature ?? 0.7,
        }),
      {},
      name,
    );

    const script = normalizeScript(extracted.script ?? "");
    const afterward = extracted.afterward;

    // 空 script → LLM 选择沉默（自然终止协议）
    if (!script) {
      log.info("LLM chose silence (empty script)", { tick, voice });
      return null;
    }

    // 脚本语法预验证（instructor 已做 Zod 验证，这里检查 shell 语法）
    const validation = validateScript(script);
    if (!validation.valid) {
      log.warn("Script validation warning (executing as-is)", {
        tick,
        errors: validation.summary,
      });
    }

    return { script, afterward, residue: extracted.residue };
  } catch (e) {
    log.error("Tick LLM call failed", e);
    writeAuditEvent(tick, "error", "tick", "LLM call failed", {
      voice,
      target,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
