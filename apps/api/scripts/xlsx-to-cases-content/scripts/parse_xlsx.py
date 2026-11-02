#!/usr/bin/env python3
"""xlsx 结构化解析器（xlsx-to-cases 技能专用；零第三方依赖：zipfile + xml.etree）。

用法：
  parse_xlsx.py <path>                        # outline：sheet 清单/行列数/表头预览/合并单元格数
  parse_xlsx.py <path> --sheet N              # 第 N 个 sheet 的数据行（0 起，N 取 outline 里的 i）
  parse_xlsx.py <path> --sheet N --rows A:B   # 第 N 个 sheet 的第 A..B 行（含端点；行号=Excel 行号，1 起，与返回 rows[].r 对齐）

输出：stdout 单行紧凑 JSON。分段取内容天然避开 run_skill_script 的 100KB 输出上限。

口径说明：
- sheet 顺序经 xl/_rels/workbook.xml.rels 的 rId 解析，不假设 sheetN.xml 与顺序一致。
- 日期不换算：Excel 日期在 XML 里是 1900 纪元序列值，原样输出（SKILL.md 已提示模型）。
- 合并单元格只有左上有值，其余为空；outline 报告 merged 数。
- 公式 cell 输出缓存值；无缓存值给 [formula] 占位，不输出公式原文。

zip bomb 防护：zip 条目数与总展开量（infolist 声明值，读前判断）上限，超限退出码 1。
阈值可用环境变量覆写（测试用）：XLSX_MAX_ENTRIES / XLSX_MAX_TOTAL_BYTES。
"""
import argparse
import json
import os
import sys
import xml.etree.ElementTree as ET
import zipfile

M = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
PR = '{http://schemas.openxmlformats.org/package/2006/relationships}'
WORKBOOK = 'xl/workbook.xml'
RELS = 'xl/_rels/workbook.xml.rels'
SHARED = 'xl/sharedStrings.xml'
MAX_ENTRIES = int(os.environ.get('XLSX_MAX_ENTRIES', '2000'))
MAX_TOTAL_BYTES = int(os.environ.get('XLSX_MAX_TOTAL_BYTES', str(200 * 1024 * 1024)))
# 单次输出护栏：防一个大 sheet 把 stdout 撑爆（run_skill_script 100KB 上限）。
MAX_CELL_CHARS = 200
MAX_ROWS_OUT = 1000
HEADER_PREVIEW_CELLS = 12
HEADER_PREVIEW_CHARS = 60


def fail(msg):
    print(json.dumps({'ok': False, 'error': msg}, ensure_ascii=False))
    sys.exit(1)


def load_zip(path):
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        fail('not a valid zip/xlsx: %s' % path)
    infos = z.infolist()
    if len(infos) > MAX_ENTRIES:
        fail('zip entries %d > %d' % (len(infos), MAX_ENTRIES))
    total = sum(i.file_size for i in infos)
    if total > MAX_TOTAL_BYTES:
        fail('zip uncompressed size %d > %d (zip bomb?)' % (total, MAX_TOTAL_BYTES))
    return z


def col_num(ref):
    """'BC3' → 列号 55（1 起）。只取前导字母。"""
    n = 0
    for ch in ref:
        if 'a' <= ch <= 'z':
            n = n * 26 + (ord(ch) - 96)
        elif 'A' <= ch <= 'Z':
            n = n * 26 + (ord(ch) - 64)
        else:
            break
    return n


def load_shared_strings(z):
    """sharedStrings.xml → {序号: 文本}。<si> 可能是单 <t> 或多个 <r>/<t> run。"""
    out = {}
    try:
        root = ET.fromstring(z.read(SHARED))
    except (KeyError, ET.ParseError):
        return out
    for i, si in enumerate(root.findall(M + 'si')):
        out[i] = ''.join(t.text or '' for t in si.iter(M + 't'))
    return out


def resolve_sheet_paths(z):
    """workbook.xml 的 sheet 清单（顺序）+ rels 的 rId → 内部路径。
    返回 [(name, state, target)]；rels 缺失/无对应条目 → 报错（乱序 rId 的正确性关键）。"""
    try:
        wb = ET.fromstring(z.read(WORKBOOK))
    except (KeyError, ET.ParseError):
        fail('missing or malformed %s' % WORKBOOK)
    rels = {}
    try:
        rel_root = ET.fromstring(z.read(RELS))
        for rel in rel_root.findall(PR + 'Relationship'):
            if rel.get('TargetMode') == 'External':
                continue
            target = rel.get('Target', '').lstrip('/')
            if not target.startswith('xl/'):
                target = 'xl/' + target
            rels[rel.get('Id', '')] = target
    except KeyError:
        fail('missing %s' % RELS)
    sheets = []
    for sh in wb.iter(M + 'sheet'):
        rid = sh.get(R + 'id')
        target = rels.get(rid) if rid else None
        if not target:
            fail('sheet %r rId=%s not found in rels' % (sh.get('name'), rid))
        sheets.append((sh.get('name') or '(unnamed)', sh.get('state') or 'visible', target))
    if not sheets:
        fail('no sheets in %s' % WORKBOOK)
    return sheets


