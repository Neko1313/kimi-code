import type { RuntimeToolCall } from './runtime';

const READ_FIELDS = { path: 'file_path', line_offset: 'offset', n_lines: 'limit' } as const;

export function modsToolArgs(tool: unknown, args: Record<string, unknown>): Record<string, unknown> {
  if (tool !== 'Read') return args;
  const result = { ...args };
  for (const [native, portable] of Object.entries(READ_FIELDS)) if (Object.hasOwn(result, native)) { result[portable] = result[native]; delete result[native]; }
  return result;
}

export function nativeToolArgs(tool: unknown, args: Record<string, unknown>): Record<string, unknown> {
  if (tool !== 'Read') return args;
  const result = { ...args };
  for (const [native, portable] of Object.entries(READ_FIELDS)) if (Object.hasOwn(result, portable)) {
    if (Object.hasOwn(result, native) && result[native] !== result[portable]) throw new Error(`Conflicting Read fields: ${native} and ${portable}`);
    result[native] = result[portable]; delete result[portable];
  }
  return result;
}

export function nativeToolCall(input: RuntimeToolCall): RuntimeToolCall {
  if (input.input !== null && typeof input.input === 'object' && !Array.isArray(input.input)) return { ...input, input: nativeToolArgs(input.tool, input.input as Record<string, unknown>) };
  return nativeToolArgs(input.tool, input) as RuntimeToolCall;
}
