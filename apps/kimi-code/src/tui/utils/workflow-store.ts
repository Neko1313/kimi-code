import { join } from 'node:path';

export interface WorkflowRunItem {
  readonly stageId: string;
  readonly item: string;
  readonly round: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly attempts: number;
}

export interface WorkflowStageGroup {
  readonly stageId: string;
  readonly items: readonly WorkflowRunItem[];
  readonly okCount: number;
}

export interface WorkflowPlanGroup {
  readonly name: string;
  readonly stages: readonly WorkflowStageGroup[];
  readonly ok: boolean;
}

export const WORKFLOW_PLUGIN_STORE_FILE = join('plugin-runtime', 'kimi-workflow.json');

export function resolveWorkflowStorePath(dataDir: string): string {
  return join(dataDir, WORKFLOW_PLUGIN_STORE_FILE);
}

export function parseWorkflowStore(text: string): WorkflowPlanGroup[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const plans: WorkflowPlanGroup[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const prefix = 'workflow.';
    const suffix = '.runs';
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const name = key.slice(prefix.length, key.length - suffix.length);
    if (name.length === 0 || !Array.isArray(value)) continue;
    const items: WorkflowRunItem[] = [];
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      if (
        typeof record['stageId'] !== 'string' ||
        typeof record['item'] !== 'string' ||
        typeof record['exitCode'] !== 'number'
      ) {
        continue;
      }
      items.push({
        stageId: record['stageId'],
        item: record['item'],
        round: typeof record['round'] === 'number' ? record['round'] : 1,
        exitCode: record['exitCode'],
        stdout: typeof record['stdout'] === 'string' ? record['stdout'] : '',
        attempts: typeof record['attempts'] === 'number' ? record['attempts'] : 1,
      });
    }
    const byStage = new Map<string, WorkflowRunItem[]>();
    for (const item of items) {
      const list = byStage.get(item.stageId) ?? [];
      list.push(item);
      byStage.set(item.stageId, list);
    }
    const stages: WorkflowStageGroup[] = [...byStage.entries()].map(([stageId, stageItems]) => ({
      stageId,
      items: stageItems,
      okCount: stageItems.filter((item) => item.exitCode === 0).length,
    }));
    plans.push({
      name,
      stages,
      ok: stages.every((stage) => stage.okCount === stage.items.length),
    });
  }
  return plans;
}

export function countPlanItems(plan: WorkflowPlanGroup): { total: number; ok: number } {
  let total = 0;
  let ok = 0;
  for (const stage of plan.stages) {
    total += stage.items.length;
    ok += stage.okCount;
  }
  return { total, ok };
}
