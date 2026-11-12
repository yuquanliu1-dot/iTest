/**
 * Document attachment adapter (.docx/.xlsx): selecting a file pre-uploads it immediately (POST /assistant/versions/:id/attachments);
 * send() returns the server-issued reference tag as a **text part**.
 *
 * Why a text part instead of an image part/dataURL: react-pi's ThreadController flattens the attachment
 * text part into the message body (buildPiSendInput, ThreadController.js:82-94), so
 * "optimistic message == pi session record == SSE replay" match verbatim — userContentKey reconciliation matches and there are no
 * duplicate bubbles. Any backend rewrite of message text would break this invariant; see spec 2026-11-03.
 *
 * The upload starts immediately in add() (a background Promise); failures are thrown uniformly in send() — the message isn't sent and the error is visible.
 * The server dispatches the type by the X-Filename extension; this adapter doesn't parse content.
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

/** All four accept values present: some environments only recognize the extension, some only the mime. */
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

/** Browsers give an empty file.type for drag-and-drop/some scenarios — fill in the mime by extension, falling back to octet-stream. */
function mimeOf(name: string, type: string): string {
  if (type) return type;
  if (/\.docx$/i.test(name)) return WORDPROCESSINGML_MIME;
  if (/\.xlsx$/i.test(name)) return SPREADSHEETML_MIME;
  return 'application/octet-stream';
}

export class FileAttachmentAdapter implements AttachmentAdapter {
  accept = FILE_ACCEPT;
  /** attachmentId → in-flight upload Promise; discarded on remove(), awaited in send(). */
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
      // Same state as SimpleImageAttachmentAdapter: the composer can send directly; send() awaits the upload.
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const pending = this.uploads.get(attachment.id);
    let r: Awaited<ReturnType<typeof api.assistantAttachments.uploadAttachment>>;
    if (pending) {
      this.uploads.delete(attachment.id);
      r = await pending as typeof r; // an upload failure throws here: the message isn't sent
    } else {
      // The add-phase upload was already cleaned up (extreme timings like send-after-remove) — synchronous re-upload fallback.
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
