
import type { WorkflowCall, WorkflowPhase, WorkflowRun, WorkflowActivity as RuntimeActivity } from '../../kimi-workflow/types/index.d.ts';
import type { EngineInterface, RenderInput, RenderElement, StateFamily } from 'claude-code';

interface RuntimeBrowserCell { text: string; width?: number; align?: string; color?: RuntimeUiColor }
interface RuntimeBrowserRow { key: string; cells: RuntimeBrowserCell[] }
interface RuntimeBrowserColumn { id: string; title: string; width?: number; rows: RuntimeBrowserRow[]; selectedKey?: string; focused?: boolean; text?: string; emptyText?: string }
interface RuntimeBrowserElement { type: 'browser'; title: string; description?: string; summary?: string; columns: RuntimeBrowserColumn[]; footer?: string; captureEscape?: boolean }
type RuntimeUiColor = 'primary' | 'success' | 'error' | 'warning' | 'dim' | 'muted' | 'textStrong';


export interface View {
  screen: 'runs' | 'run' | 'tasks';
  runId?: string;
  phase?: string;
  focus: 'phases' | 'agents';
  callId?: string;
  selectedRun?: string;
  selectedTask?: string;
  taskId?: string;
  agentSelection: Record<string, string>;
  filter: number;
  error?: string;
}
const initial = (): View => ({ screen: 'run', focus: 'phases', filter: 0, agentSelection: {} });
const filters = ['all', 'running', 'failed', 'completed'] as const;
const color = (status: string): RuntimeUiColor => status === 'completed' ? 'success' : status === 'failed' ? 'error' : status === 'running' ? 'textStrong' : status === 'paused' ? 'warning' : 'dim';
const mark = (status: string): string => status === 'completed' ? '✓' : status === 'running' ? '●' : status === 'failed' ? '✗' : status === 'cancelled' || status === 'interrupted' ? '⊘' : '·';
const cell = (text: string, options: Omit<RuntimeBrowserCell, 'text'> = {}): RuntimeBrowserCell => ({ text, ...options });

function compact(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}k`;
  return String(value);
}
function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`;
}
function phasesOf(run: WorkflowRun): WorkflowPhase[] {
  const phases = [...(run.phases ?? [])];
  for (const name of [...run.calls.map((call) => call.phase), ...(run.activePhase === undefined ? [] : [run.activePhase])]) {
    if (!phases.some((phase) => phase.name === name)) phases.push({ name });
  }
  return phases;
}
function phaseStatus(run: WorkflowRun, phase: WorkflowPhase): string {
  const calls = run.calls.filter((call) => call.phase === phase.name);
  if (calls.some((call) => call.status === 'failed')) return 'failed';
  if (calls.some((call) => call.status === 'running')) return run.status === 'paused' ? 'paused' : 'running';
  if (calls.length > 0 && calls.every((call) => call.status === 'completed')) return 'completed';
  if (calls.some((call) => call.status === 'cancelled')) return 'cancelled';
  if (run.activePhase === phase.name && (run.status === 'running' || run.status === 'paused')) return run.status;
  return 'queued';
}
function selectedAgent(view: View, calls: WorkflowCall[], phase: string): WorkflowCall | undefined {
  const key = Object.hasOwn(view.agentSelection, phase) ? view.agentSelection[phase] : undefined;
  return calls.find((call) => call.id === key) ?? calls[0];
}
function filteredCalls(run: WorkflowRun, phase: string, filter: number): WorkflowCall[] {
  const status = filters[filter] ?? 'all';
  return run.calls.filter((call) => call.phase === phase && (status === 'all' || call.status === status));
}
function agentRow(call: WorkflowCall, run: WorkflowRun): RuntimeBrowserRow {
  const progress = call.progress ?? call.result?.progress;
  const modelInfo = progress ?? run.calls.find((other) => other.model === call.model && (other.progress ?? other.result?.progress) !== undefined)?.progress;
  const model = modelInfo?.model ?? call.model;
  const context = modelInfo?.maxContextTokens;
  const usage = call.result?.usage;
  const tokens = usage === undefined ? progress?.inputTokens === undefined ? undefined : progress.inputTokens + (progress.outputTokens ?? 0) : usage.input + usage.output;
  const elapsed = call.startedAt === undefined ? progress?.elapsedMs : (call.finishedAt ?? (call.status === 'running' ? Date.now() : run.finishedAt ?? run.updatedAt)) - call.startedAt;
  return { key: call.id, cells: [
    cell(mark(call.status), { width: 1, color: color(call.status) }),
    cell(call.label, { color: color(call.status) }),
    cell(`${model}${context === undefined ? '' : ` (${compact(context)} context)`}`, { width: 27, color: 'muted' }),
    cell(tokens === undefined ? '— tok' : `${compact(tokens)} tok`, { width: 10, align: 'right', color: 'muted' }),
    cell(progress === undefined ? '— tools' : `${progress.toolCalls} tools`, { width: 9, align: 'right', color: 'muted' }),
    cell(elapsed === undefined ? '—' : duration(elapsed), { width: 6, align: 'right', color: 'muted' }),
  ] };
}
async function outputText(api: ViewApi, call: WorkflowCall): Promise<string> {
  const progress = call.progress ?? call.result?.progress;
  const output = call.result?.text ?? (call.taskId === undefined ? '(waiting for output)' : await api.tasks.output(call.taskId));
  const usage = call.result?.usage;
  return [
    `${mark(call.status)} ${call.status} · attempt ${call.attempt} · ${progress?.model ?? call.model}`,
    usage === undefined ? '' : `${compact(usage.input + usage.output)} tokens · ${progress?.toolCalls ?? '—'} tools`,
    call.error === undefined ? '' : `Error: ${call.error}`,
    '', 'Prompt', call.prompt, '', 'Output', output || '(no output yet)',
  ].join('\n');
}

