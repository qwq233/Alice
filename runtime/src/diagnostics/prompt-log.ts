/**
 * Prompt 日志 — 生产环境拦截完整 LLM prompt + 响应，落盘为 markdown。
 *
 * 启用方式：环境变量 ALICE_PROMPT_LOG=true
 * 输出目录：runtime/prompt-logs/（自动创建，.gitignore 排除）
 *
 * 每次 LLM 调用产生一个 markdown 文件，包含：
 * - 元数据（tick / target / voice / round / 时间）
 * - 完整 system prompt
 * - 完整 user prompt
 * - LLM 输出的脚本
 * - 脚本执行结果（thinks / actions / errors）
 *
 * 用途：事后诊断 prompt 工程问题——看 LLM 看到了什么、产出了什么。
 *
 * @see docs/adr/78-naturalness-hotfixes.md — 实战群聊诊断
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../utils/logger.js";

const log = createLogger("prompt-log");
const __dirname = dirname(fileURLToPath(import.meta.url));

/** prompt-logs 目录（runtime/prompt-logs/） */
const LOG_DIR = resolve(__dirname, "../../prompt-logs");

/** 是否启用 prompt 日志。 */
export function isPromptLogEnabled(): boolean {
  return process.env.ALICE_PROMPT_LOG === "true" || process.env.ALICE_PROMPT_LOG === "1";
}

/** prompt 快照的输入数据。 */
export interface PromptSnapshot {
  tick: number;
  target: string | null;
  voice: string;
  round: number;
  system: string;
  user: string;
  /** LLM 返回的脚本（null = LLM 调用失败）。 */
  script: string | null;
  /** 脚本执行后的数据（可选，终端轮才有完整数据）。 */
  execution?: {
    thinks: string[];
    queryLogs: Array<{ fn: string; result: string }>;
    errors: string[];
  };
}

/**
 * 将 prompt 快照写入 markdown 文件。
 *
 * 文件名格式：{tick}-{round}-{target}-{timestamp}.md
 * 非阻塞——写入失败只 log.warn，不影响主流程。
 */
export function logPromptSnapshot(snapshot: PromptSnapshot): void {
  if (!isPromptLogEnabled()) return;

  try {
    mkdirSync(LOG_DIR, { recursive: true });

    const ts = new Date();
    const tsStr = ts.toISOString().replace(/[:.]/g, "-");
    const targetSlug = (snapshot.target ?? "no-target").replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${snapshot.tick}-r${snapshot.round}-${targetSlug}-${tsStr}.md`;
    const filepath = resolve(LOG_DIR, filename);

    const parts: string[] = [
      `# Prompt Snapshot — tick ${snapshot.tick}, round ${snapshot.round}`,
      "",
      "| Key | Value |",
      "|-----|-------|",
      `| tick | ${snapshot.tick} |`,
      `| round | ${snapshot.round} |`,
      `| target | ${snapshot.target ?? "(none)"} |`,
      `| voice | ${snapshot.voice} |`,
      `| time | ${ts.toISOString()} |`,
      `| script | ${snapshot.script ? `${snapshot.script.length} chars` : "FAILED"} |`,
      "",
    ];

    // System prompt
    parts.push("## System Prompt", "", "```", snapshot.system, "```", "");

    // User prompt
    parts.push("## User Prompt", "", "```", snapshot.user, "```", "");

    // LLM output
    if (snapshot.script) {
      parts.push("## LLM Script Output", "", "```sh", snapshot.script, "```", "");
    } else {
      parts.push("## LLM Script Output", "", "**LLM 调用失败**", "");
    }

    // Sandbox results
    if (snapshot.execution) {
      const sb = snapshot.execution;
      parts.push("## Script Execution Results", "");

      if (sb.thinks.length > 0) {
        parts.push("### Thinks", "");
        for (const t of sb.thinks) {
          parts.push(`- ${t}`);
        }
        parts.push("");
      }

      if (sb.queryLogs.length > 0) {
        parts.push("### Query Logs", "");
        for (const q of sb.queryLogs) {
          const preview = q.result.length > 200 ? `${q.result.slice(0, 200)}...` : q.result;
          parts.push(`- \`${q.fn}\`: ${preview}`);
        }
        parts.push("");
      }

      if (sb.errors.length > 0) {
        parts.push("### Errors", "");
        for (const e of sb.errors) {
          parts.push(`- ❌ ${e}`);
        }
        parts.push("");
      }
    }

    writeFileSync(filepath, parts.join("\n"), "utf-8");
    log.info("Prompt snapshot saved", { filepath: filename });
  } catch (e) {
    // 写入失败不影响主流程
    log.warn("Failed to save prompt snapshot", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
