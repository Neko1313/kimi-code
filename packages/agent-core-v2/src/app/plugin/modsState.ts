import type { Atom, AtomOptions, PluginState, ShapedValue, StateAddress, StateDollar, StateRead, StateRef, StateSetOptions, StateSetResult, StateValue } from './mods';

interface StateAccess {
  get(ref: StateAddress): Promise<StateRead>;
  set(ref: StateAddress, value: unknown, options?: StateSetOptions): Promise<StateSetResult>;
}

export function atom<P extends Extract<keyof PluginState, string>, K extends keyof PluginState[P] & string>(ref: { readonly plugin: P; readonly key: K; readonly id?: string }, initial: StateValue<P, K>): Atom<StateValue<P, K>>;
export function atom<P extends Extract<keyof PluginState, string>, K extends keyof PluginState[P] & string>(ref: { readonly plugin: P; readonly key: K; readonly id?: string }, initial: ShapedValue<StateValue<P, K>>, options: AtomOptions): Atom<ShapedValue<StateValue<P, K>>>;
export function atom(ref: StateAddress, initial: unknown, options?: AtomOptions): Atom<unknown> {
  return Object.freeze({ ref: Object.freeze({ ...ref }), initial: freezeValue(structuredClone(initial)), shape: options?.shape });
}

export function read<T>($: StateDollar, source: Atom<T>): Promise<T>;
export function read<P extends Extract<keyof PluginState, string>, K extends keyof PluginState[P] & string>($: StateDollar, source: StateRef<P, K>): Promise<StateValue<P, K> | undefined>;
export async function read($: StateDollar, source: Atom<unknown> | StateAddress): Promise<unknown> {
  const state = $.state as StateAccess;
  const held = await state.get('ref' in source ? source.ref : source);
  return valueOf(source, held.value);
}

export function update<T>($: StateDollar, target: Atom<T>, change: (value: T) => T): Promise<T>;
export function update<P extends Extract<keyof PluginState, string>, K extends keyof PluginState[P] & string>($: StateDollar, target: StateRef<P, K>, change: (value: StateValue<P, K> | undefined) => StateValue<P, K>): Promise<StateValue<P, K>>;
export async function update($: StateDollar, target: Atom<unknown> | StateAddress, change: (value: unknown) => unknown): Promise<unknown> {
  const state = $.state as StateAccess;
  const ref = 'ref' in target ? target.ref : target;
  while (true) {
    const held = await state.get(ref);
    const value = change(valueOf(target, held.value));
    if (value !== null && typeof value === 'object' && 'then' in value && typeof value.then === 'function') throw new Error('State updates must be synchronous');
    const stored = 'ref' in target && target.shape !== undefined ? { shape: target.shape, value } : value;
    if ((await state.set(ref, stored, { ifVersion: held.version })).isSet) return value;
  }
}

function valueOf(source: Atom<unknown> | StateAddress, stored: unknown): unknown {
  if (!('ref' in source)) return stored;
  if (source.shape !== undefined) return stored !== null && typeof stored === 'object' && 'shape' in stored && stored.shape === source.shape && 'value' in stored ? stored.value : source.initial;
  return stored === undefined ? source.initial : stored;
}

function freezeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezeValue(child, seen);
    Object.freeze(value);
  }
  return value;
}
