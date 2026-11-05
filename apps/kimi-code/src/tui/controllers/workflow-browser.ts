import { readFile, stat } from 'node:fs/promises';

import type { ProcessTerminal, TUI } from '@moonshot-ai/pi-tui';

import {
  WorkflowBrowserApp,
  type WorkflowBrowserProps,
  type WorkflowRow,
} from '../components/dialogs/workflow-browser';
import type { CustomEditor } from '../components/editor/custom-editor';
import {
  countPlanItems,
  parseWorkflowStore,
  resolveWorkflowStorePath,
  type WorkflowPlanGroup,
} from '../utils/workflow-store';
import { getDataDir } from '#/utils/paths';
import { beginScreenTakeover, endScreenTakeover, type ScreenTakeover } from '../utils/screen-takeover';

export interface WorkflowBrowserState {
  component: WorkflowBrowserApp;
  takeover: ScreenTakeover;
  plans: readonly WorkflowPlanGroup[];
  selectedIndex: number;
  expandedPlans: ReadonlySet<string>;
  failedOnly: boolean;
  lastMtimeMs: number;
  pollTimer: NodeJS.Timeout;
}

export interface WorkflowBrowserHost {
  readonly state: {
    workflowBrowser: WorkflowBrowserState | undefined;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
  };
  showError(msg: string): void;
  setWorkflowBrowser(value: WorkflowBrowserState | undefined): void;
}

export class WorkflowBrowserController {
  constructor(private readonly host: WorkflowBrowserHost) {}

  async show(): Promise<void> {
    const { state } = this.host;
    if (state.workflowBrowser !== undefined) return;

    const storePath = resolveWorkflowStorePath(getDataDir());
    const { plans, mtimeMs } = await this.loadPlans(storePath);
    const expandedPlans = new Set<string>(plans.filter((plan) => !plan.ok).map((plan) => plan.name));
    const failedOnly = false;
    const rows = buildRows(plans, expandedPlans, failedOnly);
    const selectedIndex = rows.length > 0 ? 0 : -1;

    const component = new WorkflowBrowserApp(
      this.buildProps(storePath, plans, expandedPlans, failedOnly, rows, selectedIndex),
      state.terminal,
    );
    const takeover = beginScreenTakeover(state.ui, component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.poll(storePath);
    }, 1000);

