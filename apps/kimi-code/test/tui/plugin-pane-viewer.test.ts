import { describe, expect, it, vi } from 'vitest';

import type { Terminal } from '@moonshot-ai/pi-tui';

import { PluginPaneViewer, buildComponent, type RuntimeElement } from '../../src/tui/components/dialogs/plugin-pane-viewer';
import { PluginChrome } from '../../src/tui/components/chrome/plugin-chrome';

describe('buildComponent', () => {
  it('renders a text element to a line', () => {
    const component = buildComponent({ type: 'text', text: 'hello' });
    expect(component.render(40).map((line) => line.trimEnd())).toEqual(['hello']);
  });

  it('renders a column box with mixed children', () => {
    const tree: RuntimeElement = {
      type: 'box',
      direction: 'column',
      children: [
        { type: 'text', text: 'one' },
        'two',
        { type: 'button', label: 'Open', hotkey: 'o' },
      ],
    };
    const lines = buildComponent(tree).render(40).map((line) => line.replaceAll(/\s+$/g, ''));
    expect(lines[0]).toContain('one');
    expect(lines[1]).toContain('two');
    expect(lines[2]).toContain('[Open]');
    expect(lines[2]).toContain('(o)');
  });

  it('renders a row box side by side', () => {
    const tree: RuntimeElement = {
      type: 'box',
      direction: 'row',
      children: [
        { type: 'text', text: 'left' },
        { type: 'text', text: 'right' },
      ],
    };
    const lines = buildComponent(tree).render(40);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('left');
    expect(lines[0]).toContain('right');
  });
});

function terminal(rows = 10): Terminal {
  return {
    start: () => {}, stop: () => {}, drainInput: async () => {}, write: () => {}, columns: 80, rows,
    kittyProtocolActive: false, moveBy: () => {}, hideCursor: () => {}, showCursor: () => {},
    clearLine: () => {}, clearFromCursor: () => {}, clearScreen: () => {}, setTitle: () => {},
    setProgress: () => {}, setProgramStatus: () => {},
  };
}

