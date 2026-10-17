import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Button from '../../../components/ui/Button';
import Icon from '../../../components/Icon';

export default function OverviewEmpty({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { versionId } = useParams<{ versionId: string }>();
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center max-w-md">
        <div className="flex justify-center">
          <Icon name="beaker" size={48} style={{ color: 'var(--muted-foreground)' }} />
        </div>
        <h3 className="text-[16px] font-semibold mt-3" style={{ color: 'var(--foreground)' }}>
          {t('overview:emptyTitle')}
        </h3>
        <p className="text-[12px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
          {t('overview:emptyDescription')}
        </p>
        <div className="flex gap-2 justify-center mt-4">
          <Button onClick={() => navigate(`/p/${projectId}/v/${versionId}/groups`)}>
            {t('overview:goCreateCase')}
          </Button>
          <Button variant="ghost" onClick={() => navigate(`/p/${projectId}/v/${versionId}/plans`)}>
            {t('overview:goCreatePlan')}
          </Button>
        </div>
      </div>
    </div>
  );
}
