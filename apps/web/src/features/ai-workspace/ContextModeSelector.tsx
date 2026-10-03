import Segmented from '../../components/ui/Segmented';

export type ContextMode = 'repo' | 'page' | 'auto';

interface Props {
  value: ContextMode;
  onChange: (mode: ContextMode) => void;
  hasRepo: boolean;
}

export default function ContextModeSelector({ value, onChange, hasRepo }: Props) {
  return (
    <Segmented<ContextMode>
      options={[
        { value: 'repo', label: '参考源码', disabled: !hasRepo, title: hasRepo ? undefined : '请先到项目设置配置仓库' },
        { value: 'page', label: '抓取页面' },
        { value: 'auto', label: '自动' },
      ]}
      value={value}
      onChange={onChange}
    />
  );
}
