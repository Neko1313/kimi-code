import { describe, expect, it } from 'vitest';

import { buildComponent, type RuntimeElement } from '../../src/tui/components/dialogs/plugin-pane-viewer';

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
