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
      options?: { timeoutMs?: number; cwd?: string; input?: string },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  readonly ui: {
    open(options: { id: string; title: string }): Promise<void>;
    close(options: { id: string }): Promise<void>;
    invalidate(): void;
  };
};

type Element =
  | { readonly type: 'box'; readonly direction: 'row' | 'column'; readonly gap?: number; readonly children: readonly (Element | string)[] }
  | { readonly type: 'text'; readonly text: string; readonly color?: 'primary' | 'success' | 'error' | 'warning' | 'dim' | 'muted' | 'textStrong' }
  | { readonly type: 'button'; readonly label: string; readonly hotkey?: string };

type EventPayload = {
  readonly event: string;
  readonly cwd: string;
  readonly data: Record<string, unknown>;
};

type Next = (e?: EventPayload) => unknown;
type Handler = (api: RuntimeApi, event: EventPayload, next: Next) => unknown;
type Register = {
  (event: string, handler: Handler): void;
  (event: string, matcher: string, handler: Handler): void;
};

const RUN_PREFIX = 'workflow run ';
const STATUS_PREFIX = 'workflow status ';
const PENDING_REL = '.kimi-workflow/pending.json';
const PANE_ID = 'kimi-workflow';

let selectedLine = 0;
let expandedPlans = new Set<string>();
let failedOnly = false;

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

export function register(on: Register): void {
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
      return { block: ['workflow: pending plan invalid', ...issues.map((i) => `${i.path}: ${i.message}`)].join('\n') };
    }
    api.log.info(`workflow "${plan.name}": starting (${plan.stages.length} stage(s)) from pending file`);
    const result = await runPlan(plan, engineDeps(api));
    await openPane(api);
    return { block: renderResult(result) };
  });

  on('ui.render', async (api, event, next) => {
    if (event.data['requestId'] !== PANE_ID) return next();
    return renderPane(api);
  });

  on('ui.key', async (api, event) => {
    if (event.data['paneId'] !== PANE_ID) return;
    const key = typeof event.data['key'] === 'string' ? event.data['key'] : '';
    const rows = await collectRows(api);
    if (key === 'up') {
      selectedLine = Math.max(0, selectedLine - 1);
    } else if (key === 'down') {
      selectedLine = Math.min(Math.max(0, rows.length - 1), selectedLine + 1);
    } else if (key === 'enter') {
      const row = rows[selectedLine];
      if (row?.kind === 'plan') {
        const nextExpanded = new Set(expandedPlans);
        if (nextExpanded.has(row.name)) {
          nextExpanded.delete(row.name);
        } else {
          nextExpanded.add(row.name);
        }
        expandedPlans = nextExpanded;
      }
    } else if (key === 'f') {
      failedOnly = !failedOnly;
    } else if (key === 'r') {
      expandedPlans = new Set();
    }
    api.ui.invalidate();
  });
}

async function openPane(api: RuntimeApi): Promise<void> {
  await api.ui.open({ id: PANE_ID, title: 'Workflow runs' });
  api.ui.invalidate();
}

type Row =
  | { kind: 'plan'; name: string; ok: boolean; okCount: number; total: number }
  | { kind: 'stage'; stageId: string; okCount: number; total: number }
  | { kind: 'item'; item: string; round: number; exitCode: number; stdout: string; stageId: string };

async function collectRows(api: RuntimeApi): Promise<Row[]> {
  const names = await storePlanNames(api);
  const rows: Row[] = [];
  for (const name of names) {
    const runs = (await api.store.get<RunRecord[]>(`workflow.${name}.runs`)) ?? [];
    const stages = new Map<string, RunRecord[]>();
    for (const run of runs) {
      const list = stages.get(run.stageId) ?? [];
      list.push(run);
      stages.set(run.stageId, list);
    }
    const okCount = runs.filter((r) => r.exitCode === 0).length;
    rows.push({ kind: 'plan', name, ok: runs.length > 0 && okCount === runs.length, okCount, total: runs.length });
    if (!expandedPlans.has(name)) continue;
    for (const [stageId, items] of stages) {
      const stageOk = items.filter((r) => r.exitCode === 0).length;
      rows.push({ kind: 'stage', stageId, okCount: stageOk, total: items.length });
      for (const item of items) {
        if (failedOnly && item.exitCode === 0) continue;
        rows.push({
          kind: 'item',
          stageId,
          item: item.item,
          round: item.round,
          exitCode: item.exitCode,
          stdout: item.stdout,
        });
      }
    }
  }
  return rows;
}

