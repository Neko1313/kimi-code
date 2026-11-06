import { randomUUID } from 'node:crypto';

import { log, type PluginPaneInfo, type Session } from '@moonshot-ai/kimi-code-sdk';
import type { Component, Focusable, ProcessTerminal, TUI } from '@moonshot-ai/pi-tui';
import { TuiAltScreen, VStack } from '@moonshot-ai/pi-tui';

import { isExperimentalFlagEnabled } from '../commands/experimental-flags';
import type { PluginGraphics } from './plugin-graphics';

import { PluginPaneViewer } from '../components/dialogs/plugin-pane-viewer';
import { AgentTranscriptView } from '../components/messages/agent-transcript-view';

export interface PluginPaneViewerState {
  component: PluginPaneViewer;
  paneId: string;
  offChange: () => void;
}
export interface PluginPanesHost {
  readonly session: Session | undefined;
  readonly pluginGraphics: PluginGraphics;
  readonly state: {
    pluginPaneViewer: PluginPaneViewerState | undefined;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
  };
  showError(msg: string): void;
  showNotice(title: string, detail?: string): void;
  setPluginPaneViewer(value: PluginPaneViewerState | undefined): void;
  mountEditorReplacement(panel: Component & Focusable, onDisplaced?: () => void, onReplaced?: () => void): void;
  restoreEditor(): void;
}

export class PluginPanesController {
  private readonly clientId = randomUUID();
  private refreshing = false;
  private dirty = false;
  private keyQueue: Promise<void> = Promise.resolve();
  private panes: readonly PluginPaneInfo[] = [];
  private viewRevision = 0;
  private originalRoot: Component | undefined;
  private transcript: { agentId: string; component: AgentTranscriptView } | undefined;
  private lastTranscriptRefresh = 0;

  constructor(private readonly host: PluginPanesHost) {}

  async show(command?: string, args?: string, sitePaneId?: string): Promise<void> {
    const session = this.host.session;
    if (session === undefined) return;
    try {
      const result = command === undefined ? undefined : await session.plugins.runCommand({ name: command, args });
      this.panes = await session.plugins.listPanes();
      if (this.host.session !== session) return;
      const requestedId = sitePaneId ?? (result !== null && typeof result === 'object' && 'paneId' in result && typeof result.paneId === 'string' ? result.paneId : undefined);
      const requestedPane = command === undefined && sitePaneId === undefined ? undefined : this.panes.find(pane => requestedId === undefined ? pane.pluginId === command?.split(':')[0] : pane.id === requestedId);
      if (command !== undefined && requestedPane === undefined) {
        this.host.showNotice(command, result === undefined ? undefined : typeof result === 'string' ? result : JSON.stringify(result, null, 2));
        return;
      }
      if (this.panes.length === 0) { this.host.showError('No plugin panes are open. Enable a runtime plugin first.'); return; }
      const { state } = this.host;
      if (state.pluginPaneViewer !== undefined) {
        if (requestedPane !== undefined) state.pluginPaneViewer.paneId = requestedPane.id;
        state.ui.setFocus(state.pluginPaneViewer.component);
        await this.refresh();
        return;
      }
      const pane = requestedPane ?? this.panes[0]!;
      const component = new PluginPaneViewer({ title: pane.title, tree: undefined, paneId: pane.id, onKey: key => void this.dispatchKey(key), onClose: () => this.close() }, state.terminal);
      const viewer: PluginPaneViewerState = { component, paneId: pane.id, offChange: () => {} };
      this.host.setPluginPaneViewer(viewer);
      this.host.mountEditorReplacement(component, undefined, () => {
        if (state.pluginPaneViewer !== viewer) return;
        viewer.offChange(); viewer.component.dispose();
        this.restoreTranscript();
        this.host.setPluginPaneViewer(undefined);
      });
      viewer.offChange = await session.plugins.subscribe(() => void this.refresh());
      if (state.pluginPaneViewer !== viewer) { viewer.offChange(); return; }
      await this.refresh();
    } catch (error) {
      this.close();
      this.host.showError(error instanceof Error ? error.message : String(error));
    }
  }

  async showSite(component: string): Promise<boolean> {
    if (isExperimentalFlagEnabled('plugin_graphics')) await this.host.pluginGraphics.initialize();
    const id = await this.host.session?.plugins.openSite({ component, surface: isExperimentalFlagEnabled('plugin_graphics') && this.host.pluginGraphics.available ? 'desktop' : 'terminal' });
    if (id === undefined) return false;
    await this.show(undefined, undefined, id);
    return true;
  }

  close(): void {
    const viewer = this.host.state.pluginPaneViewer;
    if (viewer === undefined) return;
    viewer.offChange(); viewer.component.dispose();
    void this.host.session?.plugins.closePane({id:viewer.paneId}).catch(error => { log.warn('Plugin pane close failed',{error}); });
    this.restoreTranscript();
    this.host.setPluginPaneViewer(undefined);
    this.host.restoreEditor();
    this.host.state.ui.requestRender();
  }

