import type { EngineResult } from './engine.ts';

import type { RuntimeAgentOptions, RuntimePluginApi } from '@moonshot-ai/kimi-code-sdk/plugin';

import type { WorkflowCall, WorkflowPhase, WorkflowRun, WorkflowInput, RunStatus, CallStatus } from '../types/index.d.ts';
export type { WorkflowCall, WorkflowPhase, WorkflowRun, WorkflowInput, RunStatus, CallStatus } from '../types/index.d.ts';

interface LiveRun {
  run: WorkflowRun;
  controller: AbortController;
  workers: Map<string, AbortController>;
  notify: Set<() => void>;
  prefixes: Map<string, { ready: Promise<void>; release: () => void }>;
  budgetExceeded: boolean;
}
const live = new Map<string, LiveRun>();
const saves = new Map<string, Promise<void>>();
const cached = new Map<string, WorkflowRun>();
interface JournalEntry { reset?: boolean; metadata: Partial<WorkflowRun>; calls: WorkflowCall[]; logs?: string[] }
const snapshots = new Map<string, { metadata: Record<string, unknown>; calls: Map<string, string>; logText: string }>();
const key = (api: RuntimePluginApi): string => `session.${api.context.sessionId ?? 'none'}.workflows`;
const scope = (api: RuntimePluginApi, id: string): string => `${api.context.sessionId}\0${id}`;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function listRuns(api: RuntimePluginApi): Promise<WorkflowRun[]> {
  const legacy = (await api.store.get<WorkflowRun[]>(key(api))) ?? [];
  const ids = (await api.store.get<string[]>(key(api) + '.index')) ?? [];
  const stored: WorkflowRun[] = [];
  for (const id of ids) {
    const cacheKey = scope(api, id);
    let run = live.get(cacheKey)?.run ?? cached.get(cacheKey);
    if (run === undefined) {
      for (const entry of await api.store.readLog<JournalEntry>(`${key(api)}.${id}`)) {
        if (entry.reset) run = { calls: [], logs: [] } as unknown as WorkflowRun;
        if (run === undefined) throw new Error('Workflow journal has no initial checkpoint');
        Object.assign(run, entry.metadata);
        for (const call of entry.calls) {
          const index = run.calls.findIndex(item => item.id === call.id);
          if (index < 0) run.calls.push(call); else run.calls[index] = call;
        }
        if (entry.logs !== undefined) run.logs = entry.logs;
      }
      if (run !== undefined) cached.set(cacheKey, run);
    }
    if (run !== undefined) stored.push(run);
  }
  for (const run of legacy) if (!ids.includes(run.id)) stored.push(run);
  return stored.map((run) => {
    const active = live.get(scope(api, run.id));
    if (active !== undefined) return active.run;
    if (run.status !== 'running' && run.status !== 'paused') return run;
    return { ...run, status: 'interrupted', calls: run.calls.map((call) => call.status === 'running' || call.status === 'queued' ? { ...call, status: 'cancelled', error: 'Session ended before this call completed' } : call) };
  });
}
async function save(api: RuntimePluginApi, run: WorkflowRun): Promise<void> {
  const id = scope(api, run.id);
  const work = (saves.get(id) ?? Promise.resolve()).then(async () => {
    run.updatedAt = Date.now();
    let previous = snapshots.get(id);
    if (previous !== undefined && [...previous.calls.keys()].some(callId => !run.calls.some(call => call.id === callId))) previous = undefined;
    const metadata: Record<string, unknown> = {};
    const allMetadata: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(run)) {
      if (field === 'calls' || field === 'logs') continue;
      allMetadata[field] = value;
      if (previous === undefined || previous.metadata[field] !== value) metadata[field] = value;
    }
    const signatures = new Map<string, string>();
    const calls = run.calls.filter(call => {
      const signature = JSON.stringify([call.status, call.attempt, call.agentId, call.taskId, call.startedAt, call.finishedAt]);
      signatures.set(call.id, signature);
      return previous?.calls.get(call.id) !== signature;
    });
    const logText = JSON.stringify(run.logs);
    await api.store.append(`${key(api)}.${run.id}`, { reset: previous === undefined ? true : undefined, metadata, calls, logs: previous?.logText === logText ? undefined : run.logs } satisfies JournalEntry);
    snapshots.set(id, { metadata: allMetadata, calls: signatures, logText });
    cached.set(id, run);
    if (previous === undefined) await api.store.update<string[]>(key(api) + '.index', (ids = []) => [run.id, ...ids.filter(item => item !== run.id)]);
  });
  const queued = work.catch(() => undefined);
  saves.set(id, queued);
  try { await work; } finally { if (saves.get(id) === queued) saves.delete(id); }
}
function wake(active: LiveRun): void {
  for (const resolve of active.notify) resolve();
  active.notify.clear();
}
async function changed(active: LiveRun, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve) => {
    const done = (): void => { active.notify.delete(done); signal.removeEventListener('abort', done); resolve(); };
    active.notify.add(done);
    signal.addEventListener('abort', done, { once: true });
  });
  signal.throwIfAborted();
}

