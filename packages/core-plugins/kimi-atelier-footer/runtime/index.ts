import type { Register, RenderElement, RenderInput, RenderNode } from '@moonshot-ai/kimi-code-sdk/plugin';

type Window = { percent: number; resetsAt?: string };
type AtelierUsage = { contextPercent: number | null; fiveHour: Window | null; sevenDay: Window | null };
type SharedState = { get(ref: { plugin: string; key: string }): Promise<{ value: unknown }> };

function removeGauges(node: RenderNode, inQuota: boolean, removed: { value: boolean }): RenderNode | undefined {
  if (typeof node === 'string') return node;
  const inLine = inQuota || node.props?.['key'] === 'ligne-quotas';
  if (inLine && node.type === 'Svg' && typeof node.props?.['alt'] === 'string' && node.props['alt'].startsWith('Quotas :')) {
    removed.value = true;
    const remaining = node.props['alt'].split(' · ').filter(part => !part.startsWith('Quotas :'));
    return remaining.length === 0 ? undefined : { type: 'Text', props: { dimColor: true }, children: [remaining.join(' · ')] };
  }
  if (inLine && node.type === 'Text' && /^\s*(?:ctx|5\s*h|7\s*j)\s/i.test(node.children?.filter(child => typeof child === 'string').join('') ?? '')) {
    removed.value = true;
    return undefined;
  }
  if (node.children === undefined) return node;
  return { ...node, children: node.children.map(child => removeGauges(child, inLine, removed)).filter((child): child is RenderNode => child !== undefined) };
}

function quota(label: string, value: Window | null, now: number): string | undefined {
  if (value === null || typeof value?.percent !== 'number' || !Number.isFinite(value.percent)) return undefined;
  const end = value.resetsAt === undefined ? NaN : Date.parse(value.resetsAt);
  if (Number.isFinite(end) && end <= now) return `${label} 0%`;
  const date = new Date(end);
  const day = end - now >= 24 * 60 * 60 * 1000 ? `${date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })} ` : '';
  const reset = Number.isFinite(end) ? ` ↻${day}${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '';
  return `${label} ${Math.round(value.percent)}%${reset}`;
}

export const register: Register = on => {
  const active = new Map<string, boolean>();
  const usageRef = { plugin: 'atelier', key: 'usage' };
  const hiddenRef = { plugin: 'atelier', key: 'isHidden' };
  on('kimi.ui.rendered', { component: 'AbovePrompt' }, async ($, event, next) => {
    const original = await next(event) as RenderElement | undefined;
    const client = typeof event['clientId'] === 'string' ? event['clientId'] : '';
    active.set(client, false);
    if (original === undefined || (event['props'] as Record<string, unknown> | undefined)?.['hasSurvey'] === true) return original;
    const state = $.state as unknown as SharedState;
    const usage = (await state.get(usageRef)).value as AtelierUsage | undefined;
    const hidden = (await state.get(hiddenRef)).value;
    if (!usage || typeof usage.contextPercent !== 'number' || hidden === true) return original;
    const removed = { value: false };
    const result = removeGauges(original, false, removed) as RenderElement | undefined;
    active.set(client, removed.value);
    return result;
  });
  on('ui.render', { component: 'ContextUsage' }, async ($, event, next) => {
    const client = typeof event['clientId'] === 'string' ? event['clientId'] : '';
    if (!active.get(client)) return next(event);
    const usage = (await ($.state as unknown as SharedState).get(usageRef)).value as AtelierUsage | undefined;
    if (!usage) return next(event);
    const now = Date.now();
    const props = event['props'] as Record<string, unknown> | undefined;
    const context = typeof props?.['text'] === 'string' ? props['text'] : '';
    const labels = [quota('5h', usage.fiveHour, now), quota('7d', usage.sevenDay, now)].filter((value): value is string => value !== undefined);
    const width = typeof props?.['bodyColumns'] === 'number' ? props['bodyColumns'] : Infinity;
    while (labels.length > 0 && [...labels, context].filter(Boolean).join(' · ').length > width) labels.pop();
    if (context) labels.push(context);
    return $.ui.resolve(event as unknown as RenderInput).Text({ children: [labels.join(' · ')] });
  });
};
