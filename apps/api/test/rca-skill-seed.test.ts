import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** defect-rca skill 内容守卫:frontmatter name 与目录名一致、seed 脚本指向正确内容目录。
 *  防手滑改名导致 seed 落盘目录与 DB name 不一致（pi loader 按 name=目录名发现技能）。 */
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
