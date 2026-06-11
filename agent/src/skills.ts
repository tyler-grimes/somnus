/**
 * Skill lifecycle. The dream cycle drafts SKILL.md directories into
 * .claude/skills-pending/; Tyler reviews and approves via /skills; approved
 * skills live in .claude/skills/ and their frontmatter (name + description,
 * ~100 tokens each) is injected into the system prompt — progressive
 * disclosure: Somnus Reads the full SKILL.md only when a skill is relevant.
 *
 * The human gate is deliberate: ungated self-authored skills measured ≈ zero
 * gain in the research behind this system (SkillsBench). Do not auto-approve.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const SKILLS_PENDING_DIR = path.join(ROOT, ".claude", "skills-pending");
export const SKILLS_ACTIVE_DIR = path.join(ROOT, ".claude", "skills");

export interface SkillMeta {
  slug: string;
  name: string;
  description: string;
  path: string;
}

function readSkillDir(base: string): SkillMeta[] {
  if (!fs.existsSync(base)) return [];
  const out: SkillMeta[] = [];
  for (const slug of fs.readdirSync(base)) {
    const skillPath = path.join(base, slug, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const head = fs.readFileSync(skillPath, "utf8").slice(0, 2000);
    const name = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? slug;
    const description = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? "";
    out.push({ slug, name, description, path: skillPath });
  }
  return out;
}

export function activeSkills(): SkillMeta[] {
  return readSkillDir(SKILLS_ACTIVE_DIR);
}

export function pendingSkills(): SkillMeta[] {
  return readSkillDir(SKILLS_PENDING_DIR);
}

export function approveSkill(slug: string): boolean {
  const from = path.join(SKILLS_PENDING_DIR, slug);
  if (!fs.existsSync(path.join(from, "SKILL.md"))) return false;
  fs.mkdirSync(SKILLS_ACTIVE_DIR, { recursive: true });
  fs.renameSync(from, path.join(SKILLS_ACTIVE_DIR, slug));
  return true;
}

export function rejectSkill(slug: string): boolean {
  const dir = path.join(SKILLS_PENDING_DIR, slug);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true });
  return true;
}

/** System-prompt section: frontmatter only; bodies load on demand via Read. */
export function skillsPromptSection(): string {
  const skills = activeSkills();
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}\n  full instructions: ${s.path}`);
  return `\n<skills>\nYou have learned skills — procedures distilled from your own friction history. When a task matches a skill's description, Read its full instructions before acting.\n${lines.join("\n")}\n</skills>\n`;
}