async function projectWorkflow(api: ViewApi): Promise<RuntimeBrowserElement> {
  const runs = await listRuns(api);
  let view = api.view.get<View>('view');
  if (view === undefined || view.screen === undefined) {
    const run = runs.find((item) => item.status === 'running' || item.status === 'paused') ?? runs[0];
    view = { ...initial(), runId: run?.id, phase: run?.activePhase ?? (run === undefined ? undefined : phasesOf(run)[0]?.name) };

  }
  const footer = view.error ?? `Tab/←→ focus · ↑↓ navigate · Enter choose · PgUp/PgDn scroll · Esc cancel · filter: ${filters[view.filter]}`;
  if (view.screen === 'tasks') {
    const tasks = await api.tasks.list();
    const selected = tasks.find((task) => task.id === view.selectedTask) ?? tasks[0];
    const detail = view.taskId === undefined ? undefined : await api.tasks.output(view.taskId);
    return { type: 'browser', title: 'Session tasks', description: 'Session agent and process tasks', summary: `${tasks.length} tasks`, footer, captureEscape: true, columns: [{ id: 'tasks', title: detail === undefined ? 'Tasks' : selected?.title ?? 'Output', focused: true, selectedKey: selected?.id,
      rows: tasks.map((task) => ({ key: task.id, cells: [cell(mark(task.status), { width: 1, color: color(task.status) }), cell(task.title), cell(task.status, { width: 12, color: color(task.status) })] })), text: detail,
    }] };
  }
  const run = runs.find((item) => item.id === view.runId) ?? runs[0];
  if (view.screen === 'runs' || run === undefined) {
    return { type: 'browser', title: 'Workflow runs', description: 'Select a run to browse its phases and agents', summary: `${runs.length} runs`, footer, columns: [{
      id: 'runs', title: 'Runs', focused: true, selectedKey: view.selectedRun ?? run?.id,
      emptyText: 'No workflows yet. Start one with the workflow skill.',
      rows: runs.map((item) => ({ key: item.id, cells: [cell(mark(item.status), { width: 1, color: color(item.status) }), cell(item.name), cell(`${item.calls.filter((call) => call.status === 'completed').length}/${item.calls.length} agents`, { width: 14, color: 'muted', align: 'right' }), cell(item.status, { width: 12, color: color(item.status) })] })),
    }] };
  }
  const phases = phasesOf(run);
  const phase = phases.find((item) => item.name === view.phase) ?? phases.find((item) => item.name === run.activePhase) ?? phases[0];
  const calls = filteredCalls(run, phase?.name ?? '', view.filter);
  const selected = selectedAgent(view, calls, phase?.name ?? '');
  const detail = run.calls.find((call) => call.id === view.callId);
  const completed = run.calls.filter((call) => call.status === 'completed').length;
  const summary = `${completed}/${run.calls.length} agents · ${duration((run.finishedAt ?? (run.status === 'running' || run.status === 'paused' ? Date.now() : run.updatedAt)) - run.createdAt)}${run.status === 'paused' ? ' · paused' : ''}${run.tokenBudget === undefined ? '' : ` · ${compact(run.tokensSpent ?? 0)}/${compact(run.tokenBudget)} tok`}`;
  const columns: RuntimeBrowserColumn[] = [
    { id: 'phases', title: 'Phases', width: 32, focused: view.focus === 'phases', selectedKey: phase?.name, rows: phases.map((item, index) => {
      const status = phaseStatus(run, item);
      const items = run.calls.filter((call) => call.phase === item.name);
      return { key: item.name, cells: [
        cell(status === 'completed' ? '✓' : status === 'failed' ? '✗' : String(index + 1), { width: 1, color: color(status) }),
        cell(item.name, { color: color(status) }),
        cell(items.length === 0 ? '' : `${items.filter((call) => call.status === 'completed').length}/${items.length}`, { width: 7, color: 'muted', align: 'right' }),
      ] };
    }) },
    { id: 'agents', title: detail === undefined ? `${phase?.name ?? 'Work'} · ${calls.length} agents` : detail.label, focused: view.focus === 'agents', selectedKey: selected?.id, rows: detail === undefined ? calls.map((call) => agentRow(call, run)) : [], text: detail === undefined ? undefined : await outputText(api, detail), emptyText: run.error ?? 'This phase has not started yet.' },
  ];
  return { type: 'browser', title: run.name, description: run.description ?? `${phases.length} phases · ${run.status}`, summary, columns, footer, captureEscape: true };
}

