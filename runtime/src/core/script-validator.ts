/**
 * 脚本预验证 — LLM 输出后、Docker 执行前的轻量 dry-run。
 *
 * 验证层级：
 * 1. bash -n 语法检查（本地 spawn，毫秒级）
 * 2. 命令名校验：每个非注释非空行的首个 token 是否在已知命令集里
 * 3. 模糊匹配建议：未知命令 → Levenshtein 距离 ≤ 2 的候选
 *
 * 返回人类/LLM 可读的错误消息，供 instructor retry 反馈。
 *
 * @see docs/adr/211-instructor-js-script-prevalidation.md
 */
import { execFileSync } from "node:child_process";

// logger 预留（后续需要时启用）
// import { createLogger } from "../utils/logger.js";
// const log = createLogger("script-validator");

// 已知命令集 — 启动时从 CommandCatalog 注入
let _knownCommands = new Set<string>([
  // 内置系统命令（始终可用）
  "irc",
  "self",
  "alice-pkg",
  // shell 内建
  "echo",
  "printf",
  "set",
  "export",
  "read",
  "test",
  "true",
  "false",
  "exit",
  // 常见 POSIX 工具
  "grep",
  "sed",
  "awk",
  "cat",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "tr",
  "cut",
  "date",
  "sleep",
  "man",
]);

/** 从 CommandCatalog 注入额外命令名（启动时调用）。 */
export function registerKnownCommands(names: Iterable<string>): void {
  for (const name of names) {
    _knownCommands.add(name);
  }
}

/** 重置（测试用）。 */
export function resetKnownCommands(): void {
  _knownCommands = new Set(["irc", "self", "engine", "alice-pkg"]);
}

/** 获取当前已知命令集（测试/调试用）。 */
export function getKnownCommands(): ReadonlySet<string> {
  return _knownCommands;
}

// ── 验证逻辑 ──────────────────────────────────────────────────────────────

export interface ValidationError {
  line: number;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  /** LLM 可读的错误摘要（供 instructor retry 注入）。 */
  summary: string;
}

/**
 * 轻量 dry-run 验证脚本。
 * 不需要 Docker，毫秒级完成。
 */
export function validateScript(script: string): ValidationResult {
  const errors: ValidationError[] = [];

  // 0. 必须包含至少一条可执行命令（非注释、非空行）
  //    防止 LLM 输出纯自然语言或只有注释 → 浪费 Docker 执行
  if (!hasExecutableCommand(script)) {
    errors.push({
      line: 1,
      message: "Script has no executable commands — only comments or empty lines",
    });
    return {
      valid: false,
      errors,
      summary: errors.map((e) => `line ${e.line}: ${e.message}`).join("\n"),
    };
  }

  // 1. bash -n 语法检查
  const syntaxErrors = checkBashSyntax(script);
  errors.push(...syntaxErrors);

  // 2. 命令名校验（仅在语法正确时检查，避免噪音）
  if (syntaxErrors.length === 0) {
    const cmdErrors = checkCommandNames(script);
    errors.push(...cmdErrors);
  }

  const valid = errors.length === 0;
  const summary = valid ? "" : errors.map((e) => `line ${e.line}: ${e.message}`).join("\n");

  return { valid, errors, summary };
}

/** 脚本是否包含至少一条可执行命令（非注释、非空行、非纯赋值）。 */
function hasExecutableCommand(script: string): boolean {
  for (const line of script.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return true;
  }
  return false;
}

/** bash -n 语法检查。 */
function checkBashSyntax(script: string): ValidationError[] {
  try {
    execFileSync("bash", ["-n"], {
      input: script,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return [];
  } catch (e: unknown) {
    const err = e as { stderr?: string };
    const stderr = err.stderr ?? "";
    const errors: ValidationError[] = [];

    // 解析 bash -n 输出格式: "bash: line N: ..."
    for (const line of stderr.split("\n")) {
      const match = line.match(/line (\d+): (.+)/);
      if (match) {
        errors.push({
          line: Number.parseInt(match[1], 10),
          message: `syntax error: ${match[2]}`,
        });
      }
    }

    // 如果没能解析出结构化错误，至少返回原始 stderr
    if (errors.length === 0 && stderr.trim()) {
      errors.push({ line: 1, message: `syntax error: ${stderr.trim().slice(0, 200)}` });
    }

    return errors;
  }
}

// ── 命令名校验 ──────────────────────────────────────────────────────────
//
// 只校验顶级命令名。子命令校验交给 citty 在容器内运行时完成 —
// citty 自带 "Unknown command" 报错，错误通过 feedback-arc 反馈给 LLM。
// @see citty resolveSubCommand → CLIError("E_UNKNOWN_COMMAND")

/** 命令名校验：每个非注释非空行的首 token 是否已知。 */
function checkCommandNames(script: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const lines = script.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // 跳过空行、注释、shebang
    if (!trimmed || trimmed.startsWith("#")) continue;

    // 跳过 shell 变量赋值 (FOO=bar, foo=$(cmd), foo=`cmd`)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) continue;

    // 提取首 token（命令名）
    const firstToken = trimmed.split(/[\s;|&(]/)[0];
    if (!firstToken) continue;

    // 跳过 shell 关键字
    if (SHELL_KEYWORDS.has(firstToken)) continue;

    if (!_knownCommands.has(firstToken)) {
      const suggestion = findClosest(firstToken, _knownCommands);
      const msg = suggestion
        ? `unknown command '${firstToken}', did you mean '${suggestion}'?`
        : `unknown command '${firstToken}'`;
      errors.push({ line: i + 1, message: msg });
    }
  }

  return errors;
}

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "do",
  "done",
  "while",
  "until",
  "case",
  "esac",
  "in",
  "function",
  "{",
  "}",
  "[[",
  "]]",
  "!",
]);

// ── 模糊匹配 ──────────────────────────────────────────────────────────────

/** Levenshtein 距离。 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

/** 在已知命令集中找 Levenshtein 距离 ≤ 2 的最近匹配。 */
function findClosest(input: string, candidates: ReadonlySet<string>): string | null {
  let best: string | null = null;
  let bestDist = 3; // 阈值
  for (const cmd of candidates) {
    // 快速剪枝：长度差 > 2 不可能 ≤ 2
    if (Math.abs(input.length - cmd.length) > 2) continue;
    const dist = levenshtein(input, cmd);
    if (dist < bestDist) {
      bestDist = dist;
      best = cmd;
    }
  }
  return best;
}
