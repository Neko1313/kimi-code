import { compileToolArgsValidator, validateToolArgs, type JsonType } from '#/tool/args-validator';
import { ToolAccesses, type ExecutableTool, type ToolExecution } from '#/tool/toolContract';

export class RuntimeStructuredOutput implements ExecutableTool {
  readonly name = 'StructuredOutput';
  readonly description = 'Submit the final result matching the required JSON schema. Validation errors are returned so you can correct the result. This ends your task.';
  readonly parameters: Record<string, unknown>;
  private readonly validate: ReturnType<typeof compileToolArgsValidator>;
  private failures = 0;
  private submitted = false;
  private value: unknown;
  private lastIssue: string | undefined;

  constructor(schema: Record<string, unknown>) {
    if (schema['type'] !== 'object') throw new Error('Structured output schema must have an object root');
    this.validate = compileToolArgsValidator(schema);
    if (schema['additionalProperties'] === false && Array.isArray(schema['required'])) {
      const properties = schema['properties'] as Record<string, unknown> | undefined;
      const patterns = Object.keys((schema['patternProperties'] ?? {}) as Record<string, unknown>).map(pattern => new RegExp(pattern, 'u'));
      for (const key of schema['required']) if (typeof key === 'string' && !Object.hasOwn(properties ?? {}, key) && !patterns.some(pattern => pattern.test(key))) throw new Error(`Structured output schema forbids required property: ${key}`);
    }
    this.parameters = schema;
  }

  text(): string | undefined { return this.submitted ? JSON.stringify(this.value) : undefined; }
  result(): unknown { if (!this.submitted) throw new Error('Agent ended without submitting StructuredOutput'); return this.value; }
  exhausted(): boolean { return this.failures >= 5; }
  error(): string { return this.lastIssue ?? 'Agent did not submit StructuredOutput'; }

  resolveExecution(input: unknown): ToolExecution {
    const issue = validateToolArgs(this.validate, input as JsonType);
    if (issue !== null) {
      this.lastIssue = issue;
      this.failures++;
      return { isError: true, output: `Invalid structured output: ${issue}. Submit a corrected object using StructuredOutput.`, stopTurn: this.exhausted() };
    }
    return {
      approvalRule: 'StructuredOutput', accesses: ToolAccesses.none(),
      execute: async () => {
        this.value = structuredClone(input);
        this.submitted = true;
        return { output: JSON.stringify(input), stopTurn: true, stopTurnReason: 'structured_output' };
      },
    };
  }
}
