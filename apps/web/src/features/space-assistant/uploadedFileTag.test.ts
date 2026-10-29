import { describe, it, expect } from 'vitest';
import { splitUploadedFileTags, buildUploadedFileTag, UPLOADED_FILE_TAG_RE } from './uploadedFileTag';

describe('splitUploadedFileTags', () => {
  it('无标签：原样单段返回', () => {
    expect(splitUploadedFileTags('普通消息')).toEqual(['普通消息']);
  });
  it('标签在末尾：切成 [正文, meta]', () => {
    const out = splitUploadedFileTags('请生成用例\n<uploaded-file name="需求.docx" path="/a/b.docx" chars="42"/>');
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('请生成用例');
    expect(out[1]).toEqual({ name: '需求.docx', path: '/a/b.docx', chars: '42' });
  });
  it('多个标签与夹缝文本：顺序保留', () => {
    const out = splitUploadedFileTags(
      '<uploaded-file name="a.docx" path="/a" chars="1"/>中间<uploaded-file name="b.docx" path="/b" chars="unknown"/>',
    );
    expect(out).toEqual([
      { name: 'a.docx', path: '/a', chars: '1' },
      '中间',
      { name: 'b.docx', path: '/b', chars: 'unknown' },
    ]);
  });
});

describe('buildUploadedFileTag', () => {
  it('构造自闭合标签；chars=null → unknown；文件名双引号转义', () => {
    expect(buildUploadedFileTag('需求.docx', '/a/b.docx', 42))
      .toBe('<uploaded-file name="需求.docx" path="/a/b.docx" chars="42"/>');
    expect(buildUploadedFileTag('带"引号".docx', '/a', null))
      .toBe('<uploaded-file name="带&quot;引号&quot;.docx" path="/a" chars="unknown"/>');
  });
  it('构造出的标签能被解析正则吃回（round-trip）', () => {
    const tag = buildUploadedFileTag('x.docx', '/p', 7);
    expect(UPLOADED_FILE_TAG_RE.test(tag)).toBe(true);
    expect(splitUploadedFileTags(tag)).toEqual([{ name: 'x.docx', path: '/p', chars: '7' }]);
  });
});
