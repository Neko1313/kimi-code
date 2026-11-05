import {
  Container,
  HStack,
  Key,
  matchesKey,
  Text,
  VStack,
  type Component,
  type Focusable,
  type Terminal,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { printableChar } from '@/tui/utils/printable-key';

export type PluginUiColor =
  | 'primary'
  | 'success'
  | 'error'
  | 'warning'
  | 'dim'
  | 'muted'
  | 'textStrong';

export type RuntimeElement =
  | {
      readonly type: 'box';
      readonly direction: 'row' | 'column';
      readonly gap?: number;
      readonly children: readonly (RuntimeElement | string)[];
    }
  | { readonly type: 'text'; readonly text: string; readonly color?: PluginUiColor }
  | { readonly type: 'button'; readonly label: string; readonly hotkey?: string };

export interface PluginPaneViewerProps {
  readonly title: string;
  readonly tree: RuntimeElement | undefined;
  readonly paneId: string;
  readonly onKey: (key: string) => void;
  readonly onClose: () => void;
}

const COLOR_TOKENS: Record<PluginUiColor, string> = {
  primary: 'primary',
  success: 'success',
  error: 'error',
  warning: 'warning',
  dim: 'textDim',
  muted: 'textMuted',
  textStrong: 'textStrong',
};

export function buildComponent(element: RuntimeElement | string): Component {
  if (typeof element === 'string') {
    return new Text(element, 0, 0);
  }
  if (element.type === 'text') {
    const token = COLOR_TOKENS[element.color ?? 'textStrong'];
    return new Text(currentTheme.fg(token as never, element.text), 0, 0);
  }
  if (element.type === 'button') {
    const label = element.hotkey !== undefined ? `[${element.label}] (${element.hotkey})` : `[${element.label}]`;
    return new Text(currentTheme.fg('primary', label), 0, 0);
  }
  const children = element.children.map((child) => buildComponent(child));
  if (element.direction === 'row') {
    const row = new HStack();
    for (const child of children) row.addChild(child);
    return row;
  }
  const column = new VStack();
  for (const child of children) column.addChild(child);
  return column;
}

export class PluginPaneViewer extends Container implements Focusable {
  focused = false;

  private props: PluginPaneViewerProps;

  constructor(props: PluginPaneViewerProps, _terminal: Terminal) {
    super();
    this.props = props;
  }

  setProps(props: PluginPaneViewerProps): void {
    this.props = props;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.props.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.props.onKey('up');
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.props.onKey('down');
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.props.onKey('enter');
      return;
    }
    const ch = printableChar(data);
    if (ch === 'q') {
      this.props.onClose();
      return;
    }
    if (ch !== undefined) {
      this.props.onKey(ch);
    }
  }

  override render(width: number): string[] {
    this.clear();
    this.addChild(new Text(currentTheme.fg('primary', this.props.title), 0, 0));
    this.addChild(new Text('', 0, 0));
    if (this.props.tree === undefined) {
      this.addChild(new Text(currentTheme.fg('textDim', '(pane did not render anything)'), 0, 0));
    } else {
      this.addChild(buildComponent(this.props.tree));
    }
    return super.render(width);
  }
}
