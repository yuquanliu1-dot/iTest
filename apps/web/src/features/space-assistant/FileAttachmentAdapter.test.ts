import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  api: {
    assistantAttachments: {
      uploadAttachment: vi.fn(),
    },
  },
}));

import { api } from '../../api/client';
import { FileAttachmentAdapter } from './FileAttachmentAdapter';

const uploadAttachment = vi.mocked(api.assistantAttachments.uploadAttachment);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function makeFile(name = '需求规格.docx', size = 1024, type = DOCX_MIME): File {
  return new File([new Uint8Array(size)], name, { type });
}

beforeEach(() => {
  uploadAttachment.mockReset();
});

describe('FileAttachmentAdapter', () => {
  it('accept 同时声明 docx/xlsx 的扩展名与 mime（部分环境只认其一）', () => {
    const ad = new FileAttachmentAdapter('v1', { tooLarge: '文件超过 10MB 上限' });
    expect(ad.accept.split(',')).toEqual(expect.arrayContaining(['.docx', '.xlsx', DOCX_MIME, XLSX_MIME]));
  });

  it('add → send：上传一次并把结果拼成引用标签文本部件（docx）', async () => {
    uploadAttachment.mockResolvedValue({
      name: '需求规格.docx', path: '/data/uploads/assistant/v1/abc.docx',
      chars: 42, size: 1024, sha256: 'abc', deduped: false, extracted: true,
    });
    const ad = new FileAttachmentAdapter('v1', { tooLarge: '文件超过 10MB 上限' });
    const pending = await ad.add({ file: makeFile() });
    expect(pending.name).toBe('需求规格.docx');
    const done = await ad.send(pending);
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(done.status.type).toBe('complete');
    expect(done.content).toEqual([{
      type: 'text',
      text: '<uploaded-file name="需求规格.docx" path="/data/uploads/assistant/v1/abc.docx" chars="42"/>',
    }]);
  });

  it('xlsx：mime 缺失（拖拽场景）按扩展名补 spreadsheetml，标签拼装同款', async () => {
    uploadAttachment.mockResolvedValue({
      name: '用例矩阵.xlsx', path: '/data/uploads/assistant/v1/def.xlsx',
      chars: 300, size: 2048, sha256: 'def', deduped: false, extracted: true,
    });
    const ad = new FileAttachmentAdapter('v1', { tooLarge: '文件超过 10MB 上限' });
    const pending = await ad.add({ file: makeFile('用例矩阵.xlsx', 2048, '') });
    expect(pending.contentType).toBe(XLSX_MIME);
    const done = await ad.send(pending);
    expect(done.content).toEqual([{
      type: 'text',
      text: '<uploaded-file name="用例矩阵.xlsx" path="/data/uploads/assistant/v1/def.xlsx" chars="300"/>',
    }]);
  });

  it('超过 10MB：add 直接抛错，不发起上传', async () => {
    const ad = new FileAttachmentAdapter('v1', { tooLarge: '文件超过 10MB 上限' });
    await expect(ad.add({ file: makeFile('big.docx', 10 * 1024 * 1024 + 1) }))
      .rejects.toThrow('文件超过 10MB 上限');
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it('上传失败：send 抛错（消息不发出的语义）', async () => {
    uploadAttachment.mockRejectedValue(new Error('HTTP 413'));
    const ad = new FileAttachmentAdapter('v1', { tooLarge: '文件超过 10MB 上限' });
    const pending = await ad.add({ file: makeFile() });
    await expect(ad.send(pending)).rejects.toThrow('HTTP 413');
  });

  it('remove 丢弃进行中上传后 send 走直传兜底', async () => {
    uploadAttachment.mockResolvedValue({
      name: 'a.docx', path: '/p', chars: 1, size: 1, sha256: 's', deduped: false, extracted: true,
    });
    const ad = new FileAttachmentAdapter('v1', { tooLarge: 'x' });
    const pending = await ad.add({ file: makeFile() });
    await ad.remove(pending);
    await ad.send(pending);
    expect(uploadAttachment).toHaveBeenCalledTimes(2); // once in add + once as the send fallback
  });
});
