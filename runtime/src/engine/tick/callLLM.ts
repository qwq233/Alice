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

import { createHash } from "node:crypto";

import { validateScript } from "../../core/script-validator.js";
import { writeAuditEvent } from "../../db/audit.js";
import { getAvailableInstructor } from "../../llm/instructor-client.js";
import {
  buildTickSessionKey,
  clearTickSession,
  getReusableResponseId,
  saveReusableResponseId,
} from "../../llm/tick-session.js";
import { withResilience } from "../../llm/resilience.js";
import { normalizeScript, type TickStep, TickStepSchema } from "../../llm/schemas.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("tick/callLLM");

/** instructor 验证重试次数（Zod 错误反馈 → LLM 自我修正）。 */
const INSTRUCTOR_MAX_RETRIES = 2;

/** 开关：启用 Responses API previous_response_id 复用，减少 system prompt 重发。 */
const SESSION_REUSE_ENABLED = process.env.LLM_SESSION_REUSE === "true";

const TICK_STEP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["script", "afterward"],
  properties: {
    script: { type: "string", minLength: 1 },
    afterward: {
      type: "string",
      enum: ["done", "waiting_reply", "watching", "fed_up", "cooling_down"],
    },
    residue: {
      type: "object",
      additionalProperties: false,
      required: ["feeling"],
      properties: {
        feeling: {
          type: "string",
          enum: ["unresolved", "interrupted", "curious", "settled"],
        },
        toward: { type: "string" },
        reason: { type: "string", maxLength: 200 },
      },
    },
  },
} as const;

function fingerprintSystemPrompt(system: string): string {
  return createHash("sha256").update(system).digest("hex");
}

async function tryCallTickLLMWithSession(
  system: string,
  user: string,
  target: string | null,
  voice: string,
  temperature?: number,
): Promise<TickStep | null> {
  if (!SESSION_REUSE_ENABLED) return null;

  const { openai, model, name, mode } = getAvailableInstructor();
  if (mode !== "TOOLS") return null;

  const systemFingerprint = fingerprintSystemPrompt(system);
  const sessionKey = buildTickSessionKey({
    providerName: name,
    model,
    target,
    voice,
  });
  const previousResponseId = getReusableResponseId({
    sessionKey,
    providerName: name,
    model,
    systemFingerprint,
  });

  const input = previousResponseId
    ? [{ role: "user" as const, content: user }]
    : [
        { role: "system" as const, content: system },
        { role: "user" as const, content: user },
      ];

  try {
    const response = await withResilience(
      () =>
        openai.responses.create({
          model,
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
          input,
          temperature: temperature ?? 0.7,
          text: {
            format: {
              type: "json_schema",
              name: "TickStep",
              schema: TICK_STEP_JSON_SCHEMA,
              strict: true,
            },
          },
        }),
      {},
      name,
    );

    const outputText = (response as { output_text?: string }).output_text?.trim() ?? "";
    if (!outputText) {
      throw new Error("Responses API returned empty output_text");
    }

    const parsedJson = JSON.parse(outputText) as unknown;
    const parsed = TickStepSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const responseId = (response as { id?: string }).id;
    if (responseId) {
      saveReusableResponseId({
        sessionKey,
        providerName: name,
        model,
        systemFingerprint,
        previousResponseId: responseId,
      });
    }

    log.debug("Tick LLM used response session reuse", {
      provider: name,
      target,
      voice,
      reused: !!previousResponseId,
    });
    return parsed.data;
  } catch (e) {
    clearTickSession(sessionKey);
    log.warn("Responses session path failed, falling back to stateless instructor", {
      provider: name,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}


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
    const sessionExtracted = await tryCallTickLLMWithSession(
      system,
      user,
      target,
      voice,
      temperature,
    );

    const extracted =
      sessionExtracted ??
      (await (async () => {
        const { client, model, name } = getAvailableInstructor();
        return withResilience(
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
      })());

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
