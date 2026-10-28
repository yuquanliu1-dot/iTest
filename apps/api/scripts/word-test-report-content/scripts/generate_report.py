#!/usr/bin/env python3
"""生成 Word 测试报告（.docx）并按平台产物协议输出下载清单。

用法（由 AI 经 run_skill_script 调用，cwd = 技能根）：
  generate_report.py '<报告 JSON>'

报告 JSON schema 见 SKILL.md：{title, period?, sections:[{heading?, paragraphs?, table?}]}。
JSON 经 argv 传入（平台直接 spawn，不经 shell，无需转义），单参上限 ~128KB（Linux
MAX_ARG_STRLEN），报告精简在 100KB 以内即可。

生成策略：优先 python-docx；ImportError 时降级为标准库 zipfile 手写 OOXML（docx 本质是
zip + XML），两条路径产物都能被 Word/WPS/LibreOffice 打开，内容一致。

产物协议：文件写到 .out/ 下，stdout 最后一行打印
  __ITEST_ARTIFACTS__ [{"name":"报告.docx","path":".out/报告.docx"}]
平台据此落库并推送下载卡，用户点击即下载。
"""
import json
import os
import re
import sys
from datetime import datetime
from xml.sax.saxutils import escape

OUT_DIR = ".out"


def fail(msg, code=2):
    print(f"错误：{msg}", file=sys.stderr)
    sys.exit(code)


def load_payload():
    if len(sys.argv) < 2:
        fail("缺少报告 JSON 参数（usage: generate_report.py '<json>'）")
    try:
        data = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        fail(f"报告 JSON 解析失败：{e}")
    if not isinstance(data, dict):
        fail("报告 JSON 顶层必须是对象")
    sections = data.get("sections")
    if not isinstance(sections, list) or not sections:
        fail("报告 JSON 缺少非空 sections 数组")
    title = str(data.get("title") or "").strip()
    if not title:
        fail("报告 JSON 缺少 title")
    return data, title


def out_filename(title):
    stem = re.sub(r'[\\/:*?"<>|\s]+', "-", title).strip("-") or "report"
    return f"{stem}-{datetime.now():%Y%m%d-%H%M}.docx"


def collect_parts(data):
    """归一化 sections：只认 heading(str)/paragraphs(str list)/table({headers,rows})。"""
    parts = []
    for i, sec in enumerate(data["sections"]):
        if not isinstance(sec, dict):
            continue
        heading = str(sec.get("heading") or "").strip()
        paragraphs = [str(p) for p in sec.get("paragraphs") or [] if str(p).strip()]
        table = None
        t = sec.get("table")
        if isinstance(t, dict):
            headers = [str(h) for h in t.get("headers") or []]
            rows = [[str(c) for c in r] for r in t.get("rows") or [] if isinstance(r, (list, tuple))]
            if headers or rows:
                table = {"headers": headers, "rows": rows}
        if heading or paragraphs or table:
            parts.append({"heading": heading, "paragraphs": paragraphs, "table": table})
        elif i == 0:
            fail("sections[0] 内容为空（至少要有 heading/paragraphs/table 其一）")
    if not parts:
        fail("sections 没有可渲染内容")
    period = str(data.get("period") or "").strip()
    return period, parts


# ---------- python-docx 路径 ----------

def write_with_docx(path, title, period, parts):
    from docx import Document

    doc = Document()
    doc.add_heading(title, 0)
    if period:
        doc.add_paragraph(period)
    for part in parts:
        if part["heading"]:
            doc.add_heading(part["heading"], 1)
        for p in part["paragraphs"]:
            doc.add_paragraph(p)
        table = part["table"]
        if table:
            headers, rows = table["headers"], table["rows"]
            ncols = max(len(headers), max((len(r) for r in rows), default=0))
            grid = doc.add_table(rows=1 + len(rows), cols=ncols)
            grid.style = "Table Grid"
            for j, h in enumerate(headers):
                grid.rows[0].cells[j].text = h
            for i, r in enumerate(rows, start=1):
                for j, c in enumerate(r):
                    grid.rows[i].cells[j].text = c
    doc.save(path)


# ---------- 标准库 OOXML 路径（无 python-docx 时的降级） ----------

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def w_paragraph(text, style=None, bold=False):
    pr = ""
    if style:
        pr += f'<w:pStyle w:val="{style}"/>'
    run_pr = "<w:rPr><w:b/></w:rPr>" if bold else ""
    return (
        f'<w:p>{pr}<w:r>{run_pr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'
    )


def w_table(table):
    ncols = max(len(table["headers"]), max((len(r) for r in table["rows"]), default=0)) or 1
    borders = (
        "<w:tblBorders>"
        + "".join(
            f'<w:{side} w:val="single" w:sz="4" w:color="999999"/>'
            for side in ("top", "left", "bottom", "right", "insideH", "insideV")
        )
        + "</w:tblBorders>"
    )
    rows_xml = []
    if table["headers"]:
        cells = "".join(
            f'<w:tc><w:tcPr/><w:p><w:r><w:rPr><w:b/></w:rPr>'
            f'<w:t xml:space="preserve">{escape(h)}</w:t></w:r></w:p></w:tc>'
            for h in table["headers"]
        )
        rows_xml.append(f"<w:tr>{cells}</w:tr>")
    for r in table["rows"]:
        cells = "".join(
            f'<w:tc><w:tcPr/><w:p><w:r><w:t xml:space="preserve">{escape(c)}</w:t></w:r></w:p></w:tc>'
            for c in r
        ) + '<w:tc><w:tcPr/><w:p/></w:tc>' * (ncols - len(r))
        rows_xml.append(f"<w:tr>{cells}</w:tr>")
    return (
        f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>{borders}</w:tblPr>'
        + "".join(rows_xml)
        + "</w:tbl>"
    )


def write_with_zipfile(path, title, period, parts):
    """最小合法 docx：[Content_Types].xml + rels + document.xml + styles.xml。
    styles 只定义 Title/Heading1，让标题有分层外观；正文一律 Normal。"""
    body = [w_paragraph(title, style="Title")]
    if period:
        body.append(w_paragraph(period))
    for part in parts:
        if part["heading"]:
            body.append(w_paragraph(part["heading"], style="Heading1"))
        body.extend(w_paragraph(p) for p in part["paragraphs"])
        if part["table"]:
            body.append(w_table(part["table"]))
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W_NS}"><w:body>'
        + "".join(body)
        + '<w:sectPr/></w:body></w:document>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        "</Types>"
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )
    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        "</Relationships>"
    )
    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:styles xmlns:w="{W_NS}">'
        '<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>'
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>'
        '<w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/></w:rPr></w:style>'
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>'
        '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
        "</w:styles>"
    )
    import zipfile

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("word/document.xml", document)
        z.writestr("word/_rels/document.xml.rels", doc_rels)
        z.writestr("word/styles.xml", styles)


def main():
    data, title = load_payload()
    period, parts = collect_parts(data)

    os.makedirs(OUT_DIR, exist_ok=True)
    fname = out_filename(title)
    path = os.path.join(OUT_DIR, fname)

    try:
        write_with_docx(path, title, period, parts)
        engine = "python-docx"
    except ImportError:
        write_with_zipfile(path, title, period, parts)
        engine = "stdlib-ooxml"

    size = os.path.getsize(path)
    print(f"已生成 {path}（{size} 字节，{len(parts)} 个章节，引擎 {engine}）")
    print(f'__ITEST_ARTIFACTS__ [{{"name":"{fname}","path":"{path}"}}]')


if __name__ == "__main__":
    main()
