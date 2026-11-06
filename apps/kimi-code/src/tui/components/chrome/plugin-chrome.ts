import type { RenderElement, RuntimeElement } from '@moonshot-ai/kimi-code-sdk/plugin';
import { Key, matchesKey, truncateToWidth, type Component, type Focusable } from '@moonshot-ai/pi-tui';

import type { PluginGraphics } from '#/tui/controllers/plugin-graphics';

import { ModsTree } from '../dialogs/mods-tree';
import { buildComponent } from '../dialogs/plugin-pane-viewer';
import { currentTheme } from '#/tui/theme';
import { hasSvg, graphicTree } from '#/tui/utils/plugin-graphics-tree';
import { printableChar } from '#/tui/utils/printable-key';

export class PluginChrome implements Component, Focusable {
  focused = false;
  private readonly trees = new Map<string, Component>();
  private source = new Map<string, RuntimeElement>();
  private width = 0;

  constructor(
    private readonly rows: () => number,
    private readonly action: (component: string, key: string) => void,
    private readonly blur: () => void,
    private readonly resized: () => void,
    private readonly graphics?: PluginGraphics,
    private readonly changed: () => void = resized,
  ) {}

  setTrees(trees: ReadonlyMap<string, RuntimeElement>): void {
    this.source = new Map(trees);
    for (const component of this.trees.keys()) if (!trees.has(component)) { const tree = this.trees.get(component); if (tree instanceof ModsTree) tree.dispose(); this.trees.delete(component); }
    for (const [component, tree] of trees) {
      const existing = this.trees.get(component);
      if (/^[A-Z]/.test(tree.type) || hasSvg(tree)) {
        const value = graphicTree(tree) as RenderElement;
        if (existing instanceof ModsTree) existing.setTree(value);
        else this.trees.set(component,new ModsTree(value,key=>this.action(component,key),() => Math.max(1, this.rows() - (this.focused ? 1 : 0)),this.graphics,true));
      } else { if (existing instanceof ModsTree) existing.dispose(); this.trees.set(component,buildComponent(tree)); }
    }
  }

  get hasContent(): boolean { return this.trees.size > 0; }
  get columns(): number { return this.width; }
  invalidate(): void {}

  handleInput(data: string): void {
    if (!this.focused) return;
    if (matchesKey(data, Key.escape)) { this.blur(); return; }
    const tree=this.trees.get('AbovePrompt');
    if (tree instanceof ModsTree) { if (tree.handleInput(data)) this.changed(); return; }
    const buttons: Extract<RuntimeElement,{type:'button'}>[]=[];
    const visit=(node:RuntimeElement|string):void=>{if(typeof node==='string')return;if(node.type==='button')buttons.push(node);else if(node.type==='box')node.children.forEach(visit);};
    const source=this.source.get('AbovePrompt');
    if(source!==undefined)visit(source);
    const ch=printableChar(data);
    const button=buttons.find(item=>item.hotkey!==undefined&&item.hotkey===ch)??(matchesKey(data,Key.enter)?buttons[0]:undefined);
    if(button!==undefined)this.action('AbovePrompt',`action:${button.action??button.hotkey??'enter'}`);
  }

  render(width: number): string[] {
    if (width !== this.width) { this.width = width; this.resized(); }
    const lines = [...this.trees.values()].flatMap(tree => {
      if (tree instanceof ModsTree) tree.setActive(this.focused);
      return tree.render(width);
    });
    if (lines.length === 0) return [];
    if (this.focused) lines.unshift(currentTheme.fg('textMuted', 'Plugin controls · Tab navigate · Enter select · Esc return'));
    return lines.slice(0, this.rows()).map(line => /\u001B(?:_G|\]1337;File=)/.test(line) ? line : truncateToWidth(line, Math.max(1, width)));
  }
}
