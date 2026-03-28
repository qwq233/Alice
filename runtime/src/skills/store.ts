/**
 * 内容寻址存储 — Nix 风格 SHA256 + 目录结构。
 *
 * store/{hash}/ 下存放 manifest.yaml + 执行体。
 * 同 manifest + 同版本 = 同 hash → 幂等安装，不重复。
 *
 * @see docs/adr/201-os-for-llm.md
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getAliceStoreRoot } from "./registry.js";

/** 存储根目录（开发态可在 workspace，runner/container 可绑定到系统前缀）。 */
const DEFAULT_STORE_ROOT = getAliceStoreRoot();

function writeLauncher(storePath: string, skillName: string): void {
  const launcherPath = join(storePath, skillName);
  const launcher = [
    "#!/usr/bin/env sh",
    'DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"',
    `exec npx tsx "$DIR/bin/${skillName}.ts" "$@"`,
    "",
  ].join("\n");
  writeFileSync(launcherPath, launcher);
  chmodSync(launcherPath, 0o755);
}

function normalizePackageManuals(storePath: string, sourceDir?: string): void {
  if (!sourceDir) return;

  const canonicalManRoot = join(storePath, "share", "man");
  const sourceShareMan = join(sourceDir, "share", "man");
  const sourceLooseMan = join(sourceDir, "man");

  if (existsSync(sourceShareMan) && !existsSync(canonicalManRoot)) {
    mkdirSync(join(storePath, "share"), { recursive: true });
    cpSync(sourceShareMan, canonicalManRoot, { recursive: true });
    return;
  }

  if (existsSync(sourceLooseMan) && !existsSync(canonicalManRoot)) {
    mkdirSync(join(storePath, "share"), { recursive: true });
    cpSync(sourceLooseMan, canonicalManRoot, { recursive: true });
  }
}

interface ParsedManifest {
  name?: string;
  description?: string;
  manPage?: string;
  actions?: Array<{
    whenToUse?: string;
    description?: string[];
    params?: Array<{
      name?: string;
      required?: boolean;
    }>;
  }>;
}

/** 从 ParsedManifest 提取手册生成所需的公共字段。 */
function extractManualFields(manifest: ParsedManifest, skillName: string) {
  const description = manifest.description ?? `${skillName} skill command`;
  const action = manifest.actions?.[0];
  const whenToUse = action?.whenToUse ?? "Use when this capability is relevant.";
  return { description, action, whenToUse };
}

function buildParamSynopsis(
  action: { params?: Array<{ name?: string; required?: boolean }> } | undefined,
  skillName: string,
  upperCase = false,
): string {
  const params =
    action?.params?.map((param) => {
      const name = upperCase ? (param.name ?? "arg").toUpperCase() : (param.name ?? "arg");
      return param.required === false ? `[${name}=...]` : `${name}=...`;
    }) ?? [];
  return [skillName, ...params].join(" ");
}

function buildFallbackManualText(manifest: ParsedManifest, skillName: string): string {
  const { description, action, whenToUse } = extractManualFields(manifest, skillName);
  const title = manifest.name ?? skillName;
  const synopsis = buildParamSynopsis(action, skillName);

  return [
    `${title} - ${description}`,
    "",
    "Usage:",
    `  ${synopsis}`,
    "",
    "When to use:",
    `  ${whenToUse}`,
    "",
  ].join("\n");
}

function buildFallbackManpage(manifest: ParsedManifest, skillName: string): string {
  const { description, action, whenToUse } = extractManualFields(manifest, skillName);
  const title = (manifest.name ?? skillName).toUpperCase();
  const synopsis = buildParamSynopsis(action, skillName, true);

  return [
    `.TH ${title} 1`,
    `.SH NAME`,
    `${skillName} \\- ${description}`,
    `.SH SYNOPSIS`,
    synopsis,
    `.SH DESCRIPTION`,
    whenToUse,
    "",
  ].join("\n");
}

function writeFallbackManuals(
  storePath: string,
  manifestContent: string,
  skillName?: string,
): void {
  if (!skillName) return;

  const parsed = parseYaml(manifestContent) as ParsedManifest;
  const manRoot = join(storePath, "share", "man");
  const txtRoot = join(manRoot, "txt");
  const man1Root = join(manRoot, "man1");
  mkdirSync(txtRoot, { recursive: true });
  mkdirSync(man1Root, { recursive: true });

  const txtPath = join(txtRoot, `${skillName}.txt`);
  if (!existsSync(txtPath)) {
    // 优先使用 manifest 中的完整 manPage，否则自动生成
    const txtContent = parsed.manPage ?? buildFallbackManualText(parsed, skillName);
    writeFileSync(txtPath, txtContent);
  }

  const manPath = join(man1Root, `${skillName}.1`);
  if (!existsSync(manPath)) {
    writeFileSync(manPath, buildFallbackManpage(parsed, skillName));
  }
}

/**
 * 计算 manifest 内容的 SHA256 哈希。
 * 内容寻址 = 同内容同 hash。
 */
export function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * 安装 manifest 到内容寻址存储。
 *
 * @param manifestContent manifest.yaml 原始内容
 * @param sourceDir Skill 包源码目录（可选）。提供时会将整个包复制到 store。
 * @param storeRoot 存储根目录
 * @returns { hash, storePath }
 */
export function installToStore(
  manifestContent: string,
  sourceDir?: string,
  skillName?: string,
  storeRoot: string = DEFAULT_STORE_ROOT,
): { hash: string; storePath: string } {
  const hash = computeHash(manifestContent);
  const storePath = join(storeRoot, hash);

  if (!existsSync(storePath)) {
    if (sourceDir) {
      // Store contains the full package body so installed skills stay runnable
      // even after the source workspace changes.
      cpSync(sourceDir, storePath, { recursive: true });
    } else {
      mkdirSync(storePath, { recursive: true });
    }
    writeFileSync(join(storePath, "manifest.yaml"), manifestContent);
  }

  normalizePackageManuals(storePath, sourceDir);
  writeFallbackManuals(storePath, manifestContent, skillName);

  // Backfill launcher even for stores created before the installed-command path existed.
  if (sourceDir && skillName && !existsSync(join(storePath, skillName))) {
    writeLauncher(storePath, skillName);
  }

  return { hash, storePath };
}

/**
 * 从存储中读取 manifest 内容。
 */
export function readFromStore(hash: string, storeRoot: string = DEFAULT_STORE_ROOT): string | null {
  const filePath = join(storeRoot, hash, "manifest.yaml");
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

/**
 * 从存储中移除。
 */
export function removeFromStore(hash: string, storeRoot: string = DEFAULT_STORE_ROOT): void {
  const storePath = join(storeRoot, hash);
  if (existsSync(storePath)) {
    rmSync(storePath, { recursive: true });
  }
}

/**
 * 检查 hash 是否已存在于存储中。
 */
export function existsInStore(hash: string, storeRoot: string = DEFAULT_STORE_ROOT): boolean {
  return existsSync(join(storeRoot, hash, "manifest.yaml"));
}
