/**
 * Reads the extracted text of an assistant attachment (for general Q&A; deep parsing goes through the
 * corresponding skill's python parser on the original file — docx table/heading hierarchy and xlsx sheet
 * structure exist only in the original).
 * Double path validation (confinedPath + the DB row belonging to the current version) guards against cross-version reads.
 */
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { readAssistantAttachmentText } from '../threadAttachments.js';

/** mime → deep-parse pointer for the corresponding skill (shared by tool copy and error guidance). */
function deepParseHint(mime: string | null): string {
  return /spreadsheetml/.test(mime ?? '')
    ? 'file-to-cases 技能的 parse_xlsx.py'
    : 'file-to-cases 技能的 parse_docx.py';
}

export function buildReadThreadAttachmentTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'read_thread_attachment',
    description: '读取用户在对话中上传的 docx/xlsx 附件全文（docx 为服务端 mammoth 提取的纯文本，xlsx 为各 sheet 的管道分隔行文本；均不含完整结构）。path 取用户消息里 <uploaded-file path="…"/> 标签的值。需要表格/标题层级（docx）或 sheet 结构/大表分段（xlsx）时，改用 file-to-cases 技能的 parse_docx.py / parse_xlsx.py 直接解析原件。',
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
    }),
    promptGuidelines: [
      '用户消息里出现 <uploaded-file path="…"/> 标签时，需要附件内容就用 read_thread_attachment 按需读全文；docx 需要表格/标题层级或 xlsx 需要 sheet 结构/分段读大表时，用 file-to-cases 技能的 parse_docx.py / parse_xlsx.py 直接解析原件，不要用本工具替代。',
    ],
    execute: async (input) => {
      const { path } = input as { path: string };
      const hit = await readAssistantAttachmentText(ctx.versionId, path);
      if (!hit) return { ok: false, error: `附件不存在或不属于当前版本: ${path}` };
      if (!hit.row.extractedPath) {
        return { ok: false, error: `该附件文本提取失败（文件可能损坏或加密），可让 ${deepParseHint(hit.row.mime)} 直接解析原件: ${path}` };
      }
      return {
        ok: true,
        data: hit.truncated
          ? `${hit.text}\n\n[已截断至 ${hit.text.length} 字符，全文 ${hit.row.extractedChars} 字符]`
          : hit.text,
      };
    },
  };
}