async function workflowKey(api: ViewApi, key: string): Promise<void> {
  const runs = await listRuns(api);
  const view: View = { ...(api.view.get<View>('view') ?? initial()), error: undefined };
  const run = runs.find((item) => item.id === view.runId) ?? runs[0];
  const phases = run === undefined ? [] : phasesOf(run);
  const phase = phases.find((item) => item.name === view.phase) ?? phases.find((item) => item.name === run?.activePhase) ?? phases[0];
  const calls = run === undefined ? [] : filteredCalls(run, phase?.name ?? '', view.filter);
  try {
    if (key.startsWith('select:')) {
      const selection = JSON.parse(key.slice('select:'.length)) as { column: string; key: string };
      if (selection.column === 'runs' && runs.some((item) => item.id === selection.key)) view.selectedRun = selection.key;
      else if (selection.column === 'phases' && phases.some((item) => item.name === selection.key)) { view.phase = selection.key; view.callId = undefined; }
      else if (selection.column === 'agents' && calls.some((call) => call.id === selection.key) && phase !== undefined) { view.agentSelection = { ...view.agentSelection, [phase.name]: selection.key }; view.focus = 'agents'; }
      else if (selection.column === 'tasks' && (await api.tasks.list()).some((task) => task.id === selection.key)) view.selectedTask = selection.key;
    } else if (key === 'enter' || key === 'right') {
      if (view.screen === 'tasks') {
        const task = (await api.tasks.list()).find(item => item.id === view.selectedTask) ?? (await api.tasks.list())[0];
        view.taskId = task?.id;
        if (task?.agentId !== undefined) await api.showAgent(task.agentId);
      }
      else if (view.screen === 'runs') {
        const next = runs.find((item) => item.id === view.selectedRun) ?? runs[0];
        view.screen = 'run'; view.runId = next?.id; view.phase = next?.activePhase ?? (next === undefined ? undefined : phasesOf(next)[0]?.name); view.focus = 'phases';
      } else if (view.focus === 'phases') view.focus = 'agents';
      else {
        const call = selectedAgent(view, calls, phase?.name ?? '');
        view.callId = call?.id;
        if (call?.agentId !== undefined) await api.showAgent(call.agentId);
      }
    } else if (key === 'escape' || key === 'left') {
      if (view.taskId !== undefined) view.taskId = undefined;
      else if (view.callId !== undefined) view.callId = undefined;
      else if (view.focus === 'agents' && key === 'left') view.focus = 'phases';
      else { view.screen = 'runs'; view.selectedRun = run?.id; }
    } else if (key === 'tab' || key === 'shift-tab') view.focus = view.focus === 'phases' ? 'agents' : 'phases';
    else if (key === 't') { view.screen = view.screen === 'tasks' ? 'run' : 'tasks'; view.taskId = undefined; }
    else if (key === 'f') { view.filter = (view.filter + 1) % filters.length; view.callId = undefined; }
    else if (key === 'p' || key === 'x' || key === 'r') {
      if (view.screen === 'tasks') {
        if (key !== 'x') throw new Error('Select a workflow to pause or retry');
        const task = (await api.tasks.list()).find(item => item.id === view.selectedTask) ?? (await api.tasks.list())[0];
        if (task === undefined) throw new Error('Select a task first');
        await api.stopTask(task.id);
        api.view.set('view', view);
        return;
      }
      const target = view.screen === 'runs' ? runs.find((item) => item.id === view.selectedRun) ?? run : run;
      if (target === undefined) throw new Error('Select a workflow first');
      const callId = view.focus === 'agents' && view.screen === 'run' ? view.callId ?? selectedAgent(view, calls, phase?.name ?? '')?.id : undefined;
      await controlWorkflow(api, target.id, key === 'p' ? target.status === 'paused' ? 'resume' : 'pause' : key === 'x' ? 'cancel' : 'restart', key === 'p' ? undefined : callId);
    }
  } catch (error) { view.error = error instanceof Error ? error.message : String(error); }
  api.view.set('view', view);
}

