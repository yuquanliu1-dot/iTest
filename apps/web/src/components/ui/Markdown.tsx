import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** AI 消息 markdown 渲染：GFM（表格/删除线/任务列表），排版走 .md-body；默认不渲染内嵌 HTML。 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

export default Markdown;
