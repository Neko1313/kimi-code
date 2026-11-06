import type { On, RenderInput } from 'claude-code';
import { renderWorkflow } from './view.ts';

export function register(on: On): void {
  on('workflow.run', async ($, e, next) => {
    const result = await next(e);
    await $.ui.open({ id: 'kimi-workflow', title: 'Workflows', columns: 100, rows: 20 });
    return result;
  });
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'workflows', description: 'Browse workflow phases, agents and output', immediate: true });
    return next(e);
  });
  on('command.run', { command: 'workflows' }, async ($) => {
    await $.ui.open({ id: 'kimi-workflow', title: 'Workflows', focus: true, columns: 100, rows: 20 });
    return {};
  });
  on('ui.render', { component: ['Pane', 'KimiTasks'] }, ($, e, next) => e['component'] === 'KimiTasks' || e['requestId'] === 'kimi-workflow' ? renderWorkflow($, e as unknown as RenderInput<'Pane', 'terminal'>, { tasks: e['component'] === 'KimiTasks', viewId: typeof (e['props'] as Record<string, unknown>)?.['viewId'] === 'string' ? (e['props'] as { viewId: string }).viewId : undefined }) : next(e));
}