interface ViewApi {
  showAgent(id: string): Promise<void>;
  stopTask(id: string): Promise<void>;
  view: { get<T>(key: string): T | undefined; set(key: string, value: View): void };
  tasks: { list(): Promise<readonly RuntimeActivity[]>; output(id: string): Promise<string> };
  runs(): Promise<WorkflowRun[]>;
  control(id: string, action: string, callId?: string): Promise<unknown>;
}
const listRuns = (api: ViewApi): Promise<WorkflowRun[]> => api.runs();
const controlWorkflow = (api: ViewApi, id: string, action: string, callId?: string): Promise<unknown> => api.control(id, action, callId);
declare module 'claude-code' {
  interface PluginState { 'kimi-workflow-ui': { view: StateFamily<View> } }
}
async function viewApi($: EngineInterface, e: RenderInput<'Pane', 'terminal'>, options: { viewId?: string; tasks?: boolean }): Promise<ViewApi> {
  const ref = { plugin: 'kimi-workflow-ui', key: 'view', id: options.viewId ?? e.requestId } as const;
  let view = (await $.state.get(ref)).value;
  if (view === undefined && options.tasks) view = { ...initial(), screen: 'tasks' };
  return {
    showAgent: async agentId => { await $.ui.view({ agentId }); },
    stopTask: taskId => $.workflow.stopTask({ taskId }),
    view: { get: <T>() => view as T | undefined, set: (_key, next) => { view = next; } },
    tasks: { list: () => $.workflow.tasks({}), output: (id) => $.workflow.output({ id }) },
    runs: () => $.workflow.status({}),
    control: (runId, action, callId) => $.workflow.control({ runId, action, callId }),
  };
}
function rowLabel(row: RuntimeBrowserRow, column: RuntimeBrowserColumn, width: number): string {
  let cells = row.cells;
  if (column.id === 'agents' && width < 70) cells = cells.filter((_cell, index) => index !== 2);
  const fixed = cells.map((item, index) => index === 1 ? 0 : Math.min(item.width ?? 0, width < 70 ? index === 0 ? 1 : 8 : 27));
  const available = Math.max(1, width - fixed.reduce((sum, value) => sum + value, 0) - cells.length + 1);
  return cells.map((item, index) => {
    const size = fixed[index] || available;
    const text = item.text.length > size ? item.text.slice(0, Math.max(0, size - 1)) + '…' : item.text;
    return item.align === 'right' ? text.padStart(size) : text.padEnd(size);
  }).join(' ');
}

