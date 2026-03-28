import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_DOCKER_IMAGE } from "../skills/backends/docker.js";
import { ALICE_CONTAINER_PATHS, executeAliceSandboxCommand } from "../skills/container-runner.js";
import {
  getAliceManDir,
  getAliceSystemBinDir,
  isExecutableFile,
  listAliceSystemCommands,
  loadRegistry,
  mergeRegistryWithBuiltIns,
  type Registry,
  type RegistryEntry,
  resolveInstalledSkillDir,
} from "../skills/registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("command-catalog");

export interface CommandCatalogEntry {
  name: string;
  packageName: string;
  kind: "system" | "skill";
  summary: string;
  /** ADR-223: skill 的 whenToUse（从 manifest.yaml 提取）。 */
  whenToUse?: string;
}

export interface CommandCatalog {
  commands: CommandCatalogEntry[];
}

function safeReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * 从纯文本 "name - description" 格式提取摘要（txt 兼容）。
 */
function parseSummaryLine(text: string | null): string | null {
  if (!text) return null;
  const first = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return null;
  const dash = first.indexOf(" - ");
  return dash >= 0 ? first.slice(dash + 3).trim() : first;
}

/**
 * 从 troff `.1` man page 的 NAME section 提取摘要。
 * 格式: `.SH NAME` 后第一个非空行，形如 `irc \- description`。
 */
function parseManpageSummary(text: string | null): string | null {
  if (!text) return null;
  const lines = text.split("\n");
  let inName = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === ".SH NAME") {
      inName = true;
      continue;
    }
    if (inName) {
      if (line.startsWith(".")) break; // 下一个 section
      if (!line) continue;
      // "irc \- Telegram system chat client for Alice"
      const match = line.match(/\\?-\s+(.+)/);
      return match ? match[1].trim() : line;
    }
  }
  return null;
}

function readSystemSummary(name: string, manRoot: string): string {
  // 优先从 .1 man page 的 NAME section 解析（权威源）
  const manSummary = parseManpageSummary(safeReadText(resolve(manRoot, "man1", `${name}.1`)));
  if (manSummary) return manSummary;

  // 向后兼容：第三方 skill 可能只有 .txt
  const txtSummary = parseSummaryLine(safeReadText(resolve(manRoot, "txt", `${name}.txt`)));
  if (txtSummary) return txtSummary;

  return `${name} command`;
}

interface ManifestMeta {
  summary: string;
  whenToUse?: string;
}

function readManifestMeta(entry: RegistryEntry): ManifestMeta {
  const manifestPath = resolve(resolveInstalledSkillDir(entry), "manifest.yaml");
  const raw = safeReadText(manifestPath);
  if (!raw) return { summary: entry.name };

  const parsed = parseYaml(raw) as {
    description?: unknown;
    actions?: Array<{ whenToUse?: string }>;
    family?: { whenToUse?: string };
  } | null;

  const summary =
    parsed && typeof parsed.description === "string" && parsed.description.trim()
      ? parsed.description.trim()
      : entry.name;

  // ADR-223: 提取 whenToUse（优先 action 级——英文，与 shell manual 一致）
  // family.whenToUse 可能是中文（旧 Capability Guide 遗留），不用。
  const whenToUse = parsed?.actions?.[0]?.whenToUse as string | undefined;

  return { summary, whenToUse };
}

interface ProbeCandidate {
  name: string;
  packageName: string;
  kind: "system" | "skill";
  summary: string;
}