export async function startWorkflow(api: RuntimePluginApi, input: WorkflowInput): Promise<{ runId: string }> {
  if (!api.context.sessionId) throw new Error('Workflow requires a session');
  const concurrency = input.concurrency ?? 8;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error('Concurrency must be between 1 and 64');
  const previous = input.resume === undefined ? undefined : (await listRuns(api)).find((run) => run.id === input.resume);
  if (input.resume !== undefined && previous === undefined) throw new Error('Unknown workflow to resume');
  if (previous !== undefined && live.has(scope(api, previous.id))) throw new Error('Workflow is already active');
  const id = previous?.id ?? crypto.randomUUID();
  const source = input.source || previous?.source || '';
  if (!source.trim()) throw new Error('Workflow script is empty');
  const tokenBudget = input.tokenBudget ?? previous?.tokenBudget;
  if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) throw new Error('Token budget must be a positive integer');
  const prefixStaggerMs = input.prefixStaggerMs ?? previous?.prefixStaggerMs ?? 5000;
  if (!Number.isInteger(prefixStaggerMs) || prefixStaggerMs < 0 || prefixStaggerMs > 10000) throw new Error('Prefix stagger must be between 0 and 10000 ms');
  const run: WorkflowRun = {
    id, name: input.name ?? previous?.name ?? 'Workflow', sessionId: api.context.sessionId,
    parentToolCallId: api.context.toolCallId,
    source, description: input.description ?? previous?.description, phases: input.phases ?? previous?.phases, args: input.args ?? previous?.args, concurrency, status: 'running',
    createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(),
    calls: [], logs: [],
    tokenBudget, tokensSpent: previous?.tokensSpent ?? 0, prefixStaggerMs,
  };
  const active: LiveRun = { run, controller: new AbortController(), workers: new Map(), notify: new Set(), prefixes: new Map(), budgetExceeded: false };
  snapshots.delete(scope(api, id));
  live.set(scope(api, id), active);
  try {
    await save(api, run);
    run.taskId = api.tasks.start({ id, title: run.name }, async (taskSignal) => {
      const signal = AbortSignal.any([taskSignal, active.controller.signal]);
      let checkpointing = false;
      const ticker = api.clock.every(1000, () => {
        api.ui.invalidate();
        if (checkpointing) return;
        checkpointing = true;
        void save(api, run).catch(error => api.log.warn(message(error))).finally(() => { checkpointing = false; });
      });
      let cursor = 0;
      let replay = previous !== undefined;
      const prior = previous?.calls ?? [];
      try {
        run.result = await api.script.run({
          source: scriptSource(source, tokenBudget, run.tokensSpent), args: run.args, signal, timeoutMs: 86_400_000,
          invoke: async (method, raw) => {
            signal.throwIfAborted();
            if (method === 'budget') return { spent: run.tokensSpent ?? 0 };
            if (method === 'meta') {
              if (raw === null || typeof raw !== 'object') throw new Error('Workflow meta must be an object');
              const meta = raw as Record<string, unknown>;
              if (typeof meta['name'] === 'string') run.name = meta['name'];
              if (typeof meta['description'] === 'string') run.description = meta['description'];
              if (meta['phases'] !== undefined) {
                if (!Array.isArray(meta['phases']) || meta['phases'].length > 128) throw new Error('Workflow meta.phases must contain at most 128 phases');
                const names = new Set<string>();
                run.phases = meta['phases'].map((entry: unknown) => {
                  if (entry === null || typeof entry !== 'object') throw new Error('Invalid workflow phase');
                  const item = entry as Record<string, unknown>;
                  const name = item['title'] ?? item['name'];
                  const description = item['detail'] ?? item['description'];
                  if (typeof name !== 'string' || !name.trim() || names.has(name)) throw new Error('Each phase needs a unique title');
                  if (typeof item['model'] !== 'string' || !item['model'].trim()) throw new Error('Every meta phase must explicitly specify a model');
                  if (description !== undefined && typeof description !== 'string') throw new Error('Phase detail must be a string');
                  names.add(name);
                  return { name, model: item['model'], description };
                });
              }
              await save(api, run);
              return null;
            }
            if (method === 'phase') {
              const phase = String(raw);
              if (phase.length > 256) throw new Error('Phase name is too long');
              run.activePhase = phase;
              if (!run.logs.includes(`Phase: ${phase}`)) run.logs.push(`Phase: ${phase}`);
              await save(api, run);
              return null;
            }
            if (method === 'log') {
              run.logs.push(String(raw).slice(0, 16_384));
              run.logs = run.logs.slice(-1000);
              await save(api, run);
              return null;
            }
            if (method !== 'agent') throw new Error(`Unknown workflow operation: ${method}`);
            if (run.tokenBudget !== undefined && (run.tokensSpent ?? 0) >= run.tokenBudget) {
              active.budgetExceeded = true;
              active.controller.abort(new Error('Workflow token budget exceeded'));
              throw new Error('Workflow token budget exceeded');
            }
            if (cursor >= 1000) throw new Error('Workflow exceeds the 1000-agent limit');
            const options = parseAgent(raw);
            const position = cursor++;
            const old = prior[position];
            const call: WorkflowCall = {
              id: String(position), phase: options.phase, prompt: options.prompt, model: options.model,
              label: options.label ?? `Agent ${position + 1}`, profile: options.profile, schema: options.schema,
              status: 'queued', attempt: (old?.attempt ?? 0) + 1,
            };
            if (replay && old?.status === 'completed' && sameCall(old, call)) {
              run.calls.push(structuredClone(old));
              await save(api, run);
              return old.result?.value ?? old.result?.text;
            }
            replay = false;
            run.calls.push(call);
            await save(api, run);
            while (run.status === 'paused' || active.workers.size >= run.concurrency) await changed(active, signal);
            signal.throwIfAborted();
            const controller = new AbortController();
            const workerSignal = AbortSignal.any([signal, controller.signal]);
            active.workers.set(call.id, controller);
            call.status = 'running';
            call.startedAt = Date.now();
            await save(api, run);
            let releasePrefix: (() => void) | undefined;
            let observedTokens = 0;
            const account = (tokens: number): void => {
              const delta = Math.max(0, tokens - observedTokens);
              observedTokens = Math.max(observedTokens, tokens);
              run.tokensSpent = (run.tokensSpent ?? 0) + delta;
              if (run.tokenBudget !== undefined && run.tokensSpent > run.tokenBudget) {
                active.budgetExceeded = true;
                active.controller.abort(new Error('Workflow token budget exceeded'));
              }
            };
            try {
              const prefix = JSON.stringify([options.model, options.profile, options.schema, api.context.cwd]);
              const existingPrefix = active.prefixes.get(prefix);
              if (existingPrefix === undefined) {
                let release!: () => void;
                const ready = new Promise<void>(resolve => { release = resolve; });
                active.prefixes.set(prefix, { ready, release }); releasePrefix = release;
              } else if (prefixStaggerMs > 0) {
                await new Promise<void>((resolve, reject) => {
                  const done = (): void => { timer.cancel(); workerSignal.removeEventListener('abort', abort); resolve(); };
                  const abort = (): void => { timer.cancel(); workerSignal.removeEventListener('abort', abort); reject(workerSignal.reason); };
                  const timer = api.clock.after(prefixStaggerMs, done);
                  workerSignal.addEventListener('abort', abort, { once: true });
                  void existingPrefix.ready.then(done);
                  if (workerSignal.aborted) abort();
                });
              }
              workerSignal.throwIfAborted();
              const result = await api.agent.run({ ...options, parentRunId: id, notify: false, maxOutputTokens: tokenBudget === undefined ? undefined : Math.max(1, Math.floor((tokenBudget - (run.tokensSpent ?? 0)) / concurrency)), onProgress: (progress) => { call.progress = progress; account(progress.outputTokens ?? 0); if (progress.firstResponseAt !== undefined) releasePrefix?.(); api.ui.invalidate(); }, signal: workerSignal, onStarted: (agentId, taskId) => {
                call.agentId = agentId; call.taskId = taskId;
                void save(api, run).catch((error: unknown) => api.log.warn(message(error)));
              } });
              call.result = result;
              if (tokenBudget !== undefined && result.usage?.output === undefined && call.progress?.outputTokens === undefined) {
                active.budgetExceeded = true;
                active.controller.abort(new Error('Workflow budget requires reported output-token usage'));
                throw new Error('Workflow budget requires reported output-token usage');
              }
              account(result.usage?.output ?? call.progress?.outputTokens ?? 0);
              call.progress = result.progress ?? call.progress;
              call.status = 'completed';
              return result.value ?? result.text;
            } catch (error) {
              call.status = controller.signal.aborted || signal.aborted ? 'cancelled' : 'failed';
              call.error = message(error);
              throw error;
            } finally {
              releasePrefix?.();
              call.finishedAt = Date.now();
              try { await save(api, run); } finally { active.workers.delete(call.id); wake(active); }
            }
          },
        });
        run.status = 'completed';
      } catch (error) {
        run.status = active.budgetExceeded ? 'failed' : signal.aborted ? 'cancelled' : 'failed';
        run.error = message(error);
      } finally {
        ticker.cancel();
        run.finishedAt = Date.now();
        active.controller.abort(new Error('Workflow finished'));
        wake(active);
        while (active.workers.size > 0) await changed(active, new AbortController().signal);
        for (const call of run.calls) if (call.status === 'queued' || call.status === 'running') call.status = 'cancelled';
        try { await save(api, run); }
        finally { live.delete(scope(api, id)); saves.delete(scope(api, id)); }
      }
      if (run.status === 'failed') throw new Error(run.error ?? 'Workflow failed');
      return { runId: id, result: run.result, failedCalls: run.calls.filter(call => call.status === 'failed').length };
    });
    await save(api, run);
  } catch (error) {
    live.delete(scope(api, id));
    run.status = 'failed'; run.error = message(error);
    await save(api, run);
    throw error;
  }
  api.ui.invalidate();
  return { runId: id };
}