def cell_text(c, shared):
    """cell → 文本。t: s=sharedString / inlineStr / b=布尔 / str=公式字符串结果 / e=错误 / n=数值。"""
    t = c.get('t', 'n')
    if t == 'inlineStr':
        is_el = c.find(M + 'is')
        if is_el is None:
            return ''
        return ''.join(tel.text or '' for tel in is_el.iter(M + 't'))[:MAX_CELL_CHARS]
    v = c.find(M + 'v')
    raw = v.text if v is not None else None
    if t == 's':
        try:
            return shared.get(int(raw), '')[:MAX_CELL_CHARS] if raw is not None else ''
        except ValueError:
            return ''
    if t == 'b':
        return 'TRUE' if raw == '1' else 'FALSE'
    if raw is None:
        return '[formula]' if c.find(M + 'f') is not None else ''
    return raw[:MAX_CELL_CHARS]


def load_sheet_rows(z, target, shared):
    """sheet XML → {行号: {列号: 文本}}（稀疏字典）+ 合并单元格数。跳过无 <v>/<is> 的 cell。"""
    try:
        root = ET.fromstring(z.read(target))
    except (KeyError, ET.ParseError):
        fail('missing or malformed %s' % target)
    rows = {}
    for row in root.iter(M + 'row'):
        try:
            rnum = int(row.get('r', '0'))
        except ValueError:
            continue
        cells = {}
        fallback_col = 0
        for c in row.findall(M + 'c'):
            ref = c.get('r')
            col = col_num(ref) if ref else fallback_col + 1
            fallback_col = col
            if col <= 0:
                continue
            text = cell_text(c, shared)
            if text != '':
                cells[col] = text
        if cells:
            rows[rnum] = cells
    merged = root.find(M + 'mergeCells')
    merged_count = int(merged.get('count', '0')) if merged is not None else 0
    return rows, merged_count


def dense(cells):
    """稀疏列字典 → 尾随空裁掉的密集数组（空洞补空串对齐列）。"""
    if not cells:
        return []
    out = [cells.get(i, '') for i in range(1, max(cells) + 1)]
    while out and out[-1] == '':
        out.pop()
    return out


def sheet_brief(rows):
    """数据行号清单 + 全表最大列数。"""
    nums = sorted(rows)
    max_col = 0
    for cells in rows.values():
        if cells:
            max_col = max(max_col, max(cells))
    return nums, max_col


def outline(path):
    z = load_zip(path)
    shared = load_shared_strings(z)
    sheets = resolve_sheet_paths(z)
    out = []
    for i, (name, state, target) in enumerate(sheets):
        rows, merged = load_sheet_rows(z, target, shared)
        nums, max_col = sheet_brief(rows)
        header = []
        if nums:
            header = dense(rows[nums[0]])[:HEADER_PREVIEW_CELLS]
            header = [h[:HEADER_PREVIEW_CHARS] for h in header]
        out.append({
            'i': i,
            'name': name,
            'rows': len(nums),
            'cols': max_col,
            'hidden': state != 'visible',
            'merged': merged,
            'firstRow': nums[0] if nums else None,
            'header': header,
        })
    return {
        'ok': True,
        'mode': 'outline',
        'stats': {'sheets': len(out)},
        'sheets': out,
    }


def sheet_content(path, n, rows_range):
    z = load_zip(path)
    shared = load_shared_strings(z)
    sheets = resolve_sheet_paths(z)
    if n < 0 or n >= len(sheets):
        fail('sheet index %d out of range (0..%d)' % (n, len(sheets) - 1))
    name, _state, target = sheets[n]
    rows, merged = load_sheet_rows(z, target, shared)
    nums, _max_col = sheet_brief(rows)
    if rows_range is not None:
        a, b = rows_range
        nums = [rn for rn in nums if a <= rn <= b]
    rows_out = [{'r': rn, 'c': dense(rows[rn])} for rn in nums[:MAX_ROWS_OUT]]
    return {
        'ok': True,
        'mode': 'sheet',
        'sheet': n,
        'name': name,
        'totalRows': len(nums),
        'merged': merged,
        'truncated': len(nums) > MAX_ROWS_OUT,
        'rows': rows_out,
    }


def parse_rows_range(raw):
    if ':' not in raw:
        fail('--rows expects A:B (e.g. 1:200)')
    try:
        a, b = (int(p) for p in raw.split(':', 1))
    except ValueError:
        fail('--rows expects integer A:B')
    if a < 1 or b < a:
        fail('--rows expects 1 <= A <= B')
    return a, b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--sheet', type=int, default=None)
    ap.add_argument('--rows', default=None)
    args = ap.parse_args()
    if not os.path.isfile(args.path):
        fail('file not found: %s' % args.path)
    if args.rows is not None and args.sheet is None:
        fail('--rows requires --sheet')
    rows_range = parse_rows_range(args.rows) if args.rows is not None else None
    out = outline(args.path) if args.sheet is None else sheet_content(args.path, args.sheet, rows_range)
    print(json.dumps(out, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
