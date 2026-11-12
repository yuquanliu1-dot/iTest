import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Markdown rendering for AI messages: GFM (tables/strikethrough/task lists), typography via .md-body; embedded HTML is not rendered by default. */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

export default Markdown;
