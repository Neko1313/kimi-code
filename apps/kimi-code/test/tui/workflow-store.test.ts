import { describe, expect, it } from 'vitest';

import {
  countPlanItems,
  parseWorkflowStore,
  resolveWorkflowStorePath,
} from '../../src/tui/utils/workflow-store';
import { buildRows } from '../../src/tui/controllers/workflow-browser';

const STORE = JSON.stringify({
  'workflow.demo.runs': [
    { stageId: 'review', item: 'a.txt', round: 1, exitCode: 0, stdout: 'ok a', attempts: 1 },
    { stageId: 'review', item: 'b.txt', round: 1, exitCode: 1, stdout: 'boom', attempts: 2 },
    { stageId: 'recheck', item: 'b.txt', round: 1, exitCode: 0, stdout: 'fixed', attempts: 1 },
  ],
  'unrelated.key': [1, 2, 3],
  'workflow.empty.runs': [],
});

describe('parseWorkflowStore', () => {
  it('extracts plans with stages grouped in record order', () => {
    const plans = parseWorkflowStore(STORE);
    expect(plans.map((p) => p.name)).toEqual(['demo', 'empty']);
    const demo = plans[0];
    expect(demo?.stages.map((s) => s.stageId)).toEqual(['review', 'recheck']);
    expect(demo?.stages[0]?.okCount).toBe(1);
    expect(demo?.stages[0]?.items[1]?.attempts).toBe(2);
    expect(demo?.ok).toBe(false);
    expect(countPlanItems(demo ?? { name: '', stages: [], ok: false })).toEqual({ total: 3, ok: 2 });
  });

  it('returns empty for invalid JSON and non-object payloads', () => {
    expect(parseWorkflowStore('not json')).toEqual([]);
    expect(parseWorkflowStore('"str"')).toEqual([]);
    expect(parseWorkflowStore('[]')).toEqual([]);
  });

  it('skips malformed records but keeps valid ones', () => {
    const plans = parseWorkflowStore(
      JSON.stringify({
        'workflow.x.runs': [
          { stageId: 's', item: 'a', exitCode: 0 },
          { stageId: 42, item: 'b', exitCode: 1 },
          null,
        ],
      }),
    );
    expect(plans[0]?.stages[0]?.items).toHaveLength(1);
  });

  it('resolves the store path under the data dir', () => {
    expect(resolveWorkflowStorePath('/tmp/home')).toBe('/tmp/home/plugin-runtime/kimi-workflow.json');
  });
});

describe('buildRows', () => {
  const plans = parseWorkflowStore(STORE);
  const expanded = new Set(['demo']);

  it('collapses plans that are not expanded', () => {
    const rows = buildRows(plans, new Set(), false);
    expect(rows.every((r) => r.kind === 'plan')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('expands stages and items for expanded plans', () => {
    const rows = buildRows(plans, expanded, false);
    expect(rows.map((r) => r.kind)).toEqual([
      'plan',
      'stage',
      'item',
      'item',
      'stage',
      'item',
      'plan',
    ]);
  });

  it('filters to failed items only', () => {
    const rows = buildRows(plans, expanded, true);
    const items = rows.filter((r) => r.kind === 'item');
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === 'item' && items[0].ok).toBe(false);
  });
});
