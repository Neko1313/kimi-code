import type { RuntimeElement } from '@moonshot-ai/kimi-code-sdk';
import {
  HStack, Key, matchesKey, ScrollView, Text, truncateToWidth, VStack,
  type Component, type Focusable, type Terminal,
} from '@moonshot-ai/pi-tui';

import type { PluginGraphics } from '#/tui/controllers/plugin-graphics';

import { ModsTree } from './mods-tree';
import type { RenderElement } from '@moonshot-ai/kimi-code-sdk/plugin';

import { currentTheme, type ColorToken } from '#/tui/theme';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';
import { hasSvg, graphicTree } from '#/tui/utils/plugin-graphics-tree';
import { printableChar } from '#/tui/utils/printable-key';

export type { RuntimeElement } from '@moonshot-ai/kimi-code-sdk';

export interface PluginPaneViewerProps {
  readonly title: string;
  readonly graphics?: PluginGraphics;
  readonly closeOnEscape?: boolean;
  readonly tree: RuntimeElement | undefined;
  readonly paneId: string;
  readonly onKey: (key: string) => void;
  readonly onClose: () => void;
  readonly onBlur?: () => void;
  readonly onCycle?: (direction: number) => void;
  readonly requestRender?: () => void;
  readonly rows?: number;
  readonly onResize?: () => void;
}

const COLOR_TOKENS: Record<NonNullable<Extract<RuntimeElement, { type: 'text' }>['color']>, ColorToken> = {
  primary: 'primary', success: 'success', error: 'error', warning: 'warning',
  dim: 'textDim', muted: 'textMuted', textStrong: 'textStrong',
};

export function buildComponent(element: RuntimeElement | string): Component {
  if (typeof element !== 'string' && /^[A-Z]/.test(element.type)) return new ModsTree(element as RenderElement, () => {}, () => 24);
  if (typeof element === 'string') return new Text(sanitizeShellOutput(element), 0, 0);
  if (element.type === 'text') return new Text(currentTheme.fg(COLOR_TOKENS[element.color ?? 'textStrong'], sanitizeShellOutput(element.text)), 0, 0);
  if (element.type === 'button') {
    const label = element.hotkey === undefined ? `[${element.label}]` : `[${element.label}] (${element.hotkey})`;
    return new Text(currentTheme.fg('primary', sanitizeShellOutput(label)), 0, 0);
  }
  if (element.type !== 'box') return new Text('', 0, 0);
  const stack = element.direction === 'row' ? new HStack([], { gap: element.gap }) : new VStack([], { gap: element.gap });
  for (const child of element.children) stack.addChild(buildComponent(child));
  return stack;
}

function selectedNode(tree: RuntimeElement | undefined): Extract<RuntimeElement, { type: 'text' }> | undefined {
  if (tree?.type === 'text') return tree.selected ? tree : undefined;
  if (tree?.type !== 'box') return undefined;
  for (const child of tree.children) {
    const found = typeof child === 'string' ? undefined : selectedNode(child);
    if (found !== undefined) return found;
  }
  return undefined;
}
function buttonAction(tree: RuntimeElement | undefined, key: string): string | undefined {
  if (tree?.type === 'button' && tree.hotkey === key) return tree.action;
  if (tree?.type !== 'box') return undefined;
  for (const child of tree.children) {
    const action = typeof child === 'string' ? undefined : buttonAction(child, key);
    if (action !== undefined) return action;
  }
  return undefined;
}

export class PluginPaneViewer extends VStack implements Focusable {
  focused = false;
  readonly scroll: ScrollView;
  private readonly header = new Text('', 0, 0);
  private readonly footer = new Text('', 0, 0);
  private body: Component = new Text('Loading…', 0, 0);
  private browser: ModsTree | undefined;
  private viewport: string | undefined;
  private selection: string | undefined;
  private reveal = false;

  constructor(private props: PluginPaneViewerProps, private readonly terminal: Terminal) {
    super();
    this.scroll = new ScrollView({ render: (width) => this.renderBody(width), invalidate: () => this.body.invalidate() }, {
      overscroll: 'contain', scrollbar: 'always',
      scrollbarTrackStyle: (text) => currentTheme.fg('textDim', text),
      scrollbarThumbStyle: (text) => currentTheme.fg('primary', text),
    });
    this.addChild(this.header, { shrink: 0 });
    this.addChild(this.scroll, { basis: 0, grow: 1, minSize: 1 });
    this.addChild(this.footer, { shrink: 0 });
    this.setProps(props);
  }