function buildCandidates(
  registry: Registry,
  systemBinDir: string,
  manRoot: string,
): ProbeCandidate[] {
  const systemEntries = listAliceSystemCommands(systemBinDir).map((name) => ({
    name,
    packageName: "alice-system",
    kind: "system" as const,
    summary: readSystemSummary(name, manRoot),
  }));

  const skillEntries = Object.entries(registry)
    .filter(([packageName]) => packageName !== "alice-system")
    .map(([packageName, entry]) => {
      const meta = readManifestMeta(entry);
      return {
        name: entry.name,
        packageName,
        kind: "skill" as const,
        summary: meta.summary,
        whenToUse: meta.whenToUse,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...systemEntries, ...skillEntries];
}

async function probeVisibleNames(
  candidates: readonly ProbeCandidate[],
  env: Record<string, string>,
  options: {
    registry: Registry;
    image: string;
    systemBinDir: string;
    manRoot: string;
  },
): Promise<{ commands: Set<string>; manTopics: Set<string> }> {
  const uniqueNames = [...new Set(candidates.map((candidate) => candidate.name))];
  if (uniqueNames.length === 0) {
    return { commands: new Set<string>(), manTopics: new Set<string>() };
  }

  // Shell script passed to container — curly braces are sh variable expansion, not JS templates.
  /* eslint-disable no-template-curly-in-string */
  const script =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: sh variable expansion
    'set -eu\nfor name in "$@"; do\n  if [ -n "${ALICE_SYSTEM_BIN_DIR:-}" ] && [ -x "${ALICE_SYSTEM_BIN_DIR}/$name" ]; then\n    printf "CMD\\t%s\\n" "$name"\n  fi\n  if [ -n "${ALICE_MANPATH:-}" ] && [ -e "${ALICE_MANPATH}/man1/$name.1" ]; then\n    printf "MAN\\t%s\\n" "$name"\n  fi\ndone';

  const stdout = await executeAliceSandboxCommand({
    command: script,
    args: uniqueNames,
    image: options.image,
    skillName: "alice-system",
    enginePort: undefined,
    network: false,
    memory: "256m",
    timeout: 30,
    env,
    extraMounts: collectProbeMounts(options.registry, options.systemBinDir, options.manRoot),
    isolation: "sandboxed",
  });

  const commands = new Set<string>();
  const manTopics = new Set<string>();

  for (const line of stdout.split(/\r?\n/)) {
    const [kind, name] = line.split("\t");
    if (!kind || !name) continue;
    if (kind === "CMD") commands.add(name);
    if (kind === "MAN") manTopics.add(name);
  }

  return { commands, manTopics };
}

function fallbackVisibleNames(
  candidates: readonly ProbeCandidate[],
  systemBinDir: string,
  manRoot: string,
): { commands: Set<string>; manTopics: Set<string> } {
  const commands = new Set<string>();
  const manTopics = new Set<string>();

  for (const candidate of candidates) {
    if (isExecutableFile(resolve(systemBinDir, candidate.name))) {
      commands.add(candidate.name);
    }
    const manPath = resolve(manRoot, "man1", `${candidate.name}.1`);
    try {
      readFileSync(manPath, "utf-8");
      manTopics.add(candidate.name);
    } catch {
      // ignore missing manuals in fallback mode
    }
  }

  return { commands, manTopics };
}

function collectProbeMounts(
  registry: Registry,
  systemBinDir: string,
  manRoot: string,
): Array<{ source: string; target?: string; readOnly?: boolean }> {
  const mounts = new Map<string, { source: string; target?: string; readOnly?: boolean }>();
  const remember = (source: string, target?: string) => {
    mounts.set(`${source}->${target ?? source}`, { source, target, readOnly: true });
  };

  remember(systemBinDir, ALICE_CONTAINER_PATHS.bin);
  remember(manRoot, ALICE_CONTAINER_PATHS.man);
  for (const entry of Object.values(registry)) {
    remember(resolveInstalledSkillDir(entry));
  }

  return [...mounts.values()];
}

export async function probeCommandCatalog(options?: {
  registry?: Registry;
  systemBinDir?: string;
  manRoot?: string;
  env?: Record<string, string>;
  image?: string;
}): Promise<CommandCatalog> {
  const registry = options?.registry ?? mergeRegistryWithBuiltIns(loadRegistry());
  const systemBinDir = options?.systemBinDir ?? getAliceSystemBinDir();
  const manRoot = options?.manRoot ?? getAliceManDir();
  const candidates = buildCandidates(registry, systemBinDir, manRoot);
  const image = options?.image ?? process.env.ALICE_COMMAND_PROBE_IMAGE ?? DEFAULT_DOCKER_IMAGE;

  const env = options?.env ?? {};

  const visible = await probeVisibleNames(candidates, env, {
    registry,
    image,
    systemBinDir,
    manRoot,
  }).catch((error) => {
    log.warn("Container probe failed, falling back to host catalog", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackVisibleNames(candidates, systemBinDir, manRoot);
  });
  // ADR-223: skill 命令通过 Engine API 执行，不在 filesystem 上。
  // 不经过 container probe 过滤——它们始终可见。
  // 只有 system 命令需要通过 probe 确认存在性。
  // ADR-216: man pages 已删除，统一用 --help。hasMan/manTopics 不再需要。
  const commands = candidates.filter((c) => c.kind === "skill" || visible.commands.has(c.name));

  return { commands };
}