export async function recordProcessPlan(api: RuntimePluginApi, result: EngineResult): Promise<void> {
  if (api.context.sessionId === undefined) return;
  const now = Date.now();
  await save(api, {
    id: crypto.randomUUID(), name: result.planName, sessionId: api.context.sessionId,
    source: '', concurrency: 1, status: result.ok ? 'completed' : 'failed', createdAt: now, updatedAt: now,
    logs: [], calls: result.stages.flatMap((stage) => stage.records.map((record, index) => ({
      id: `${stage.stageId}/${index}`, phase: stage.stageId, prompt: record.item, label: record.item,
      model: 'process', attempt: record.attempts, status: record.exitCode === 0 ? 'completed' : 'failed',
      error: record.exitCode === 0 ? undefined : `Process exited with code ${record.exitCode}`,
      result: { agentId: '', taskId: '', text: record.stdout },
    }))),
  });
}

function sameCall(a: WorkflowCall, b: WorkflowCall): boolean {
  return JSON.stringify([a.prompt, a.model, a.profile, a.phase, a.schema]) === JSON.stringify([b.prompt, b.model, b.profile, b.phase, b.schema]);
}
function parseAgent(raw: unknown): RuntimeAgentOptions & { phase: string } {
  if (raw === null || typeof raw !== 'object') throw new Error('Invalid agent options');
  const value = raw as Record<string, unknown>;
  if (typeof value['prompt'] !== 'string' || !value['prompt'].trim() || value['prompt'].length > 1_000_000) throw new Error('Agent requires a non-empty prompt');
  if (typeof value['model'] !== 'string' || !value['model'].trim()) throw new Error('Every agent must explicitly specify a model');
  if (value['profile'] !== undefined && typeof value['profile'] !== 'string') throw new Error('Agent profile must be a string');
  if (value['schema'] !== undefined && (value['schema'] === null || typeof value['schema'] !== 'object' || Array.isArray(value['schema']))) throw new Error('Agent schema must be a JSON schema object');
  return { prompt: value['prompt'], model: value['model'], profile: typeof value['profile'] === 'string' ? value['profile'] : undefined, label: typeof value['label'] === 'string' ? value['label'] : undefined, schema: value['schema'] as Record<string, unknown> | undefined, phase: typeof value['phase'] === 'string' ? value['phase'] : 'Work' };
}

