import type { RenderElement, RenderNode } from '@moonshot-ai/kimi-code-sdk/plugin';
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@moonshot-ai/pi-tui';

import type { PluginGraphics, PluginGraphicsView } from '#/tui/controllers/plugin-graphics';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

type Option = { value: string; label?: string };
interface Selection { list: SearchableList<Option>; top: number; drawnValue?: string }
const clean = (value: unknown): string => sanitizeShellOutput(typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '').replaceAll('\t', '  ');
const fit = (value: string, width: number): string => {
  if (width <= 0) return '';
  const clipped = truncateToWidth(value, Math.max(1, width), '…');
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
};

export class ModsTree implements Component {
  private readonly selections = new Map<string, Selection>();
  private readonly inputs = new Map<string, { value: string; drawnValue?: string }>();
  private controls: RenderElement[] = [];
  private focusedKey: string | undefined;
  private rows = 10;
  private scrollTop = 0;
  private revealControl = false;
  private contentRows = 0;
  private active = false;
  private hasSvg = false;
  private canvas: PluginGraphicsView | undefined;

  constructor(private tree: RenderElement, private readonly action: (key: string) => void, private readonly height: () => number, private readonly graphics?: PluginGraphics, private readonly fitGraphics = false, private readonly native?: (key: string, width: number, node: RenderElement) => string[] | undefined) { this.setTree(tree); }

