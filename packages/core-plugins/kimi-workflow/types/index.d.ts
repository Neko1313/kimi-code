export interface WorkflowAgentProgress { readonly model: string; readonly maxContextTokens?: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly toolCalls: number; readonly elapsedMs: number; readonly firstResponseAt?: number }
export interface WorkflowAgentResult { readonly agentId: string; readonly taskId: string; readonly text: string; readonly value?: unknown; readonly progress?: WorkflowAgentProgress; readonly usage?: { readonly input: number; readonly output: number; readonly cache_read?: number; readonly cache_write?: number } }
export interface WorkflowActivity { readonly id: string; readonly title: string; readonly status: string; readonly kind: string; readonly agentId?: string }

export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type CallStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface WorkflowCall {
  id: string;
  phase: string;
  prompt: string;
  model: string;
  profile?: string;
  label: string;
  schema?: Record<string, unknown>;
  status: CallStatus;
  attempt: number;
  agentId?: string;
  taskId?: string;
  result?: WorkflowAgentResult;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  progress?: WorkflowAgentProgress;
}
export interface WorkflowPhase { name: string; model?: string; description?: string }
export interface WorkflowRun {
  id: string;
  name: string;
  sessionId: string;
  taskId?: string;
  parentToolCallId?: string;
  source: string;
  description?: string;
  phases?: WorkflowPhase[];
  activePhase?: string;
  finishedAt?: number;
  args?: unknown;
  concurrency: number;
  tokenBudget?: number;
  tokensSpent?: number;
  prefixStaggerMs?: number;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  calls: WorkflowCall[];
  logs: string[];
  result?: unknown;
  error?: string;
}
export interface WorkflowInput {
  source: string;
  description?: string;
  phases?: WorkflowPhase[];
  name?: string;
  args?: unknown;
  concurrency?: number;
  tokenBudget?: number;
  prefixStaggerMs?: number;
  resume?: string;
}
export interface Workflow {
  run(input: WorkflowInput): Promise<{ runId: string }>;
  status(input: Record<string, never>): Promise<WorkflowRun[]>;
  status(input: { runId: string }): Promise<WorkflowRun | null>;
  control(input: { runId: string; action: string; callId?: string }): Promise<unknown>;
  tasks(input: Record<string, never>): Promise<readonly WorkflowActivity[]>;
  output(input: { id: string }): Promise<string>;
  stopTask(input: { taskId: string }): Promise<void>;
}

declare module 'claude-code' {
  interface EngineInterface { workflow: Workflow }
}
