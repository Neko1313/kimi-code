import { runPlan, type EngineDeps, type RunRecord } from './engine.ts';
import { parsePlan } from './plan.ts';

type RuntimeApi = {
  readonly pluginId: string;
  readonly log: { info(message: string): void; warn(message: string): void };
  readonly store: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  readonly process: {
    run(
      args: readonly string[],
      options: { timeoutMs?: number; cwd?: string; input?: string },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
};

type EventPayload = {
  readonly event: string;
  readonly data: Record<string, unknown>;
};

const PLAN_PREFIX = '/workflow run ';

function engineDeps(api: RuntimeApi): EngineDeps {
  const runsKey = (planName: string): string => `workflow.${planName}.runs`;
  let saveQueue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    saveQueue = saveQueue.then(task, task);
    return saveQueue;
  };
  return {
    run: (args, options) => api.process.run(args, options),
    log: (message) => {
      api.log.info(message);
    },
    loadRuns: async (planName) => {
      const stored = await api.store.get<RunRecord[]>(runsKey(planName));
      return stored ?? [];
    },
    saveRun: (planName, record) =>
      enqueue(async () => {
        const stored = (await api.store.get<RunRecord[]>(runsKey(planName))) ?? [];
        stored.push(record);
        await api.store.set(runsKey(planName), stored);
      }),
  };
}

export function register(on: (event: string, matcher: string, handler: (api: RuntimeApi, event: EventPayload, next: (e?: EventPayload) => unknown) => unknown) => void): void {
  on('UserPromptSubmit', '^/workflow', async (api, event, next) => {
    const prompt = textOf(event.data['prompt']);
    if (prompt === undefined) return next();

    if (prompt.startsWith(PLAN_PREFIX)) {
      await handleRun(api, prompt.slice(PLAN_PREFIX.length));
      return { block: 'workflow executed (see logs); prompt consumed' };
    }
    if (prompt.startsWith('/workflow status ')) {
      await handleStatus(api, prompt.slice('/workflow status '.length));
      return { block: 'workflow status printed (see logs)' };
    }
    return next();
  });
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value;
}

async function handleRun(api: RuntimeApi, planJson: string): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(planJson);
  } catch {
    api.log.warn('workflow: plan is not valid JSON');
    return;
  }
  const { plan, issues } = parsePlan(raw);
  if (plan === undefined) {
    for (const issue of issues) {
      api.log.warn(`workflow plan issue at ${issue.path}: ${issue.message}`);
    }
    return;
  }
  api.log.info(`workflow "${plan.name}": starting (${plan.stages.length} stage(s))`);
  const started = Date.now();
  const result = await runPlan(plan, engineDeps(api));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  for (const stage of result.stages) {
    const okCount = stage.records.filter((r) => r.exitCode === 0).length;
    api.log.info(
      `workflow "${plan.name}" stage ${stage.stageId}: ${okCount}/${stage.records.length} ok, failed: [${stage.failedItems.join(', ')}]`,
    );
  }
  api.log.info(
    `workflow "${plan.name}": ${result.ok ? 'completed' : 'finished with failures'} in ${seconds}s`,
  );
}

async function handleStatus(api: RuntimeApi, planName: string): Promise<void> {
  const name = planName.trim();
  const runs = (await api.store.get<RunRecord[]>(`workflow.${name}.runs`)) ?? [];
  if (runs.length === 0) {
    api.log.info(`workflow "${name}": no recorded runs`);
    return;
  }
  const ok = runs.filter((r) => r.exitCode === 0).length;
  api.log.info(`workflow "${name}": ${ok}/${runs.length} item-runs ok`);
  for (const run of runs) {
    api.log.info(`  ${run.stageId} #${run.round} ${run.item}: exit ${run.exitCode}`);
  }
}