  private async cycle(direction: number): Promise<void> {
    const viewer = this.host.state.pluginPaneViewer;
    if (viewer === undefined || this.panes.length === 0) return;
    const index = this.panes.findIndex(pane => pane.id === viewer.paneId);
    viewer.paneId = this.panes[(index + direction + this.panes.length) % this.panes.length]!.id;
    await this.refresh();
  }

  private async dispatchKey(key: string): Promise<void> {
    const { session, state } = this.host;
    const viewer = state.pluginPaneViewer;
    if (session === undefined || viewer === undefined) return;
    this.keyQueue = this.keyQueue.then(async () => {
      if (state.pluginPaneViewer !== viewer || this.host.session !== session) return;
      await session.plugins.dispatchKey({ id: viewer.paneId, key, clientId: this.clientId });
      await this.refresh();
    }).catch((error: unknown) => this.host.showError(error instanceof Error ? error.message : String(error)));
    await this.keyQueue;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) { this.dirty = true; return; }
    this.refreshing = true;
    try {
      do {
        this.dirty = false;
        const { state, session } = this.host;
        const viewer = state.pluginPaneViewer;
        if (viewer === undefined || session === undefined) return;
        const view = await session.plugins.getView({ clientId: this.clientId });
        if (state.pluginPaneViewer !== viewer || this.host.session !== session) return;
        if (view.revision !== this.viewRevision) {
          this.viewRevision = view.revision;
          if (view.paneId !== undefined) viewer.paneId = view.paneId;
          if (view.agentId === undefined) this.restoreTranscript();
          else this.openTranscript(view.agentId);
        }
        if (this.transcript !== undefined && Date.now() - this.lastTranscriptRefresh > 250) {
          this.lastTranscriptRefresh = Date.now();
          const transcript = this.transcript;
          const context = await session.getAgentContext(transcript.agentId);
          if (this.transcript === transcript && this.host.session === session) transcript.component.setMessages(context.history);
        }
        this.panes = await session.plugins.listPanes();
        const pane = this.panes.find(item => item.id === viewer.paneId) ?? this.panes[0];
        if (pane === undefined) { this.close(); return; }
        viewer.paneId = pane.id;
        const width = Math.max(1, state.terminal.columns - 4);
        const rows = Math.max(6, Math.min(pane.rows ?? 20, Math.floor(state.terminal.rows * 0.55)));
        if (isExperimentalFlagEnabled('plugin_graphics')) await this.host.pluginGraphics.initialize();
        const tree = await session.plugins.renderPane({ surface: isExperimentalFlagEnabled('plugin_graphics') && this.host.pluginGraphics.available ? 'desktop' : 'terminal', id: pane.id, width, rows: Math.max(1, rows - 5), placement: 'inline', clientId: this.clientId });
        if (state.pluginPaneViewer !== viewer || this.host.session !== session) return;
        viewer.component.setProps({ closeOnEscape:pane.closeOnEscape, graphics: this.host.pluginGraphics, rows, title: `${pane.title} (${this.panes.findIndex(item => item.id === pane.id) + 1}/${this.panes.length})`, tree, paneId: pane.id,
          onKey: key => void this.dispatchKey(key), onClose: () => this.close(),
          onCycle: direction => void this.cycle(direction), onResize: () => void this.refresh(), requestRender: () => state.ui.requestRender(),
        });
        state.ui.requestRender();
      } while (this.dirty);
    } catch (error) { this.host.showError(error instanceof Error ? error.message : String(error)); }
    finally { this.refreshing = false; }
  }

  private openTranscript(agentId: string): void {
    const { ui } = this.host.state;
    if (!(ui instanceof TuiAltScreen)) { this.host.showNotice('Agent transcript', 'Transcript viewing requires fullscreen mode.'); return; }
    if (this.transcript?.agentId === agentId) return;
    this.originalRoot ??= ui.getLayoutRoot();
    const root = this.originalRoot;
    if (!(root instanceof VStack) || root.children[1] === undefined) return;
    const component = new AgentTranscriptView(agentId, () => this.restoreTranscript(), () => ui.requestRender());
    const layout = new VStack();
    layout.addChild(component, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
    layout.addChild(root.children[1], { basis: 'auto', grow: 0, shrink: 1, minSize: 1 });
    this.transcript = { agentId, component };
    this.lastTranscriptRefresh = 0;
    ui.setLayoutRoot(layout);
    ui.setFocus(component);
    ui.requestRender();
  }

  private restoreTranscript(): void {
    const { ui, pluginPaneViewer } = this.host.state;
    if (this.originalRoot !== undefined && ui instanceof TuiAltScreen) ui.setLayoutRoot(this.originalRoot);
    this.originalRoot = undefined;
    this.transcript = undefined;
    if (pluginPaneViewer !== undefined) ui.setFocus(pluginPaneViewer.component);
    ui.requestRender();
  }
}
