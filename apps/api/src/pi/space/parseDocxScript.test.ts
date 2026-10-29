import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import archiver from 'archiver';

const exec = promisify(execFile);
const SCRIPT = path.resolve(process.cwd(), 'scripts/docx-to-cases-content/scripts/parse_docx.py');

/** 用 archiver（已有依赖）现场构造最小 docx（zip + document.xml/styles.xml）。 */
async function buildDocx(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'docx-'));
  const out = path.join(dir, 'fixture.docx');
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const sink = new Writable({
      write(c, _e, cb) { chunks.push(c as Buffer); cb(); },
    });
    archive.pipe(sink);
    for (const [name, body] of Object.entries(files)) archive.append(body, { name });
    void archive.finalize().then(async () => {
      await writeFile(out, Buffer.concat(chunks));
      resolve();
    }, reject);
  });
  return out;
}

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>登录模块</w:t></w:r></w:p>
<w:p><w:r><w:t>用户通过账号密码登录。</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>REQ-001</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>登录成功</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:pPr><w:pStyle w:val="H2"/></w:pPr><w:r><w:t>密码规则</w:t></w:r></w:p>
<w:p><w:r><w:t>密码长度至少 8 位。</w:t></w:r></w:p>
</w:body></w:document>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="H1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="H2"><w:name w:val="heading 2"/></w:style>
</w:styles>`;

function lastJson(stdout: string): any {
  return JSON.parse(stdout.trim().split('\n').pop()!);
}

describe('parse_docx.py', () => {
  it('outline：H1 成节、段落/表格计数、子标题清单', async () => {
    const docx = await buildDocx({ 'word/document.xml': DOCUMENT_XML, 'word/styles.xml': STYLES_XML });
    const out = lastJson((await exec('python3', [SCRIPT, docx])).stdout);
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('outline');
    expect(out.stats.sections).toBe(1);
    expect(out.stats.tables).toBe(1);
    expect(out.sections[0].title).toBe('登录模块');
    expect(out.sections[0].paras).toBe(2);
    expect(out.sections[0].tables).toEqual([{ rows: 1, cols: 2 }]);
    expect(out.sections[0].subheadings).toEqual(['密码规则']);
  });

  it('--section 0：段落全文与表格单元格完整', async () => {
    const docx = await buildDocx({ 'word/document.xml': DOCUMENT_XML, 'word/styles.xml': STYLES_XML });
    const out = lastJson((await exec('python3', [SCRIPT, docx, '--section', '0'])).stdout);
    expect(out.ok).toBe(true);
    const texts = out.blocks.filter((b: any) => b.type === 'para').map((b: any) => b.text);
    expect(texts).toContain('用户通过账号密码登录。');
    expect(texts).toContain('密码长度至少 8 位。');
    expect(out.blocks.find((b: any) => b.type === 'table').rows).toEqual([['REQ-001', '登录成功']]);
  });

  it('--sub 0：子章节切分正确', async () => {
    const docx = await buildDocx({ 'word/document.xml': DOCUMENT_XML, 'word/styles.xml': STYLES_XML });
    const out = lastJson((await exec('python3', [SCRIPT, docx, '--section', '0', '--sub', '0'])).stdout);
    expect(out.title).toBe('登录模块 / 密码规则');
    const texts = out.blocks.filter((b: any) => b.type === 'para').map((b: any) => b.text);
    expect(texts).toEqual(['密码长度至少 8 位。']);
  });

  it('非 zip 文件：ok=false 且退出码非 0', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'docx-'));
    const fake = path.join(dir, 'fake.docx');
    await writeFile(fake, 'not a zip at all');
    await expect(exec('python3', [SCRIPT, fake])).rejects.toThrow();
  });

  it('zip bomb（声明展开量超阈值）：拒绝', async () => {
    const docx = await buildDocx({
      'word/document.xml': DOCUMENT_XML,
      'word/styles.xml': STYLES_XML,
      'big.txt': 'x'.repeat(2048),
    });
    await expect(exec('python3', [SCRIPT, docx], {
      env: { ...process.env, DOCX_MAX_TOTAL_BYTES: '1024' },
    })).rejects.toThrow();
  });
});
