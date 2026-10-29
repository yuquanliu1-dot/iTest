/**
 * docx 附件 adapter：选文件即预上传（POST /assistant/versions/:id/attachments），
 * send() 把服务端签发的引用标签作为**文本部件**返回。
 *
 * 为什么是文本部件而不是 image 部件/dataURL：react-pi 的 ThreadController 会把附件的
 * 文本部件拍平进消息正文（buildPiSendInput，ThreadController.js:82-94），于是
 * 「乐观消息 == pi 会话记录 == SSE 回放」逐字一致——userContentKey 对账匹配、无重复
 * 气泡。后端任何对消息文本的改写都会破坏这一不变量，见 spec 2026-10-29。
 *
 * 上传在 add() 即刻开始（后台 Promise）；失败在 send() 统一抛出——消息不发出、错误可见。
 */
import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from '@assistant-ui/react';
import { api } from '../../api/client';
import { buildUploadedFileTag } from './uploadedFileTag';

const DOCX_MAX_BYTES = 10 * 1024 * 1024;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface DocxAdapterLabels {
  tooLarge: string;
}

function genId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class DocxAttachmentAdapter implements AttachmentAdapter {
  accept = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  /** attachmentId → 进行中的上传 Promise；remove() 时丢弃，send() 时 await。 */
  private uploads = new Map<string, Promise<unknown>>();

  constructor(
    private versionId: string,
    private labels: DocxAdapterLabels,
  ) {}

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    if (file.size > DOCX_MAX_BYTES) {
      throw new Error(`${this.labels.tooLarge}（${(file.size / 1024 / 1024).toFixed(1)}MB）`);
    }
    const id = genId();
    this.uploads.set(id, api.assistantAttachments.uploadDocx(this.versionId, file));
    return {
      id,
      type: 'document',
      name: file.name,
      contentType: file.type || DOCX_MIME,
      file,
      // 与 SimpleImageAttachmentAdapter 同款状态：composer 直接可发送，send() 内 await 上传。
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const pending = this.uploads.get(attachment.id);
    let r: Awaited<ReturnType<typeof api.assistantAttachments.uploadDocx>>;
    if (pending) {
      this.uploads.delete(attachment.id);
      r = await pending as typeof r; // 上传失败在此抛出：消息不发出
    } else {
      // add 阶段的上传已被清理（remove 后仍发送等极端时序）——同步补传兜底。
      r = await api.assistantAttachments.uploadDocx(this.versionId, attachment.file!);
    }
    return {
      ...attachment,
      status: { type: 'complete' },
      content: [{ type: 'text', text: buildUploadedFileTag(r.name, r.path, r.chars) }],
    };
  }

  async remove(attachment: Attachment): Promise<void> {
    this.uploads.delete(attachment.id);
  }
}
