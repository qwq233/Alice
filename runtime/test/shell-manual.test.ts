import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { probeCommandCatalog } from "../src/core/command-catalog.js";
import { generateShellManual } from "../src/core/shell-manual.js";
import { ALICE_CONTAINER_PATHS } from "../src/skills/container-runner.js";
import type { Registry } from "../src/skills/registry.js";

vi.mock("../src/skills/backends/docker.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/skills/backends/docker.js")>();
  return {
    ...original,
    executeDockerCommand: vi.fn(),
  };
});

describe("command catalog", () => {
  it("probes command visibility via container and builds the catalog", async () => {
    const { executeDockerCommand } = await import("../src/skills/backends/docker.js");
    const mockDocker = executeDockerCommand as ReturnType<typeof vi.fn>;
    mockDocker.mockResolvedValue("CMD\tirc\nCMD\tctl\nCMD\tweather\nMAN\tirc\n");

    const root = mkdtempSync(join(tmpdir(), "alice-catalog-"));
    const systemBinDir = join(root, "system-bin");
    const manRoot = join(root, "man");
    const storePath = join(root, "store-weather");

    mkdirSync(systemBinDir, { recursive: true });
    mkdirSync(join(manRoot, "man1"), { recursive: true });
    mkdirSync(storePath, { recursive: true });

    writeFileSync(join(systemBinDir, "irc"), "#!/usr/bin/env sh\n");
    writeFileSync(join(systemBinDir, "ctl"), "#!/usr/bin/env sh\n");
    chmodSync(join(systemBinDir, "irc"), 0o755);
    chmodSync(join(systemBinDir, "ctl"), 0o755);
    writeFileSync(join(systemBinDir, "irc.ts"), "ignored source");
    writeFileSync(
      join(manRoot, "man1", "irc.1"),
      ".TH IRC 1\n.SH NAME\nirc \\- Telegram system chat client for Alice\n",
    );

    writeFileSync(
      join(storePath, "manifest.yaml"),
      [
        "name: weather",
        'version: "1.1.0"',
        'description: "Weather forecast — global coverage"',
        "actions:",
        "  - name: use_weather_app",
        '    description: ["Check weather"]',
        '    whenToUse: "Check weather"',
      ].join("\n"),
    );
    writeFileSync(join(storePath, "weather"), "#!/usr/bin/env sh\n");
    chmodSync(join(storePath, "weather"), 0o755);
    symlinkSync(join(storePath, "weather"), join(systemBinDir, "weather"));

    const registry: Registry = {
      "alice-system": {
        name: "alice-system",
        version: "1.0.0",
        hash: "builtin-system",
        storePath: systemBinDir,
        commandPath: join(systemBinDir, "irc"),
        installedAt: "2026-03-11T00:00:00.000Z",
        actions: ["irc", "ctl"],
        categories: ["app"],
        capabilities: [],
        backend: "shell",
      },
      weather: {
        name: "weather",
        version: "1.1.0",
        hash: "hash-weather",
        storePath,
        commandPath: join(storePath, "weather"),
        installedAt: "2026-03-11T00:00:00.000Z",
        actions: ["use_weather_app"],
        categories: ["weather"],
        capabilities: [],
        backend: "shell",
      },
    };

    const catalog = await probeCommandCatalog({
      registry,
      systemBinDir,
      manRoot,
      env: {
        PATH: `${systemBinDir}:${process.env.PATH ?? ""}`,
        ALICE_MANPATH: manRoot,
        MANPATH: manRoot,
        ALICE_SYSTEM_BIN_DIR: systemBinDir,
      },
    });

    expect(catalog.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "irc",
          kind: "system",
          summary: "Telegram system chat client for Alice",
        }),
        expect.objectContaining({
          name: "weather",
          kind: "skill",
          summary: expect.stringContaining("Weather"),
        }),
      ]),
    );
    expect(catalog.commands.filter((entry) => entry.name === "weather")).toHaveLength(1);
  });
});

describe("generateShellManual", () => {
  it("renders a live command catalog instead of a hardcoded command block", async () => {
    const { executeDockerCommand } = await import("../src/skills/backends/docker.js");
    const mockDocker = executeDockerCommand as ReturnType<typeof vi.fn>;
    // 模拟容器探测返回系统命令
    mockDocker.mockResolvedValue(
      "CMD\tirc\nCMD\tself\nCMD\tengine\nCMD\task\nCMD\talice-pkg\nMAN\tirc\n",
    );
    const manual = await generateShellManual([]);
    expect(manual).toContain("## Command Catalog");
    expect(manual).toContain("This catalog is fetched through a live runtime command probe");
    expect(manual).toContain("`irc`");
    // ADR-213: ctl 已删除，流控通过 tool calling flow 参数
    expect(manual).not.toContain("`ctl`");
    expect(manual).not.toContain("## Core Commands");
  });
});

