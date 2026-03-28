/**
 * 脚本预验证单元测试。
 *
 * @see src/core/script-validator.ts
 * @see docs/adr/211-instructor-js-script-prevalidation.md
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  getKnownCommands,
  registerKnownCommands,
  resetKnownCommands,
  validateScript,
} from "../src/core/script-validator.js";

afterEach(() => {
  resetKnownCommands();
});

describe("validateScript", () => {
  // ── bash -n 语法检查 ────────────────────────────────────────────────

  it("有效脚本 → valid", () => {
    const result = validateScript("# 思考\nirc say hello");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("语法错误 → 报告行号", () => {
    const result = validateScript("if true\necho yes");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("syntax error"))).toBe(true);
  });

  it("纯注释脚本 → invalid（无可执行命令）", () => {
    const result = validateScript("# 只有注释\n# 没有命令");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("no executable commands");
  });

  it("LLM 输出纯自然语言 → invalid", () => {
    const result = validateScript("好的我来看看这个群的情况，让我想想该说什么");
    expect(result.valid).toBe(false);
    // 要么被 bash -n 拦截，要么被命令名校验拦截
  });

  // ── 命令名校验 ──────────────────────────────────────────────────────

  it("已知命令 → valid", () => {
    const result = validateScript("irc say hello\nself feel valence=positive");
    expect(result.valid).toBe(true);
  });

  it("未知命令 → 报错", () => {
    const result = validateScript("unknowncmd hello");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("unknown command");
  });

  it("变量赋值 → 跳过（不是命令）", () => {
    const result = validateScript("recent=$(irc tail 5)\nirc say hello");
    expect(result.valid).toBe(true);
  });

  it("shell 关键字 → 跳过", () => {
    registerKnownCommands(["echo"]);
    const result = validateScript("if true; then\n  echo yes\nfi");
    expect(result.valid).toBe(true);
  });

  // ── 模糊匹配 ────────────────────────────────────────────────────────

  it("拼写错误 → did you mean 建议", () => {
    const result = validateScript("irc stikcer happy");
    // 'irc' 本身是已知的，但 'irc stikcer' 整行首 token 是 'irc'
    // 所以这个测试用一个不存在的首命令
    const result2 = validateScript("slef feel valence=positive");
    expect(result2.valid).toBe(false);
    expect(result2.errors[0].message).toContain("did you mean 'self'");
  });

  it("完全不相关的命令 → 无建议", () => {
    const result = validateScript("xyzzyplugh hello");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).not.toContain("did you mean");
  });

  // ── registerKnownCommands ───────────────────────────────────────────

  it("注册自定义命令后可通过验证", () => {
    const before = validateScript("my-custom-skill run");
    expect(before.valid).toBe(false);

    registerKnownCommands(["my-custom-skill"]);
    const after = validateScript("my-custom-skill run");
    expect(after.valid).toBe(true);
  });

  // ── summary 格式 ────────────────────────────────────────────────────

  it("summary 包含行号和错误信息", () => {
    const result = validateScript("# 思考\nslef feel\nirc say hi");
    expect(result.summary).toContain("line 2:");
    expect(result.summary).toContain("slef");
  });
});
