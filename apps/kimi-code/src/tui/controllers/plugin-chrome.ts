import { randomUUID } from 'node:crypto';

import { log, type KimiHarness, type Session } from '@moonshot-ai/kimi-code-sdk';
import type { RuntimeElement } from '@moonshot-ai/kimi-code-sdk/plugin';
import { Key, matchesKey } from '@moonshot-ai/pi-tui';

import type { PluginPanesController } from './plugin-panes';
import type { PluginGraphics } from './plugin-graphics';

import { PluginChrome } from '../components/chrome/plugin-chrome';
import { ModsTree } from '../components/dialogs/mods-tree';
import { formatContextStatus } from '../components/chrome/footer';
import { graphicTree } from '../utils/plugin-graphics-tree';
import type { RenderElement } from '@moonshot-ai/kimi-code-sdk/plugin';
import { isExperimentalFlagEnabled } from '../commands/experimental-flags';
import { isBlockingPromptPending, type TUIState } from '../tui-state';
import { PLUGIN_CHROME_MAX_ROWS, PLUGIN_CHROME_POLL_MS, PLUGIN_CHROME_REFRESH_MS, PLUGIN_UI_DISCOVERY_MS } from '../constant/plugin-runtime';

export interface PluginChromeHost {
  readonly session: Session | undefined;
  readonly harness: KimiHarness;
  readonly pluginGraphics: PluginGraphics;
  readonly pluginPanesController: Pick<PluginPanesController,'show'>;
  readonly state: TUIState;
  ensureSession(): Promise<Session | undefined>;
}

export class PluginChromeController {
  private readonly clientId = randomUUID();
  private readonly component: PluginChrome;
  private session: Session | undefined;
  private off: (() => void) | undefined;
  private offInput: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private refreshing = false;
  private dirty = false;
  private nextDiscovery = 0;
  private keys: Promise<void> = Promise.resolve();
  private readonly nativeTrees = new Map<string, ModsTree>();

  constructor(private readonly host: PluginChromeHost) {
    this.component = new PluginChrome(() => this.rows(), (component, key) => this.dispatch(component, key), () => {
      host.state.ui.setFocus(host.state.editor);
      host.state.ui.requestRender();
    }, () => this.refresh(), host.pluginGraphics, () => host.state.ui.requestRender());
    host.state.pluginChromeContainer.addChild(this.component);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.offInput = this.host.state.ui.addInputListener(data => {
      if (!matchesKey(data, Key.ctrlShift('b')) || !this.component.hasContent || isBlockingPromptPending(this.host.state)) return undefined;
      if (this.host.state.editorContainer.children[0] !== this.host.state.editor) return undefined;
      this.host.state.ui.setFocus(this.component.focused ? this.host.state.editor : this.component);
      this.host.state.ui.requestRender();
      return { consume: true };
    });
    this.timer = setInterval(() => this.refresh(), PLUGIN_CHROME_POLL_MS);
    this.timer.unref();
    this.refresh();
  }

  refresh(discover = false): void {
    if (discover) this.nextDiscovery = 0;
    if (!this.started || this.scheduled !== undefined) return;
    this.scheduled = setTimeout(() => { this.scheduled = undefined; void this.update(); }, PLUGIN_CHROME_REFRESH_MS);
    this.scheduled.unref();
  }

  async requiresSession(): Promise<boolean> {
    if (this.host.state.startupState === 'picker') return false;
    if (!isExperimentalFlagEnabled('plugin_runtime') || !this.host.state.appState.model) return false;
    for (const plugin of await this.host.harness.listPlugins()) {
      if (!plugin.enabled || plugin.state !== 'ok') continue;
      if ((await this.host.harness.getPluginInfo(plugin.id)).manifest?.runtime?.capabilities.includes('ui')) return true;
    }
    return false;
  }

  dispose(): void {
    this.started = false;
    this.off?.(); this.off = undefined;
    this.offInput?.(); this.offInput = undefined;
    clearInterval(this.timer); clearTimeout(this.scheduled);
    this.component.setTrees(new Map());
    this.clearNative();
  }

  private clearNative(): void {
    for (const tree of this.nativeTrees.values()) tree.dispose();
    this.nativeTrees.clear();
    this.host.state.footer.setContextOverride(undefined);
    this.host.state.activitySpinner?.instance.setReplacement(undefined);
  }

  private rows(): number { return Math.max(1, Math.min(PLUGIN_CHROME_MAX_ROWS, Math.floor(this.host.state.terminal.rows / 3))); }