describe('PluginPaneViewer', () => {
  const tree = (count: number): RuntimeElement => ({ type: 'box', direction: 'column', children: Array.from({ length: count }, (_, index) => ({ type: 'text', text: `row-${index}`, key: String(index), selected: index === 0 })) });
  it('pages through full output and preserves the scroll position during updates', () => {
    const props = { title: 'Runs', paneId: 'runs', tree: tree(80), onKey: vi.fn(), onClose: vi.fn() };
    const viewer = new PluginPaneViewer(props, terminal());
    expect(viewer.render(60).join('\n')).toContain('row-0');
    viewer.handleInput('\u001B[6~');
    const top = viewer.scroll.scrollTop;
    expect(top).toBeGreaterThan(0);
    viewer.setProps({ ...props, tree: tree(81) });
    viewer.render(60);
    expect(viewer.scroll.scrollTop).toBe(top);
    viewer.handleInput('\u001B[F');
    expect(viewer.render(60).join('\n')).toContain('row-80');
    viewer.handleInput('\u001B[H');
    expect(viewer.scroll.scrollTop).toBe(0);
  });
  it('keeps nested back navigation in the plugin and routes button actions', () => {
    const onKey = vi.fn();
    const onClose = vi.fn();
    const onCycle = vi.fn();
    const viewer = new PluginPaneViewer({ title: 'Detail', paneId: 'runs', tree: { type: 'box', direction: 'column', captureEscape: true, children: [{ type: 'button', label: 'Retry', hotkey: 'r', action: 'retry' }] }, onKey, onClose, onCycle }, terminal());
    viewer.handleInput('\u001B');
    expect(onKey).toHaveBeenCalledWith('escape');
    expect(onClose).not.toHaveBeenCalled();
    viewer.handleInput('r');
    expect(onKey).toHaveBeenCalledWith('action:retry');
    viewer.handleInput('\t');
    expect(onCycle).toHaveBeenCalledWith(1);
    viewer.handleInput('q');
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('strips terminal commands from plugin content', () => {
    expect(buildComponent({ type: 'text', text: 'safe\u001B[2Jtext' }).render(60).join('')).not.toContain('\u001B[2J');
  });
});

describe('Mods elements', () => {
  it('keeps a compact mascot beside growing content and aligns it at the bottom', () => {
    const tree={type:'Box',props:{flexDirection:'row',alignItems:'flex-end'},children:[
      {type:'Box',props:{flexGrow:1},children:[{type:'Text',children:['Context 25%\n5h 40%']}]},
      {type:'Box',props:{flexShrink:0},children:[{type:'Text',children:['▐██▌']}]},
    ]} as const;
    const lines=buildComponent(tree).render(40).map(line=>line.replaceAll(/\u001B\[[0-9;]*m/g,''));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Context 25%');
    expect(lines[0]).not.toContain('▐██▌');
    expect(lines[1]).toMatch(/5h 40%\s+▐██▌$/);
  });

  it('renders persistent plugin bands without dialog chrome and preserves keyboard callbacks', () => {
    const action=vi.fn(),blur=vi.fn(),resized=vi.fn();
    const view=new PluginChrome(()=>10,action,blur,resized);
    expect(view.render(60)).toEqual([]);
    view.setTrees(new Map([['AbovePrompt',{type:'Box',children:[{type:'Text',children:['Context 20%']},{type:'Button',props:{key:'refresh',label:'Refresh',callback:'owned'}}]}]]));
    expect(view.render(60).join('')).toContain('Context 20%');
    expect(view.render(60).join('')).not.toContain('Esc cancel');
    view.focused=true;
    view.handleInput('\r');
    expect(action).toHaveBeenCalledWith('AbovePrompt','callback:{"handle":"owned"}');
    view.handleInput('\u001B');
    expect(blur).toHaveBeenCalledOnce();
    view.setTrees(new Map());
    expect(view.render(60)).toEqual([]);
  });

  it('reveals hover controls on keyboard focus and skips controls that stay hidden', () => {
    const action = vi.fn();
    const view = new PluginChrome(() => 10, action, vi.fn(), vi.fn());
    const tree = { type: 'Box', children: [
      { type: 'Button', props: { key: 'visible', label: 'Visible', callback: 'visible' }, children: [] },
      { type: 'Box', props: { display: 'none', hover: { display: 'flex' } }, children: [
        { type: 'Button', props: { key: 'pet', label: 'Pet', plain: true, callback: 'pet' }, children: [] },
      ] },
      { type: 'Box', props: { display: 'none' }, children: [
        { type: 'Button', props: { key: 'hidden', label: 'Hidden', callback: 'hidden' } },
      ] },
      { type: 'Button', props: { key: 'disabled', label: 'Unavailable', callback: 'disabled', disabled: true } },
    ] } as const;
    view.setTrees(new Map([['AbovePrompt', tree]]));
    expect(view.render(60).join('')).not.toContain('Pet');
    view.focused = true;
    expect(view.render(60).join('')).toContain('Pet');
    expect(view.render(60).join('')).not.toContain('Hidden');
    view.handleInput('\t');
    expect(view.render(60).join('')).toContain('[Pet]');
    view.setTrees(new Map([['AbovePrompt', tree]]));
    view.handleInput('\r');
    expect(action).toHaveBeenLastCalledWith('AbovePrompt', 'callback:{"handle":"pet"}');
    view.handleInput('\t');
    view.handleInput('\r');
    expect(action).toHaveBeenLastCalledWith('AbovePrompt', 'callback:{"handle":"visible"}');
    view.focused = false;
    expect(view.render(60).join('')).not.toContain('Pet');
  });

  it('keeps the focused control visible below the keyboard hint in a short band', () => {
    const view = new PluginChrome(() => 4, vi.fn(), vi.fn(), vi.fn());
    view.setTrees(new Map([['AbovePrompt', { type: 'Box', children: [
      { type: 'Text', children: ['First\nSecond\nThird'] },
      { type: 'Button', props: { key: 'refresh', label: 'Refresh', callback: 'refresh' } },
    ] }]]));
    view.focused = true;
    const lines = view.render(40);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('Plugin controls');
    expect(lines.join('')).toContain('[Refresh]');
  });
  it('keeps Select cursors during redraws, scrolls lists and routes callbacks by focus', async () => {
    const { ModsTree } = await import('../../src/tui/components/dialogs/mods-tree');
    const onKey = vi.fn();
    const options = Array.from({ length: 40 }, (_, index) => ({ value: String(index), label: `agent-${index}` }));
    const tree = { type: 'Box', props: { flexDirection: 'row', gap: 1 }, children: [
      { type: 'Select', props: { key: 'phases', autoFocus: true, options, value: '0', callback: 'phase' } },
      { type: 'Select', props: { key: 'agents', options: [{ value: 'work', label: 'Worker' }], callback: 'worker' } },
    ] } as const;
    const view = new ModsTree(tree, onKey, () => 15);
    for (let i = 0; i < 20; i++) view.handleInput('\u001B[B');
    view.setTree(tree);
    expect(view.render(80).join('\n')).toContain('agent-20');
    expect(view.render(80).join('\n')).not.toContain('agent-0');
    view.handleInput('\r');
    expect(onKey).toHaveBeenLastCalledWith('callback:{"handle":"phase","value":"20"}');
    view.handleInput('\t');
    view.handleInput('\r');
    expect(onKey).toHaveBeenLastCalledWith('callback:{"handle":"worker","value":"work"}');
  });

  it('scrolls long output within the measured pane and preserves position across updates', async () => {
    const { ModsTree } = await import('../../src/tui/components/dialogs/mods-tree');
    const makeTree = (count: number) => ({ type: 'Text', children: [Array.from({ length: count }, (_, index) => `output-${index}`).join('\n')] }) as const;
    const view = new ModsTree(makeTree(100), vi.fn(), () => 12);
    expect(view.render(60)).toHaveLength(12);
    view.handleInput('\u001B[6~');
    const first = view.render(60)[0];
    expect(first).not.toContain('output-0');
    view.setTree(makeTree(101));
    expect(view.render(60)[0]).toBe(first);
    view.handleInput('\u001B[F');
    expect(view.render(60).join('\n')).toContain('output-100');
  });

  it('keeps single-line input locally, handles Kitty keys and submits the complete value', async () => {
    const { ModsTree } = await import('../../src/tui/components/dialogs/mods-tree');
    const onKey = vi.fn();
    const view = new ModsTree({ type: 'Input', props: { key: 'input', callback: 'change', submitCallback: 'submit' } }, onKey, () => 10);
    view.handleInput('\u001B[97u');
    view.handleInput('b');
    view.handleInput('\r');
    expect(onKey).toHaveBeenLastCalledWith('callback:{"handle":"submit","value":"ab"}');
    expect(view.render(40).join('')).toContain('ab');
  });
});