export async function controlWorkflow(api: RuntimePluginApi, id: string, action: string, callId?: string): Promise<unknown> {
  const active = live.get(scope(api, id));
  if (action === 'restart') {
    if (active !== undefined) {
      active.controller.abort(new Error('Restart requested'));
      wake(active);
      await api.tasks.cancel(id);
    }
    const run = (await listRuns(api)).find((item) => item.id === id);
    if (run === undefined) throw new Error('Unknown workflow');
    if (!run.source) throw new Error('Process plans must be restarted with workflow run');
    if (callId !== undefined) {
      const index = run.calls.findIndex((call) => call.id === callId);
      if (index < 0) throw new Error('Unknown workflow call');
      run.calls = run.calls.slice(0, index);
      await save(api, run);
    }
    return startWorkflow(api, { source: run.source, args: run.args, concurrency: run.concurrency, tokenBudget: run.tokenBudget, prefixStaggerMs: run.prefixStaggerMs, resume: id });
  }
  if (active === undefined) throw new Error('Workflow is not active; restart it to resume');
  if (action === 'pause') active.run.status = 'paused';
  else if (action === 'resume') active.run.status = 'running';
  else if (action === 'cancel' && callId !== undefined) {
    const worker = active.workers.get(callId);
    if (worker === undefined) throw new Error('Selected agent is not running');
    worker.abort(new Error('Agent stopped by user'));
  } else if (action === 'cancel') {
    active.controller.abort(new Error('Workflow stopped by user'));
    wake(active);
    await api.tasks.cancel(id);
    return { status: 'cancelled' };
  } else throw new Error(`Unknown workflow action: ${action}`);
  wake(active);
  await save(api, active.run);
  return { status: active.run.status };
}

