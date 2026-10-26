import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../../api/client';

export type Range = '7d' | '30d';

export interface OverviewResponse {
  kpi: {
    totalCases: number;
    totalPlans: number;
    passRate: number;
    firstPassRate: number;
    totalRuns7d: number;
    aiCalls7d: number;
    aiHealedReports7d: number;
    p95DurationMs: number | null;
    solidifyRate: number;
    solidifyPendingSteps: number;
    solidifyPendingAiTasks: number;
  };
  trend: Array<{
    date: string;
    passed: number;
    firstPassed: number;
    failed: number;
    total: number;
  }>;
  topFailures: Array<{
    caseId: string;
    caseTitle: string;
    failureCount: number;
    totalRuns: number;
    lastFailureAt: string;
    flakySuspected: boolean;
  }>;
  executions: { passed: number; failed: number; blocked: number; healed: number };
  rca: {
    analyzed: number;
    highConfidence: number;
    byCategory: { case_issue: number; environment: number; system_defect: number; other: number };
  };
  coverage: {
    totalRequirements: number;
    linkedRequirements: number;
    uncoveredRequirements: number;
    linkedCases: number;
    totalCases: number;
    byCoverageType: Record<string, number>;
  };
  plans: Array<{
    id: string;
    name: string;
    lastStatus: 'passed' | 'failed' | 'running' | 'queued' | null;
    lastRunAt: string | null;
    passRate: number;
    totalCases: number;
    lastRcaCategory: string | null;
    triggeredBy: 'manual' | 'schedule' | null;
  }>;
  schedules: { enabledCount: number };
  recordingActivity: Array<{ kind: string; count: number }>;
  aiUsage: Array<{ date: string; calls: number; healedSteps: number }>;
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