async function storePlanNames(api: RuntimeApi): Promise<string[]> {
  const homeProbe = await api.process.run(['sh', '-c', 'printf %s "${KIMI_CODE_HOME:-$HOME/.kimi-code}"']);
  if (homeProbe.exitCode !== 0) return [];
  const read = await api.process.run(['cat', `${homeProbe.stdout}/plugin-runtime/kimi-workflow.json`]);
  if (read.exitCode !== 0 || read.stdout.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.stdout);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const names: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (key.startsWith('workflow.') && key.endsWith('.runs')) {
      names.push(key.slice('workflow.'.length, key.length - '.runs'.length));
    }
  }
  return names.toReversed();
}

async function renderPane(api: RuntimeApi): Promise<Element> {
  const rows = await collectRows(api);
  if (selectedLine >= rows.length) selectedLine = Math.max(0, rows.length - 1);
  const selected = rows[selectedLine];
  const children: (Element | string)[] = [
    { type: 'text', text: `Workflow runs${failedOnly ? '  [failed only]' : ''}`, color: 'primary' },
  ];
  rows.forEach((row, index) => {
    const pointer = index === selectedLine ? '❯ ' : '  ';
    if (row.kind === 'plan') {
      children.push({
        type: 'text',
        text: `${pointer}${row.ok ? '✓' : '✗'} ${row.name}  ${row.okCount}/${row.total}`,
        color: row.ok ? 'success' : 'error',
      });
    } else if (row.kind === 'stage') {
      children.push({ type: 'text', text: `${pointer}  ${row.stageId} ${row.okCount}/${row.total} ok`, color: 'dim' });
    } else {
      children.push({
        type: 'text',
        text: `${pointer}  ${row.exitCode === 0 ? '✓' : '✗'} ${row.item} · r${row.round} · exit ${row.exitCode}`,
        color: row.exitCode === 0 ? 'success' : 'error',
      });
    }
  });
  if (rows.length === 0) {
    children.push({ type: 'text', text: 'No workflow runs yet.', color: 'dim' });
  }
  children.push('');
  if (selected?.kind === 'item') {
    children.push({ type: 'text', text: `${selected.stageId} · ${selected.item} · round ${selected.round}`, color: 'muted' });
    const out = selected.stdout.trimEnd();
    const outLines = out.length > 0 ? out.split('\n') : ['(no output)'];
    for (const line of outLines.slice(-6)) {
      children.push({ type: 'text', text: `  ${line}`, color: 'textStrong' });
    }
  }
  children.push({ type: 'text', text: '↑/↓ move · Enter expand · f failed-only · r collapse · q/Esc close', color: 'muted' });
  return { type: 'box', direction: 'column', children };
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter((part) => part !== null && typeof part === 'object')
    .filter((part) => (part as { type?: string }).type === 'text' && typeof (part as { text?: string }).text === 'string')
    .map((part) => (part as { text: string }).text)
    .join(' ');
  return text.length > 0 ? text : undefined;
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

async function handleRun(api: RuntimeApi, planJson: string): Promise<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(planJson);
  } catch {
    return 'workflow: plan is not valid JSON';
  }
  const { plan, issues } = parsePlan(raw);
  if (plan === undefined) {
    return ['workflow: plan invalid', ...issues.map((i) => `${i.path}: ${i.message}`)].join('\n');
  }
  api.log.info(`workflow "${plan.name}": starting (${plan.stages.length} stage(s))`);
  const started = Date.now();
  const result = await runPlan(plan, engineDeps(api));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  api.log.info(`workflow "${plan.name}": ${result.ok ? 'completed' : 'finished with failures'} in ${seconds}s`);
  await openPane(api);
  return renderResult(result);
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
