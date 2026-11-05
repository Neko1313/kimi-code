import type { ProcessTerminal, TUI } from '@moonshot-ai/pi-tui';

import {
  PluginPaneViewer,
  type RuntimeElement,
} from '../components/dialogs/plugin-pane-viewer';
import type { CustomEditor } from '../components/editor/custom-editor';
import { beginScreenTakeover, endScreenTakeover, type ScreenTakeover } from '../utils/screen-takeover';

export interface PluginPaneInfo {
  readonly id: string;
  readonly title: string;
}

export interface PluginUiHost {
  listPanes(): readonly PluginPaneInfo[];
  renderPane(id: string, width: number): Promise<RuntimeElement | undefined>;
  dispatchKey(id: string, key: string): Promise<void>;
  onDidChange(listener: () => void): () => void;
}

const PLUGIN_UI_HOST_KEY = Symbol.for('kimi-code.pluginUiHost');

function getPluginUiHost(): PluginUiHost | undefined {
  return (globalThis as Record<symbol, unknown>)[PLUGIN_UI_HOST_KEY] as PluginUiHost | undefined;
}

export interface PluginPaneViewerState {
  component: PluginPaneViewer;
  takeover: ScreenTakeover;
  paneId: string;
  offChange: () => void;
  pollTimer: NodeJS.Timeout;
}

export interface PluginPanesHost {
  readonly state: {
    pluginPaneViewer: PluginPaneViewerState | undefined;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
  };
  showError(msg: string): void;
  setPluginPaneViewer(value: PluginPaneViewerState | undefined): void;
}

export class PluginPanesController {
  constructor(private readonly host: PluginPanesHost) {}

  async show(): Promise<void> {
    const { state } = this.host;
    if (state.pluginPaneViewer !== undefined) return;

    const uiHost = getPluginUiHost();
    if (uiHost === undefined) {
      this.host.showError('Plugin runtime is not active (enable the plugin_runtime flag).');
      return;
    }
    const panes = uiHost.listPanes();
    if (panes.length === 0) {
      this.host.showError('No plugin panes are open. Run a workflow first (workflow run ...).');
      return;
    }
    const pane = panes[0];
    if (pane === undefined) return;

    const component = new PluginPaneViewer(
      {
        title: pane.title,
        tree: undefined,
        paneId: pane.id,
        onKey: (key) => void this.dispatchKey(pane.id, key),
        onClose: () => this.close(),
      },
      state.terminal,
    );

    const takeover = beginScreenTakeover(state.ui, component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const offChange = uiHost.onDidChange(() => void this.refresh(pane.id));
    const pollTimer = setInterval(() => void this.refresh(pane.id), 1000);

    this.host.setPluginPaneViewer({ component, takeover, paneId: pane.id, offChange, pollTimer });
    await this.refresh(pane.id);
  }

  close(): void {
    const { state } = this.host;
    const viewer = state.pluginPaneViewer;
    if (viewer === undefined) return;
    clearInterval(viewer.pollTimer);
    viewer.offChange();
    endScreenTakeover(state.ui, viewer.takeover);
    this.host.setPluginPaneViewer(undefined);
    state.ui.setFocus(state.editor);
    state.ui.requestRender(true);
  }

  private async dispatchKey(paneId: string, key: string): Promise<void> {
    const uiHost = getPluginUiHost();
    if (uiHost === undefined) return;
    await uiHost.dispatchKey(paneId, key);
    await this.refresh(paneId);
  }

  private async refresh(paneId: string): Promise<void> {
    const { state } = this.host;
    const viewer = state.pluginPaneViewer;
    if (viewer === undefined || viewer.paneId !== paneId) return;
    const uiHost = getPluginUiHost();
    if (uiHost === undefined) return;
    let tree: RuntimeElement | undefined;
    try {
      tree = await uiHost.renderPane(paneId, state.terminal.columns);
    } catch {
      tree = undefined;
    }
    const current = this.host.state.pluginPaneViewer;
    if (current === undefined || current.paneId !== paneId) return;
    current.component.setProps({
      title: uiHost.listPanes().find((p) => p.id === paneId)?.title ?? paneId,
      tree,
      paneId,
      onKey: (key) => void this.dispatchKey(paneId, key),
      onClose: () => this.close(),
    });
    state.ui.requestRender();
  }
}
