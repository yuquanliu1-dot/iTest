import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { useUIStore } from '../../stores/ui';
import { Button } from '../ui/shadcn/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';
import Icon from '../Icon';

type RecorderState = 'unknown' | 'ready' | 'update' | 'stale' | 'missing';

const PING_TIMEOUT_MS = 800;
const PING_SOURCE = 'ita-web';
const PONG_SOURCE = 'ita-ext';

/** 简单 semver 比较：0.0.1 < 0.0.2。manifest version 恒为 x.y.z，够用。 */
function versionLt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** 顶栏常驻徽标 + 弹层：探测 Chrome 录制扩展、下载 zip、安装说明。
 *  探测机制：ping/pong。扩展的 content/bridge.js 在收到 ping 时回 {source:'ita-ext',type:'pong',id,version}。
 *  详见 apps/recorder/content/bridge.js。
 *  升级感知：pong 回报的已装版本与 /api/recorder/extension/version 的当前版本对比，
 *  已装较旧时进入 'update' 琥珀态并开放下载按钮——老用户无需留意版本号也能感知有新扩展可装。 */
export default function RecorderExtensionBadge() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const toast = useUIStore((s) => s.showToast);

  const [state, setState] = useState<RecorderState>('unknown');
  const [version, setVersion] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [probeNonce, setProbeNonce] = useState(0);
  const pendingRef = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  // 拉取当前部署版本：pong 回来后好比较。与探测同一次挂载触发，重检测时一并刷新。
  useEffect(() => {
    if (!isAuthenticated) return;
    api.recorder
      .extensionVersion()
      .then((r) => setCurrent(r.version))
      .catch(() => setCurrent(null)); // 拉不到就不比较，保持 ready 不误报升级
  }, [isAuthenticated, probeNonce]);

  const sendPing = useCallback(() => {
    if (!isAuthenticated) return;
    // 旧的还在等就清掉，避免并发 ping 串号
    if (pendingRef.current) {
      clearTimeout(pendingRef.current.timer);
      pendingRef.current = null;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      pendingRef.current = null;
      setState('missing');
      setVersion(null);
    }, PING_TIMEOUT_MS);
    pendingRef.current = { id, timer };
    window.postMessage({ source: PING_SOURCE, type: 'ping', id }, '*');
  }, [isAuthenticated]);

  // mount 时 ping；probeNonce 变化时重 ping（弹层里「重新检测」按钮用）
  useEffect(() => {
    if (!isAuthenticated) return;
    sendPing();
    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current.timer);
        pendingRef.current = null;
      }
    };
  }, [sendPing, isAuthenticated, probeNonce]);

  // 常驻监听 pong。延迟注入（content script 还在 inject 中）也能兜住。
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.source !== PONG_SOURCE || e.data?.type !== 'pong') return;
      const pending = pendingRef.current;
      // 收到不属于自己的 pong（比如旧 ping 的延迟响应）直接忽略
      if (pending && e.data.id !== pending.id) return;
      if (pending) {
        clearTimeout(pending.timer);
        pendingRef.current = null;
      }
      if (e.data.version) {
        // 已装版本是"探测到了扩展"的基态；最终 ready/update 由 effectiveState 按版本比较推出。
        setVersion(e.data.version);
        setState('ready');
      } else {
        // pong 收到但 version 为空 → 扩展刚被重载过，context invalidated
        setState('stale');
        setVersion(null);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // 派生状态：pong 有版本 + 拉到了当前版本 → 比较出 ready 还是 update。
  // state 只存探测阶段的结果（unknown/missing/stale），ready 与 update 由版本比较推算。
  const effectiveState: RecorderState = useMemo(() => {
    if (state === 'missing' || state === 'stale' || state === 'unknown') return state;
    if (version && current) return versionLt(version, current) ? 'update' : 'ready';
    return 'ready'; // current 未拉到时不误报升级
  }, [state, version, current]);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const blob = await api.downloadExtensionZip();
      // 用 Content-Disposition 里的 itest-recorder-v0.0.1.zip；拿不到就回退到通用名
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'itest-recorder.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 给浏览器一点时间触发下载再回收
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setDownloading(false);
    }
  }, [toast]);

  if (!isAuthenticated) return null;

  const dotColor =
    effectiveState === 'ready'
      ? 'var(--success)'
      : effectiveState === 'update'
        ? 'var(--warning)'
        : effectiveState === 'stale'
          ? 'var(--warning)'
          : 'var(--destructive)';
  const label =
    effectiveState === 'ready'
      ? `录制扩展 v${version ?? ''}`
      : effectiveState === 'update'
        ? `扩展可升级 v${current ?? ''}`
        : effectiveState === 'stale'
          ? '录制扩展（连接失效）'
          : '录制扩展（未安装）';

  return (
    <>
      <Button
        variant="outline-ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="录制扩展状态"
        className="h-7 gap-1.5 px-2 text-xs"
      >
        <span
          aria-hidden
          style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }}
        />
        {effectiveState === 'unknown' ? '检测中…' : label}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>录制扩展状态</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4 text-xs/relaxed">
            <StatusRow state={effectiveState} version={version} current={current} onRecheck={() => setProbeNonce((n) => n + 1)} />

            {effectiveState === 'ready' ? (
              <UpdateHint />
            ) : effectiveState === 'update' ? (
              <>
                <p className="text-[11px]" style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}>
                  有新版本扩展可用。下载并覆盖安装后，录制修复与新增能力即刻生效。
                </p>
                <ol className="flex flex-col gap-1 pl-4 text-xs/relaxed" style={{ listStyle: 'decimal' }}>
                  <li>下载新版 <code>itest-recorder.zip</code> 并解压。</li>
                  <li>在 <code>chrome://extensions/</code> 移除旧扩展（点「移除」）。</li>
                  <li>点「加载已解压的扩展程序」→ 选择刚才解压的目录。</li>
                  <li>回到本页面，徽标变为绿色 v{current ?? ''} 即完成升级。</li>
                </ol>
              </>
            ) : (
              <>
                <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                  iTest Web 录制依赖 Chrome 扩展。下载后按下列步骤安装。
                </p>
                <ol className="flex flex-col gap-1 pl-4 text-xs/relaxed" style={{ listStyle: 'decimal' }}>
                  <li>下载并解压 <code>itest-recorder.zip</code> 到一个固定目录。</li>
                  <li>
                    Chrome 地址栏访问 <code>chrome://extensions/</code>。
                  </li>
                  <li>右上角打开「开发者模式」。</li>
                  <li>点「加载已解压的扩展程序」→ 选择刚才解压的目录。</li>
                  <li>回到本页面，徽标变绿即代表已就绪。</li>
                </ol>
                <p className="text-[11px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
                  提示：扩展默认在当前中台域名下注入；若扩展所在机器访问中台的地址与这里不同（例如跨机器访问），
                  可点击扩展图标，在弹窗里把「中台地址」改成实际访问地址后保存。
                </p>
              </>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProbeNonce((n) => n + 1)}
                disabled={effectiveState === 'unknown'}
              >
                <Icon name="refresh" size={12} />
                重新检测
              </Button>
              {effectiveState !== 'ready' && (
                <Button size="sm" onClick={handleDownload} disabled={downloading}>
                  <Icon name="download" size={12} />
                  {downloading ? '打包中…' : '下载扩展 zip'}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StatusRow({
  state,
  version,
  current,
  onRecheck,
}: {
  state: RecorderState;
  version: string | null;
  current: string | null;
  onRecheck: () => void;
}) {
  if (state === 'ready') {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5"
        style={{ background: 'var(--success-soft)', color: 'var(--success)' }}
      >
        <Icon name="check" size={14} />
        <span className="font-medium">已就绪</span>
        {version && <span className="text-[11px]">v{version}</span>}
      </div>
    );
  }
  if (state === 'update') {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5"
        style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
      >
        <Icon name="download" size={14} />
        <span className="font-medium">有新版本</span>
        <span className="text-[11px]">已装 v{version ?? '?'} → v{current ?? '?'}</span>
        <button
          type="button"
          className="ml-auto text-[11px] underline"
          onClick={onRecheck}
        >
          重新检测
        </button>
      </div>
    );
  }
  if (state === 'stale') {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5"
        style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
      >
        <Icon name="warning" size={14} />
        <span className="font-medium">连接已失效</span>
        <button
          type="button"
          className="ml-auto text-[11px] underline"
          onClick={onRecheck}
        >
          重新检测
        </button>
      </div>
    );
  }
  if (state === 'missing') {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5"
        style={{ background: 'var(--destructive-soft)', color: 'var(--destructive)' }}
      >
        <Icon name="plug" size={14} />
        <span className="font-medium">未检测到扩展</span>
        <button
          type="button"
          className="ml-auto text-[11px] underline"
          onClick={onRecheck}
        >
          重新检测
        </button>
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1.5"
      style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
    >
      <Icon name="loader" size={14} />
      <span className="font-medium">检测中…</span>
    </div>
  );
}

function UpdateHint() {
  return (
    <div className="text-[11px] flex flex-col gap-1" style={{ color: 'var(--muted-foreground)' }}>
      <p>已安装的是当前最新版本，无需升级。若扩展行为异常，可在 <code>chrome://extensions/</code> 点「刷新」重载。</p>
      <p>如需重新下载：先卸载当前扩展，再点下方「下载扩展 zip」。备用下载入口：<code>中台地址/api/recorder/extension.zip</code>。</p>
    </div>
  );
}
