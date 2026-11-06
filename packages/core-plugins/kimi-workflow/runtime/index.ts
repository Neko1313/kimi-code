import type { On } from 'claude-code';

import { startWorkflow, controlWorkflow, listRuns, type WorkflowInput } from './workflow.ts';

export function register(on: On): void {
  on('engine.create', async (_$, e, next) => ({ ...await next(e) as object, workflow: {
    run: () => { throw new Error('workflow.run needs its provider'); },
    status: () => { throw new Error('workflow.status needs its provider'); },
    control: () => { throw new Error('workflow.control needs its provider'); },
    tasks: () => { throw new Error('workflow.tasks needs its provider'); },
    output: () => { throw new Error('workflow.output needs its provider'); },
    stopTask: () => { throw new Error('workflow.stopTask needs its provider'); },
  } }));
  on('workflow.run', async ($, e) => ({ value: await startWorkflow($.kimi, e as unknown as WorkflowInput) })).catch((_$, _e, next) => ({ deny: next.error.message ?? 'Workflow provider failed' }));
  on('workflow.status', async ($, e) => {
    const runs = await listRuns($.kimi);
    return { value: e['runId'] === undefined ? runs : runs.find(run => run.id === e['runId']) ?? null };
  }).catch((_$, _e, next) => ({ deny: next.error.message ?? 'Workflow provider failed' }));
  on('workflow.control', async ($, e) => ({ value: await controlWorkflow($.kimi, String(e['runId']), String(e['action']), e['callId'] as string | undefined) })).catch((_$, _e, next) => ({ deny: next.error.message ?? 'Workflow provider failed' }));
  on('workflow.tasks', ($) => ({ value: $.kimi.tasks.list() })).catch((_$, _e, next) => ({ deny: next.error.message ?? 'Workflow provider failed' }));
  on('workflow.output', async ($, e) => ({ value: await $.kimi.tasks.output(String(e['id'])) })).catch((_$, _e, next) => ({ deny: next.error.message ?? 'Workflow provider failed' }));
  on('workflow.stopTask', async ($, e) => { await $.kimi.tasks.cancel(String(e['taskId'])); return { value: undefined }; }).catch((_$, _e, next) => ({ deny: next.error.message ?? 'Workflow provider failed' }));
}