    this.host.setWorkflowBrowser({
      component,
      takeover,
      plans,
      selectedIndex,
      expandedPlans,
      failedOnly,
      lastMtimeMs: mtimeMs,
      pollTimer,
    });
  }

  close(): void {
    const { state } = this.host;
    const browser = state.workflowBrowser;
    if (browser === undefined) return;
    clearInterval(browser.pollTimer);
    endScreenTakeover(state.ui, browser.takeover);
    this.host.setWorkflowBrowser(undefined);
    state.ui.setFocus(state.editor);
    state.ui.requestRender(true);
  }

  move(delta: number): void {
    const browser = this.host.state.workflowBrowser;
    if (browser === undefined) return;
    const rows = this.currentRows(browser);
    if (rows.length === 0) return;
    const next = Math.min(rows.length - 1, Math.max(0, browser.selectedIndex + delta));
    this.pushState({ ...browser, selectedIndex: next });
  }

  toggleExpand(): void {
    const browser = this.host.state.workflowBrowser;
    if (browser === undefined) return;
    const rows = this.currentRows(browser);
    const selected = rows[browser.selectedIndex];
    if (selected === undefined || selected.kind !== 'plan') return;
    const expanded = new Set(browser.expandedPlans);
    if (expanded.has(selected.label)) {
      expanded.delete(selected.label);
    } else {
      expanded.add(selected.label);
    }
    this.pushState({ ...browser, expandedPlans: expanded });
  }

  toggleFilter(): void {
    const browser = this.host.state.workflowBrowser;
    if (browser === undefined) return;
    this.pushState({ ...browser, failedOnly: !browser.failedOnly });
  }

  async reload(): Promise<void> {
    const browser = this.host.state.workflowBrowser;
    if (browser === undefined) return;
    const storePath = resolveWorkflowStorePath(getDataDir());
    const { plans, mtimeMs } = await this.loadPlans(storePath);
    this.pushState({ ...browser, plans, lastMtimeMs: mtimeMs });
  }

  private async poll(storePath: string): Promise<void> {
    const browser = this.host.state.workflowBrowser;
    if (browser === undefined) return;
    let mtimeMs = browser.lastMtimeMs;
    try {
      mtimeMs = (await stat(storePath)).mtimeMs;
    } catch {
      mtimeMs = -1;
    }
    if (mtimeMs === browser.lastMtimeMs) return;
    await this.reload();
  }

  private async loadPlans(
    storePath: string,
  ): Promise<{ plans: readonly WorkflowPlanGroup[]; mtimeMs: number }> {
    let text: string;
    let mtimeMs = -1;
    try {
      text = await readFile(storePath, 'utf8');
      mtimeMs = (await stat(storePath)).mtimeMs;
    } catch {
      return { plans: [], mtimeMs };
    }
    return { plans: parseWorkflowStore(text), mtimeMs };
  }

  private currentRows(browser: WorkflowBrowserState): readonly WorkflowRow[] {
    return buildRows(browser.plans, browser.expandedPlans, browser.failedOnly);
  }

  private pushState(next: WorkflowBrowserState): void {
    const rows = this.currentRows(next);
    const selectedIndex =
      next.selectedIndex < 0
        ? rows.length > 0
          ? 0
          : -1
        : Math.min(next.selectedIndex, Math.max(0, rows.length - 1));
    const storePath = resolveWorkflowStorePath(getDataDir());
    const state: WorkflowBrowserState = { ...next, selectedIndex };
    this.host.setWorkflowBrowser(state);
    state.component.setProps(
      this.buildProps(storePath, state.plans, state.expandedPlans, state.failedOnly, rows, selectedIndex),
    );
    this.host.state.ui.requestRender();
  }

  private buildProps(
    storePath: string,
    plans: readonly WorkflowPlanGroup[],
    expandedPlans: ReadonlySet<string>,
    failedOnly: boolean,
    rows: readonly WorkflowRow[],
    selectedIndex: number,
  ): WorkflowBrowserProps {
    return {
      rows,
      selectedIndex,
      failedOnly,
      storeLabel: `store: ${storePath}`,
      emptyLabel:
        'No workflow runs yet. Run one: workflow run {"name":"demo","stages":[{"id":"s","type":"sequential","worker":{"command":"echo","argsTemplate":["hi"]}}]}',
      onMove: (delta) => this.move(delta),
      onToggleExpand: () => this.toggleExpand(),
      onToggleFilter: () => this.toggleFilter(),
      onReload: () => void this.reload(),
      onClose: () => this.close(),
    };
  }
}

export function buildRows(
  plans: readonly WorkflowPlanGroup[],
  expandedPlans: ReadonlySet<string>,
  failedOnly: boolean,
): readonly WorkflowRow[] {
  const rows: WorkflowRow[] = [];
  plans.forEach((plan, planIdx) => {
    const counts = countPlanItems(plan);
    rows.push({
      kind: 'plan',
      planIdx,
      label: `${plan.name}  ${counts.ok}/${counts.total}`,
      ok: plan.ok,
    });
    if (!expandedPlans.has(plan.name)) return;
    for (const stage of plan.stages) {
      rows.push({
        kind: 'stage',
        planIdx,
        label: stage.stageId,
        okCount: stage.okCount,
        total: stage.items.length,
      });
      for (const item of stage.items) {
        if (failedOnly && item.exitCode === 0) continue;
        rows.push({
          kind: 'item',
          planIdx,
          label: `${item.item} · r${item.round} · exit ${item.exitCode}`,
          ok: item.exitCode === 0,
          detail: item.stdout,
        });
      }
    }
  });
  return rows;
}
