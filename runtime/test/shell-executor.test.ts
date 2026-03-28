import { describe, expect, it, vi } from "vitest";

// 拦截 Docker 调用：替换 executeInContainer 中的 execFile("docker", ...)
// 用真实 /bin/sh 执行脚本（测试关注的是 sentinel 解析和 thinks 提取逻辑，不是容器隔离本身）
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: vi.fn((cmd: string, args: string[], opts: unknown, cb: Function) => {
      if (cmd === "docker") {
        const sub = args[0]; // docker subcommand: exec, create, start, inspect, rm ...
        if (sub === "exec") {
          // docker exec ... /bin/sh -c <script> — 提取脚本并用真实 sh 执行
          const shIdx = args.indexOf("/bin/sh");
          const script = shIdx >= 0 ? args[shIdx + 2] : args[args.length - 1];
          return original.execFile("/bin/sh", ["-c", script], opts as any, cb as any);
        }
        // create / start / inspect / rm — 返回成功空输出
        if (typeof cb === "function") cb(null, "", "");
        return;
      }
      return original.execFile(cmd, args, opts as any, cb as any);
    }),
  };
});

// 必须在 vi.mock 之后动态导入
const { executeShellScript } = await import("../src/core/shell-executor.js");

describe("executeShellScript", () => {
  // ADR-213: CONTROL_PREFIX 解析已移除。流控信号通过 tool calling flow 参数传递。

  it("filters ACTION_PREFIX lines from visible logs", async () => {
    const result = await executeShellScript(
      'printf "__ALICE_ACTION__:send_message\\n"\nprintf "visible\\n"',
      {},
    );

    expect(result.completedActions).toEqual(["send_message"]);
    expect(result.logs).toEqual(["visible"]);
    expect(result.errors).toEqual([]);
  });

  it("extracts # comments as thinks (cognitive trace)", async () => {
    const result = await executeShellScript(
      '#!/bin/sh\n# 他好久没联系了\n# 先试探一下\necho "hello"',
      {},
    );

    expect(result.thinks).toEqual(["他好久没联系了", "先试探一下"]);
    expect(result.logs).toEqual(["hello"]);
  });

  it("surfaces shell failures as script errors", async () => {
    const result = await executeShellScript("echo boom >&2\nexit 2", {});
    expect(result.errors[0]).toContain("boom");
  });

  it("strips garbled ANSI fragments and invisible noise from logs", async () => {
    const zws = "\u200b";
    const result = await executeShellScript(
      `printf "\\033[4m\\033[1mhello\\033[22m\\033[24m\\n[4m[1mworld[22m[24m\\nfoo${zws}bar\\n"`,
      {},
    );

    expect(result.logs).toEqual(["hello", "world", "foobar"]);
    expect(result.errors).toEqual([]);
  });
});
