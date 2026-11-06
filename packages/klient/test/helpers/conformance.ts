/**
 * Shared conformance suite — the guarantee that the ipc and memory
 * transports are interchangeable. Every transport test file runs the exact
 * same assertions against a real in-process engine; only the `before` setup
 * differs per file.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Service } from '@moonshot-ai/agent-core-v2/_base/di/service';
import { CommandContribution } from '@moonshot-ai/agent-core-v2/agent/command/commandContribution';
import { ToolResultEvent } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import { IEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import { IConfigService, ConfigTarget } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IOAuthService } from '@moonshot-ai/agent-core-v2/app/auth/auth';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { IFeatureManager } from '@moonshot-ai/agent-core-v2/app/feature/featureManager';
import { getLiveSessionById } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionLookup';
import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IAgentToolPolicyService } from '@moonshot-ai/agent-core-v2/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '@moonshot-ai/agent-core-v2/agent/toolRegistry/toolRegistry';
import { IAgentPermissionRulesService } from '@moonshot-ai/agent-core-v2/agent/permissionRules/permissionRules';
import { IAgentContextMemoryService } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentLifecycleService } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '@moonshot-ai/agent-core-v2/session/subagent/subagent';
import { IAgentLoopService } from '@moonshot-ai/agent-core-v2/agent/loop/loop';
import { IPluginRuntimeHost } from '@moonshot-ai/agent-core-v2/app/plugin/runtime';
import { IWireService } from '@moonshot-ai/agent-core-v2/wire/wire';
import { IModelCatalog } from '@moonshot-ai/agent-core-v2/llm-adapter/model/catalog';
import { IModelService } from '@moonshot-ai/agent-core-v2/llm-adapter/model/model';
import { IProtocolAdapterRegistry } from '@moonshot-ai/agent-core-v2/llm-adapter/protocol/protocol';
import { generateModel } from '@moonshot-ai/agent-core-v2/llm-adapter/model/generate';
import type { LlmRequester } from '@moonshot-ai/agent-core-v2/human/llm-requester/requester';
import { coreRequesterFromA } from '../../../agent-core-v2/test/harness/scripted-generate.js';
import {
  resetModelsDevUpstreamForTest,
  setModelsDevUpstreamForTest,
} from '@moonshot-ai/agent-core-v2/app/kosongConfig/modelsDevUpstream';

import type { Klient } from '../../src/index.js';
import type { TestEngine } from './engine.js';

export interface KlientConformanceTarget {
  readonly klient: Klient;
  /**
   * The in-process engine's App scope. Both transports boot the engine
   * in-process, so the suite can assemble dynamic units (e.g. contributed
   * commands) through the production `IFeatureManager` path.
   */
  readonly app: TestEngine['app'];
  cleanup(): Promise<void>;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export function defineKlientConformance(
  transport: string,
  makeTarget: () => Promise<KlientConformanceTarget>,
): void {
  describe(`klient conformance: ${transport}`, () => {
    let target: KlientConformanceTarget;

    beforeAll(async () => {
      target = await makeTarget();
    });

    afterAll(async () => {
      await target.cleanup();
    });

    it('env() aggregates the host snapshot', async () => {
      const env = await target.klient.global.env();
      expect(env.platform).toBe(process.platform);
      expect(env.homeDir.length).toBeGreaterThan(0);
      expect(env.clientVersion.length).toBeGreaterThan(0);
    });

    it('workspaces round-trip through create/get/update/list/delete', async () => {
      const additionalDir = await mkdtemp(join(tmpdir(), 'klient-workspace-extra-'));
      try {
        const workspaces = target.klient.global.workspaces;
        const created = await workspaces.createOrTouch({ root: process.cwd(), name: 'conformance' });
        expect(created.id.length).toBeGreaterThan(0);

        const fetched = await workspaces.get(created.id);
        expect(fetched?.name).toBe('conformance');

        const updated = await workspaces.update({ id: created.id, patch: { name: 'conformance-2' } });
        expect(updated?.name).toBe('conformance-2');

        const withAdditionalDirs = await workspaces.update({
          id: created.id,
          patch: { additionalDirs: [additionalDir] },
        });
        expect(withAdditionalDirs?.additionalDirs).toEqual([additionalDir]);

        const cleared = await workspaces.update({
          id: created.id,
          patch: { additionalDirs: [] },
        });
        expect(cleared?.additionalDirs).toEqual([]);

        const list = await workspaces.list();
        expect(list.some((w) => w.id === created.id)).toBe(true);

        await workspaces.delete(created.id);
        expect(await workspaces.get(created.id)).toBeUndefined();
      } finally {
        await rm(additionalDir, { recursive: true, force: true });
      }
    });

    it('exposes runtime plugin methods and subscriptions on the agent facade', async () => {
      expect(await target.klient.global.plugins.listRuntimeCommands()).toEqual([]);
      const session = await target.klient.global.sessions.create({ workDir: process.cwd() });
      const agent = target.klient.session(session.id).agent('main');
      expect(await agent.plugins.listPanes()).toEqual([]);
      expect(await agent.plugins.openSite({ component: 'KimiTasks' })).toBeUndefined();
      expect(await agent.plugins.renderSite({ component:'AbovePrompt',width:80,rows:10 })).toBeUndefined();
      expect(await agent.plugins.listCommands()).toEqual([]);
      expect(await agent.plugins.renderPane({ id: 'missing', width: 80 })).toBeUndefined();
      await expect(agent.plugins.call({ method: 'missing.domain.method', input: {} })).rejects.toThrow('Unknown plugin method');
      const subscription = agent.events.on('plugins.changed', () => {});
      subscription.dispose();
    });

    it('renders native session context and cached account limits through persistent mod sites', async () => {
      const root=await mkdtemp(join(tmpdir(),'native-plugin-chrome-'));
      const flags=target.app.accessor.get(IFlagService);
      const usage=vi.spyOn(target.app.accessor.get(IOAuthService),'getManagedUsage').mockResolvedValue({kind:'ok',quota:{usages:{limit5h:{usedRatio:0.42,resetAt:'2030-01-01T12:00:00Z'},limit7d:{usedRatio:0.15}},extraUsage:null}});
      let sessionId:string|undefined;
      try {
        flags.setConfigOverrides({plugin_runtime:true});
        await target.klient.global.kosong.addProvider('managed:kimi-code',{type:'openai',baseUrl:'http://127.0.0.1:1',auth:{method:'api-key',apiKey:'YOUR_API_KEY'}});
        await target.app.accessor.get(IModelService).set('chrome-model',{provider:'managed:kimi-code',model:'example-model',maxContextSize:32768});
        await writeFile(join(root,'kimi.plugin.json'),JSON.stringify({name:'chrome-test',runtime:{api:'claude-mods',modules:['./index.ts'],capabilities:['events','session','state','ui','domains','clock']}}));
        await writeFile(join(root,'index.ts'),`
          import {atom,read,update} from 'claude-code';
          const count=atom({plugin:'chrome-test',key:'count'},0);
          const usage=atom({plugin:'chrome-test',key:'usage'},null);
          export function register(on){
            on('engine.create',async(_,e,next)=>({...await next(e),facts:{get:()=>{}}}));
            on('facts.get',async $=>({value:{id:await $.session.id(),model:await $.session.model(),usage:await $.session.usage(),surfaces:await $.session.surfaces()}}));
            on('session.measure',async($,e,next)=>{await new Promise(done=>$.clock.after(30,done));await update($,usage,()=>e);return next(e)});
            on('ui.render',{component:'Spinner'},async($,e,next)=>$.ui.resolve(e).Box({children:[$.ui.resolve(e).Text({children:['Native:']}),await next({...e,props:{...e.props,word:'Active'}})]}));
            on('ui.render',{component:'AbovePrompt'},async($,e)=>{
              const {Box,Text,Button,Svg}=$.ui.resolve(e);const u=await read($,usage);
              return Box({children:[Text({children:['5h '+u.rateLimits[0].percentUsed+' Context '+u.context.window+' Count '+await read($,count)]}),Button({key:'more',label:'More',onPress:async event=>{await update($,count,n=>n+(event.surface==='desktop'?2:1));await $.ui.open({id:'card',title:'Card'})}}),e.surface==='desktop'?Svg({source:'<svg xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="5"/></svg>',alt:'Circle',width:20,height:20}):Text({children:[]})]});
            });
          }
        `);
        await target.klient.global.plugins.install(root);
        await target.klient.global.plugins.setEnabled({id:'chrome-test',enabled:true});
        await target.klient.global.plugins.reload();
        const created=await target.klient.global.sessions.create({workDir:root});sessionId=created.id;
        const agent=target.klient.session(sessionId).agent('main');
        await agent.setModel('chrome-model');
        const spinner = await agent.plugins.renderSite({component:'Spinner',width:80,rows:1,clientId:'one',props:{word:'Working'},defaultTree:{type:'Text',props:{key:'kimi-native-Spinner'},children:['Working']}});
        expect(spinner).toMatchObject({type:'Box',children:[{type:'Text',children:['Native:']},{type:'Text',props:{key:'kimi-native-Spinner'},children:['Active']}]});
        const facts=await agent.plugins.call({method:'chrome-test.facts.get',input:{}}) as {id:string;model:string;usage:{context:{window:number};rateLimits:{kind:string;percentUsed:number}[]}};
        expect(facts.id).toBe(sessionId);expect(facts.model).toBe('example-model');
        expect(facts.usage.context.window).toBe(32768);
        expect(facts.usage.rateLimits).toMatchObject([{kind:'five_hour',percentUsed:42},{kind:'seven_day',percentUsed:15}]);
        const tree=await agent.plugins.renderSite({component:'AbovePrompt',width:80,rows:10,clientId:'one'}) as import('@moonshot-ai/agent-core-v2/app/plugin/mods').RenderElement;
        expect(JSON.stringify(tree)).toContain('5h 42 Context 32768 Count 0');
        const button=tree.children![1] as import('@moonshot-ai/agent-core-v2/app/plugin/mods').RenderElement;
        const key='callback:'+JSON.stringify({handle:button.props!['callback']});
        await expect(agent.plugins.dispatchSiteKey({component:'AbovePrompt',key,clientId:'two'})).rejects.toThrow('foreign');
        await agent.plugins.dispatchSiteKey({component:'AbovePrompt',key,clientId:'one'});
        expect(JSON.stringify(await agent.plugins.renderSite({component:'AbovePrompt',width:80,rows:10,clientId:'one'}))).toContain('Count 1');
        const graphical=await agent.plugins.renderSite({component:'AbovePrompt',surface:'desktop',width:80,rows:10,clientId:'one'}) as import('@moonshot-ai/agent-core-v2/app/plugin/mods').RenderElement;
        expect(graphical.children?.[2]).toMatchObject({type:'Svg',props:{alt:'Circle',width:20}});
        const surfaces=await agent.plugins.call({method:'chrome-test.facts.get',input:{}}) as {surfaces:string[]};
        expect(surfaces.surfaces).toEqual(['desktop']);
        await agent.plugins.dispatchSiteKey({component:'AbovePrompt',key,clientId:'one'});
        expect(JSON.stringify(await agent.plugins.renderSite({component:'AbovePrompt',width:80,rows:10,clientId:'one'}))).toContain('Count 3');
        expect(await agent.plugins.getView({clientId:'one'})).toMatchObject({paneId:'card'});
        await agent.plugins.closePane({id:'card'});
        expect((await agent.plugins.getView({clientId:'one'})).paneId).toBeUndefined();
        expect(usage).toHaveBeenCalledTimes(1);
        expect(await agent.plugins.listPanes()).toEqual([]);
      } finally {
        if(sessionId!==undefined) await target.klient.session(sessionId).close();
        await target.klient.global.plugins.remove('chrome-test').catch(()=>{});
        usage.mockRestore();flags.setConfigOverrides(undefined);
        await rm(root,{recursive:true,force:true});
      }
    });

    it.runIf(process.env['CLAUDE_MOD_FIXTURE'])('runs the original agents-md in native prompts, reads, forks and separate sessions', async () => {
      const root = await mkdtemp(join(tmpdir(), 'native-original-mod-'));
      const flags = target.app.accessor.get(IFlagService);
      const protocols = target.app.accessor.get(IProtocolAdapterRegistry);
      const request = protocols.request.bind(protocols);
      const seen: { prompt: string; messages: string }[] = [];
      let reads: string[] = [];
      let serial = 0;
      const requester: LlmRequester = { generate: async (config, content, control) => {
        seen.push({ prompt: config.systemPrompt ?? '', messages: JSON.stringify(content.messages) });
        const filename = reads.shift();
        control.onEvent?.({ type: 'llm.streaming.part', part: filename === undefined ? { type: 'text', text: 'Done' } : { type: 'function', id: `read-${++serial}`, name: 'Read', arguments: JSON.stringify({ path: filename }) } });
        control.onEvent?.({ type: 'llm.streaming.finish', finish: { finishReason: filename === undefined ? 'completed' : 'tool_calls', rawFinishReason: filename === undefined ? 'stop' : 'tool_calls' } });
        control.onEvent?.({ type: 'llm.done' });
      } };
      const generate = vi.spyOn(protocols, 'request').mockImplementation((model, params) => coreRequesterFromA(request(model, params), requester));
      const sessionIds: string[] = [];
      const settled = async (sessionId: string, agentId = 'main') => {
        const live = getLiveSessionById(target.app.accessor, sessionId)!;
        await live.accessor.get(IAgentLifecycleService).handleOf(agentId)!.accessor.get(IAgentLoopService).settled();
      };
      try {
        await mkdir(join(root, '.git'));
        await mkdir(join(root, '.claude'));
        await mkdir(join(root, 'src'));
        await writeFile(join(root, 'AGENTS.md'), 'ROOT_NATIVE_INSTRUCTIONS');
        await writeFile(join(root, '.claude/AGENTS.md'), 'ROOT_MOD_INSTRUCTIONS\n@extra.md\n@blocked.md\n');
        await writeFile(join(root, '.claude/extra.md'), 'IMPORTED_MOD_INSTRUCTIONS');
        await writeFile(join(root, '.claude/blocked.md'), 'DENIED_MOD_INSTRUCTIONS');
        await writeFile(join(root, 'src/AGENTS.md'), 'NESTED_MOD_INSTRUCTIONS');
        await writeFile(join(root, 'src/file.ts'), 'export const example = true;');
        flags.setConfigOverrides({ plugin_runtime: true, subagent_fork: true });
        await target.klient.global.kosong.addProvider('mods-provider', { type: 'openai', baseUrl: 'http://127.0.0.1:1', auth: { method: 'api-key', apiKey: 'YOUR_API_KEY' } });
        await target.app.accessor.get(IModelService).set('mods-model', { provider: 'mods-provider', model: 'example-model', maxContextSize: 32768 });
        await target.klient.global.plugins.install(process.env['CLAUDE_MOD_FIXTURE']!);
        await target.klient.global.plugins.setEnabled({ id: 'agents-md', enabled: true });
        await target.klient.global.plugins.reload();
        const created = await target.klient.global.sessions.create({ workDir: root });
        sessionIds.push(created.id);
        const agent = target.klient.session(created.id).agent('main');
        await agent.setModel('mods-model');
        await agent.setPermission('yolo');
        const main = getLiveSessionById(target.app.accessor, created.id)!.accessor.get(IAgentLifecycleService).handleOf('main')!;
        main.accessor.get(IAgentPermissionRulesService).addRules([{ decision: 'deny', scope: 'user', pattern: `Read(${join(root, '.claude/blocked.md')})` }]);
        const nativeProfile = main.accessor.get(IAgentProfileService).data();
        expect(nativeProfile.instructionPrompt).toBeDefined();
        expect(target.app.accessor.get(IPluginRuntimeHost).hasHandlers('prompt.context')).toBe(true);
        const probe = await target.app.accessor.get(IPluginRuntimeHost).invoke('prompt.context', { blocks: [{ name: 'claudeMd', text: '' }], instructionFiles: [] }, { cwd: root, sessionId: created.id, agentId: 'main' }, e => e) as { instructionFiles: { path: string }[] };
        expect(probe.instructionFiles.map(file => file.path)).toContain(join(root, '.claude/AGENTS.md'));
        reads = [join(root, 'src/file.ts'), join(root, 'src/file.ts')];
        await agent.prompt({ input: [{ type: 'text', text: 'Read the example file twice.' }] });
        await settled(created.id);
        expect(seen[0]?.prompt).toContain('ROOT_NATIVE_INSTRUCTIONS');
        expect(seen[0]?.prompt).toContain('ROOT_MOD_INSTRUCTIONS');
        expect(seen[0]?.prompt).toContain('IMPORTED_MOD_INSTRUCTIONS');
        expect(seen[0]?.prompt).not.toContain('DENIED_MOD_INSTRUCTIONS');
        expect(seen[0]?.prompt.split('ROOT_NATIVE_INSTRUCTIONS')).toHaveLength(2);
        expect(seen.at(-1)?.messages.split('NESTED_MOD_INSTRUCTIONS')).toHaveLength(2);
        const context = await agent.getContext();
        expect(context.history.filter(message => message.origin?.kind === 'injection' && message.origin.variant === 'plugin-tool-context')).toHaveLength(1);

        const live = getLiveSessionById(target.app.accessor, created.id)!;
        const subagents = live.accessor.get(ISessionSubagentService);
        const plan = await subagents.planSpawn({ callerAgentId: 'main', fork: true });
        const child = await subagents.spawn({ callerAgentId: 'main', plan, prompt: 'Read the same example file.' });
        reads = [join(root, 'src/file.ts')];
        const childFacade = target.klient.session(created.id).agent(child.agentId);
        await childFacade.prompt({ input: [{ type: 'text', text: child.promptText }] });
        await settled(created.id, child.agentId);
        expect((await childFacade.getContext()).history.filter(message => message.origin?.kind === 'injection' && message.origin.variant === 'plugin-tool-context')).toHaveLength(1);

        const memory = main.accessor.get(IAgentContextMemoryService);
        for (const reset of ['clear', 'compaction'] as const) {
          await writeFile(join(root, '.claude/AGENTS.md'), `ROOT_MOD_INSTRUCTIONS\nAFTER_${reset}\n@extra.md\n`);
          if (reset === 'clear') memory.clear();
          else memory.applyCompaction({ summary: 'Earlier work completed.', compactedCount: memory.get().length, tokensBefore: 100 });
          const before = seen.length;
          reads = [join(root, 'src/file.ts')];
          await agent.prompt({ input: [{ type: 'text', text: 'Read again after resetting context.' }] });
          await settled(created.id);
          expect(seen[before]?.prompt).toContain(`AFTER_${reset}`);
          expect(seen.at(-1)?.messages).toContain('NESTED_MOD_INSTRUCTIONS');
        }

        const other = await target.klient.global.sessions.create({ workDir: root });
        sessionIds.push(other.id);
        const otherAgent = target.klient.session(other.id).agent('main');
        await otherAgent.setModel('mods-model');
        await otherAgent.setPermission('yolo');
        reads = [join(root, 'src/file.ts')];
        await otherAgent.prompt({ input: [{ type: 'text', text: 'Read the example file.' }] });
        await settled(other.id);
        expect((await otherAgent.getContext()).history.filter(message => message.origin?.kind === 'injection' && message.origin.variant === 'plugin-tool-context')).toHaveLength(1);

        await target.app.accessor.get(IConfigService).replace('pluginRuntime', { options: { 'agents-md': { instructionFiles: 'managed-only' } } }, ConfigTarget.Memory);
        await target.klient.global.plugins.reload();
        const before = seen.length;
        await otherAgent.prompt({ input: [{ type: 'text', text: 'Reply briefly.' }] });
        await settled(other.id);
        expect(seen[before]?.prompt).not.toContain('ROOT_NATIVE_INSTRUCTIONS');
        expect(seen[before]?.prompt).not.toContain('ROOT_MOD_INSTRUCTIONS');
      } finally {
        for (const id of sessionIds) await target.klient.session(id).close();
        await target.klient.global.plugins.remove('agents-md').catch(() => {});
        generate.mockRestore(); flags.setConfigOverrides(undefined);
        await target.app.accessor.get(IConfigService).replace('pluginRuntime', undefined, ConfigTarget.Memory);
        await rm(root, { recursive: true, force: true });
      }
    });

    it('runs plugin agents through native subagent and task services', async () => {
      const root = await mkdtemp(join(tmpdir(), 'klient-native-plugin-'));
      const flags = target.app.accessor.get(IFlagService);
      const registry = target.app.accessor.get(IProtocolAdapterRegistry);
      const request = registry.request.bind(registry);
      let sessionId: string | undefined;
      const observedTools: string[][] = [];
      const observedPrompts: string[] = [];
      const observedDescriptions: string[] = [];
      const observedLimits: (number | undefined)[] = [];
      let structuredAttempts = 0;
      const fakeRequester: LlmRequester = { generate: (config, _content, control) => {
        observedTools.push((config.tools ?? []).map(tool => tool.name));
        observedPrompts.push(config.systemPrompt ?? '');
        observedDescriptions.push(...(config.tools ?? []).map(tool => tool.description));
        if (config.tools?.some(tool => tool.name === 'StructuredOutput')) {
          observedLimits.push(config.maxCompletionTokens);
          structuredAttempts++;
          control.onEvent?.({ type: 'llm.streaming.part', part: { type: 'function', id: `structured-${structuredAttempts}`, name: 'StructuredOutput', arguments: structuredAttempts === 1 ? '{"ok":"invalid"}' : '{"ok":true}' } });
          control.onEvent?.({ type: 'llm.streaming.finish', finish: { finishReason: 'tool_calls', rawFinishReason: 'tool_calls' } });
          control.onEvent?.({ type: 'llm.streaming.usage', usage: { inputOther: 10, inputCacheCreation: 0, output: 3 } });
          control.onEvent?.({ type: 'llm.done' });
          return Promise.resolve();
        }
        control.onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: '{"ok":true}' } });
        control.onEvent?.({ type: 'llm.streaming.finish', finish: { finishReason: 'completed', rawFinishReason: 'stop' } });
        control.onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      } };
      const generate = vi.spyOn(registry, 'request').mockImplementation((model, params) => coreRequesterFromA(request(model, params), fakeRequester));
      try {
        await target.app.accessor.get(IConfigService).replace('secondaryModel', { models: { 'native-model': '' }, defaultModel: 'native-model' }, ConfigTarget.Memory);
        flags.setConfigOverrides({ plugin_runtime: true });
        await writeFile(join(root, 'kimi.plugin.json'), JSON.stringify({ name: 'native-test', runtime: { modules: ['./index.ts'], capabilities: ['events', 'agent', 'domains', 'command', 'tools', 'prompt', 'script', 'store', 'tasks', 'clock', 'ui', 'log'], tools: [{ name: 'ExampleWorkflow', description: 'Run agents through the native harness', method: 'agent.run', inputSchema: { type: 'object', additionalProperties: false } }] } }));
        const workflowModule = fileURLToPath(new URL('../../../core-plugins/kimi-workflow/runtime/workflow.ts', import.meta.url));
        const source = `return agent('Return JSON', { model: 'native-model', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } });`;
        await writeFile(join(root, 'index.ts'), `import { startWorkflow, listRuns } from ${JSON.stringify(workflowModule)};
        export function register(on) {
          on.command('ready', 'Ready', ($) => $.ui.open({ id: 'native-view', title: 'Native view' }));
          on('ui.key', ($) => $.ui.view({ agentId: 'main' }));
          on.domain('agent', {
            run: { input: { type: 'object' }, handler: ($) => startWorkflow($, { source: ${JSON.stringify(source)}, tokenBudget: 100, concurrency: 1 }) },
            invalid: { input: {}, handler: ($) => $.agent.run({ model: 'native-model', prompt: 'Do not start', schema: { type: 'object', required: ['missing'], additionalProperties: false } }) },
            status: { input: { type: 'object' }, handler: ($) => listRuns($) },
            setup: { input: {}, handler: ($) => $.tool.register({ name: 'double', description: 'Double an integer', inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } }) },
            invoke: { input: {}, handler: ($) => $.tool.call({ tool: 'mcp__native-test__double', value: 21 }) },
            check: { input: {}, handler: ($) => $.tool.check({ tool: 'mcp__native-test__double', value: 21 }) },
            list: { input: {}, handler: ($) => $.agent.list() },
            count: { input: {}, handler: ($) => $.store.get('toolCalls') }
          });
          on('SessionStart', ($) => $.tool.register({ name: 'double', description: 'Double an integer', inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } }));
          on('tool.call', async ($, e, next) => { if (e.data.tool !== 'mcp__native-test__double') return next(e); await $.store.update('toolCalls', (value = 0) => value + 1); return { result: Number(e.data.value) * 2 }; });
          on('tool.check', () => ({ decision: 'allow' }));
          on('tool.describe', async ($, e, next) => e.data.tool === 'ExampleWorkflow' ? { description: 'Native workflow tool description' } : next(e));
          on('prompt.compose', async ($, e, next) => { const result = await next(e); return { sections: [...result.sections, { id: 'native-test:guidance', text: 'Native runtime session guidance', scope: 'session' }] }; });
        }`);
        await target.klient.global.kosong.addProvider('native-provider', { type: 'openai', baseUrl: 'http://127.0.0.1:1', auth: { method: 'api-key', apiKey: 'YOUR_API_KEY' } });
        await target.app.accessor.get(IModelService).set('native-model', { provider: 'native-provider', model: 'example-model', maxContextSize: 32768 });
        const guardRoot = join(root, 'origin-guard');
        await mkdir(guardRoot);
        await writeFile(join(guardRoot, 'kimi.plugin.json'), JSON.stringify({ name: 'a-origin-guard', runtime: { api: 'claude-mods', modules: ['./index.ts'], capabilities: ['events', 'store', 'domains'] } }));
        await writeFile(join(guardRoot, 'index.ts'), `export function register(on) {
          on('engine.create', async (_,e,next) => ({...await next(e),originGuard:{read:()=>({value:[]})}}));
          on('originGuard.read', async $ => ({value:await $.store.get('events') ?? []}));
          on('agent.spawn',async ($,e,next)=>{
            await $.kimi.store.update('events',(events=[])=>[...events,{event:'spawn',origin:next.origin}]);
            return next(e);
          });
          on('tool.call',{tool:['StructuredOutput','mcp__native-test__double']},async ($,e,next)=>{
            await $.kimi.store.update('events',(events=[])=>[...events,{event:'tool',tool:e.tool,origin:next.origin}]);
            const result=await next(e);
            if(e.tool==='mcp__native-test__double') throw new Error('recover after execution');
            return result;
          }).catch(async ($,e,next)=>{
            await $.kimi.store.update('events',(events=[])=>[...events,{event:'catch',called:next.called,kind:next.error.kind}]);
            return next(e);
          });
        }`);
        await target.klient.global.plugins.install(guardRoot);
        await target.klient.global.plugins.setEnabled({ id: 'a-origin-guard', enabled: true });
        const plugin = await target.klient.global.plugins.install(root);
        await target.klient.global.plugins.setEnabled({ id: plugin.id, enabled: true });
        await target.klient.global.plugins.reload();
        expect(await target.klient.global.plugins.listRuntimeCommands()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'native-test:ready', pluginId: 'native-test' })]));
        const created = await target.klient.global.sessions.create({ workDir: root });
        sessionId = created.id;
        const agent = target.klient.session(created.id).agent('main');
        await agent.setModel('native-model');
        const main = getLiveSessionById(target.app.accessor, created.id)?.accessor.get(IAgentLifecycleService).handleOf('main');
        expect(main?.accessor.get(IAgentToolPolicyService).isToolActive('Plugin')).toBe(true);
        expect(main?.accessor.get(IAgentToolRegistryService).resolve('Plugin')).toBeDefined();
        await expect.poll(async () => (await agent.plugins.listCommands()).length).toBeGreaterThan(0);
        await agent.plugins.runCommand({ name: 'native-test:ready' });
        await agent.plugins.dispatchKey({ id: 'native-view', key: 'open', clientId: 'primary' });
        expect(await agent.plugins.getView({ clientId: 'primary' })).toEqual({ agentId: 'main', revision: 1 });
        expect(await agent.plugins.getView({ clientId: 'secondary' })).toEqual({ revision: 0 });
        const registry = main!.accessor.get(IAgentToolRegistryService);
        await expect.poll(() => registry.resolve('ExampleWorkflow')).toBeDefined();
        expect(main!.accessor.get(IAgentToolPolicyService).isToolActive('ExampleWorkflow', 'user')).toBe(true);
        await agent.prompt({ input: [{ type: 'text', text: 'Return a short reply.' }] });
        await expect.poll(() => observedTools.some(names => names.includes('ExampleWorkflow'))).toBe(true);
        expect(observedPrompts.some(text => text.includes('Native runtime session guidance'))).toBe(true);
        expect(observedDescriptions).toContain('Native workflow tool description');
        await main!.accessor.get(IAgentLoopService).settled();
        expect(await agent.plugins.call({ method: 'native-test.agent.setup', input: {} })).toEqual({ tool: 'mcp__native-test__double' });
        await expect.poll(() => registry.resolve('mcp__native-test__double')).toBeDefined();
        await agent.setPermission('yolo');
        const doubled = await agent.plugins.call({ method: 'native-test.agent.invoke', input: {} }) as { text: string };
        expect(JSON.parse(doubled.text)).toEqual({ result: 42 });
        await agent.plugins.call({ method: 'native-test.agent.invoke', input: {} });
        expect(await agent.plugins.call({ method: 'native-test.agent.count', input: {} })).toBe(2);
        await expect(agent.plugins.call({ method: 'native-test.agent.invalid', input: {} })).rejects.toThrow('forbids required property');
        expect(structuredAttempts).toBe(0);
        main!.accessor.get(IAgentPermissionRulesService).addRules([{ decision: 'deny', scope: 'user', pattern: 'Plugin(native-test.tool.double)' }]);
        expect(await agent.plugins.call({ method: 'native-test.agent.check', input: {} })).toMatchObject({ decision: 'deny', reason: 'user-configured-deny' });
        const denied = await agent.plugins.call({ method: 'native-test.agent.invoke', input: {} });
        expect(denied).toMatchObject({ isError: true });
        expect(await agent.plugins.call({ method: 'native-test.agent.count', input: {} })).toBe(2);
        const execution = await registry.resolve('ExampleWorkflow')!.resolveExecution({});
        if (execution.isError === true) throw new Error(JSON.stringify(execution.output));
        expect(execution.approvalRule).toBe('Plugin(native-test.agent.run)');
        const nativeResult = await execution.execute({ turnId: 1, toolCallId: 'native-plugin', signal: new AbortController().signal });
        if (nativeResult.isError) throw new Error(JSON.stringify(nativeResult.output));
        const result = JSON.parse(nativeResult.output as string) as { runId: string };
        expect(result.runId).toEqual(expect.any(String));
        const status = async () => (await agent.plugins.call({ method: 'native-test.agent.status', input: {} }) as { status: string; calls: unknown[] }[])[0];
        await expect.poll(async () => { const run = await status(); return JSON.stringify({ status: run?.status, calls: run?.calls, attempts: structuredAttempts }); }, { timeout: 10000 }).toMatch(/^\{"status":"completed"/);
        expect((await status())?.calls).toEqual([expect.objectContaining({ model: 'native-model', result: expect.objectContaining({ value: { ok: true }, agentId: expect.any(String), taskId: expect.any(String) }) })]);
        expect(structuredAttempts).toBe(2);
        expect(await agent.plugins.call({ method: 'a-origin-guard.originGuard.read', input: {} })).toEqual([
          { event: 'tool', tool: 'mcp__native-test__double', origin: { plugin: 'native-test', tier: 'user' } },
          { event: 'catch', called: true, kind: 'throw' },
          { event: 'tool', tool: 'mcp__native-test__double', origin: { plugin: 'native-test', tier: 'user' } },
          { event: 'catch', called: true, kind: 'throw' },
          { event: 'spawn', origin: { plugin: 'native-test', tier: 'user' } },
          { event: 'tool', tool: 'StructuredOutput', origin: { plugin: 'engine', tier: 'core' } },
        ]);
        expect(observedLimits).toEqual([100, 100]);
        expect(await status()).toMatchObject({ tokensSpent: 6 });
        expect(await agent.plugins.call({ method: 'native-test.agent.list', input: {} })).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'main' })]));
        await target.klient.global.plugins.reload();
        await expect.poll(() => registry.resolve('mcp__native-test__double')).toBeDefined();
        const tasks = await agent.getTasks({ activeOnly: false });
        expect(tasks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'plugin', runId: result.runId, parentToolCallId: 'native-plugin' }), expect.objectContaining({ kind: 'agent', parentToolCallId: 'native-plugin', parentRunId: result.runId })]));
        const workflowTask = tasks.find(task => task.kind === 'plugin');
        expect(workflowTask?.status).toBe('completed');
        expect(JSON.parse(await agent.getTaskOutput({ taskId: workflowTask!.taskId }))).toEqual({ runId: result.runId, result: { ok: true }, failedCalls: 0 });
        await expect.poll(async () => (await agent.getContext()).history.some(message => message.origin?.kind === 'task' && message.origin.taskId === workflowTask!.taskId)).toBe(true);
        const profile = main!.accessor.get(IAgentProfileService);
        const originalDenied = profile.data().disallowedTools;
        profile.update({ disallowedTools: ['Plugin'] });
        expect(await execution.execute({ turnId: 1, toolCallId: 'denied-plugin', signal: new AbortController().signal })).toMatchObject({ isError: true, output: expect.stringContaining('disabled') });
        profile.update({ disallowedTools: originalDenied });

        await target.klient.global.plugins.remove(plugin.id);
        await expect.poll(() => registry.resolve('ExampleWorkflow')).toBeUndefined();
        expect(await target.klient.global.plugins.listRuntimeCommands()).not.toEqual(expect.arrayContaining([expect.objectContaining({ pluginId: 'native-test' })]));
      } finally {
        if (sessionId !== undefined) await target.klient.session(sessionId).close();
        await target.klient.global.plugins.remove('native-test').catch(() => {});
        await target.klient.global.plugins.remove('a-origin-guard').catch(() => {});
        generate.mockRestore();
        flags.setConfigOverrides(undefined);
        await target.app.accessor.get(IConfigService).replace('secondaryModel', undefined, ConfigTarget.Memory);
        await target.app.accessor.get(IModelService).delete('native-model');
        await target.klient.global.kosong.removeProvider('native-provider');
        await rm(root, { recursive: true, force: true });
      }
    });

    it('sessions index responds with a page shape', async () => {
      const page = await target.klient.global.sessions.list({});
      expect(Array.isArray(page.items)).toBe(true);
      const count = await target.klient.global.sessions.countActive(['no-such-workspace']);
      expect(typeof count).toBe('number');
    });

    it('creates a titled session through implicit workspace materialization', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance session',
      });

      try {
        expect(created).toMatchObject({
          title: 'conformance session',
          cwd: process.cwd(),
          archived: false,
        });
        expect(created.id.length).toBeGreaterThan(0);
        expect(await target.klient.global.sessions.get(created.id)).toMatchObject({
          id: created.id,
          title: 'conformance session',
        });
      } finally {
        await target.klient.session(created.id).close();
      }
    });

    it('session createChild tags child markers while fork stays untagged', async () => {
      const parent = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance parent',
      });
      try {
        const parentHandle = getLiveSessionById(target.app.accessor, parent.id)!;
        const main = await parentHandle.accessor
          .get(IAgentLifecycleService)
          .create({ agentId: 'main' });
        const mainHandle = parentHandle.accessor.get(IAgentLifecycleService).handleOf(main.agentId)!;
        mainHandle.accessor.get(IAgentContextMemoryService).append({
          role: 'user',
          content: [{ type: 'text', text: 'fork through this turn' }],
          origin: { kind: 'user' },
        });
        await mainHandle.accessor.get(IWireService).flush();

        const child = await target.klient.session(parent.id).createChild();
        try {
          expect(child.custom?.['parent_session_id']).toBe(parent.id);
          expect(child.custom?.['child_session_kind']).toBe('child');
          expect(child.title).toBe('Child: conformance parent');
        } finally {
          await target.klient.session(child.id).close();
        }
        const forked = await target.klient.session(parent.id).fork({ turnIndex: 0 });
        try {
          expect(forked.custom?.['parent_session_id']).toBeUndefined();
          expect(forked.custom?.['child_session_kind']).toBeUndefined();
          expect(forked.lastPrompt).toBe('fork through this turn');
        } finally {
          await target.klient.session(forked.id).close();
        }
      } finally {
        await target.klient.session(parent.id).close();
      }
    });

    it('session skills.list returns the workspace skills as summaries', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'klient-conf-skills-'));
      try {
        await mkdir(join(workDir, '.kimi-code', 'skills', 'conf-skill'), { recursive: true });
        await writeFile(
          join(workDir, '.kimi-code', 'skills', 'conf-skill', 'SKILL.md'),
          '---\nname: conf-skill\ndescription: conformance fixture skill\n---\n\n# Conf\n',
        );
        const created = await target.klient.global.sessions.create({ workDir });
        try {
          const skills = await target.klient.session(created.id).skills.list();
          expect(skills.find((skill) => skill.name === 'conf-skill')).toMatchObject({
            name: 'conf-skill',
            description: 'conformance fixture skill',
            source: 'project',
          });
        } finally {
          await target.klient.session(created.id).close();
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('promptWithSkills submits skills, args, and steerIfActive on every transport', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'klient-conf-skill-submit-'));
      try {
        await mkdir(join(workDir, '.kimi-code', 'skills', 'conf-skill'), { recursive: true });
        await writeFile(
          join(workDir, '.kimi-code', 'skills', 'conf-skill', 'SKILL.md'),
          '---\nname: conf-skill\ndescription: conformance fixture skill\n---\n\n# Conf body\n',
        );
        const created = await target.klient.global.sessions.create({ workDir });
        try {
          const agent = target.klient.session(created.id).agent('main');

          await expect(
            agent.promptWithSkills({
              input: [{ type: 'text', text: 'Run the fixture skill.' }],
              skills: [{ name: 'missing-skill' }],
            }),
          ).rejects.toThrow(/not found/i);

          const launched = await agent.promptWithSkills({
            input: [{ type: 'text', text: 'Run the fixture skill.' }],
            skills: [{ name: 'conf-skill', args: 'src/app.ts' }],
            steerIfActive: true,
          });
          expect(launched).toMatchObject({ turn_id: 0, state: 'running' });
          expect(launched.prompt_id.length).toBeGreaterThan(0);
          expect(launched.created_at.length).toBeGreaterThan(0);

          const { history } = await agent.getContext();
          const bundled = history.find(
            (message) => message.role === 'user' && message.origin?.kind === 'user',
          );
          expect(bundled?.origin).toMatchObject({
            kind: 'user',
            skillActivations: [{ skillName: 'conf-skill', skillArgs: 'src/app.ts' }],
          });
          const texts = bundled?.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text);
          expect(texts?.[0]).toContain('# Conf body');
          expect(texts?.[0]).toContain('ARGUMENTS: src/app.ts');
          expect(texts?.[1]).toBe('Run the fixture skill.');
        } finally {
          await target.klient.session(created.id).close();
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('providers.set/get/delete works and emits kosong.providers.changed', async () => {
      const events: Array<{
        added: readonly string[];
        removed: readonly string[];
        changed: readonly string[];
      }> = [];
      const errors: Error[] = [];
      target.klient.events.onError((error) => {
        errors.push(error);
      });
      const sub = target.klient.events.on('kosong.providers.changed', (event) => {
        events.push(event);
      });
      // Give the subscription a wire round-trip (memory is synchronous; ipc
      // and http's lazy WS need a frame exchange).
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      const name = '__klient_conformance__';
      try {
        await target.klient.global.kosong.addProvider(name, {
          type: 'openai',
          auth: { method: 'api-key', apiKey: 'conf-key' },
        });
        const got = await target.klient.global.kosong.getProvider(name);
        expect(got.has_api_key).toBe(true);

        await waitFor(
          () => events.some((event) => [...event.added, ...event.changed].includes(name)),
          5_000,
        );
      } finally {
        await target.klient.global.kosong.removeProvider(name);
        sub.dispose();
      }
      expect(errors).toEqual([]);
    });

    it('config reads respond', async () => {
      const all = await target.klient.global.config.getAll();
      expect(typeof all).toBe('object');
      expect(Array.isArray(await target.klient.global.config.diagnostics())).toBe(true);
    });

    it('config replaceSections writes several domains and clears undefined ones', async () => {
      const config = target.klient.global.config;
      const beforeProviders = await config.inspect<Record<string, unknown>>('providers');
      const beforeModels = await config.inspect<Record<string, unknown>>('models');
      try {
        await config.replaceSections({
          sections: {
            providers: {
              ...beforeProviders.userValue,
              'conf-provider': { type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' },
            },
            models: {
              ...beforeModels.userValue,
              'conf-provider/m1': { provider: 'conf-provider', model: 'm1', maxContextSize: 100 },
            },
            defaultModel: 'conf-provider/m1',
          },
        });
        expect((await config.inspect<string>('defaultModel')).userValue).toBe('conf-provider/m1');

        // A domain mapped to `undefined` is cleared; domains absent from the
        // sections record are left untouched.
        await config.replaceSections({ sections: { defaultModel: undefined } });
        expect((await config.inspect<string>('defaultModel')).userValue).toBeUndefined();
        const providers = await config.inspect<Record<string, unknown>>('providers');
        expect(providers.userValue?.['conf-provider']).toBeDefined();
      } finally {
        await config.replaceSections({
          sections: { providers: beforeProviders.userValue, models: beforeModels.userValue },
        });
      }
    });

    it('keeps a credential binding edited while the registry response is in flight', async () => {
      const { config, kosong } = target.klient.global;
      const domains = ['providers', 'models', 'defaultModel', 'defaultProvider', 'thinking'];
      const before = Object.fromEntries(
        await Promise.all(domains.map(async (domain) => [
          domain, (await config.inspect(domain)).userValue,
        ])),
      );
      const url = 'https://registry.example.test/api.json';
      const source = { kind: 'apiJson', url, apiKey: '' };
      const provider = { type: 'openai', baseUrl: 'https://owned.example.test/v1', source };
      try {
        await config.replaceSections({
          sections: {
            providers: { owned: { ...provider, apiKeyEnv: 'FIRST_EXAMPLE_KEY' } },
            models: {},
            defaultModel: undefined,
            defaultProvider: undefined,
            thinking: undefined,
          },
        });
        setModelsDevUpstreamForTest({
          fetchImpl: async () => {
            await config.set({
              domain: 'providers',
              patch: { owned: { apiKeyEnv: 'SECOND_EXAMPLE_KEY' } },
            });
            return Response.json({
              owned: {
                id: 'owned',
                name: 'Owned',
                type: 'openai',
                api: provider.baseUrl,
                models: { m1: { id: 'm1' } },
              },
            });
          },
        });
        await kosong.importCustomRegistry({ url, setDefaultWhenUnset: false });
        await config.reload();
        const providers = await config.inspect<Record<string, { apiKeyEnv?: string }>>('providers');
        expect(providers.userValue?.['owned']?.apiKeyEnv).toBe('SECOND_EXAMPLE_KEY');
      } finally {
        resetModelsDevUpstreamForTest();
        await config.replaceSections({ sections: before });
      }
    });

    it('hostFs.home() returns the host home and recent roots', async () => {
      const home = await target.klient.global.hostFs.home();
      expect(home.home.length).toBeGreaterThan(0);
      expect(Array.isArray(home.recent_roots)).toBe(true);

      const browse = await target.klient.global.hostFs.browse(home.home);
      expect(browse.path).toBe(home.home);
      expect(Array.isArray(browse.entries)).toBe(true);
    });

    it('files save/get/delete round-trips bytes through the file store', async () => {
      const files = target.klient.global.files;
      const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
      const meta = await files.save({
        data: bytes,
        filename: 'conformance.bin',
        mimeType: 'application/octet-stream',
        expiresInSec: 3600,
      });
      expect(meta.id.startsWith('f_')).toBe(true);
      expect(meta.name).toBe('conformance.bin');
      expect(meta.media_type).toBe('application/octet-stream');
      expect(meta.size).toBe(bytes.length);
      expect(typeof meta.expires_at).toBe('string');

      const downloaded = await files.get(meta.id);
      expect(downloaded.meta).toEqual(meta);
      expect([...downloaded.data]).toEqual([...bytes]);

      await files.delete(meta.id);
      // Both transports surface a deleted/expired upload as the same public
      // RPCError code, never the engine's raw error type.
      await expect(files.get(meta.id)).rejects.toMatchObject({ name: 'RPCError', code: 40404 });
    });

    it('kosong lists models/providers and preserves generation contracts', async () => {
      const kosong = target.klient.global.kosong;
      expect(Array.isArray(await kosong.listModels())).toBe(true);
      expect(Array.isArray(await kosong.listProviders())).toBe(true);

      const events: Array<{
        added: readonly string[];
        removed: readonly string[];
        changed: readonly string[];
      }> = [];
      const sub = target.klient.events.on('kosong.models.changed', (event) => {
        events.push(event);
      });
      // See kosong.providers.changed above — give the subscription a wire round-trip.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      const id = '__klient_conformance__';
      try {
        await kosong.addProvider({
          id,
          model: 'conf-model',
          protocol: 'openai',
          baseUrl: 'http://127.0.0.1:1',
          auth: { method: 'api-key', apiKey: 'conf-key' },
        });

        await waitFor(
          () => events.some((event) => [...event.added, ...event.changed].includes(id)),
          5_000,
        );
      } finally {
        await kosong.removeProvider(id);
        sub.dispose();
      }

      const kimiId = '__klient_kimi_thinking__';
      const kimiProviderId = '__klient_kimi_provider__';
      await kosong.addProvider(kimiProviderId, {
        type: 'kimi',
        baseUrl: 'https://example.test/v1',
        auth: { method: 'api-key', apiKey: 'conf-key' },
      });
      await target.app.accessor.get(IModelService).set(kimiId, {
        provider: kimiProviderId,
        model: 'conf-kimi',
        maxContextSize: 4096,
        capabilities: ['thinking'],
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
      });
      const bodies: Record<string, unknown>[] = [];
      const chunk = JSON.stringify({
        id: 'chatcmpl-conf',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'conf-kimi',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      vi.stubGlobal('fetch', (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        bodies.push(JSON.parse(await new Request(input, init).text()) as Record<string, unknown>);
        return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch);
      const consume = async (stream: AsyncIterable<unknown>): Promise<void> => {
        let finished = false;
        for await (const event of stream) {
          if ((event as { readonly type?: string }).type === 'finish') finished = true;
        }
        expect(finished).toBe(true);
      };
      const publicInput = {
        systemPrompt: '',
        tools: [],
        messages: [
          {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: 'hi' },
              {
                type: 'image_url' as const,
                imageUrl: { url: 'data:image/png;base64,QUJD', id: 'image-1' },
              },
            ],
            toolCalls: [],
          },
        ],
      };
      const coreInput = {
        systemPrompt: '',
        tools: [],
        messages: [
          {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: 'hi' },
              {
                type: 'image_url' as const,
                imageUrl: { url: 'data:image/png;base64,QUJD', id: 'image-1' },
              },
            ],
          },
        ],
      };
      try {
        await consume(kosong.generate(kimiId, publicInput, { thinkingEffort: 'on' }));
        await consume(kosong.generate(kimiId, publicInput, { thinkingEffort: 'max' }));
        const catalog = target.app.accessor.get(IModelCatalog);
        const registry = target.app.accessor.get(IProtocolAdapterRegistry);
        await consume(
          generateModel(registry.request(catalog.get(kimiId), { thinkingEffort: 'on' }), coreInput, undefined, {
            thinkingEffort: 'on',
          }),
        );
        await consume(
          generateModel(registry.request(catalog.get(kimiId), { thinkingEffort: 'max' }), coreInput, undefined, {
            thinkingEffort: 'max',
          }),
        );
        expect(bodies.map((body) => body['thinking'])).toEqual([
          { type: 'enabled' },
          { type: 'enabled', effort: 'max' },
          { type: 'enabled' },
          { type: 'enabled', effort: 'max' },
        ]);
        const expectedMessages = [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,QUJD', id: 'image-1' },
              },
            ],
          },
        ];
        expect(bodies).toHaveLength(4);
        for (const body of bodies) {
          expect(body['messages']).toEqual(expectedMessages);
        }

        const responsePart = {
          type: 'image_url' as const,
          imageUrl: { url: 'data:image/png;base64,QUJD', id: 'response-image', name: 'pixel.png' },
        };
        const fakeRequester: LlmRequester = {
          generate: (_config, _content, control) => {
            control.onEvent?.({ type: 'llm.streaming.part', part: responsePart });
            control.onEvent?.({
              type: 'llm.streaming.finish',
              finish: { finishReason: 'completed', rawFinishReason: 'stop' },
            });
            control.onEvent?.({ type: 'llm.done' });
            return Promise.resolve();
          },
        };
        const request = registry.request.bind(registry);
        const generate = vi.spyOn(registry, 'request').mockImplementation((model, params) =>
          coreRequesterFromA(request(model, params), fakeRequester),
        );
        try {
          const responseEvents: unknown[] = [];
          for await (const event of kosong.generate(kimiId, publicInput)) {
            responseEvents.push(event);
          }
          const publicPart = {
            type: 'image_url',
            imageUrl: {
              url: 'data:image/png;base64,QUJD',
              id: 'response-image',
              name: 'pixel.png',
            },
          };
          expect(responseEvents).toStrictEqual([
            { type: 'part', part: publicPart },
            expect.objectContaining({
              type: 'finish',
              message: { role: 'assistant', content: [publicPart], toolCalls: [] },
            }),
            expect.objectContaining({
              type: 'timing',
              firstTokenLatencyMs: expect.any(Number),
              streamDurationMs: expect.any(Number),
            }),
          ]);
        } finally {
          generate.mockRestore();
        }
      } finally {
        vi.unstubAllGlobals();
        await kosong.removeProvider(kimiId);
        await kosong.removeProvider(kimiProviderId);
      }
    });

    it('flags / plugins / auth read models respond', async () => {
      expect(Array.isArray(await target.klient.global.flags.list())).toBe(true);
      expect(Array.isArray(await target.klient.global.flags.enabledIds())).toBe(true);
      expect(typeof await target.klient.global.flags.snapshot()).toBe('object');
      expect(Array.isArray(await target.klient.global.plugins.list())).toBe(true);
      const status = await target.klient.global.auth.status();
      expect(typeof status.loggedIn).toBe('boolean');
    });

    it('global mcp round-trips user-level server CRUD', async () => {
      const mcp = target.klient.global.mcp;
      const cwd = await mkdtemp(join(tmpdir(), 'klient-conf-mcp-crud-'));
      try {
        expect(await mcp.list({ cwd })).toEqual([]);

        const added = await mcp.add({
          cwd,
          server: {
            name: 'conf-mcp',
            transport: 'stdio',
            command: 'conf-command',
            env: { TOKEN: 'secret' },
          },
        });
        const entry = added.find((server) => server.name === 'conf-mcp');
        // Mutable (user-level) entries carry the full config for edit prefill.
        expect(entry).toMatchObject({
          name: 'conf-mcp',
          source: 'global',
          mutable: true,
          config: { transport: 'stdio', command: 'conf-command', env: { TOKEN: 'secret' } },
        });

        await mcp.update({
          cwd,
          server: { name: 'conf-mcp', transport: 'stdio', command: 'conf-command-2' },
        });
        expect((await mcp.get({ name: 'conf-mcp', cwd })).config).toMatchObject({
          command: 'conf-command-2',
        });

        await mcp.remove({ name: 'conf-mcp', cwd });
        expect(await mcp.list({ cwd })).toEqual([]);
        await expect(mcp.get({ name: 'conf-mcp', cwd })).rejects.toMatchObject({
          name: 'RPCError',
          code: 40408,
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('global mcp probes an inline server config without persisting it', async () => {
      const mcp = target.klient.global.mcp;
      // Inline probe against a scratch cwd: the binary runs but never
      // speaks MCP, so the connection test reports a clean failure.
      const probeCwd = await mkdtemp(join(tmpdir(), 'klient-conf-mcp-probe-'));
      try {
        const probe = await mcp.test({
          server: {
            name: 'conf-probe',
            transport: 'stdio',
            command: process.execPath,
            args: ['--version'],
            startupTimeoutMs: 10_000,
          },
          cwd: probeCwd,
        });
        expect(probe.success).toBe(false);
        expect(typeof probe.output).toBe('string');
      } finally {
        await rm(probeCwd, { recursive: true, force: true });
      }
      expect(await mcp.list()).toEqual([]);
    });

    it('global mcp resolves locators and classifies auth offline', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: { name: 'conf-mcp', transport: 'stdio', command: 'conf-command' },
      });
      try {
        // The locator surface: resolve a legacy name, inspect nothing/all.
        expect(await mcp.resolveByName({ name: 'conf-mcp' })).toEqual({
          source: 'global',
          name: 'conf-mcp',
        });
        expect(await mcp.inspect({ targets: [] })).toEqual([]);
        // An omitted `targets` ahead of a present options arg must mean "the
        // whole catalog" on every transport (ipc encodes it as `null`).
        expect((await mcp.inspect({})).map((i) => i.runtimeName)).toContain('conf-mcp');
        await expect(
          mcp.inspect({ targets: [{ source: 'global', name: 'conf-missing' }] }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40408 });

        // Offline auth classification of a stdio server needs no probe, and
        // an OAuth flow against a stdio target is request.invalid → 40001.
        expect(await mcp.authStatuses()).toEqual([
          { name: 'conf-mcp', authStatus: 'not-applicable' },
        ]);
        await expect(
          mcp.beginAuth({ locator: { source: 'global', name: 'conf-mcp' } }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
      } finally {
        await mcp.remove({ name: 'conf-mcp' });
      }
    });

    it('global mcp completeAuth rejects an unknown flowId with 40001', async () => {
      const mcp = target.klient.global.mcp;
      await expect(mcp.completeAuth({ flowId: 'conf-unknown-flow' })).rejects.toMatchObject({
        name: 'RPCError',
        code: 40001,
      });
    });

    it('global mcp OAuth failures map to the 40929 wire code on every transport', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: {
          name: 'conf-oauth-failure',
          transport: 'http',
          url: 'http://127.0.0.1:1/mcp',
          auth: 'oauth',
        },
      });
      try {
        await expect(
          mcp.beginAuth({ locator: { source: 'global', name: 'conf-oauth-failure' } }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40929 });
      } finally {
        await mcp.remove({ name: 'conf-oauth-failure' });
      }
    });

    it('global mcp cancelAuth ignores an unknown flowId', async () => {
      const mcp = target.klient.global.mcp;
      await expect(mcp.cancelAuth({ flowId: 'conf-unknown-flow' })).resolves.toBeUndefined();
    });

    it('global mcp resetAuth clears a remote oauth server through the transport', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: {
          name: 'conf-oauth',
          transport: 'http',
          url: 'https://example.com/mcp',
          auth: 'oauth',
        },
      });
      try {
        // Invalidate is offline: no stored grant and no network needed.
        await expect(
          mcp.resetAuth({ locator: { source: 'global', name: 'conf-oauth' } }),
        ).resolves.toBeUndefined();
      } finally {
        await mcp.remove({ name: 'conf-oauth' });
      }
    });

    it('global mcp resetAuth rejects a stdio locator with 40001', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: { name: 'conf-stdio', transport: 'stdio', command: 'conf-command' },
      });
      try {
        await expect(
          mcp.resetAuth({ locator: { source: 'global', name: 'conf-stdio' } }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
      } finally {
        await mcp.remove({ name: 'conf-stdio' });
      }
    });

    it('agent environment binding and media events are available through every transport', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance environment',
      });
      try {
        const agent = target.klient.session(created.id).agent('main');
        const binding = await agent.getEnvironment();
        expect(binding.environmentId).toBe('local');
        expect(binding).toEqual({ environmentId: 'local' });
        expect(await agent.getEnvironment()).toEqual(binding);

        const seen: unknown[] = [];
        const sub = agent.events.on('tool.result', (event) => seen.push(event));
        await new Promise((resolve) => {
          setTimeout(resolve, 300);
        });
        try {
          const live = getLiveSessionById(target.app.accessor, created.id);
          if (live === undefined) throw new Error('expected a live session');
          const main = live.accessor.get(IAgentLifecycleService).handleOf('main');
          if (main === undefined) throw new Error('expected the main agent');
          main.accessor.get(IEventBus).publish(
            new ToolResultEvent({
              agentId: 'main',
              turnId: 1,
              toolCallId: 'call-media',
              output: [
                { type: 'text', text: 'media' },
                { type: 'image_url', imageUrl: { url: 'data:image/png;base64,QUJD' } },
              ],
            }),
          );
          await waitFor(() => seen.length === 1, 2_000);
          expect(seen[0]).toMatchObject({
            output: [
              { type: 'text', text: 'media' },
              {
                type: 'image_url',
                imageUrl: expect.objectContaining({ url: 'data:image/png;base64,QUJD' }),
              },
            ],
          });
        } finally {
          sub.dispose();
        }
      } finally {
        await target.klient.session(created.id).close();
      }
    });

    it('agent commands list and run a contributed command', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance commands',
      });
      const calls: string[] = [];

      // A dynamic App-scope unit contributing one command into the
      // `CommandContribution` collection — the same path a Feature takes.
      class ConformanceCommands extends Service {
        static override readonly name = 'klient-conformance-commands';
        constructor() {
          super();
          this.provide(CommandContribution, {
            name: 'conformance-echo',
            description: 'records its args',
            run: (ctx) => {
              calls.push(ctx.args);
            },
          });
        }
      }

      const featureManager = target.app.accessor.get(IFeatureManager);
      const handle = featureManager.provideUnit(ConformanceCommands);
      try {
        const agent = target.klient.session(created.id).agent('main');

        // Dynamic assembly goes through the cascade — poll until visible.
        let infos = await agent.listCommands();
        const deadline = Date.now() + 5_000;
        while (!infos.some((command) => command.name === 'conformance-echo')) {
          if (Date.now() > deadline) break;
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
          infos = await agent.listCommands();
        }
        expect(infos.map((command) => command.name)).toContain('conformance-echo');
        const echo = infos.find((command) => command.name === 'conformance-echo');
        expect(echo).toMatchObject({ name: 'conformance-echo', description: 'records its args' });
        expect(typeof echo?.source).toBe('string');

        await agent.runCommand({ name: 'conformance-echo', args: 'hello commands' });
        expect(calls).toEqual(['hello commands']);

        // Unknown names fail with a coded engine error.
        await expect(agent.runCommand({ name: 'conformance-missing' })).rejects.toThrow(
          /Unknown command/,
        );
      } finally {
        await handle.dispose();
        await target.klient.session(created.id).close();
      }
    });

    it('treats a client-chosen promptId as a pure correlation id', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance prompt correlation',
      });
      try {
        const agent = target.klient.session(created.id).agent('main');
        const first = await agent.prompt({
          input: [{ type: 'text', text: 'first' }],
          promptId: 'submission-1',
        });
        expect(first).toEqual({ turn_id: 0 });
        const second = await agent.prompt({
          input: [{ type: 'text', text: 'duplicate' }],
          promptId: 'submission-1',
        });
        expect(second === undefined || typeof second.turn_id === 'number').toBe(true);
      } finally {
        await target.klient.session(created.id).close();
      }
    });
  });
}
