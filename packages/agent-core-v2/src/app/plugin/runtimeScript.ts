import variant from '@jitl/quickjs-singlefile-cjs-release-sync';
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';

import type { RuntimeScriptOptions } from './runtime';

let modulePromise: Promise<QuickJSWASMModule> | undefined;

export async function runRuntimeScript(options: RuntimeScriptOptions): Promise<unknown> {
  const timeout = options.timeoutMs ?? 600_000;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 86_400_000) throw new Error('Script timeout must be between 1 ms and 24 hours');
  if (options.source.length > 1_000_000) throw new Error('Script exceeds the source size limit');
  options.signal?.throwIfAborted();
  const module = await (modulePromise ??= newQuickJSWASMModuleFromVariant(variant));
  const vm = module.newContext();
  const runtime = vm.runtime;
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeout;
  let sliceDeadline = Date.now() + 100;
  let alive = true;
  let settled = false;
  let result: unknown;
  let failure: unknown;
  let revision = 0;
  let wake: (() => void) | undefined;
  const changed = (): void => { revision++; wake?.(); };
  const pending = new Set<ReturnType<typeof vm.newPromise>>();
  runtime.setInterruptHandler(() => options.signal?.aborted === true || Date.now() > deadline || Date.now() > sliceDeadline);
  const invoke = vm.newFunction('__invoke', (method, input) => {
    const name: unknown = vm.dump(method);
    if (typeof name !== 'string') throw new Error('Host method must be a string');
    const value: unknown = JSON.parse(vm.getString(input));
    const deferred = vm.newPromise();
    pending.add(deferred);
    void Promise.resolve().then(() => options.invoke(name, value)).then(
      (output) => {
        if (!alive) return;
        const handle = vm.newString(JSON.stringify(output ?? null));
        deferred.resolve(handle);
        handle.dispose();
        changed();
      },
      (error: unknown) => {
        if (!alive) return;
        const handle = vm.newError(error instanceof Error ? error.message : String(error));
        deferred.reject(handle);
        handle.dispose();
        changed();
      },
    ).catch((error: unknown) => { failure = error; settled = true; changed(); });
    return deferred.handle;
  });
  vm.setProp(vm.global, '__invoke', invoke);
  invoke.dispose();
  try {
    const source = `(async function() { const args = ${JSON.stringify(options.args ?? null)}; const host = async (method, input) => JSON.parse(await __invoke(method, JSON.stringify(input ?? null)));\n${options.source}\n})()`;
    const evaluated = vm.evalCode(source, 'plugin-script.js');
    const promise = vm.unwrapResult(evaluated);
    void vm.resolvePromise(promise).then((value) => {
      if (!alive) { value.dispose(); return; }
      try {
        const handle = vm.unwrapResult(value);
        result = vm.dump(handle);
        handle.dispose();
      } catch (error) { failure = error; }
      settled = true;
      changed();
    });
    promise.dispose();
    while (!settled) {
      const seen = revision;
      options.signal?.throwIfAborted();
      if (Date.now() > deadline) throw new Error('Script timed out');
      sliceDeadline = Date.now() + 100;
      const jobs = runtime.executePendingJobs(100);
      if (jobs.error !== undefined) { const error = vm.dump(jobs.error); jobs.dispose(); throw new Error(JSON.stringify(error)); }
      jobs.dispose();
      await Promise.resolve();
      if (!settled) {
        if (runtime.hasPendingJob()) await new Promise<void>(resolve => { setTimeout(resolve, 0); });
        else await new Promise<void>(resolve => {
          const done = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', done); wake = undefined; resolve(); };
          const timer = setTimeout(done, Math.max(1, deadline - Date.now()));
          wake = done;
          options.signal?.addEventListener('abort', done, { once: true });
          if (revision !== seen || options.signal?.aborted) done();
        });
      }
    }
    options.signal?.throwIfAborted();
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error(typeof failure === 'string' ? failure : JSON.stringify(failure) ?? 'Runtime script failed');
    return result;
  } finally {
    alive = false;
    for (const deferred of pending) deferred.dispose();
    vm.dispose();
  }
}
