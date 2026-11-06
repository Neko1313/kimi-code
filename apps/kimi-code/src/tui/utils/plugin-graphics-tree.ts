import type { RenderElement, RuntimeElement } from '@moonshot-ai/kimi-code-sdk/plugin';

export function hasSvg(element: RuntimeElement | string): boolean {
  if (typeof element === 'string') return false;
  if (element.type === 'Svg') return true;
  if (element.type === 'box') return element.children.some(hasSvg);
  return 'children' in element && (element.children?.some(child => typeof child !== 'string' && hasSvg(child)) ?? false);
}

export function graphicTree(element: RuntimeElement | string, path = 'root'): RenderElement | string {
  if (typeof element === 'string') return element;
  if (element.type === 'box') return { type: 'Box', props: { flexDirection: element.direction, gap: element.gap }, children: element.children.map((child,index) => graphicTree(child,`${path}/${index}`)) };
  if (element.type === 'text') return { type: 'Text', props: { key: element.key, selected: element.selected, color: element.color, bold: element.selected }, children: [element.text] };
  if (element.type === 'button') return { type: 'Button', props: { key: path, label: element.label, nativeAction: element.action ?? element.hotkey ?? 'enter', nativeHotkey: element.hotkey } };
  return element;
}
