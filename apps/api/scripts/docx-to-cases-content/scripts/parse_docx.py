#!/usr/bin/env python3
"""docx 结构化解析器（docx-to-cases 技能专用；零第三方依赖：zipfile + xml.etree）。

用法：
  parse_docx.py <path>                      # outline：顶层章节骨架 + 表格形状 + stats
  parse_docx.py <path> --section N          # 第 N 个顶层章节的完整内容（0 起）
  parse_docx.py <path> --section N --sub M  # 顶层章节 N 下第 M 个子章节（0 起）

输出：stdout 单行紧凑 JSON。分段取内容天然避开 run_skill_script 的 100KB 输出上限
（.out/ 目录被 read_skill 文件树排除——点开头目录不进树，写文件回读不可行）。

zip bomb 防护：zip 条目数与总展开量（infolist 声明值，读前判断）上限，超限退出码 1。
阈值可用环境变量覆写（测试用）：DOCX_MAX_ENTRIES / DOCX_MAX_TOTAL_BYTES。
"""
import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
DOCXML = 'word/document.xml'
STYLES = 'word/styles.xml'
MAX_ENTRIES = int(os.environ.get('DOCX_MAX_ENTRIES', '2000'))
MAX_TOTAL_BYTES = int(os.environ.get('DOCX_MAX_TOTAL_BYTES', str(200 * 1024 * 1024)))
# 单条输出护栏：防一章把 stdout 撑爆。
MAX_CELL_CHARS = 500
MAX_PARA_CHARS = 4000
MAX_TABLE_ROWS = 200


def fail(msg):
    print(json.dumps({'ok': False, 'error': msg}, ensure_ascii=False))
    sys.exit(1)


def load_zip(path):
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        fail('not a valid zip/docx: %s' % path)
    infos = z.infolist()
    if len(infos) > MAX_ENTRIES:
        fail('zip entries %d > %d' % (len(infos), MAX_ENTRIES))
    total = sum(i.file_size for i in infos)
    if total > MAX_TOTAL_BYTES:
        fail('zip uncompressed size %d > %d (zip bomb?)' % (total, MAX_TOTAL_BYTES))
    return z


def style_levels(z):
    """styleId → 标题级别。按 styles.xml 的 name 匹配「heading N / 标题 N」（两种惯例都收）。"""
    out = {}
    try:
        root = ET.fromstring(z.read(STYLES))
    except (KeyError, ET.ParseError):
        return out
    for st in root.iter(W + 'style'):
        sid = st.get(W + 'styleId')
        nm = st.find(W + 'name')
        name = (nm.get(W + 'val') if nm is not None else '') or ''
        m = re.match(r'^(?:heading|标题)\s*([1-6])$', name.strip(), re.I)
        if sid and m:
            out[sid] = int(m.group(1))
    return out


def para_text(p):
    return ''.join(t.text or '' for t in p.iter(W + 't')).strip()


def table_rows(tbl):
    rows = []
    for tr in tbl.findall(W + 'tr')[:MAX_TABLE_ROWS]:
        cells = []
        for tc in tr.findall(W + 'tc'):
            txt = ' '.join(filter(None, (para_text(p) for p in tc.findall(W + 'p'))))
            cells.append(txt[:MAX_CELL_CHARS])
        rows.append(cells)
    return rows


def parse_blocks(z, levels):
    """文档体 → 块序列：{type:heading,level,text} | {type:para,text} | {type:table,rows}（保序）。"""
    try:
        root = ET.fromstring(z.read(DOCXML))
    except (KeyError, ET.ParseError):
        fail('missing or malformed %s' % DOCXML)
    body = root.find(W + 'body')
    if body is None:
        fail('no body in %s' % DOCXML)
    blocks = []
    for child in body:
        if child.tag == W + 'p':
            text = para_text(child)[:MAX_PARA_CHARS]
            if not text:
                continue
            ps = child.find(W + 'pPr/' + W + 'pStyle')
            sid = ps.get(W + 'val') if ps is not None else None
            lvl = levels.get(sid) if sid else None
            if lvl:
                blocks.append({'type': 'heading', 'level': lvl, 'text': text})
            else:
                blocks.append({'type': 'para', 'text': text})
        elif child.tag == W + 'tbl':
            blocks.append({'type': 'table', 'rows': table_rows(child)})
    return blocks


def build_sections(blocks):
    """顶层章节切分：level<=1 的 heading 开新章（heading 本身即标题，不重复入块）；
    全文无标题 → 单章 title='(untitled)'。"""
    sections = []
    cur = None
    for b in blocks:
        is_top = b['type'] == 'heading' and b['level'] <= 1
        if is_top:
            cur = {'title': b['text'], 'blocks': []}
            sections.append(cur)
        elif cur is None:
            cur = {'title': '(untitled)', 'blocks': []}
            sections.append(cur)
        if not is_top:
            cur['blocks'].append(b)
    return sections


def outline(path):
    z = load_zip(path)
    blocks = parse_blocks(z, style_levels(z))
    sections = build_sections(blocks)
    sec_out = []
    for s in sections:
        sec_out.append({
            'i': len(sec_out),
            'title': s['title'],
            'paras': sum(1 for b in s['blocks'] if b['type'] == 'para'),
            'tables': [
                {'rows': len(t['rows']), 'cols': max((len(r) for r in t['rows']), default=0)}
                for t in s['blocks'] if t['type'] == 'table'
            ],
            'subheadings': [b['text'] for b in s['blocks'] if b['type'] == 'heading'],
        })
    return {
        'ok': True,
        'mode': 'outline',
        'stats': {
            'sections': len(sections),
            'paras': sum(1 for b in blocks if b['type'] == 'para'),
            'tables': sum(1 for b in blocks if b['type'] == 'table'),
            'headings': sum(1 for b in blocks if b['type'] == 'heading'),
        },
        'sections': sec_out,
    }


def section_content(path, n, m):
    z = load_zip(path)
    blocks = parse_blocks(z, style_levels(z))
    sections = build_sections(blocks)
    if n < 0 or n >= len(sections):
        fail('section index %s out of range (0..%d)' % (n, len(sections) - 1))
    title = sections[n]['title']
    blocks = sections[n]['blocks']
    if m is not None:
        # 首个子标题前的导语块不入子章（仍可经 --section N 不带 --sub 全量获取）；
        # sub M 与 outline 的 subheadings[M] 对齐。
        subs = []
        cur = None
        for b in blocks:
            is_sub = b['type'] == 'heading' and b['level'] <= 2
            if is_sub:
                cur = {'title': b['text'], 'blocks': []}
                subs.append(cur)
            elif cur is not None:
                cur['blocks'].append(b)
        if m < 0 or m >= len(subs):
            fail('sub index %s out of range (0..%d)' % (m, len(subs) - 1))
        title = title + ' / ' + subs[m]['title']
        blocks = subs[m]['blocks']
    content = []
    for b in blocks:
        if b['type'] == 'table':
            content.append({'type': 'table', 'rows': b['rows']})
        else:
            content.append({'type': b['type'], 'text': b['text']})
    return {'ok': True, 'mode': 'section', 'section': n, 'sub': m, 'title': title, 'blocks': content}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--section', type=int, default=None)
    ap.add_argument('--sub', type=int, default=None)
    args = ap.parse_args()
    if not os.path.isfile(args.path):
        fail('file not found: %s' % args.path)
    out = outline(args.path) if args.section is None else section_content(args.path, args.section, args.sub)
    print(json.dumps(out, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
