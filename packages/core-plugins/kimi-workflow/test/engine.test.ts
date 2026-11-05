import { describe, expect, it } from 'vitest';

import { runPlan, type EngineDeps, type RunRecord } from '../runtime/engine.ts';
import type { WorkflowPlan } from '../runtime/plan.ts';

function makeDeps(runs: RunRecord[] = [], behavior: Record<string, number> = {}): EngineDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(args) {
      const key = args.join(' ');
      calls.push(key);
      const item = args.at(-1) ?? '';
      return { exitCode: behavior[item] ?? 0, stdout: `done ${key}`, stderr: '' };
    },
    log: () => {},
    loadRuns: async () => runs,
    saveRun: async (_plan, record) => {
      runs.push(record);
    },
  };
}

const plan = (stages: WorkflowPlan['stages']): WorkflowPlan => ({ name: 'test', stages });

describe('runPlan', () => {
  it('runs a sequential stage once', async () => {
    const deps = makeDeps();
    const result = await runPlan(
      plan([{ id: 's', type: 'sequential', worker: { command: 'echo', argsTemplate: ['hi'] } }]),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.stages[0]?.records).toHaveLength(1);
    expect(deps.calls).toEqual(['echo hi']);
  });

  it('fans out over items and reports failures', async () => {
    const deps = makeDeps([], { 'bad.ts': 1 });
    const result = await runPlan(
      plan([
        {
          id: 'review',
          type: 'fanout',
          items: ['good.ts', 'bad.ts'],
          worker: { command: 'check', argsTemplate: ['{{item}}'] },
        },
      ]),
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.stages[0]?.failedItems).toEqual(['bad.ts']);
  });

  it('skips downstream stages without itemsFrom after a failure', async () => {
    const deps = makeDeps([], { 'x': 1 });
    const result = await runPlan(
      plan([
        { id: 'a', type: 'fanout', items: ['x'], worker: { command: 'one', argsTemplate: ['{{item}}'] } },
        { id: 'b', type: 'sequential', worker: { command: 'two', argsTemplate: [] } },
      ]),
      deps,
    );
    expect(result.stages.map((s) => s.stageId)).toEqual(['a', 'b']);
    expect(result.stages[1]?.records).toEqual([]);
    expect(deps.calls.every((c) => c.startsWith('one'))).toBe(true);
  });

  it('loop stage retries failed items until clean', async () => {
    let attempts = 0;
    const deps: EngineDeps = {
      async run(args) {
        const item = args.at(-1) ?? '';
        if (item === 'flaky.ts') {
          attempts += 1;
          return { exitCode: attempts < 3 ? 1 : 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      log: () => {},
      loadRuns: async () => [],
      saveRun: async () => {},
    };
    const result = await runPlan(
      plan([
        {
          id: 'hunt',
          type: 'loop',
          items: ['flaky.ts'],
          maxRounds: 5,
          worker: { command: 'probe', argsTemplate: ['{{item}}'] },
        },
      ]),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
    expect(result.stages[0]?.failedItems).toEqual([]);
  });

  it('loop stage gives up at maxRounds', async () => {
    const deps = makeDeps([], { 'stuck.ts': 1 });
    const result = await runPlan(
      plan([
        {
          id: 'hunt',
          type: 'loop',
          items: ['stuck.ts'],
          maxRounds: 2,
          worker: { command: 'probe', argsTemplate: ['{{item}}'] },
        },
      ]),
      deps,
    );
    expect(result.ok).toBe(false);
    const records = result.stages[0]?.records ?? [];
    expect(records.filter((r) => r.item === 'stuck.ts')).toHaveLength(2);
  });

  it('feeds failed items of one stage into the next via itemsFrom', async () => {
    const deps = makeDeps([], { 'bad.ts': 1 });
    const result = await runPlan(
      plan([
        {
          id: 'review',
          type: 'fanout',
          items: ['good.ts', 'bad.ts'],
          worker: { command: 'check', argsTemplate: ['{{item}}'] },
        },
        {
          id: 'recheck',
          type: 'fanout',
          itemsFrom: 'review.failed',
          worker: { command: 'recheck', argsTemplate: ['{{item}}'] },
        },
      ]),
      deps,
    );
    expect(result.stages[1]?.records.map((r) => r.item)).toEqual(['bad.ts']);
  });

  it('respects maxConcurrency', async () => {
    let active = 0;
    let peak = 0;
    const deps: EngineDeps = {
      async run() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      log: () => {},
      loadRuns: async () => [],
      saveRun: async () => {},
    };
    await runPlan(
      plan([
        {
          id: 'wide',
          type: 'fanout',
          items: ['a', 'b', 'c', 'd', 'e', 'f'],
          maxConcurrency: 2,
          worker: { command: 'job', argsTemplate: ['{{item}}'] },
        },
      ]),
      deps,
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('reuses cached successful runs on replay', async () => {
    const deps = makeDeps();
    deps.calls.push('seed');
    const cached: RunRecord = {
      stageId: 'review',
      item: 'a.ts',
      round: 1,
      exitCode: 0,
      stdout: 'cached',
      attempts: 1,
    };
    const withCache: EngineDeps = { ...deps, loadRuns: async () => [cached] };
    const result = await runPlan(
      plan([
        {
          id: 'review',
          type: 'fanout',
          items: ['a.ts'],
          worker: { command: 'check', argsTemplate: ['{{item}}'] },
        },
      ]),
      withCache,
    );
    expect(result.ok).toBe(true);
    expect(deps.calls).toEqual(['seed']);
  });
});
