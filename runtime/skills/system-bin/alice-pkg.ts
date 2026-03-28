/**
 * alice-pkg — Alice OS 包管理器。
 *
 * 管理 Skill 包的搜索、安装、卸载、升级和回滚。
 * 所有变更操作通过 Engine API 在引擎进程内执行。
 *
 * @see docs/adr/201-ai-native-os.md
 */

import { defineCommand, runMain } from "citty";
import { engineGet, enginePost } from "../_lib/engine-client.ts";

function die(msg: string): never {
  process.stderr.write(`alice-pkg: ${msg}\n`);
  process.exit(1);
}

async function requireResult<T>(promise: Promise<unknown | null>, context: string): Promise<T> {
  const result = await promise;
  if (result == null) die(`Engine API unavailable (${context})`);
  return result as T;
}

const search = defineCommand({
  meta: { name: "search", description: "Search available skills" },
  args: {
    query: { type: "positional", description: "Search query (omit to list all)", default: "" },
  },
  async run({ args }) {
    const query = (args.query as string | undefined)?.trim() ?? "";
    const queryParam = query ? `?query=${encodeURIComponent(query)}` : "";
    const result = await requireResult<{
      query: string | null;
      skills: Array<{
        name: string;
        version: string;
        description: string;
        whenToUse: string;
        installed: boolean;
        source?: "local" | "remote";
      }>;
    }>(engineGet(`/skills/search${queryParam}`), "search");

    if (result.skills.length === 0) {
      console.log(query ? `No skills found matching "${query}".` : "No skills available.");
      return;
    }

    for (const s of result.skills) {
      const status = s.installed ? "[installed]" : "[available]";
      const source = s.source === "remote" ? " (remote)" : "";
      console.log(`${s.name} v${s.version} ${status}${source} — ${s.whenToUse}`);
    }
  },
});

const install = defineCommand({
  meta: { name: "install", description: "Install a skill by name" },
  args: {
    name: { type: "positional", description: "Skill name", required: true },
  },
  async run({ args }) {
    const name = (args.name as string).trim();
    if (!name) die("skill name required");
    const result = await requireResult<{ ok?: boolean; error?: string }>(
      enginePost("/skills/install", { name }),
      "install",
    );
    if (result.error) die(`install: ${result.error}`);
    console.log(`Installed ${name}.`);
  },
});

const remove = defineCommand({
  meta: { name: "remove", description: "Remove an installed skill" },
  args: {
    name: { type: "positional", description: "Skill name", required: true },
  },
  async run({ args }) {
    const name = (args.name as string).trim();
    if (!name) die("skill name required");
    const result = await requireResult<{ ok?: boolean; error?: string }>(
      enginePost("/skills/remove", { name }),
      "remove",
    );
    if (result.error) die(`remove: ${result.error}`);
    console.log(`Removed ${name}.`);
  },
});

const list = defineCommand({
  meta: { name: "list", description: "List installed skills" },
  async run() {
    const result = await requireResult<{
      skills: Array<{ name: string; version: string; hash: string; capabilities: string[] }>;
    }>(engineGet("/skills/list"), "list");

    if (result.skills.length === 0) {
      console.log("No skills installed.");
      return;
    }

    for (const s of result.skills) {
      const caps = s.capabilities.length > 0 ? ` [${s.capabilities.join(",")}]` : "";
      console.log(`${s.name}  ${s.version}  ${s.hash}${caps}`);
    }
  },
});

const info = defineCommand({
  meta: { name: "info", description: "Show detailed skill information" },
  args: {
    name: { type: "positional", description: "Skill name", required: true },
  },
  async run({ args }) {
    const name = (args.name as string).trim();
    if (!name) die("skill name required");
    const result = await requireResult<{
      name: string;
      manifest: Record<string, unknown> | null;
      installed: Record<string, unknown> | null;
      error?: string;
    }>(engineGet(`/skills/info/${encodeURIComponent(name)}`), "info");
    if (result.error) die(`info: ${result.error}`);
    console.log(JSON.stringify(result, null, 2));
  },
});

const upgrade = defineCommand({
  meta: { name: "upgrade", description: "Upgrade a skill to latest version" },
  args: {
    name: { type: "positional", description: "Skill name", required: true },
  },
  async run({ args }) {
    const name = (args.name as string).trim();
    if (!name) die("skill name required");
    const result = await requireResult<{ ok?: boolean; error?: string }>(
      enginePost("/skills/upgrade", { name }),
      "upgrade",
    );
    if (result.error) die(`upgrade: ${result.error}`);
    console.log(`Upgraded ${name}.`);
  },
});

const rollback = defineCommand({
  meta: { name: "rollback", description: "Rollback a skill to previous version" },
  args: {
    name: { type: "positional", description: "Skill name", required: true },
  },
  async run({ args }) {
    const name = (args.name as string).trim();
    if (!name) die("skill name required");
    const result = await requireResult<{ ok?: boolean; error?: string }>(
      enginePost("/skills/rollback", { name }),
      "rollback",
    );
    if (result.error) die(`rollback: ${result.error}`);
    console.log(`Rolled back ${name}.`);
  },
});

const publish = defineCommand({
  meta: { name: "publish", description: "Publish a skill to the remote Store" },
  args: {
    dir: { type: "positional", description: "Skill directory (default: .)" },
  },
  async run({ args }) {
    const dir = (args.dir as string | undefined)?.trim() || ".";
    const result = await requireResult<{ ok?: boolean; hash?: string; error?: string }>(
      enginePost("/skills/publish", { dir }),
      "publish",
    );
    if (result.error) die(`publish: ${result.error}`);
    console.log(`Published (hash: ${result.hash}).`);
  },
});

const main = defineCommand({
  meta: {
    name: "alice-pkg",
    description: "Alice OS package manager",
  },
  subCommands: {
    search,
    install,
    remove,
    list,
    info,
    upgrade,
    rollback,
    publish,
  },
});

runMain(main);
