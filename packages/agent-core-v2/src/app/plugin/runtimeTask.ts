import type { AgentTask, AgentTaskInfoBase, AgentTaskSink } from '#/agent/task/types';
import type { RuntimeTaskOptions } from './runtime';

export interface RuntimeTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'plugin';
  readonly pluginId: string;
  readonly runId: string;
  readonly parentToolCallId?: string;
}

declare module '#/agent/task/types' {
  interface AgentTaskInfoByKind { readonly plugin: RuntimeTaskInfo }
}

export class RuntimeTask implements AgentTask {
  readonly kind = 'plugin';
  readonly idPrefix = 'plugin';
  readonly description: string;

  constructor(private readonly options: RuntimeTaskOptions, private readonly work: (signal: AbortSignal) => Promise<unknown>, private readonly signal: AbortSignal) {
    this.description = options.title;
  }

  async start(sink: AgentTaskSink): Promise<void> {
    const signal = AbortSignal.any([sink.signal, this.signal]);
    try {
      signal.throwIfAborted();
      const result = await this.work(signal);
      signal.throwIfAborted();
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
      sink.appendOutput(text);
      await sink.settle({ status: 'completed' });
    } catch (error) {
      await sink.settle({ status: signal.aborted ? 'killed' : 'failed', stopReason: error instanceof Error ? error.message : String(error) });
    }
  }

  toInfo(base: AgentTaskInfoBase): RuntimeTaskInfo {
    return { ...base, kind: 'plugin', pluginId: this.options.pluginId ?? '', runId: this.options.id, parentToolCallId: this.options.parentToolCallId };
  }
}
