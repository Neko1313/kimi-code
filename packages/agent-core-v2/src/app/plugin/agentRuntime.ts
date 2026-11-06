import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { ToolCallStarted } from '#/agent/toolExecutor/toolExecutorEvents';
import { AssistantDelta, ThinkingDelta, TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionEventBus } from '#/app/event/eventBus';
import { IOAuthService } from '#/app/auth/auth';
import { ILogService } from '#/_base/log/log';
import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentRequestHooks, type AgentRequest } from '#/agent/loop/requestHooks';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { findGitWorkTree } from '#/app/git/workTree';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { renderInstructionFiles } from '#/agent/profile/instructionPrompt';
import type { RuntimePromptContext, RuntimeSessionUsage, RuntimeSiteRequest } from './runtime';
import { readAncestors } from './runtimeFs';
import { synchronizePromptContext } from './modsContext';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { randomUUID } from 'node:crypto';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import { IEventBus } from '#/app/event/eventBus';
import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { Emitter, type Event } from '#/_base/event';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import { IAgentScopeContext, agentContextOf } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { subagentLabels } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { compileToolArgsValidator, validateToolArgs, type JsonType } from '#/tool/args-validator';
import { RuntimeTask } from './runtimeTask';
import { RuntimeStructuredOutput } from './structuredOutput';
import type { ContentPart } from '#human/llm/message';
import type { RuntimeToolCall, RuntimeToolCheck, RuntimeToolInfo, RuntimeToolResult, RuntimeView } from './runtime';

import { IPluginRuntimeHost, type PluginPaneInfo, type RuntimeAgentProgress, type RuntimeAgentOptions, type RuntimeAgentResult, type RuntimeCommand, type RuntimeContext, type RuntimeElement } from './runtime';

export interface PluginPaneRequest {
  readonly id: string;
  readonly width: number;
  readonly rows?: number;
  readonly surface?: import('./runtime').RuntimeRenderSurface;
  readonly placement?: 'dock' | 'inline';
  readonly clientId?: string;
}

export interface PluginKeyRequest {
  readonly id: string;
  readonly key: string;
  readonly clientId?: string;
}

export interface PluginCallRequest {
  readonly method: string;
  readonly input: unknown;
}

export interface IAgentPluginRuntime {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<number>;
  openSite(input: { component: string; surface?: import('./runtime').RuntimeRenderSurface; props?: Record<string, unknown> }): Promise<string | undefined>;
  renderSite(input: RuntimeSiteRequest): Promise<RuntimeElement | undefined>;
  dispatchSiteKey(input: { component: string; requestId?: string; key: string; clientId?: string }): Promise<void>;
  closePane(input: { id: string }): Promise<void>;
  listPanes(): Promise<readonly PluginPaneInfo[]>;
  renderPane(input: PluginPaneRequest): Promise<RuntimeElement | undefined>;
  dispatchKey(input: PluginKeyRequest): Promise<void>;
  listCommands(): Promise<readonly RuntimeCommand[]>;
  runCommand(input: { name: string; args?: string }): Promise<unknown>;
  call(input: PluginCallRequest, toolCallId?: string): Promise<unknown>;
  getView(input: { clientId?: string }): Promise<RuntimeView>;
}

export const IAgentPluginRuntime = createDecorator<IAgentPluginRuntime>('agentPluginRuntime');

export class AgentPluginRuntime extends Service implements IAgentPluginRuntime {
  declare readonly _serviceBrand: undefined;
  private readonly controller = new AbortController();
  private readonly changes = this._register(new Emitter<number>());
  readonly onDidChange = this.changes.event;
  private revision = 0;
  private readonly partials = new Map<string, () => string>();
  private readonly context: RuntimeContext;
  private promptContext: { key: string; value: Promise<RuntimePromptContext> } | undefined;
  private inheritedPromptContext: { key: string; value: Promise<RuntimePromptContext> } | undefined;
  private quota: { provider: string; expires: number; value: Promise<RuntimeSessionUsage['rateLimits']> } | undefined;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private measureKey: string | undefined;
  private measureWork: Promise<void> = Promise.resolve();