  private dispatch(component: string, key: string): void {
    const session = this.session;
    if (session === undefined) return;
    this.keys = this.keys.then(async () => {
      if (!this.started || this.host.session !== session) return;
      const before = await session.plugins.getView({clientId:this.clientId});
      await session.plugins.dispatchSiteKey({ component, key, clientId: this.clientId });
      const view = await session.plugins.getView({clientId:this.clientId});
      if (this.started && this.host.session === session && view.revision !== before.revision && view.paneId !== undefined) await this.host.pluginPanesController.show(undefined,undefined,view.paneId);
      this.refresh();
    }).catch(error => log.warn('Plugin control failed', { error }));
  }

  private async update(): Promise<void> {
    if (this.refreshing) { this.dirty = true; return; }
    this.refreshing = true;
    try {
      do {
        this.dirty = false;
        if (!this.started) return;
        if (!isExperimentalFlagEnabled('plugin_runtime')) {
          this.component.setTrees(new Map());
          this.clearNative();
          if (this.component.focused) this.host.state.ui.setFocus(this.host.state.editor);
          this.host.state.ui.requestRender();
          return;
        }
        let session = this.host.session;
        if (session === undefined && this.host.state.appState.model && Date.now() >= this.nextDiscovery) {
          this.nextDiscovery = Date.now() + PLUGIN_UI_DISCOVERY_MS;
          if (await this.requiresSession()) session = await this.host.ensureSession();
        }
        if (session !== this.session) {
          this.off?.(); this.off = undefined;
          this.session = session;
          this.component.setTrees(new Map());
          this.clearNative();
          if (session !== undefined) {
            const off = await session.plugins.subscribe(() => this.refresh());
            if (!this.started || this.host.session !== session) { off(); return; }
            this.off = off;
          }
        }
        if (session === undefined) { this.host.state.ui.requestRender(); return; }
        const graphics = isExperimentalFlagEnabled('plugin_graphics') && await this.host.pluginGraphics.initialize();
        const surface = graphics && this.host.pluginGraphics.available ? 'desktop' : 'terminal';
        const rows = this.rows();
        const width = Math.max(1, this.component.columns || this.host.state.terminal.columns - 4);
        const trees = new Map<string, RuntimeElement>();
        for (const component of ['AbovePrompt', 'StatusLine', 'Toast']) {
          const tree = await session.plugins.renderSite({ component, surface, width, rows, clientId: this.clientId, props: { isWorking: this.host.state.appState.streamingPhase !== 'idle', hasSurvey: isBlockingPromptPending(this.host.state) } });
          if (!this.started || this.host.session !== session) return;
          if (tree !== undefined) trees.set(component,tree);
        }
        const state = this.host.state.appState;
        const spinner = this.host.state.activitySpinner?.instance;
        const contextText = formatContextStatus(state.contextUsage, state.contextTokens, state.maxContextTokens);
        const sites = [
          { component: 'ContextUsage', text: contextText, props: { text: contextText, tokens: state.contextTokens, window: state.maxContextTokens, percent: state.contextUsage * 100 } },
          ...(spinner === undefined ? [] : [{ component: 'Spinner', text: spinner.getLabel(), props: { word: spinner.getLabel(), message: '', suffix: '', mode: state.streamingPhase } }]),
        ];
        for (const site of sites) {
          const key = `kimi-native-${site.component}`;
          const defaultTree: RenderElement = { type: 'Text', props: { key }, children: [site.text] };
          const result = await session.plugins.renderSite({ component: site.component, surface, width, rows, clientId: this.clientId, props: site.props, defaultTree });
          if (!this.started || this.host.session !== session) return;
          let replacement = this.nativeTrees.get(site.component);
          if (result === undefined || JSON.stringify(result) === JSON.stringify(defaultTree)) {
            replacement?.dispose(); this.nativeTrees.delete(site.component); replacement = undefined;
          } else {
            const value = graphicTree(result) as RenderElement;
            if (replacement) replacement.setTree(value);
            else {
              replacement = new ModsTree(value, key => this.dispatch(site.component, key), () => 1, this.host.pluginGraphics, true, (name, columns, node) => {
                if (name !== key) return undefined;
                const value = typeof node.children?.[0] === 'string' ? node.children[0] : undefined;
                if (site.component === 'Spinner') {
                  const current = this.host.state.activitySpinner?.instance;
                  return current?.renderNative(columns).map(line => value === undefined ? line : line.replace(current.getLabel(), value));
                }
                return [value ?? formatContextStatus(this.host.state.appState.contextUsage, this.host.state.appState.contextTokens, this.host.state.appState.maxContextTokens)];
              });
              this.nativeTrees.set(site.component, replacement);
            }
          }
          if (site.component === 'Spinner') spinner?.setReplacement(replacement);
          else this.host.state.footer.setContextOverride(replacement);
        }
        this.component.setTrees(trees);
        this.host.state.ui.requestRender();
      } while (this.dirty);
    } catch (error) { log.warn('Plugin chrome refresh failed', { error }); }
    finally { this.refreshing = false; }
  }
}
