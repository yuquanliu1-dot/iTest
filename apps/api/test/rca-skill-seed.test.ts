import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** defect-rca skill content guard: frontmatter name matches the directory name, and the seed script points at the right content directory.
 *  Prevents an accidental rename from desyncing the seeded on-disk directory from the DB name (the pi loader discovers skills by name=directory name). */
describe('defect-rca skill 内容', () => {
  it('SKILL.md frontmatter name=defect-rca 且 description 非空', async () => {
    const md = await readFile(join(__dirname, '../scripts/defect-rca-content/SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(md);
    expect(fm).not.toBeNull();
    const name = /name:\s*(.+)/.exec(fm![1]!)?.[1]?.trim();
    expect(name).toBe('defect-rca');
    const desc = /description:\s*(.+)/.exec(fm![1]!)?.[1]?.trim() ?? '';
    expect(desc.length).toBeGreaterThan(10);
  });

  it('seed 脚本指向 defect-rca-content 且 NAME=defect-rca', async () => {
    const seed = await readFile(join(__dirname, '../scripts/seed-defect-rca.mjs'), 'utf8');
    expect(seed).toContain("defect-rca-content");
    expect(seed).toContain("'defect-rca'");
  });
});