function scriptSource(source: string, tokenBudget?: number, initialSpent = 0): string {
  return `
    (() => {
      const unavailable = () => { throw new Error('Workflow time and randomness must be passed through args for reproducible resume'); };
      const date = new Proxy(Date, {
        apply: unavailable,
        construct: (target, values) => { if (!values.length) return unavailable(); return Reflect.construct(target, values); },
        get: (target, key) => key === 'now' ? unavailable : Reflect.get(target, key),
      });
      Object.defineProperty(Date.prototype, 'constructor', { value: date });
      Object.defineProperty(globalThis, 'Date', { value: date, writable: false, configurable: false });
      Object.defineProperty(Math, 'random', { value: unavailable, writable: false, configurable: false });
    })();
    let currentPhase = 'Work';
    let spent = ${initialSpent};
    const budget = Object.freeze({ total: ${tokenBudget ?? 'null'}, spent: () => spent, remaining: () => budget.total === null ? Infinity : Math.max(0, budget.total - spent) });
    let metaSent = false;
    const sendMeta = async () => { if (!metaSent && typeof meta !== 'undefined') { await host('meta', meta); metaSent = true; } };
    const phase = async (name) => { await sendMeta(); currentPhase = String(name); return host('phase', currentPhase); };
    const log = (text) => host('log', String(text));
    const agent = async (prompt, options) => { await sendMeta(); try { return await host('agent', { ...options, prompt, phase: options?.phase ?? currentPhase }); } finally { spent = (await host('budget')).spent; } };
    const branch = async (work, failFast) => { try { return await work(); } catch (error) { if (failFast) throw error; await host('log', 'Branch failed: ' + (error instanceof Error ? error.message : String(error))); return null; } };
    const parallel = async (items, { failFast = false } = {}) => { if (!Array.isArray(items) || items.length > 4096) throw new Error('parallel expects at most 4096 items'); return Promise.all(items.map(item => branch(() => typeof item === 'function' ? item() : item, failFast))); };
    const pipeline = async (items, ...stages) => {
      if (!Array.isArray(items) || items.length > 4096) throw new Error('pipeline expects at most 4096 items');
      const options = stages.at(-1) !== null && typeof stages.at(-1) === 'object' ? stages.pop() : {};
      return Promise.all(items.map((item, index) => branch(async () => { let value = item; for (const stage of stages) { value = await stage(value, item, index); if (value === null) break; } return value; }, options.failFast ?? false)));
    };
    ${source.replaceAll(/\bexport\s+const\s+meta\s*=/g, 'const meta =')}
  `;
}
