/**
 * 文档附件 adapter（.docx/.xlsx）：选文件即预上传（POST /assistant/versions/:id/attachments），
 * send() 把服务端签发的引用标签作为**文本部件**返回。
 *
 * 为什么是文本部件而不是 image 部件/dataURL：react-pi 的 ThreadController 会把附件的
 * 文本部件拍平进消息正文（buildPiSendInput，ThreadController.js:82-94），于是
 * 「乐观消息 == pi 会话记录 == SSE 回放」逐字一致——userContentKey 对账匹配、无重复
 * 气泡。后端任何对消息文本的改写都会破坏这一不变量，见 spec 2026-11-03。
 *
 * 上传在 add() 即刻开始（后台 Promise）；失败在 send() 统一抛出——消息不发出、错误可见。
 * 服务端按 X-Filename 扩展名分派类型；本 adapter 不解析内容。
 */
import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from '@assistant-ui/react';
import { api } from '../../api/client';
import { buildUploadedFileTag } from './uploadedFileTag';

const FILE_MAX_BYTES = 10 * 1024 * 1024;
const WORDPROCESSINGML_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SPREADSHEETML_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** accept 四值齐备：部分环境只认扩展名、部分只认 mime。 */
const FILE_ACCEPT = [
  '.docx', '.xlsx',
  WORDPROCESSINGML_MIME,
  SPREADSHEETML_MIME,
].join(',');

export interface FileAdapterLabels {
  tooLarge: string;
}

function genId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 浏览器对拖拽/部分场景给空 file.type——按扩展名补 mime，兜底 octet-stream。 */
function mimeOf(name: string, type: string): string {
  if (type) return type;
  if (/\.docx$/i.test(name)) return WORDPROCESSINGML_MIME;
  if (/\.xlsx$/i.test(name)) return SPREADSHEETML_MIME;
  return 'application/octet-stream';
}

export class FileAttachmentAdapter implements AttachmentAdapter {
  accept = FILE_ACCEPT;
  /** attachmentId → 进行中的上传 Promise；remove() 时丢弃，send() 时 await。 */
  private uploads = new Map<string, Promise<unknown>>();

  constructor(
    private versionId: string,
    private labels: FileAdapterLabels,
  ) {}

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    if (file.size > FILE_MAX_BYTES) {
      throw new Error(`${this.labels.tooLarge}（${(file.size / 1024 / 1024).toFixed(1)}MB）`);
    }
    const id = genId();
    this.uploads.set(id, api.assistantAttachments.uploadAttachment(this.versionId, file));
    return {
      id,
      type: 'document',
      name: file.name,
      contentType: mimeOf(file.name, file.type),
      file,
      // 与 SimpleImageAttachmentAdapter 同款状态：composer 直接可发送，send() 内 await 上传。
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const pending = this.uploads.get(attachment.id);
    let r: Awaited<ReturnType<typeof api.assistantAttachments.uploadAttachment>>;
    if (pending) {
      this.uploads.delete(attachment.id);
      r = await pending as typeof r; // 上传失败在此抛出：消息不发出
    } else {
      // add 阶段的上传已被清理（remove 后仍发送等极端时序）——同步补传兜底。
      r = await api.assistantAttachments.uploadAttachment(this.versionId, attachment.file!);
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
