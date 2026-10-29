/**
 * 读助手 docx 附件的提取文本（一般问答用；skill 深解析走 docx-to-cases 的
 * parse_docx.py 直接读原件——表格结构只有原件里有）。
 * 路径双重校验（confinedPath + DB 行归属当前版本）防跨版本读。
 */
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { readAssistantAttachmentText } from '../threadAttachments.js';

export function buildReadThreadAttachmentTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'read_thread_attachment',
    description: '读取用户在对话中上传的 docx 附件全文（服务端 mammoth 提取的纯文本，不含表格结构）。path 取用户消息里 <uploaded-file path="…"/> 标签的值。需要表格/标题层级时改用 docx-to-cases 技能的 parse_docx.py 直接解析原件。',
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
    }),
    promptGuidelines: [
      '用户消息里出现 <uploaded-file path="…"/> 标签时，需要文档内容就用 read_thread_attachment 按需读全文；需要表格/标题层级时用 docx-to-cases 技能的 parse_docx.py 直接解析原件，不要用本工具替代。',
    ],
    execute: async (input) => {
      const { path } = input as { path: string };
      const hit = await readAssistantAttachmentText(ctx.versionId, path);
      if (!hit) return { ok: false, error: `附件不存在或不属于当前版本: ${path}` };
      if (!hit.row.extractedPath) {
        return { ok: false, error: `该附件文本提取失败（文件可能损坏），可让 docx-to-cases 技能的 parse_docx.py 直接解析原件: ${path}` };
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
