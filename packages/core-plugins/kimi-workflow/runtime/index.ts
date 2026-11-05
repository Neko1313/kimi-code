import { runPlan, type EngineDeps, type EngineResult, type RunRecord } from './engine.ts';
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

const RUN_PREFIX = 'workflow run ';
const STATUS_PREFIX = 'workflow status ';
const PENDING_REL = '.kimi-workflow/pending.json';

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
  on('UserPromptSubmit', '^workflow (run|status) ', async (api, event, next) => {
    const prompt = textOf(event.data['prompt']);
    if (prompt === undefined) return next();

    if (prompt.startsWith(RUN_PREFIX)) {
      const summary = await handleRun(api, prompt.slice(RUN_PREFIX.length));
      return { block: summary };
    }
    if (prompt.startsWith(STATUS_PREFIX)) {
      const summary = await handleStatus(api, prompt.slice(STATUS_PREFIX.length));
      return { block: summary };
    }
    return next();
  });

  on('Stop', async (api, event, next) => {
    const probe = await api.process.run(['cat', PENDING_REL], { cwd: event.cwd });
    if (probe.exitCode !== 0) return next();
    await api.process.run(['rm', '-f', PENDING_REL], { cwd: event.cwd });
    let raw: unknown;
    try {
      raw = JSON.parse(probe.stdout);
    } catch {
      return { block: 'workflow: .kimi-workflow/pending.json is not valid JSON; consumed' };
    }
    const { plan, issues } = parsePlan(raw);
    if (plan === undefined) {
      const lines = issues.map((issue) => `plan issue at ${issue.path}: ${issue.message}`);
      return { block: ['workflow: pending plan invalid', ...lines].join('\n') };
    }
    api.log.info(`workflow "${plan.name}": starting (${plan.stages.length} stage(s)) from pending file`);
    const result = await runPlan(plan, engineDeps(api));
    return { block: renderResult(result) };
  });
}

type TextPartLike = { readonly type: string; readonly text?: string };

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter((part): part is TextPartLike => part !== null && typeof part === 'object')
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join(' ');
  return text.length > 0 ? text : undefined;
}

async function handleRun(api: RuntimeApi, planJson: string): Promise<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(planJson);
  } catch {
    return 'workflow: plan is not valid JSON';
  }
  const { plan, issues } = parsePlan(raw);
  if (plan === undefined) {
    const lines = issues.map((issue) => `plan issue at ${issue.path}: ${issue.message}`);
    return ['workflow: plan invalid', ...lines].join('\n');
  }
  api.log.info(`workflow "${plan.name}": starting (${plan.stages.length} stage(s))`);
  const started = Date.now();
  const result = await runPlan(plan, engineDeps(api));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  api.log.info(`workflow "${plan.name}": ${result.ok ? 'completed' : 'finished with failures'} in ${seconds}s`);
  return renderResult(result);
}

function renderResult(result: EngineResult): string {
  const lines: string[] = [`workflow "${result.planName}": ${result.ok ? 'completed' : 'FAILED'}`];
  for (const stage of result.stages) {
    const okCount = stage.records.filter((r) => r.exitCode === 0).length;
    const failed = stage.failedItems.length > 0 ? `, failed: ${stage.failedItems.join(', ')}` : '';
    lines.push(`  stage ${stage.stageId}: ${okCount}/${stage.records.length} ok${failed}`);
  }
  return lines.join('\n');
}

async function handleStatus(api: RuntimeApi, planName: string): Promise<string> {
  const name = planName.trim();
  const runs = (await api.store.get<RunRecord[]>(`workflow.${name}.runs`)) ?? [];
  if (runs.length === 0) {
    return `workflow "${name}": no recorded runs`;
  }
  const lines = [`workflow "${name}": ${runs.filter((r) => r.exitCode === 0).length}/${runs.length} item-runs ok`];
  for (const run of runs) {
    lines.push(`  ${run.stageId} #${run.round} ${run.item}: exit ${run.exitCode}`);
  }
  return lines.join('\n');
}
