import {
  Container,
  Key,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  type Focusable,
  type Terminal,
} from '@moonshot-ai/pi-tui';

import { FAILURE_MARK, SELECT_POINTER, SUCCESS_MARK } from '@/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '@/tui/utils/printable-key';

export type WorkflowRow =
  | { readonly kind: 'plan'; readonly planIdx: number; readonly label: string; readonly ok: boolean }
  | { readonly kind: 'stage'; readonly planIdx: number; readonly label: string; readonly okCount: number; readonly total: number }
  | { readonly kind: 'item'; readonly planIdx: number; readonly label: string; readonly ok: boolean; readonly detail: string };

export interface WorkflowBrowserProps {
  readonly rows: readonly WorkflowRow[];
  readonly selectedIndex: number;
  readonly failedOnly: boolean;
  readonly storeLabel: string;
  readonly emptyLabel: string;
  readonly onMove: (delta: number) => void;
  readonly onToggleExpand: () => void;
  readonly onToggleFilter: () => void;
  readonly onReload: () => void;
  readonly onClose: () => void;
}

const DETAIL_HEIGHT = 8;

export class WorkflowBrowserApp extends Container implements Focusable {
  focused = false;

  private props: WorkflowBrowserProps;
  private readonly terminal: Terminal;

  constructor(props: WorkflowBrowserProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
  }

  setProps(props: WorkflowBrowserProps): void {
    this.props = props;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.props.onMove(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.props.onMove(1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.props.onToggleExpand();
      return;
    }
    const ch = printableChar(data);
    if (ch === 'q' || matchesKey(data, Key.escape)) {
      this.props.onClose();
      return;
    }
    if (ch === 'f') {
      this.props.onToggleFilter();
      return;
    }
    if (ch === 'r') {
      this.props.onReload();
    }
  }

  override render(width: number): string[] {
    this.clear();
    const p = this.props;
    const dim = (text: string): string => currentTheme.fg('textDim', text);
    const muted = (text: string): string => currentTheme.fg('textMuted', text);
    const error = (text: string): string => currentTheme.fg('error', text);
    const success = (text: string): string => currentTheme.fg('success', text);

    const title = 'Workflow runs';
    const filter = p.failedOnly ? dim(' [failed only]') : '';
    this.addChild(new Text(`${currentTheme.fg('primary', title)}${filter}`, 0, 0));
    this.addChild(new Text(muted(p.storeLabel), 0, 1));
    this.addChild(new Spacer(1));

    if (p.rows.length === 0) {
      this.addChild(new Text(dim(p.emptyLabel), 0, 0));
    }

    const listHeight = Math.max(1, this.terminal.rows - DETAIL_HEIGHT - 6);
    const start = this.windowStart(p.selectedIndex, listHeight);
    const windowRows = p.rows.slice(start, start + listHeight);

    windowRows.forEach((row, offset) => {
      const index = start + offset;
      const pointer = index === p.selectedIndex ? currentTheme.fg('primary', SELECT_POINTER) : ' ';
      if (row.kind === 'plan') {
        const mark = row.ok ? success(SUCCESS_MARK) : error(FAILURE_MARK);
        this.addChild(new Text(`${pointer}${mark}${row.label}`, 0, 0));
        return;
      }
      if (row.kind === 'stage') {
        const line = `  ${row.label} ${muted(`${row.okCount}/${row.total} ok`)}`;
        this.addChild(new Text(pointer + line, 0, 0));
        return;
      }
      const mark = row.ok ? success(SUCCESS_MARK) : error(FAILURE_MARK);
      this.addChild(new Text(`${pointer}  ${mark}${row.label}`, 0, 0));
    });

    const selected = p.rows[p.selectedIndex];
    this.addChild(new Spacer(1));
    this.addChild(new Text(dim('─'.repeat(Math.max(4, width - 2))), 0, 0));
    if (selected?.kind === 'item') {
      this.addChild(new Text(muted(selected.label), 0, 0));
      const lines = selected.detail.length > 0 ? selected.detail.trimEnd().split('\n') : ['(no output)'];
      for (const line of lines.slice(-(DETAIL_HEIGHT - 3))) {
        this.addChild(new Text(truncateToWidth(line, Math.max(8, width - 4), '…'), 2, 0));
      }
    } else if (selected !== undefined) {
      this.addChild(new Text(dim(`${selected.kind}: ${selected.label}`), 0, 0));
    } else {
      this.addChild(new Text(dim('no runs yet'), 0, 0));
    }

    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        muted('↑/↓ move · Enter expand/collapse · f failed-only · r reload · q/Esc close'),
        0,
        0,
      ),
    );
    return super.render(width);
  }

  private windowStart(selected: number, height: number): number {
    if (selected < height) return 0;
    return selected - height + 1;
  }
}
