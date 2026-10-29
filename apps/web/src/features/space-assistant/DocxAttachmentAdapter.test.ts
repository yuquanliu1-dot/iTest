import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  api: {
    assistantAttachments: {
      uploadDocx: vi.fn(),
    },
  },
}));

import { api } from '../../api/client';
import { DocxAttachmentAdapter } from './DocxAttachmentAdapter';

const uploadDocx = vi.mocked(api.assistantAttachments.uploadDocx);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function makeFile(name = '需求规格.docx', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: DOCX_MIME });
}

beforeEach(() => {
  uploadDocx.mockReset();
});

describe('DocxAttachmentAdapter', () => {
  it('add → send：上传一次并把结果拼成引用标签文本部件', async () => {
    uploadDocx.mockResolvedValue({
      name: '需求规格.docx', path: '/data/uploads/assistant/v1/abc.docx',
      chars: 42, size: 1024, sha256: 'abc', deduped: false, extracted: true,
    });
    const ad = new DocxAttachmentAdapter('v1', { tooLarge: 'docx 超过 10MB 上限' });
    const pending = await ad.add({ file: makeFile() });
    expect(pending.name).toBe('需求规格.docx');
    const done = await ad.send(pending);
    expect(uploadDocx).toHaveBeenCalledTimes(1);
    expect(done.status.type).toBe('complete');
    expect(done.content).toEqual([{
      type: 'text',
      text: '<uploaded-file name="需求规格.docx" path="/data/uploads/assistant/v1/abc.docx" chars="42"/>',
    }]);
  });

  it('超过 10MB：add 直接抛错，不发起上传', async () => {
    const ad = new DocxAttachmentAdapter('v1', { tooLarge: 'docx 超过 10MB 上限' });
    await expect(ad.add({ file: makeFile('big.docx', 10 * 1024 * 1024 + 1) }))
      .rejects.toThrow('docx 超过 10MB 上限');
    expect(uploadDocx).not.toHaveBeenCalled();
  });

  it('上传失败：send 抛错（消息不发出的语义）', async () => {
    uploadDocx.mockRejectedValue(new Error('HTTP 413'));
    const ad = new DocxAttachmentAdapter('v1', { tooLarge: 'docx 超过 10MB 上限' });
    const pending = await ad.add({ file: makeFile() });
    await expect(ad.send(pending)).rejects.toThrow('HTTP 413');
  });

  it('remove 丢弃进行中上传后 send 走直传兜底', async () => {
    uploadDocx.mockResolvedValue({
      name: 'a.docx', path: '/p', chars: 1, size: 1, sha256: 's', deduped: false, extracted: true,
    });
    const ad = new DocxAttachmentAdapter('v1', { tooLarge: 'x' });
    const pending = await ad.add({ file: makeFile() });
    await ad.remove(pending);
    await ad.send(pending);
    expect(uploadDocx).toHaveBeenCalledTimes(2); // add 一次 + send 兜底一次
  });
});