  setTree(tree: RenderElement): void {
    this.tree = tree;
    this.controls = [];
    this.hasSvg = false;
    const selectKeys = new Set<string>();
    const visit = (node: RenderNode): void => {
      if (typeof node === 'string') return;
      const props = this.properties(node);
      if (props['display'] === 'none') return;
      if (node.type === 'Svg') this.hasSvg = true;
      if (['Select', 'Button', 'Input'].includes(node.type) && props['disabled'] !== true) this.controls.push(node);
      if (node.type === 'Input') {
        const key = String(props['key']);
        const current = this.inputs.get(key);
        const drawnValue = props['value'] as string | undefined;
        if (current === undefined || current.drawnValue !== drawnValue) this.inputs.set(key, { value: drawnValue ?? '', drawnValue });
      }
      if (node.type === 'Select') {
        const key = String(props['key']);
        selectKeys.add(key);
        const options = props['options'] as Option[];
        let state = this.selections.get(key);
        if (state === undefined) {
          state = { list: new SearchableList({ items: options, toSearchText: option => option.label ?? option.value, searchable: false }), top: 0 };
          this.selections.set(key, state);
        }
        state.list.setItems(options);
        const value = props['value'] as string | undefined;
        if (state.drawnValue !== value) {
          state.list.moveTo(Math.max(0, options.findIndex(option => option.value === value)));
          state.drawnValue = value;
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
    if (!this.controls.some(control => control.props?.['key'] === this.focusedKey)) this.focusedKey = clean((this.controls.find(control => control.props?.['autoFocus']) ?? this.controls[0])?.props?.['key']);
    for (const key of this.selections.keys()) if (!selectKeys.has(key)) this.selections.delete(key);
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.setTree(this.tree);
    this.revealControl = active && this.controls.length > 0;
  }

  dispose(): void { this.canvas?.dispose(); this.canvas = undefined; }

  invalidate(): void {}

  handleInput(data: string): boolean {
    this.setActive(true);
    const ch = printableChar(data);
    const shortcut = ch === undefined ? undefined : this.controls.find(control => control.props?.['nativeHotkey'] === ch);
    if (shortcut) { this.send(shortcut); return true; }
    if (this.contentRows > this.height() && (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown) || matchesKey(data, Key.home) || matchesKey(data, Key.end))) {
      this.revealControl = false;
      if (this.canvas) {
        if (matchesKey(data, Key.home)) this.canvas.scroll(0);
        else if (matchesKey(data, Key.end)) this.canvas.scroll(this.canvas.totalRows);
        else this.canvas.scrollBy((matchesKey(data, Key.pageUp) ? -1 : 1) * Math.max(1,this.height() - 1));
        return true;
      }
      if (matchesKey(data, Key.home)) this.scrollTop = 0;
      else if (matchesKey(data, Key.end)) this.scrollTop = this.contentRows;
      else this.scrollTop += (matchesKey(data, Key.pageUp) ? -1 : 1) * Math.max(1, this.height() - 1);
      return true;
    }
    const index = this.controls.findIndex(control => control.props?.['key'] === this.focusedKey);
    const control = this.controls[index];
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      if (this.controls.length === 0) return false;
      const backwards = matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.left);
      this.revealControl = true;
      this.focusedKey = clean(this.controls[(index + (backwards ? -1 : 1) + this.controls.length) % this.controls.length]?.props?.['key']);
      return true;
    }
    if (control === undefined) return false;
    const props = control.props ?? {};
    if (control.type === 'Select') {
      const state = this.selections.get(String(props['key']))!;
      if (matchesKey(data, Key.enter)) {
        const selected = state.list.selected();
        if (selected !== undefined) this.send(control, selected.value);
        return true;
      }
      if (ch === 'j') state.list.moveDown();
      else if (ch === 'k') state.list.moveUp();
      else if (matchesKey(data, Key.home)) state.list.moveTo(0);
      else if (matchesKey(data, Key.end)) state.list.moveTo(state.list.filtered().length - 1);
      else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
        state.list.moveTo(state.list.view().selectedIndex + (matchesKey(data, Key.pageUp) ? -this.rows : this.rows));
      } else return state.list.handleKey(data);
      return true;
    }
    if (control.type === 'Button' && (matchesKey(data, Key.enter) || ch === ' ')) { this.send(control); return true; }
    if (control.type === 'Input') {
      const current = this.inputs.get(String(props['key']))!;
      if (matchesKey(data, Key.enter)) { this.send(control, current.value, true); return true; }
      if (matchesKey(data, Key.backspace)) current.value = Array.from(new Intl.Segmenter().segment(current.value), part => part.segment).slice(0, -1).join('');
      else if (ch !== undefined) current.value += ch;
      else return false;
      if (props['callback'] !== undefined) this.send(control, current.value);
      return true;
    }
    return false;
  }

  private send(control: RenderElement, value?: string, submit = false): void {
    if (typeof control.props?.['nativeAction'] === 'string') { this.action(`action:${control.props['nativeAction']}`); return; }
    this.action(`callback:${JSON.stringify({ handle: control.props?.[submit ? 'submitCallback' : 'callback'], value })}`);
  }

  render(width: number): string[] {
    this.rows = Math.max(1, this.height() - 8);
    const lines = this.draw(this.tree, Math.max(1, width));
    this.contentRows = lines.length;
    if (this.revealControl) {
      this.revealControl = false;
      const focused = this.controls.find(control => control.props?.['key'] === this.focusedKey);
      if (focused?.type === 'Button') {
        const label = focused.children?.length ? focused.children.filter(child => typeof child === 'string').join('') : clean(focused.props?.['label']);
        const row = lines.findIndex(line => line.includes(`[${label}]`));
        if (row < this.scrollTop) this.scrollTop = Math.max(0, row);
        else if (row >= this.scrollTop + this.height()) this.scrollTop = row - this.height() + 1;
      } else this.scrollTop = 0;
    }
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, lines.length - this.height()));
    if (this.hasSvg && this.graphics?.available) {
      this.canvas ??= this.graphics.createView();
      const frame = this.canvas.render(this.projection(this.tree) as RenderElement, width, this.height(), this.active, this.fitGraphics);
      this.contentRows = this.canvas.totalRows || lines.length;
      if (frame.length > 0) return frame;
    } else this.dispose();
    return lines.slice(this.scrollTop, this.scrollTop + this.height());
  }

  private draw(node: RenderNode, width: number): string[] {
    if (typeof node === 'string') return wrapTextWithAnsi(clean(node), width);
    if (typeof node.props?.['key'] === 'string') {
      const native = this.native?.(node.props['key'], width, node);
      if (native !== undefined) return native;
    }
    const props = this.properties(node);
    if (props['display'] === 'none') return [];
    if (node.type === 'Svg') return [clean(props['alt'])];
    if (node.type === 'Select') {
      const state = this.selections.get(String(props['key']))!;
      const view = state.list.view();
      if (view.selectedIndex < state.top) state.top = view.selectedIndex;
      if (view.selectedIndex >= state.top + this.rows) state.top = view.selectedIndex - this.rows + 1;
      state.top = Math.min(state.top, Math.max(0, view.items.length - this.rows));
      const focused = this.active && props['key'] === this.focusedKey;
      return view.items.slice(state.top, state.top + this.rows).map((option, index) => {
        const selected = index + state.top === view.selectedIndex;
        const label = `${selected ? SELECT_POINTER : ' '} ${clean(option.label ?? option.value)}`;
        return currentTheme.fg(selected && focused ? 'primary' : 'textStrong', selected && focused ? currentTheme.bold(fit(label, width)) : fit(label, width));
      });
    }
    if (node.type !== 'Box') {
      const text = node.type === 'Input' ? this.inputs.get(String(props['key']))?.value ?? '' : node.children?.length ? node.children.map(child => typeof child === 'string' ? clean(child) : this.draw(child, width).join('')).join('') : clean(props['text'] ?? props['value'] ?? props['label'] ?? props['code']);
      const focused = this.active && props['key'] === this.focusedKey;
      const token: ColorToken = props['dimColor'] || props['dim'] || props['disabled'] ? 'textMuted' : props['color'] === 'accent' ? 'primary' : props['color'] === 'success' ? 'success' : props['color'] === 'error' ? 'error' : 'textStrong';
      const label = node.type === 'Button' && (!props['plain'] || focused) ? `[${text}]` : text;
      const styled = currentTheme.fg(focused ? 'primary' : token, props['bold'] || focused ? currentTheme.bold(label) : label);
      return wrapTextWithAnsi(styled, width);
    }
    const border = props['borderStyle'] !== undefined && width >= 4;
    const padding = Math.min(4, Math.max(0, Number(props['paddingX'] ?? props['padding'] ?? 0)));
    const inner = Math.max(1, width - (border ? 2 : 0) - padding * 2);
    const children = (node.children ?? []).filter(child => typeof child === 'string' || this.properties(child)['display'] !== 'none');
    const gap = Math.min(10, Math.max(0, Number((props['flexDirection'] === 'row' ? props['columnGap'] : props['rowGap']) ?? props['gap'] ?? 0)));
    let lines: string[];
    if (props['flexDirection'] === 'row' && children.length > 0) {
      const available = Math.max(children.length, inner - gap * (children.length - 1));
      const requested = children.map(child => this.naturalWidth(child));
      const fixed = requested.reduce((a, b) => a + b, 0);
      const weights = children.map(child => typeof child !== 'string' ? Math.max(0,Number(child.props?.['flexGrow'] ?? 0)) : 0);
      const weight = weights.reduce((a,b) => a+b,0);
      const widths = requested.map((size,index) => size + Math.floor(Math.max(0,available-fixed)*weights[index]!/Math.max(1,weight)));
      const lastFlexible = weights.findLastIndex(value => value > 0);
      if (lastFlexible >= 0 && fixed <= available) widths[lastFlexible] = widths[lastFlexible]! + available - widths.reduce((a,b) => a+b,0);
      let excess = Math.max(0,widths.reduce((a,b) => a+b,0)-available);
      const shrinkable = children.flatMap((child,index) => typeof child !== 'string' && child.props?.['flexShrink'] === 0 ? [] : [index]);
      for (const index of shrinkable) {
        const shrink = Math.min(widths[index]!,Math.ceil(excess/Math.max(1,shrinkable.length-shrinkable.indexOf(index))));
        widths[index] = widths[index]!-shrink;
        excess -= shrink;
      }
      const rendered = children.map((child, index) => this.draw(child, Math.max(1,widths[index]!)));
      const height = Math.max(0, ...rendered.map(part => part.length));
      lines = Array.from({ length: height }, (_, row) => rendered.map((part, index) => {
        const offset = props['alignItems'] === 'flex-end' ? height-part.length : props['alignItems'] === 'center' ? Math.floor((height-part.length)/2) : 0;
        return fit(part[row-offset] ?? '',widths[index]!);
      }).join(' '.repeat(gap)));
    } else lines = children.flatMap((child, index) => [...(index > 0 ? Array.from({ length: gap }, () => '') : []), ...this.draw(child, inner)]);
    lines = lines.map(line => `${border ? currentTheme.fg('textDim', '│') : ''}${' '.repeat(padding)}${fit(line, inner)}${' '.repeat(padding)}${border ? currentTheme.fg('textDim', '│') : ''}`);
    if (border) return [currentTheme.fg('textDim', `┌${'─'.repeat(width - 2)}┐`), ...lines, currentTheme.fg('textDim', `└${'─'.repeat(width - 2)}┘`)];
    return lines;
  }

  private naturalWidth(node: RenderNode): number {
    if (typeof node === 'string') return Math.max(0,...clean(node).split('\n').map(line => visibleWidth(line)));
    const props = this.properties(node);
    if (props['display'] === 'none') return 0;
    if (typeof props['width'] === 'number') return Math.max(1,props['width']);
    if (node.type === 'Select') return Math.max(1,...(props['options'] as Option[]).map(option => visibleWidth(clean(option.label ?? option.value))+3));
    const widths = node.children?.map(child => this.naturalWidth(child)) ?? [];
    if (node.type !== 'Box') return Math.max(1,widths.reduce((a,b) => a+b,0),visibleWidth(clean(props['text'] ?? props['label'] ?? props['value']))) + (node.type === 'Button' && (!props['plain'] || (this.active && props['key'] === this.focusedKey)) ? 2 : 0);
    const gap = Number((props['flexDirection'] === 'row' ? props['columnGap'] : props['rowGap']) ?? props['gap'] ?? 0);
    return (props['flexDirection'] === 'row' ? widths.reduce((a,b) => a+b,0)+gap*Math.max(0,widths.length-1) : Math.max(0,...widths)) + Number(props['paddingX'] ?? props['padding'] ?? 0)*2 + (props['borderStyle'] === undefined ? 0 : 2);
  }

  private projection(node: RenderNode): RenderNode {
    if (typeof node === 'string') return node;
    const props = { ...node.props, focused: this.active && node.props?.['key'] === this.focusedKey };
    if (node.type === 'Input') Object.assign(props, { value: this.inputs.get(String(node.props?.['key']))?.value ?? '' });
    if (node.type === 'Select') {
      const selected = this.selections.get(String(node.props?.['key']));
      if (selected) Object.assign(props, { options: selected.list.view().items.slice(selected.top, selected.top + this.rows), selectedIndex: selected.list.view().selectedIndex - selected.top });
    }
    return { ...node, props, children: node.children?.map(child => this.projection(child)) };
  }

  private properties(node: RenderElement): Record<string, unknown> {
    const props = node.props ?? {};
    const hover = props['hover'];
    if (this.active && hover !== null && typeof hover === 'object' && 'display' in hover) return { ...props, display: hover.display };
    return props;
  }
}
