import { useState } from 'react';
import LiveViewImg from './LiveViewImg';
import Button from './ui/Button';

/** 画面卡：live 实时流 + 结束后「回放」按钮（用户决策：不自动播）。
 *  运行中 → 实时画面（无按钮）；运行结束 → 定格最后一帧 + 「回放」按钮；
 *  点回放 → 换成录制回放（?replay=1，从头播一遍播完定格），按钮变「重新回放」；
 *  事后直接打开已结束的页面 → 没有冻帧，只显示「回放」按钮。
 *  key={session} 每次点按钮 +1 强制重挂 <img>，保证回放从头开始。 */
export default function LiveViewCard({
  liveUrl,
  replayUrl,
  running,
}: {
  liveUrl: string;
  replayUrl: string;
  running: boolean;
}) {
  const [replaying, setReplaying] = useState(false);
  const [session, setSession] = useState(0);
  // live 期间挂载过画面，结束后才保留「定格帧」；从未 live（事后浏览）不显示冻帧。
  const [everRan, setEverRan] = useState(running);
  if (running && !everRan) setEverRan(true);

  const showImg = running || everRan || replaying;
  const src = running ? liveUrl : replaying ? replayUrl : liveUrl;
  const mode = running ? 'live' : replaying ? 'replay' : 'frozen';

  return (
    <div className="mb-1.5">
      {showImg && <LiveViewImg key={session} url={src} mode={mode} />}
      {!running && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setReplaying(true);
              setSession((s) => s + 1);
            }}
          >
            {replaying ? '重新回放' : '回放'}
          </Button>
        </div>
      )}
    </div>
  );
}