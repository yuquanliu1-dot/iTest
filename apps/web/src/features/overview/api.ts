import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../../api/client';

export type Range = '7d' | '30d';

export interface OverviewResponse {
  kpi: {
    totalCases: number;
    totalPlans: number;
    passRate: number;
    totalRuns7d: number;
    aiCalls7d: number;
  };
  trend: Array<{ date: string; passed: number; failed: number; total: number }>;
  topFailures: Array<{
    caseId: string;
    caseTitle: string;
    failureCount: number;
    lastFailureAt: string;
  }>;
  priorityDistribution: Array<{
    priority: 'urgent' | 'high' | 'medium' | 'low';
    count: number;
  }>;
  plans: Array<{
    id: string;
    name: string;
    lastStatus: 'passed' | 'failed' | 'running' | 'queued' | null;
    lastRunAt: string | null;
    passRate: number;
    totalCases: number;
  }>;
  recordingActivity: Array<{ kind: string; count: number }>;
  aiActivity: Array<{ date: string; casesGenerated: number; stepsGenerated: number }>;
  recentRuns: Array<{
    id: string;
    caseId: string;
    caseTitle: string;
    status: string;
    durationMs: number | null;
    createdAt: string;
    kind: 'case' | 'plan';
  }>;
}

export function overviewQueryKey(projectId: string, range: Range) {
  return ['overview', projectId, range] as const;
}

export function useOverviewQuery(
  projectId: string | undefined,
  range: Range,
): UseQueryResult<OverviewResponse> {
  return useQuery({
    queryKey: overviewQueryKey(projectId ?? '', range),
    queryFn: () => api.projects.overview(projectId!, range),
    enabled: !!projectId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}