import { renderArgs, type StageSpec, type WorkflowPlan } from './plan.ts';

export interface RunRecord {
  readonly stageId: string;
  readonly item: string;
  readonly round: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly attempts: number;
}

export interface EngineDeps {
  run(args: readonly string[], options: { timeoutMs?: number; input?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  log(message: string): void;
  loadRuns(planName: string): Promise<readonly RunRecord[]>;
  saveRun(planName: string, record: RunRecord): Promise<void>;
}

export interface StageOutcome {
  readonly stageId: string;
  readonly records: readonly RunRecord[];
  readonly failedItems: readonly string[];
}

export interface EngineResult {
  readonly planName: string;
  readonly stages: readonly StageOutcome[];
  readonly ok: boolean;
}

function itemKey(stageId: string, item: string, round: number): string {
  return `${stageId}${round}${item}`;
}

export async function runPlan(plan: WorkflowPlan, deps: EngineDeps): Promise<EngineResult> {
  const outcomes: StageOutcome[] = [];
  const records: RunRecord[] = [...(await deps.loadRuns(plan.name))];
  let clean = true;

  for (const stage of plan.stages) {
    if (!clean && stage.itemsFrom === undefined) {
      outcomes.push({ stageId: stage.id, records: [], failedItems: [] });
      continue;
    }
    const outcome = await runStage(stage, plan, deps, records);
    outcomes.push(outcome);
    records.push(...outcome.records);
    clean = outcome.failedItems.length === 0;
  }

  return { planName: plan.name, stages: outcomes, ok: clean };
}

async function runStage(
  stage: StageSpec,
  plan: WorkflowPlan,
  deps: EngineDeps,
  records: RunRecord[],
): Promise<StageOutcome> {
  if (stage.type === 'sequential') {
    const record = await executeOnce(stage, plan.name, '(all)', 1, deps);
    return {
      stageId: stage.id,
      records: [record],
      failedItems: record.exitCode === 0 ? [] : ['(all)'],
    };
  }

  let items = resolveItems(stage, records);
  const maxRounds = stage.type === 'loop' ? (stage.maxRounds ?? 5) : 1;
  const all: RunRecord[] = [];
  const failed: string[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    if (items.length === 0) break;
    deps.log(`stage ${stage.id}: round ${round}, ${items.length} item(s)`);
    const roundRecords = await runItems(stage, plan.name, items, round, deps, records);
    all.push(...roundRecords);
    const failedNow = roundRecords.filter((r) => r.exitCode !== 0).map((r) => r.item);
    failed.splice(0, failed.length, ...failedNow);
    items = failedNow;
    if (failedNow.length === 0) break;
    if (stage.type !== 'loop') break;
  }

  return { stageId: stage.id, records: all, failedItems: failed };
}

function resolveItems(stage: StageSpec, records: readonly RunRecord[]): string[] {
  if (stage.items !== undefined) return [...stage.items];
  const ref = stage.itemsFrom;
  if (ref === undefined) return [];
  const [stageId, field] = ref.split('.');
  const source = records.filter((r) => r.stageId === stageId);
  if (field === 'failed') {
    return source.filter((r) => r.exitCode !== 0).map((r) => r.item);
  }
  if (field === 'items') {
    return [...new Set(source.map((r) => r.item))];
  }
  return [];
}

async function runItems(
  stage: StageSpec,
  planName: string,
  items: readonly string[],
  round: number,
  deps: EngineDeps,
  records: RunRecord[],
): Promise<RunRecord[]> {
  const limit = Math.max(1, stage.maxConcurrency ?? 4);
  const results: RunRecord[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item === undefined) break;
      const cached = records.find(
        (r) => itemKey(r.stageId, r.item, r.round) === itemKey(stage.id, item, round) && r.exitCode === 0,
      );
      if (cached !== undefined) {
        deps.log(`stage ${stage.id}: ${item} cached`);
        results.push(cached);
        continue;
      }
      results.push(await executeOnce(stage, planName, item, round, deps));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results.toSorted((a, b) => items.indexOf(a.item) - items.indexOf(b.item));
}

async function executeOnce(
  stage: StageSpec,
  planName: string,
  item: string,
  round: number,
  deps: EngineDeps,
): Promise<RunRecord> {
  const args = [stage.worker.command, ...renderArgs(stage.worker.argsTemplate, item)];
  const attempts = (stage.worker.retries ?? 0) + 1;
  let last = { exitCode: -1, stdout: '', stderr: '' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await deps.run(args, {
      timeoutMs: stage.worker.timeoutMs,
      input: item === '(all)' ? undefined : item,
    });
    if (last.exitCode === 0) break;
    deps.log(`stage ${stage.id}: ${item} attempt ${attempt} failed (${last.exitCode})`);
  }
  const record: RunRecord = {
    stageId: stage.id,
    item,
    round,
    exitCode: last.exitCode,
    stdout: last.stdout,
    attempts,
  };
  await deps.saveRun(planName, record);
  return record;
}
