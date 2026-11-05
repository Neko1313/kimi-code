import { describe, expect, it } from 'vitest';

import { parsePlan, renderArgs } from '../runtime/plan.ts';

describe('parsePlan', () => {
  it('accepts a minimal valid plan', () => {
    const { plan, issues } = parsePlan({
      name: 'audit',
      stages: [
        {
          id: 'review',
          type: 'fanout',
          items: ['a.ts', 'b.ts'],
          worker: { command: 'echo', argsTemplate: ['{{item}}'] },
        },
      ],
    });
    expect(issues).toEqual([]);
    expect(plan?.name).toBe('audit');
  });

  it('rejects a plan without stages', () => {
    const { plan, issues } = parsePlan({ name: 'x', stages: [] });
    expect(plan).toBeUndefined();
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects duplicate stage ids', () => {
    const { plan, issues } = parsePlan({
      name: 'x',
      stages: [
        { id: 's', type: 'sequential', worker: { command: 'echo' } },
        { id: 's', type: 'sequential', worker: { command: 'echo' } },
      ],
    });
    expect(plan).toBeUndefined();
    expect(issues.some((i) => i.message.includes('duplicate'))).toBe(true);
  });

  it('rejects fanout with both items and itemsFrom', () => {
    const { plan, issues } = parsePlan({
      name: 'x',
      stages: [
        { id: 'a', type: 'fanout', items: ['x'], itemsFrom: 'b.items', worker: { command: 'echo' } },
      ],
    });
    expect(plan).toBeUndefined();
    expect(issues.some((i) => i.path === '$.stages[0]')).toBe(true);
  });

  it('rejects itemsFrom referencing a later/unknown stage', () => {
    const { plan, issues } = parsePlan({
      name: 'x',
      stages: [
        { id: 'a', type: 'fanout', itemsFrom: 'b.failed', worker: { command: 'echo' } },
        { id: 'b', type: 'fanout', items: ['x'], worker: { command: 'echo' } },
      ],
    });
    expect(plan).toBeUndefined();
    expect(issues.some((i) => i.path.includes('itemsFrom'))).toBe(true);
  });

  it('rejects unknown stage type', () => {
    const { plan } = parsePlan({
      name: 'x',
      stages: [{ id: 'a', type: 'parallel', worker: { command: 'echo' } }],
    });
    expect(plan).toBeUndefined();
  });
});

describe('renderArgs', () => {
  it('substitutes {{item}} in every argument', () => {
    expect(renderArgs(['review', '{{item}}', 'prefix-{{item}}'], 'a.ts')).toEqual([
      'review',
      'a.ts',
      'prefix-a.ts',
    ]);
  });
});