export async function renderWorkflow($: EngineInterface, e: RenderInput<'Pane', 'terminal'>, options: { viewId?: string; tasks?: boolean } = {}): Promise<RenderElement> {
  const api = await viewApi($, e, options);
  const model = await projectWorkflow(api);
  const columns = e.viewport?.columns ?? 100;
  const phaseWidth = Math.min(32, Math.max(16, Math.floor(columns / 4)));
  const columnWidth = (column: RuntimeBrowserColumn): number => model.columns.length === 1 ? columns - 4 : column.id === 'phases' ? phaseWidth - 4 : columns - phaseWidth - 7;
  const { Box, Text, Select, Button } = $.ui.resolve(e);
  const act = async (key: string, enter = false): Promise<void> => {
    const current = await viewApi($, e, options);
    await workflowKey(current, key);
    if (enter) await workflowKey(current, 'enter');
    await $.state.set({ plugin: 'kimi-workflow-ui', key: 'view', id: options.viewId ?? e.requestId }, current.view.get<View>('view')!);
  };
  return Box({ flexDirection: 'column', gap: 0, children: [
    Box({ flexDirection: 'row', justifyContent: 'space-between', children: [Text({ bold: true, color: 'accent', children: model.title }), Text({ dimColor: true, children: model.summary ?? '' })] }),
    Text({ dimColor: true, children: model.description ?? '' }),
    Box({ flexDirection: 'row', gap: 1, children: model.columns.map(column => Box({ flexDirection: 'column', width: column.width === undefined ? undefined : phaseWidth, flexGrow: column.width === undefined ? 1 : 0, borderStyle: 'single', children: [
      Text({ bold: column.focused, children: column.title }),
      ...(column.text === undefined && column.rows.length > 0 ? [Select({ key: column.id, autoFocus: column.focused ? true : undefined, value: column.selectedKey,
        options: column.rows.map(row => ({ value: row.key, label: rowLabel(row, column, columnWidth(column)) })),
        onSelect: async (value) => { await act(`select:${JSON.stringify({ column: column.id, key: value })}`, column.id !== 'phases'); },
      })] : column.text === undefined ? [] : [Text({ children: column.text })]),
      ...(column.rows.length === 0 && column.text === undefined ? [Text({ dimColor: true, children: column.emptyText ?? 'No items' })] : []),
    ] })) }),
    Box({ flexDirection: 'row', gap: 1, children: [
      Button({ key: 'back', onPress: () => act('escape'), children: 'Back' }),
      Button({ key: 'pause', onPress: () => act('p'), children: 'Pause/resume' }),
      Button({ key: 'stop', onPress: () => act('x'), children: 'Stop' }),
      Button({ key: 'retry', onPress: () => act('r'), children: 'Retry' }),
      Button({ key: 'filter', onPress: () => act('f'), children: `Filter: ${filters[api.view.get<View>('view')?.filter ?? 0]}` }),
      Button({ key: 'toggle-tasks', onPress: () => act('t'), children: 'Tasks' }),
    ] }),
    Text({ dimColor: true, children: model.footer ?? '' }),
  ] });
}