describe("container probe mode", () => {
  it("uses the docker runner handshake for catalog probe", async () => {
    const { executeDockerCommand } = await import("../src/skills/backends/docker.js");
    const mockDocker = executeDockerCommand as ReturnType<typeof vi.fn>;
    mockDocker.mockResolvedValue("CMD\tirc\nMAN\tirc\n");

    const root = mkdtempSync(join(tmpdir(), "alice-container-probe-"));
    const systemBinDir = join(root, "opt", "alice", "bin");
    const manRoot = join(root, "opt", "alice", "share", "man");
    mkdirSync(systemBinDir, { recursive: true });
    mkdirSync(join(manRoot, "man1"), { recursive: true });
    writeFileSync(join(systemBinDir, "irc"), "#!/usr/bin/env sh\n");
    chmodSync(join(systemBinDir, "irc"), 0o755);
    writeFileSync(
      join(manRoot, "man1", "irc.1"),
      ".TH IRC 1\n.SH NAME\nirc \\- Telegram system chat client for Alice\n",
    );

    const catalog = await probeCommandCatalog({
      registry: {
        "alice-system": {
          name: "alice-system",
          version: "1.0.0",
          hash: "builtin-system",
          storePath: systemBinDir,
          commandPath: join(systemBinDir, "irc"),
          installedAt: "2026-03-11T00:00:00.000Z",
          actions: ["irc"],
          categories: ["app"],
          capabilities: [],
          backend: "shell",
        },
      },
      systemBinDir,
      manRoot,
      env: {
        PATH: systemBinDir,
        ALICE_MANPATH: manRoot,
      },
    });

    expect(mockDocker).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: "alice-system",
        network: false,
        isolation: "sandboxed",
        extraMounts: expect.arrayContaining([
          expect.objectContaining({ source: systemBinDir, target: ALICE_CONTAINER_PATHS.bin }),
          expect.objectContaining({ source: manRoot, target: ALICE_CONTAINER_PATHS.man }),
        ]),
      }),
    );
    expect(catalog.commands).toEqual([expect.objectContaining({ name: "irc" })]);
  });

  it("falls back to the host catalog when the container probe fails", async () => {
    const { executeDockerCommand } = await import("../src/skills/backends/docker.js");
    const mockDocker = executeDockerCommand as ReturnType<typeof vi.fn>;
    mockDocker.mockRejectedValue(new Error("probe failed"));

    const root = mkdtempSync(join(tmpdir(), "alice-probe-fallback-"));
    const systemBinDir = join(root, "system-bin");
    const manRoot = join(root, "man");
    const storePath = join(root, "store-weather");

    mkdirSync(systemBinDir, { recursive: true });
    mkdirSync(join(manRoot, "man1"), { recursive: true });
    mkdirSync(storePath, { recursive: true });

    writeFileSync(join(systemBinDir, "irc"), "#!/usr/bin/env sh\n");
    chmodSync(join(systemBinDir, "irc"), 0o755);
    writeFileSync(
      join(manRoot, "man1", "irc.1"),
      ".TH IRC 1\n.SH NAME\nirc \\- Telegram system chat client for Alice\n",
    );

    writeFileSync(join(storePath, "weather"), "#!/usr/bin/env sh\n");
    chmodSync(join(storePath, "weather"), 0o755);
    symlinkSync(join(storePath, "weather"), join(systemBinDir, "weather"));
    writeFileSync(
      join(storePath, "manifest.yaml"),
      ["name: weather", 'version: "1.1.0"', 'description: "fallback weather"'].join("\n"),
    );

    const catalog = await probeCommandCatalog({
      registry: {
        "alice-system": {
          name: "alice-system",
          version: "1.0.0",
          hash: "builtin-system",
          storePath: systemBinDir,
          commandPath: join(systemBinDir, "irc"),
          installedAt: "2026-03-11T00:00:00.000Z",
          actions: ["irc"],
          categories: ["app"],
          capabilities: [],
          backend: "shell",
        },
        weather: {
          name: "weather",
          version: "1.1.0",
          hash: "hash-weather",
          storePath,
          commandPath: join(storePath, "weather"),
          installedAt: "2026-03-11T00:00:00.000Z",
          actions: ["use_weather_app"],
          categories: ["weather"],
          capabilities: [],
          backend: "shell",
        },
      },
      systemBinDir,
      manRoot,
    });

    expect(catalog.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "irc" }),
        expect.objectContaining({ name: "weather", kind: "skill" }),
      ]),
    );
  });
});
