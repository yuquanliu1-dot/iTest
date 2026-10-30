import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const SCRIPT = path.resolve(process.cwd(), 'scripts/export-cases-content/scripts/export_cases.py');
const CONTENT = path.resolve(process.cwd(), 'scripts/export-cases-content');
// 用真实 TS 构建器生成 payload——测试同时锁住「TS payload 契约 ↔ python 渲染」两侧。
import { buildExportPayload, type ExportCaseRow } from '../../services/caseExport.service.js';

async function buildPayloadFile(): Promise<string> {
  const mk = (over: Partial<ExportCaseRow> = {}): ExportCaseRow => ({
    id: over.id ?? crypto.randomUUID(),
    title: over.title ?? '验证登录成功',
    description: over.description !== undefined ? over.description : '1.系统运行正常',
    expectedOutcome: over.expectedOutcome !== undefined ? over.expectedOutcome : '1.跳转首页',
    groupId: over.groupId ?? 'g1',
    groupName: over.groupName ?? '登录模块',
    versionId: 'v1',
    versionName: 'V2.3',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    steps: [
      { order: 1, instruction: '打开登录页', compiled: null, assertion: null },
      { order: 2, instruction: '输入正确账号口令', compiled: null, assertion: null },
    ],
  });
  const payload = buildExportPayload([mk(), mk({ title: '口令错误登录失败', groupName: '告警管理' })]);
  const dir = await mkdtemp(path.join(tmpdir(), 'itest-export-'));
  const file = path.join(dir, 'payload.json');
  await writeFile(file, JSON.stringify(payload), 'utf8');
  return file;
}

/** python 一行读 zip 条目（测试侧不引 zip 解压依赖）。 */
async function zipEntry(zipPath: string, name: string): Promise<string> {
  const { stdout } = await exec('python3', ['-c', 'import zipfile,sys;sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode("utf-8"))', zipPath, name]);
  return stdout;
}

interface Marker {
  name: string;
  path: string;
  count: number;
}

async function runScript(cwd: string, arg: Record<string, unknown>): Promise<{ stdout: string; marker: Marker }> {
  const { stdout } = await exec('python3', [SCRIPT, JSON.stringify(arg)], { cwd });
  const markerLine = stdout.trim().split('\n').pop()!;
  expect(markerLine.startsWith('__ITEST_ARTIFACTS__ ')).toBe(true);
  const marker = JSON.parse(markerLine.slice('__ITEST_ARTIFACTS__ '.length));
  return { stdout, marker: Array.isArray(marker) ? marker[0] : marker };
}

describe('export_cases.py', () => {
  it('docx：表格式表格 + 三行步骤多段落 + 下载标记', async () => {
    const payload = await buildPayloadFile();
    const cwd = await mkdtemp(path.join(tmpdir(), 'itest-out-'));
    const { stdout, marker } = await runScript(cwd, { payload, format: 'docx' });
    expect(stdout).toContain('2 条用例');
    expect(marker.count).toBe(2);
    expect(marker.name).toMatch(/^V2\.3-用例-\d{8}-\d{6}\.docx$/);
    expect(marker.path).toBe(`.out/${marker.name}`);
    const file = path.join(cwd, marker.path);
    const buf = await readFile(file);
    expect(buf.subarray(0, 2).toString()).toBe('PK'); // 合法 zip
    const doc = await zipEntry(file, 'word/document.xml');
    for (const label of ['用例名称', '所属分组', '预置条件', '测试步骤', '预期结果']) {
      expect(doc).toContain(label);
    }
    // 两个分组、两条用例、两行步骤都在正文里
    expect(doc).toContain('登录模块');
    expect(doc).toContain('告警管理');
    expect(doc).toContain('验证登录成功');
    expect(doc).toContain('口令错误登录失败');
    expect(doc).toContain('1. 打开登录页');
    expect(doc).toContain('2. 输入正确账号口令');
  }, 30000);

  it('xmind：双格式条目齐全 + content.json 层级正确 + title 覆盖根标题', async () => {
    const payload = await buildPayloadFile();
    const cwd = await mkdtemp(path.join(tmpdir(), 'itest-out-'));
    const { marker } = await runScript(cwd, { payload, format: 'xmind', title: '评审材料' });
    expect(marker.name).toMatch(/^评审材料-用例-\d{8}-\d{6}\.xmind$/);
    const file = path.join(cwd, marker.path);
    const names = (await exec('python3', ['-c', 'import zipfile,sys;print(" ".join(zipfile.ZipFile(sys.argv[1]).namelist()))', file])).stdout.trim().split(/\s+/);
    expect(names.sort()).toEqual(['content.json', 'content.xml', 'manifest.json', 'metadata.json']);
    const sheets = JSON.parse(await zipEntry(file, 'content.json')) as Array<{ rootTopic: {
      title: string;
      structureClass?: string;
      children?: { attached: Array<{ title: string }> };
    } }>;
    expect(sheets).toHaveLength(1);
    const root = sheets[0]!.rootTopic;
    expect(root.title).toBe('评审材料');
    expect(root.structureClass).toBe('org.xmind.ui.logic.right');
    const groups = root.children!.attached;
    expect(groups.map((g) => g.title).sort()).toEqual(['告警管理', '登录模块']);
    const docXml = await zipEntry(file, 'content.xml');
    expect(docXml).toContain('<xmap-content');
    expect(docXml.match(/<topic /g)?.length).toBe(docXml.match(/<\/topic>/g)?.length);
  }, 30000);

  it('format 非法：明确报错非 0 退出', async () => {
    const payload = await buildPayloadFile();
    const cwd = await mkdtemp(path.join(tmpdir(), 'itest-out-'));
    await expect(exec('python3', [SCRIPT, JSON.stringify({ payload, format: 'pdf' })], { cwd })).rejects.toThrow(/format/);
  });

  it('payload 文件不存在：明确报错非 0 退出', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'itest-out-'));
    await expect(exec('python3', [SCRIPT, JSON.stringify({ payload: '/tmp/itest-export-payload-not-exist.json', format: 'docx' })], { cwd }))
      .rejects.toThrow(/payload/);
  });

  it('SKILL.md frontmatter：name=export-cases 且 description 非空', async () => {
    const md = await readFile(path.join(CONTENT, 'SKILL.md'), 'utf8');
    expect(md).toMatch(/^---\nname: export-cases\ndescription: \S/);
  });
});