  constructor(
    @IPluginRuntimeHost private readonly runtime: IPluginRuntimeHost,
    @ISessionContext session: ISessionContext,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @IModelCatalog private readonly models: IModelCatalog,
    @IAgentEnvironmentBindingService private readonly binding: IAgentEnvironmentBindingService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentToolExecutorService private readonly executor: IAgentToolExecutorService,
    @IAgentPermissionPolicyService private readonly permissions: IAgentPermissionPolicyService,
    @IAgentPermissionGate private readonly permissionGate: IAgentPermissionGate,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentRequestHooks requestHooks: IAgentRequestHooks,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentContextMemoryService private readonly memory: IAgentContextMemoryService,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IOAuthService private readonly auth: IOAuthService,
    @ISessionEventBus bus: ISessionEventBus,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.context = { sessionId: session.sessionId, agentId: scope.agentId, cwd: binding.current.cwd ?? session.cwd };
    this._register(tasks.onDidChangeTask(() => this.changes.fire(++this.revision)));
    this._register(tasks.onDidAppendOutput(() => this.changes.fire(++this.revision)));
    this._register(runtime.onDidChange(() => this.changes.fire(++this.revision)));
    this._register(runtime.bindContext({
      context: this.context,
      signal: this.controller.signal,
      runAgent: (options) => this.runAgent(options),
      runProcess: (args, options) => this.runProcess(args, options),
      activities: () => tasks.list(false).map((task) => ({ id: task.taskId, title: task.description, kind: task.kind, status: task.status, agentId: task.kind === 'agent' ? task.agentId : undefined })),
      output: async (id) => this.partials.get(id)?.() || await tasks.readOutput(id),
      startTask: (options, work, signal) => tasks.registerTask(new RuntimeTask(options, work, signal), { detached: true }),
      stopTask: async id => { await tasks.stopByUser(id); },
      listTools: () => this.listTools(), callTool: (input, signal) => this.callTool(input, signal), checkTool: (input, signal) => this.checkTool(input, signal),
      hasTool: name => this.toolRegistry.resolve(name) !== undefined,
      listAgents: () => this.agents.list().map(agent => {
        const handle = this.agents.handleOf(agent.agentId)!;
        const profile = handle.accessor.get(IAgentProfileService).data();
        const task = tasks.list(false).find(item => item.kind === 'agent' && item.agentId === agent.agentId);
        return { id: agent.agentId, description: task?.description ?? profile.profileName ?? agent.agentId, status: task?.status ?? 'idle', model: profile.modelAlias };
      }),
      stopAgent: async id => { const child = this.agents.handleOf(id); if (child === undefined || id === this.scope.agentId) throw new Error('Unknown child agent'); child.accessor.get(IAgentLoopService).cancel(); },
      composePrompt: () => this.composePrompt(),
      viewAgent: async agentId => ({ isViewed: agentId === undefined || this.agents.handleOf(agentId) !== undefined }),
      sessionPath: kind => this.sessionPath(kind),
      sessionModel: async () => this.profile.hasModel() ? this.models.get(this.profile.getModel()).name : undefined,
      sessionUsage: () => this.sessionUsage(),
      getEnv: async name => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid environment variable name');
        if (name === 'HOME' || name === 'USERPROFILE') return this.environment.inspect().host?.homeDir ?? this.bootstrap.osHomeDir;
        return this.bootstrap.getEnv(name);
      },
      ancestors: async input => {
        if (!this.environment.isAvailable(['fs'])) return [];
        const lease = this.environment.acquire(['fs']);
        try {
          return await readAncestors(input, { fs: lease.environment.fs!, path: lease.environment.path!, cwd: await this.sessionPath('cwd'), home: lease.environment.host?.homeDir ?? this.bootstrap.osHomeDir, canRead: async path => (await this.checkTool({ tool: 'Read', input: { path } }, this.controller.signal)).decision === 'allow' });
        } finally { lease.dispose(); }
      },
      readPromptContext: () => { const key = this.promptContextKey(); return this.promptContext?.key === key ? this.promptContext.value : this.inheritedPromptContext?.key === key ? this.inheritedPromptContext.value : undefined; },
      inheritPromptContext: value => { this.inheritedPromptContext = value === undefined ? undefined : { key: this.promptContextKey(), value }; },
    }));
    const agent = scope.agentContext;
    this._register(bus.onAgent(agent, TurnStarted, event => this.publishLifecycle('turn.start', { turnId: event.turnId })));
    this._register(bus.onAgent(agent, TurnEnded, event => this.publishLifecycle('turn.complete', { turnId: event.turnId, reason: event.reason, durationMs: event.durationMs })));
    this._register(bus.onAgent(agent, AgentStatusUpdated, event => {
      if (this.scope.agentId !== 'main') return;
      this.publishLifecycle('session.measure');
      if (event.model !== undefined && this.profile.hasModel()) this.publishLifecycle('classic.PostModelSwitch', { to_model: this.models.get(this.profile.getModel()).name });
    }));
    this._register(requestHooks.register('plugin-runtime', async (request) => {
      if (runtime.hasHandlers('prompt.context')) request = await this.applyPromptContext(request);
      let systemPrompt = request.profile?.systemPrompt;
      let tools = request.profile?.tools;
      if (runtime.hasHandlers('prompt.section') || runtime.hasHandlers('prompt.compose')) {
        const composed = await this.composePrompt(systemPrompt);
        systemPrompt = composed.sections.map(section => section.text).join('\n\n');
      }
      if (runtime.hasHandlers('tool.describe') && tools !== undefined) tools = await Promise.all(tools.map(async tool => {
        const result = await runtime.invoke('tool.describe', { tool: tool.name, description: tool.description, isDeferred: tool.deferred === true }, this.context, e => ({ description: e['description'], isDeferred: e['isDeferred'] })) as { description: string; isDeferred?: boolean };
        if (typeof result?.description !== 'string') throw new Error(`Invalid tool description for ${tool.name}`);
        return { ...tool, description: result.description, deferred: result.isDeferred ? true as const : undefined };
      }));
      return { ...request, profile: { ...request.profile, systemPrompt, tools } };
    }));
    this._register(permissions.registerReviewer(async (context, evaluation) => {
      if (!runtime.hasHandlers('tool.check')) return evaluation;
      const decision = evaluation.result.kind === 'approve' ? 'allow' : evaluation.result.kind;
      const result = await runtime.invoke('tool.check', { tool: context.toolCall.name, input: context.args, decision, agentId: this.scope.agentId === 'main' ? undefined : this.scope.agentId }, this.context, () => ({ decision })) as RuntimeToolCheck;
      if (!['allow', 'ask', 'deny'].includes(result?.decision)) throw new Error('Invalid tool.check result');
      if (result.decision === 'deny') return { policyName: 'plugin-tool-check', result: { kind: 'deny', message: result.reason ?? 'Tool denied by runtime plugin' } };
      if (result.decision === 'ask' && decision === 'allow') return { policyName: 'plugin-tool-check', result: { kind: 'ask' } };
      return evaluation;
    }));
    this._register(executor.registerCallMiddleware(async (call, options, next) => {
      if (runtime.toolsFor(this.context).some(tool => tool.name === call.name)) return next(call);
      let args: unknown;
      try { args = JSON.parse(call.arguments ?? '{}'); } catch { return next(call); }
      const definition = this.toolRegistry.list().find(tool => tool.name === call.name);
      if (!this.toolPolicy.isToolActive(call.name, definition?.source)) return next(call);
      if (runtime.hasHandlers('tool.check') || this.permissionGate.data().rules.some(rule => rule.decision === 'deny')) {
        const check = await this.checkTool({ tool: call.name, input: args }, options.signal);
        if (check.decision === 'deny') return next(call);
      }
      let core: import('#/agent/toolExecutor/toolExecutor').ToolExecutionResult | undefined;
      const fields = args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : { input: args };
      const answered = await runtime.invoke('tool.call', { ...fields, tool: call.name, tool_use_id: call.id, agentId: this.scope.agentId === 'main' ? undefined : this.scope.agentId }, { ...this.context, toolCallId: call.id, signal: options.signal }, async e => {
        const { tool, tool_use_id: _id, agentId: _agent, ...rewritten } = e;
        if (typeof tool !== 'string') throw new Error('Invalid rewritten tool name');
        core = await next({ ...call, name: tool, arguments: JSON.stringify(rewritten) });
        return { result: core.result.output, isError: core.result.isError };
      }) as { result?: unknown; deny?: string; isError?: boolean; context?: readonly string[] };
      if (answered?.deny !== undefined) {
        return { toolCallId: call.id, toolName: call.name, durationMs: core?.durationMs ?? 0, result: { isError: true, output: core === undefined ? answered.deny : `${call.name} ran, and a plugin withheld its result: ${answered.deny}` } };
      }
      if (answered.context !== undefined && (!Array.isArray(answered.context) || answered.context.some(text => typeof text !== 'string'))) throw new Error('Invalid tool context');
      const value = answered?.result;
      const parts = Array.isArray(value) && value.every(part => part !== null && typeof part === 'object' && ['text', 'think', 'image_url', 'audio_url', 'video_url'].includes(part.type));
      const output = typeof value === 'string' ? value : parts ? value as ContentPart[] : JSON.stringify(value ?? null);
      return { toolCallId: call.id, toolName: core?.toolName ?? call.name, durationMs: core?.durationMs ?? 0, result: { ...core?.result, output, context: answered.context, isError: (answered?.isError ?? core?.result.isError) === true ? true : undefined } };
    }, () => runtime.hasHandlers('tool.call')));
  }

  override dispose(): void {
    this.controller.abort(new Error('Agent session closed'));
    super.dispose();
  }

  openSite(input: { component: string; surface?: import('./runtime').RuntimeRenderSurface; props?: Record<string, unknown> }): Promise<string | undefined> { return this.runtime.openSite(input, this.context); }
  async renderSite(input: RuntimeSiteRequest): Promise<RuntimeElement | undefined> {
    if (input.component === 'AbovePrompt' && !this.bootstrap.args.nonInteractive) await this.measure();
    return this.runtime.renderSite(input, { ...this.context, clientId: input.clientId });
  }
  dispatchSiteKey(input: { component: string; requestId?: string; key: string; clientId?: string }): Promise<void> { return this.runtime.dispatchSiteKey(input, { ...this.context, clientId: input.clientId }); }

  private publishLifecycle(name: string, data: Record<string, unknown> = {}): void {
    this.changes.fire(++this.revision);
    if (!this.runtime.hasHandlers(name)) return;
    this.lifecycleQueue = this.lifecycleQueue.then(async () => {
      if (this.controller.signal.aborted) return;
      if (name === 'session.measure') { await this.measure(); return; }
      const input = { ...data, agentId: this.scope.agentId === 'main' ? undefined : this.scope.agentId };
      await this.runtime.runCore(() => this.runtime.invoke(name, input, this.context, () => undefined));
    }).catch(error => this.log.warn(`Plugin lifecycle event failed: ${name}`, { error }));
  }

  private measure(): Promise<void> {
    const work = this.measureWork.then(async () => {
      await this.runtime.ready;
      if (!this.runtime.hasHandlers('session.measure') || this.controller.signal.aborted) return;
      const usage = await this.sessionUsage();
      const key = `${this.runtime.generation}:${JSON.stringify(usage)}`;
      if (key === this.measureKey || this.controller.signal.aborted) return;
      await this.runtime.runCore(() => this.runtime.invoke('session.measure', usage as unknown as Record<string, unknown>, this.context, () => undefined));
      this.measureKey = key;
    });
    this.measureWork = work.catch(() => {});
    return work;
  }

  private async sessionUsage(): Promise<RuntimeSessionUsage> {
    const model = this.profile.hasModel() ? this.models.get(this.profile.getModel()) : undefined;
    const tokens = this.tokenCounting.statusSize(this.scope.agentContext);
    const capability = model === undefined ? undefined : this.profile.getModelCapabilities();
    const window = capability?.max_input_tokens ?? capability?.max_context_tokens ?? model?.maxContextSize;
    const rateLimits = model?.providerName === KIMI_CODE_PROVIDER_NAME ? await this.accountLimits(model.providerName) : [];
    return { startedAt: (await this.metadata.read()).createdAt, context: { tokens, window, percent: window === undefined || window <= 0 ? undefined : tokens / window * 100 }, rateLimits: rateLimits.map(entry=>({...entry})) };
  }

  private accountLimits(provider: string): Promise<RuntimeSessionUsage['rateLimits']> {
    if (this.quota?.provider === provider && this.quota.expires > Date.now()) return this.quota.value;
    const value = this.auth.getManagedUsage(provider).then(result => {
      if (result.kind !== 'ok') { this.log.warn('Plugin account usage unavailable', { message: result.message }); return []; }
      const entries = [['five_hour', result.quota.usages.limit5h], ['seven_day', result.quota.usages.limit7d], ['monthly', result.quota.usages.monthTotal], ['monthly_code', result.quota.usages.monthCode]] as const;
      return entries.flatMap(([kind, entry]) => entry !== undefined && Number.isFinite(entry.usedRatio) ? [{ kind, percentUsed: Math.max(0, entry.usedRatio) * 100, resetsAt: entry.resetAt }] : []);
    }).catch(error => { this.log.warn('Plugin account usage unavailable', { error }); return []; });
    this.quota = { provider, expires: Date.now() + 30000, value };
    return value;
  }

  closePane(input: { id: string }): Promise<void> { return this.runtime.closePane(input.id,this.context); }

  async listPanes(): Promise<readonly PluginPaneInfo[]> {
    await this.runtime.ready;
    return this.runtime.listPanes(this.context);
  }

  renderPane(input: PluginPaneRequest): Promise<RuntimeElement | undefined> {
    return this.runtime.renderPane(input.id, input.width, { ...this.context, clientId: input.clientId }, { rows: input.rows, placement: input.placement, surface: input.surface });
  }

  dispatchKey(input: PluginKeyRequest): Promise<void> {
    return this.runtime.dispatchKey(input.id, input.key, { ...this.context, clientId: input.clientId });
  }

  listCommands(): Promise<readonly RuntimeCommand[]> {
    return this.runtime.listCommands();
  }

  runCommand(input: { name: string; args?: string }): Promise<unknown> {
    return this.runtime.runCommand(input.name, input.args ?? '', this.context);
  }

  call(input: PluginCallRequest, toolCallId?: string): Promise<unknown> {
    const run = () => this.runtime.call(input.method, input.input, { ...this.context, toolCallId });
    return toolCallId === undefined ? this.runtime.runCore(run) : run();
  }

  async getView(input: { clientId?: string }): Promise<RuntimeView> { return this.runtime.getView({ ...this.context, clientId: input.clientId }); }

  private listTools(): readonly RuntimeToolInfo[] {
    return this.toolRegistry.list().filter(tool => this.toolPolicy.isToolActive(tool.name, tool.source)).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters, source: tool.source }));
  }

  private async sessionPath(kind: 'root' | 'cwd'): Promise<string> {
    const cwd = this.binding.current.cwd ?? this.environment.workspaceRoots().workDir;
    if (kind === 'cwd' || !this.environment.isAvailable(['fs'])) return cwd;
    const lease = this.environment.acquire(['fs']);
    try { return (await findGitWorkTree(lease.environment.fs!, cwd))?.root ?? cwd; }
    finally { lease.dispose(); }
  }

  private async applyPromptContext(request: AgentRequest): Promise<AgentRequest> {
    const profile = this.profile.data();
    const metadata = request.profile?.systemPrompt === profile.systemPrompt ? profile.instructionPrompt : undefined;
    const key = this.promptContextKey();
    const blocks = [{ name: 'claudeMd', text: renderInstructionFiles(metadata?.files ?? []) }];
    const original = { blocks, instructionFiles: metadata?.files };
    if (this.promptContext?.key !== key) {
      this.promptContext = { key, value: this.inheritedPromptContext?.key === key ? this.inheritedPromptContext.value : this.runtime.invoke('prompt.context', original, this.context, e => synchronizePromptContext(e, e)) as Promise<RuntimePromptContext> };
      this.inheritedPromptContext = undefined;
    }
    const composed = await this.promptContext.value;
    const text = composed.blocks.find(block => block.name === 'claudeMd')?.text ?? '';
    const unchanged = text === blocks[0]!.text && JSON.stringify(composed.instructionFiles) === JSON.stringify(metadata?.files);
    const systemPrompt = unchanged ? request.profile?.systemPrompt : metadata === undefined ? [request.profile?.systemPrompt, text].filter(Boolean).join('\n\n') : text.length === 0 ? metadata.empty : metadata.prefix + text + metadata.suffix;
    const extra = composed.blocks.filter(block => block.name !== 'claudeMd' && block.text.length > 0).map(block => ({ type: 'text' as const, text: `# ${block.name}\n${block.text}` }));
    let added = false;
    const messages = extra.length === 0 ? request.content.messages : request.content.messages.map(message => {
      if (added || message.role !== 'user') return message;
      added = true;
      return { ...message, content: [...message.content, ...extra] };
    });
    return { ...request, profile: { ...request.profile, systemPrompt }, content: { ...request.content, messages } };
  }

  private promptContextKey(): string {
    return `${this.runtime.generation}:${this.profile.data().renderGeneration}:${this.memory.prefixRevision()}`;
  }

  private async callTool(input: RuntimeToolCall, signal: AbortSignal): Promise<RuntimeToolResult> {
    const { tool, input: nested, ...fields } = input;
    const result = this.executor.execute([{ type: 'function', id: randomUUID(), name: tool, arguments: JSON.stringify(nested ?? fields) }], { origin: 'plugin', signal: AbortSignal.any([signal, this.controller.signal]), turnId: 0 });
    for await (const executed of result) {
      const output = executed.result.output;
      return { result: output, text: typeof output === 'string' ? output : undefined, isError: executed.result.isError };
    }
    throw new Error(`Tool did not return a result: ${tool}`);
  }

  private async checkTool(input: RuntimeToolCall, signal: AbortSignal): Promise<RuntimeToolCheck> {
    const definition = this.toolRegistry.list().find(tool => tool.name === input.tool);
    const tool = this.toolRegistry.resolve(input.tool);
    if (tool === undefined || !this.toolPolicy.isToolActive(input.tool, definition?.source)) return { decision: 'deny', reason: 'Tool is unavailable or disabled' };
    const { tool: name, input: nested, ...fields } = input;
    const args = nested ?? fields;
    if (tool.parameters !== undefined) {
      const issue = validateToolArgs(compileToolArgsValidator(tool.parameters), args as JsonType);
      if (issue !== null) return { decision: 'deny', reason: issue };
    }
    const execution = await tool.resolveExecution(args);
    if (execution.isError === true) return { decision: 'deny', reason: typeof execution.output === 'string' ? execution.output : 'Invalid tool input' };
    const evaluated = await this.permissions.evaluate({ toolCall: { type: 'function', id: randomUUID(), name, arguments: JSON.stringify(args) }, toolCalls: [], tool, args, execution, turnId: 0, signal });
    const base: RuntimeToolCheck = { decision: evaluated?.result.kind === 'approve' ? 'allow' : evaluated?.result.kind === 'deny' ? 'deny' : 'ask', reason: evaluated?.policyName ?? this.permissionGate.data().mode };
    return base;
  }

  private async composePrompt(base = this.profile.getSystemPrompt()): Promise<{ sections: readonly import('./runtime').RuntimePromptSection[] }> {
    const section = { id: 'kimi:system', text: base, scope: 'shared' as const };
    const result = await this.runtime.invoke('prompt.section', { name: section.id, text: section.text }, this.context, e => ({ text: e['text'] }));
    const text = result !== null && typeof result === 'object' && 'text' in result ? result.text : section.text;
    const sections = typeof text === 'string' ? [{ ...section, text }] : [];
    const composed = await this.runtime.invoke('prompt.compose', { sections }, this.context, e => ({ sections: e['sections'] })) as { sections: readonly import('./runtime').RuntimePromptSection[] };
    if (!Array.isArray(composed?.sections) || composed.sections.some(item => typeof item.id !== 'string' || typeof item.text !== 'string' || !['shared', 'session'].includes(item.scope))) throw new Error('Invalid prompt sections');
    let sessionSeen = false;
    for (const item of composed.sections) { if (item.scope === 'session') sessionSeen = true; else if (sessionSeen) throw new Error('Shared prompt sections must precede session sections'); }
    return composed;
  }

  private async runAgent(options: RuntimeAgentOptions): Promise<RuntimeAgentResult> {
    if (typeof options.model !== 'string' || options.model.length === 0) throw new Error('A workflow agent requires an explicit model');
    if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)) throw new Error('Agent output limit must be a positive integer');
    const signal = AbortSignal.any([this.controller.signal, options.signal ?? this.controller.signal]);
    signal.throwIfAborted();
    const structured = options.schema === undefined ? undefined : new RuntimeStructuredOutput(options.schema);
    const parent = this.agents.handleOf(this.scope.agentId);
    if (parent === undefined) throw new Error('Calling agent is no longer available');
    let plan = await this.subagents.planSpawn({ callerAgentId: this.scope.agentId, profileName: options.profile, model: options.model });
    const prompt = options.schema === undefined ? options.prompt : `${options.prompt}\n\nSubmit your final result using the StructuredOutput tool. Its JSON schema defines the required result. Correct validation errors in this same context.`;
    const spawned = await this.subagents.spawn({ callerAgentId: this.scope.agentId, plan, prompt, labels: subagentLabels(this.scope.agentId), toolCallId: options.parentToolCallId, background: true });
    plan = { ...plan, model: spawned.model, modelSource: spawned.modelSource, profileName: spawned.profileName };
    const child = this.agents.handleOf(spawned.agentId);
    if (child === undefined) throw new Error('Spawned agent is unavailable');
    const childProfile = child.accessor.get(IAgentProfileService);
    const childRegistry = child.accessor.get(IAgentToolRegistryService);
    if (structured !== undefined && childRegistry.resolve(structured.name) !== undefined) throw new Error('StructuredOutput is reserved for this agent result');
    const outputRegistration = structured === undefined ? undefined : childRegistry.register(structured);
    const budgetRegistration = options.maxOutputTokens === undefined ? undefined : child.accessor.get(IAgentRequestHooks).register('plugin-budget', async request => ({ ...request, model: { ...request.model, maxOutputTokens: Math.min(typeof request.model.maxOutputTokens === 'number' ? request.model.maxOutputTokens : Infinity, options.maxOutputTokens!) } }));
    if (structured !== undefined) childProfile.addActiveTool(structured.name);
    const controller = new AbortController();
    const runSignal = AbortSignal.any([signal, controller.signal]);
    const model = this.models.get(plan.model);
    const startedAt = Date.now();
    let toolCalls = 0;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let firstResponseAt: number | undefined;
    const progress = (): RuntimeAgentProgress => ({
      model: model.displayName ?? model.name ?? plan.model,
      maxContextTokens: model.maxContextSize, inputTokens, outputTokens,
      toolCalls, elapsedMs: Date.now() - startedAt, firstResponseAt,
    });
    let lastUpdate = 0;
    const publish = (force = false): void => {
      if (!force && Date.now() - lastUpdate < 100) return;
      lastUpdate = Date.now();
      try { options.onProgress?.(progress()); } catch (error) { controller.abort(error); }
      this.changes.fire(++this.revision);
    };
    const bus = child.accessor.get(IEventBus);
    const tools = bus.subscribe(ToolCallStarted, () => { toolCalls++; publish(true); });
    const status = bus.subscribe(AgentStatusUpdated, (event) => {
      const usage = event.usage?.total;
      if (usage !== undefined) {
        inputTokens = usage.inputOther + usage.inputCacheCreation + (usage.inputCacheRead ?? 0);
        outputTokens = usage.output;
      }
      publish();
    });
    const stream = bus.subscribe(() => { publish(); });
    const markResponse = (): void => { firstResponseAt ??= Date.now(); publish(true); };
    const response = bus.subscribe(AssistantDelta, markResponse);
    const thinking = bus.subscribe(ThinkingDelta, markResponse);
    const cleanup = (): void => { tools.dispose(); status.dispose(); stream.dispose(); response.dispose(); thinking.dispose(); budgetRegistration?.dispose(); outputRegistration?.dispose(); if (structured !== undefined) childProfile.removeActiveTool(structured.name); };
    let run;
    try {
      publish(true);
      run = await this.subagents.run(agentContextOf(child), { kind: 'prompt', prompt: spawned.promptText }, { signal: runSignal, resultText: () => structured?.text() });
    } catch (error) { cleanup(); throw error; }

    const initialRun = run;
    const validatedCompletion = (async () => {
      let current = initialRun;
      for (let attempt = 0; ; attempt++) {
        let result;
        try { result = await current.completion; }
        catch (error) { if (structured?.exhausted()) throw new Error(`Structured output validation failed: ${structured.error()}`, { cause: error }); throw error; }
        if (structured === undefined || structured.text() !== undefined) return result;
        if (attempt >= 4 || structured.exhausted()) throw new Error('Agent did not submit valid StructuredOutput after five attempts');
        current = await this.subagents.run(agentContextOf(child), { kind: 'prompt', prompt: 'The task result is missing. Submit your final object using StructuredOutput; do not return prose.' }, { signal: runSignal, resultText: () => structured.text() });
      }
    })();
    const completion = mirrorAgentRun(parent, { ...run, completion: validatedCompletion }, { profileName: plan.profileName, prompt: spawned.promptText, signal: runSignal, cancel: (reason) => controller.abort(reason) });
    let taskId: string;
    try {
      taskId = this.tasks.registerTask(new SubagentTask({
        agentId: run.agentId, profileName: plan.profileName, model: plan.model, parentToolCallId: options.parentToolCallId, parentRunId: options.parentRunId,
        completion: completion.then((result) => ({ result: result.summary, usage: result.usage, stopReason: result.stopReason })),
        partialOutput: run.partialOutput,
      }, options.label ?? 'Plugin agent', controller), { detached: true, signal: runSignal });
    } catch (error) {
      controller.abort(error);
      await completion.catch(() => undefined);
      cleanup();
      throw error;
    }
    this.partials.set(taskId, run.partialOutput);
    if (options.notify === false) await this.tasks.suppressTerminalNotification(taskId);
    emitAgentRunSpawned(parent, run.agentId, { profileName: plan.profileName, parentToolCallId: options.parentToolCallId, model: plan.model, modelSource: plan.modelSource, description: options.label, runInBackground: true, taskId });
    try {
      options.onStarted?.(run.agentId, taskId, plan.model);
      const result = await completion;
      let value: unknown;
      if (structured !== undefined) value = structured.result();
      const usage = result.usage === undefined ? undefined : { input: result.usage.inputOther + result.usage.inputCacheCreation + (result.usage.inputCacheRead ?? 0), output: result.usage.output, cache_read: result.usage.inputCacheRead, cache_write: result.usage.inputCacheCreation };
      return { agentId: run.agentId, taskId, text: result.summary, value, usage, progress: progress() };
    } catch (error) {
      controller.abort(error);
      await completion.catch(() => undefined);
      throw error;
    } finally {
      cleanup();
      this.partials.delete(taskId);
      if (runSignal.aborted) controller.abort(runSignal.reason);
    }
  }

  private async runProcess(args: readonly string[], options: { timeoutMs?: number; cwd?: string; input?: string; signal?: AbortSignal } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const signal = AbortSignal.any([this.controller.signal, options.signal ?? this.controller.signal]);
    signal.throwIfAborted();
    const [command, ...rest] = args;
    if (!command) throw new Error('process.run requires a command');
    const lease = await this.environment.acquireWhenReady(['process']);
    try {
      const child = lease.track(await lease.environment.process!.spawn(command, rest, { cwd: options.cwd ?? this.context.cwd, timeout: options.timeoutMs ?? 30_000, shell: false }));
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-4_000_000); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_000_000); });
      const abort = (): void => { void child.kill('SIGKILL'); };
      signal.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
      try {
        if (signal.aborted) abort();
        const exitCode = await child.wait();
        signal.throwIfAborted();
        return { exitCode, stdout, stderr };
      } finally {
        signal.removeEventListener('abort', abort);
        await child.dispose();
      }
    } finally { lease.dispose(); }
  }
}
