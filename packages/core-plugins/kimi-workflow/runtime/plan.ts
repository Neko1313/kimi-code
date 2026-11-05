export type StageType = 'sequential' | 'fanout' | 'loop';

export interface WorkerSpec {
  readonly command: string;
  readonly argsTemplate: readonly string[];
  readonly timeoutMs?: number;
  readonly retries?: number;
}

export interface StageSpec {
  readonly id: string;
  readonly type: StageType;
  readonly worker: WorkerSpec;
  readonly items?: readonly string[];
  readonly itemsFrom?: string;
  readonly maxConcurrency?: number;
  readonly maxRounds?: number;
}

export interface WorkflowPlan {
  readonly name: string;
  readonly stages: readonly StageSpec[];
}

export interface PlanIssue {
  readonly path: string;
  readonly message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function parsePlan(raw: unknown): { plan?: WorkflowPlan; issues: PlanIssue[] } {
  const issues: PlanIssue[] = [];
  if (!isObject(raw)) {
    return { issues: [{ path: '$', message: 'plan must be an object' }] };
  }
  if (typeof raw['name'] !== 'string' || raw['name'].length === 0) {
    issues.push({ path: '$.name', message: 'name must be a non-empty string' });
  }
  if (!Array.isArray(raw['stages']) || raw['stages'].length === 0) {
    issues.push({ path: '$.stages', message: 'stages must be a non-empty array' });
    return { issues };
  }
  const seen = new Set<string>();
  raw['stages'].forEach((stageRaw: unknown, index: number) => {
    const prefix = `$.stages[${index}]`;
    if (!isObject(stageRaw)) {
      issues.push({ path: prefix, message: 'stage must be an object' });
      return;
    }
    const id = stageRaw['id'];
    if (typeof id !== 'string' || id.length === 0) {
      issues.push({ path: `${prefix}.id`, message: 'id must be a non-empty string' });
    } else if (seen.has(id)) {
      issues.push({ path: `${prefix}.id`, message: `duplicate stage id "${id}"` });
    } else {
      seen.add(id);
    }
    if (stageRaw['type'] !== 'sequential' && stageRaw['type'] !== 'fanout' && stageRaw['type'] !== 'loop') {
      issues.push({ path: `${prefix}.type`, message: 'type must be sequential | fanout | loop' });
    }
    if (!isObject(stageRaw['worker'])) {
      issues.push({ path: `${prefix}.worker`, message: 'worker must be an object' });
    } else {
      const worker = stageRaw['worker'];
      if (typeof worker['command'] !== 'string' || worker['command'].length === 0) {
        issues.push({ path: `${prefix}.worker.command`, message: 'command must be a non-empty string' });
      }
      if (worker['argsTemplate'] !== undefined && !isStringArray(worker['argsTemplate'])) {
        issues.push({ path: `${prefix}.worker.argsTemplate`, message: 'argsTemplate must be an array of strings' });
      }
    }
    if (stageRaw['type'] === 'fanout' || stageRaw['type'] === 'loop') {
      const hasItems = stageRaw['items'] !== undefined;
      const hasItemsFrom = stageRaw['itemsFrom'] !== undefined;
      if (hasItems === hasItemsFrom) {
        issues.push({
          path: prefix,
          message: `${stageRaw['type']} stage needs exactly one of items | itemsFrom`,
        });
      }
      if (hasItems && !isStringArray(stageRaw['items'])) {
        issues.push({ path: `${prefix}.items`, message: 'items must be an array of strings' });
      }
      if (hasItemsFrom) {
        const ref = stageRaw['itemsFrom'];
        if (typeof ref !== 'string' || !ref.includes('.')) {
          issues.push({
            path: `${prefix}.itemsFrom`,
            message: 'itemsFrom must reference "<stageId>.<field>"',
          });
        } else if (!seen.has(ref.split('.')[0] ?? '')) {
          issues.push({
            path: `${prefix}.itemsFrom`,
            message: `itemsFrom references unknown stage "${ref.split('.')[0]}"`,
          });
        }
      }
    }
    if (stageRaw['type'] === 'loop') {
      const maxRounds = stageRaw['maxRounds'];
      if (maxRounds !== undefined && (typeof maxRounds !== 'number' || maxRounds < 1)) {
        issues.push({ path: `${prefix}.maxRounds`, message: 'maxRounds must be a positive number' });
      }
    }
  });
  if (issues.length > 0) return { issues };
  return { plan: raw as unknown as WorkflowPlan, issues: [] };
}

export function renderArgs(template: readonly string[], item: string): string[] {
  return template.map((arg) => arg.replaceAll('{{item}}', item));
}
