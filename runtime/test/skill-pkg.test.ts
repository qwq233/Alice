import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSkill, removeSkill, rollbackSkill, upgradeSkill } from "../src/skills/pkg.js";
import { getEntry } from "../src/skills/registry.js";

interface TestRoots {
  root: string;
  storeRoot: string;
  binDir: string;
  manRoot: string;
  registryPath: string;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeRoots(): TestRoots {
  const root = mkdtempSync(join(tmpdir(), "alice-skill-pkg-"));
  tempRoots.push(root);
  return {
    root,
    storeRoot: join(root, "store"),
    binDir: join(root, "bin"),
    manRoot: join(root, "man"),
    registryPath: join(root, "registry.json"),
  };
}

function writeSkillVersion(root: string, version: string, description: string): string {
  const skillDir = join(root, `skill-${version}`);
  const name = "demo-skill";
  mkdirSync(join(skillDir, "bin"), { recursive: true });
  mkdirSync(join(skillDir, "man", "txt"), { recursive: true });
  mkdirSync(join(skillDir, "man", "man1"), { recursive: true });

  writeFileSync(
    join(skillDir, "manifest.yaml"),
    [
      `name: ${name}`,
      `version: "${version}"`,
      `description: "${description}"`,
      "runtime:",
      "  backend: shell",
      "  timeout: 30",
      "  network: false",
      "  isolation: container",
      "  shell:",
      `    command: "printf '{\\"version\\":\\"${version}\\"}\\\\n'"`,
      "actions:",
      "  - name: use_demo_skill",
      '    category: "app"',
      '    description: ["demo action"]',
      '    whenToUse: "when testing package lifecycle"',
    ].join("\n"),
  );
  writeFileSync(join(skillDir, "bin", `${name}.ts`), "console.log('demo')\n");
  writeFileSync(join(skillDir, "man", "txt", `${name}.txt`), `${name} - ${description}\n`);
  writeFileSync(
    join(skillDir, "man", "man1", `${name}.1`),
    `.TH DEMO-SKILL 1\n.SH NAME\ndemo-skill \\- ${description}\n`,
  );

  return join(skillDir, "manifest.yaml");
}

describe("skill package lifecycle", () => {
  it("installs, upgrades, and rolls back through the exported system prefix", async () => {
    const roots = makeRoots();
    const v1Manifest = writeSkillVersion(roots.root, "1.0.0", "demo skill v1");
    const v2Manifest = writeSkillVersion(roots.root, "2.0.0", "demo skill v2");

    await installSkill(v1Manifest, roots);

    const v1Entry = getEntry("demo-skill", roots.registryPath);
    expect(v1Entry).toBeDefined();
    expect(v1Entry?.commandPath).toBe(join(roots.binDir, "demo-skill"));
    expect(readlinkSync(join(roots.binDir, "demo-skill"))).toBe(
      join(roots.storeRoot, v1Entry?.hash ?? "", "demo-skill"),
    );
    expect(readlinkSync(join(roots.manRoot, "txt", "demo-skill.txt"))).toBe(
      join(roots.storeRoot, v1Entry?.hash ?? "", "share", "man", "txt", "demo-skill.txt"),
    );

    await upgradeSkill("demo-skill", v2Manifest, roots);

    const v2Entry = getEntry("demo-skill", roots.registryPath);
    expect(v2Entry?.version).toBe("2.0.0");
    expect(v2Entry?.previousHash).toBe(v1Entry?.hash);
    expect(readlinkSync(join(roots.binDir, "demo-skill"))).toBe(
      join(roots.storeRoot, v2Entry?.hash ?? "", "demo-skill"),
    );
    expect(readlinkSync(join(roots.manRoot, "txt", "demo-skill.txt"))).toBe(
      join(roots.storeRoot, v2Entry?.hash ?? "", "share", "man", "txt", "demo-skill.txt"),
    );

    await rollbackSkill("demo-skill", roots);

    const rolledBack = getEntry("demo-skill", roots.registryPath);
    expect(rolledBack?.version).toBe("1.0.0");
    expect(rolledBack?.hash).toBe(v1Entry?.hash);
    expect(rolledBack?.previousHash).toBe(v2Entry?.hash);
    expect(readlinkSync(join(roots.binDir, "demo-skill"))).toBe(
      join(roots.storeRoot, rolledBack?.hash ?? "", "demo-skill"),
    );
    expect(readlinkSync(join(roots.manRoot, "txt", "demo-skill.txt"))).toBe(
      join(roots.storeRoot, rolledBack?.hash ?? "", "share", "man", "txt", "demo-skill.txt"),
    );
  });

  it("removes exported artifacts from the system prefix on uninstall", async () => {
    const roots = makeRoots();
    const manifestPath = writeSkillVersion(roots.root, "1.0.0", "demo skill v1");

    await installSkill(manifestPath, roots);
    expect(existsSync(join(roots.binDir, "demo-skill"))).toBe(true);
    expect(existsSync(join(roots.manRoot, "txt", "demo-skill.txt"))).toBe(true);

    await removeSkill("demo-skill", roots);

    expect(existsSync(join(roots.binDir, "demo-skill"))).toBe(false);
    expect(existsSync(join(roots.manRoot, "txt", "demo-skill.txt"))).toBe(false);
    expect(getEntry("demo-skill", roots.registryPath)).toBeUndefined();
  });
});
