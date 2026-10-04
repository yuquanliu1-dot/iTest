import { useEffect, useRef, useState } from 'react';
import { api, type UserSummary } from '../../api/client';

interface Props { onPick: (userId: string) => void }

/**
 * 跨组织搜人。左树固定后，找「不在当前树路径上的人」只能靠它兜底。
 * 命中后直接进用户详情。
 */
export default function GlobalUserSearch({ onPick }: Props) {
  const [input, setInput] = useState('');
  const [results, setResults] = useState<UserSummary[]>([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!input.trim()) { setResults([]); setOpen(false); return; }
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.users.list({ q: input, page: 1, limit: 8 });
        setResults(res.items);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  return (
    <div ref={boxRef} className="shrink-0 relative" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        placeholder="搜索任意用户…"
        className="input-base input-sm"
      />
      {open && (
        <div style={{
          position: 'absolute', left: 16, right: 16, top: '100%', zIndex: 20,
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', maxHeight: 260, overflowY: 'auto',
        }}>
          {results.length === 0 ? (
            <div style={{ padding: 12, textAlign: 'center', fontSize: 12, color: 'var(--muted-foreground)' }}>无匹配</div>
          ) : results.map((u) => (
            <div
              key={u.id}
              onClick={() => { setOpen(false); setInput(''); onPick(u.id); }}
              style={{ padding: '7px 12px', fontSize: 13, cursor: 'pointer', color: 'var(--foreground)' }}
            >
              {u.displayName} <span style={{ color: 'var(--muted-foreground)' }}>@{u.username}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