  setProps(props: PluginPaneViewerProps): void {
    if (props.tree !== undefined && (/^[A-Z]/.test(props.tree.type) || hasSvg(props.tree))) {
      this.props = props;
      if (this.browser === undefined) {
        this.browser = new ModsTree(graphicTree(props.tree) as RenderElement, (key) => this.props.onKey(key), () => Math.max(1, (this.props.rows ?? this.terminal.rows) - 5), this.props.graphics);
        this.clear();
        this.addChild(this.browser, { grow: 1, minSize: 1 });
      } else this.browser.setTree(graphicTree(props.tree) as RenderElement);
      return;
    }
    if (this.browser !== undefined) {
      this.browser.dispose();
      this.browser = undefined;
      this.clear();
      this.addChild(this.header, { shrink: 0 });
      this.addChild(this.scroll, { basis: 0, grow: 1, minSize: 1 });
      this.addChild(this.footer, { shrink: 0 });
    }
    const node = selectedNode(props.tree);
    const next = `${props.paneId}/${node?.key ?? ''}`;
    this.reveal ||= next !== this.selection;
    this.selection = next;
    this.props = props;
    this.body = props.tree === undefined ? new Text('No content.', 0, 0) : buildComponent(props.tree);
    this.header.setText(currentTheme.fg('primary', `│ ${sanitizeShellOutput(props.title)}`));
    this.footer.setText(currentTheme.fg('textMuted', 'PgUp/PgDn scroll · Tab pane · q close'));
  }

  dispose(): void { this.browser?.dispose(); }

  handleInput(data: string): void {
    if (this.browser?.handleInput(data)) { this.props.requestRender?.(); return; }
    if (matchesKey(data, Key.escape)) {
      if (this.props.closeOnEscape === false) this.props.onKey('escape');
      else if ((this.props.tree?.type === 'box') && this.props.tree.captureEscape) this.props.onKey('escape');
      else (this.props.onBlur ?? this.props.onClose)();
    } else if (matchesKey(data, Key.tab)) { if (this.browser !== undefined) this.props.onKey('tab'); else this.props.onCycle?.(1); }
    else if (matchesKey(data, Key.shift('tab'))) { if (this.browser !== undefined) this.props.onKey('shift-tab'); else this.props.onCycle?.(-1); }
    else if (matchesKey(data, Key.pageUp)) this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.pageDown)) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.home)) this.scroll.scrollToStart();
    else if (matchesKey(data, Key.end)) this.scroll.scrollToEnd();
    else if (matchesKey(data, Key.up)) this.props.onKey('up');
    else if (matchesKey(data, Key.down)) this.props.onKey('down');
    else if (matchesKey(data, Key.left)) this.props.onKey('left');
    else if (matchesKey(data, Key.right)) this.props.onKey('right');
    else if (matchesKey(data, Key.enter)) this.props.onKey('enter');
    else {
      const ch = printableChar(data);
      if (ch === 'q') this.props.onClose();
      else if (ch === 'j' || ch === 'k') this.scroll.scrollBy(ch === 'j' ? 1 : -1);
      else if (ch !== undefined) {
        const action = buttonAction(this.props.tree, ch);
        this.props.onKey(action === undefined ? ch : `action:${action}`);
      }
    }
    this.props.requestRender?.();
  }

  private renderBody(width: number): string[] {
    const lines = this.body.render(width);
    if (this.reveal && this.scroll.viewportHeight > 0) {
      this.reveal = false;
      const selected = selectedNode(this.props.tree);
      const index = selected === undefined ? 0 : lines.findIndex((line) => line.includes(sanitizeShellOutput(selected.text).slice(0, Math.max(1, Math.min(16, width)))));
      this.scroll.updateLayout(lines.length, this.scroll.viewportHeight, () => this.props.requestRender?.());
      if (index < this.scroll.scrollTop) this.scroll.scrollTo(Math.max(0, index));
      else if (index >= this.scroll.scrollTop + this.scroll.viewportHeight) this.scroll.scrollTo(index - this.scroll.viewportHeight + 1);
    }
    return lines;
  }

  override render(width: number): string[] {
    const viewport = `${width}:${this.terminal.rows}`;
    if (this.viewport !== undefined && this.viewport !== viewport && this.props.onResize !== undefined) queueMicrotask(() => this.props.onResize?.());
    this.viewport = viewport;
    if (this.browser !== undefined) {
      this.browser.setActive(this.focused);
      const border = currentTheme.fg('primary', '─'.repeat(Math.max(1, width)));
      return [border, currentTheme.fg('primary', currentTheme.bold(` ${sanitizeShellOutput(this.props.title)}`)),
        currentTheme.fg('textMuted', ' Tab controls · ↑↓ navigate · Enter select · PgUp/PgDn scroll · Esc cancel'), '',
        ...this.browser.render(Math.max(1, width - 2)).map(line => /\u001B(?:_G|\]1337;File=)/.test(line) ? line : ` ${line}`), border,
      ].map(line => /\u001B(?:_G|\]1337;File=)/.test(line) ? line : truncateToWidth(line, width));
    }
    const lines = this.body.render(Math.max(1, width - 1));
    this.scroll.updateLayout(lines.length, Math.max(1, (this.props.rows ?? this.terminal.rows) - 2), () => this.props.requestRender?.());
    const body = this.renderBody(Math.max(1, width - 1));
    return [...this.header.render(width), ...body.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.scroll.viewportHeight), ...this.footer.render(width)];
  }
}
