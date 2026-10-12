import { useEffect, useState } from 'react';
import LiveViewImg from './LiveViewImg';
import Button from './ui/Button';
import Segmented from './ui/Segmented';

/** 回放倍速档位：1x 原速；2/4x 跳看；8x 快速过一遍长录制。 */
const SPEEDS = [1, 2, 4, 8] as const;

/** 画面卡：live 实时流 + 结束后「回放」按钮（用户决策：不自动播）+ 回放倍速。
 *  运行中 → 实时画面（无按钮）；运行结束 → 定格最后一帧 + 「回放」按钮；
 *  点回放 → 换成录制回放（?replay=1，从头播一遍播完定格），按钮变「重新回放」，
 *  同时出现倍速档位；切档位 → 换 URL + key 自增，从头以新倍速重播。
 *  事后直接打开已结束的页面 → 没有冻帧，只显示「回放」按钮。
 *  key={session} 每次切换 src 都强制重挂 <img>，保证回放从头开始。
 *
 *  录制只在服务端内存里（TTL 30min + LRU 6 份 + 进程重启即失），所以结束时先探一次
 *  ?replay=meta：探测中或不可回放就不显示「回放」按钮（避免点下去撞 404）。 */
export default function LiveViewCard({
  liveUrl,
  replayUrl,
  replayMetaUrl,
  running,
}: {
  liveUrl: string;
  /** 带倍速的回放 URL（speed=1 时即普通 replayUrl）。 */
  replayUrl: (speed: number) => string;
  /** 录制可用性探测 URL（?replay=meta）。 */
  replayMetaUrl: string;
  running: boolean;
}) {
  const [replaying, setReplaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [session, setSession] = useState(0);
  // live 期间挂载过画面，结束后才保留「定格帧」；从未 live（事后浏览）不显示冻帧。
  const [everRan, setEverRan] = useState(running);
  if (running && !everRan) setEverRan(true);
  // undefined=未探测（运行中/探测未回来）；true/false=服务端录制是否仍可回放。
  const [replayable, setReplayable] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (running) {
      setReplayable(undefined);
      return;
    }
    let cancelled = false;
    fetch(replayMetaUrl, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((m: { available?: boolean }) => {
        if (!cancelled) setReplayable(!!m?.available);
      })
      .catch(() => {
        if (!cancelled) setReplayable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [replayMetaUrl, running]);

  const showImg = running || everRan || replaying;
  const src = running ? liveUrl : replaying ? replayUrl(speed) : liveUrl;
  const mode = running ? 'live' : replaying ? 'replay' : 'frozen';

  const restart = (s: number) => {
    setSpeed(s);
    setReplaying(true);
    setSession((k) => k + 1);
  };

  return (
    <div className="mb-1.5">
      {showImg && <LiveViewImg key={session} url={src} mode={mode} />}
      {!running && replayable && (
        <div className="flex items-center justify-end gap-1.5">
          {replaying && (
            <Segmented
              value={String(speed)}
              onChange={(v) => restart(Number(v))}
              options={SPEEDS.map((s) => ({ value: String(s), label: `${s}x` }))}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => restart(speed)}
          >
            {replaying ? '重新回放' : '回放'}
          </Button>
        </div>
      )}
    </div>
  );
}