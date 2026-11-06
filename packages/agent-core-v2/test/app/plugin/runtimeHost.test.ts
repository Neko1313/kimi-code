import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRuntimeScript } from '#/app/plugin/runtimeScript';
import { RuntimeStructuredOutput } from '#/app/plugin/structuredOutput';
import { PluginRuntimeHost } from '#/app/plugin/runtimeHost';
import { PLUGIN_RUNTIME_FLAG_ID } from '#/app/plugin/runtimeFlag';
import type { PluginInfo } from '#/app/plugin/types';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubFlag } from '../flag/stubs';
import { stubLog } from '../../_base/log/stubs';
import { stubPluginService } from './stubs';

async function writeFixturePlugin(root: string, moduleSource: string, api: 'native' | 'claude-mods' = 'native'): Promise<void> {
  await mkdir(path.join(root, 'runtime'), { recursive: true });
  await writeFile(
    path.join(root, 'kimi.plugin.json'),
    JSON.stringify({
      name: 'fixture-runtime',
      version: '0.0.1',
      runtime: {
        api,
        modules: ['./runtime/index.ts'],
        capabilities: ['events', 'store', 'log', 'clock', 'ui', 'state', 'agent', 'tasks', 'domains', 'command', 'script', 'tools', 'session'],
      },
    }),
  );
  await writeFile(path.join(root, 'runtime', 'index.ts'), moduleSource);
}

function stubPluginInfo(root: string, api: 'native' | 'claude-mods' = 'native'): PluginInfo {
  return {
    id: 'fixture-runtime',
    displayName: 'fixture-runtime',
    enabled: true,
    state: 'ok',
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'local-path',
    origin: 'custom',
    installedAt: new Date(0).toISOString(),
    root,
    diagnostics: [],
    skills: [],
    mcpServers: [],
    manifest: {
      name: 'fixture-runtime',
      runtime: {
        api,
        modules: ['./runtime/index.ts'],
        capabilities: ['events', 'store', 'log', 'clock', 'ui', 'state', 'agent', 'tasks', 'domains', 'command', 'script', 'tools', 'session'],
      },
    },
  } as PluginInfo;
}

describe('PluginRuntimeHost', () => {
  let root: string;
  let storeRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kimi-runtime-plugin-'));
    storeRoot = await mkdtemp(path.join(tmpdir(), 'kimi-runtime-store-'));
    process.env['KIMI_CODE_HOME'] = storeRoot;
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env['KIMI_CODE_HOME'];
    await rm(root, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
  });

  async function makeHost(moduleSource: string, enabled = true, api: 'native' | 'claude-mods' = 'native', others: Record<string, string> = {}, nonInteractive = false): Promise<PluginRuntimeHost> {
    await writeFixturePlugin(root, moduleSource, api);
    for (const [id, source] of Object.entries(others)) await writeFixturePlugin(path.join(root, id), source, 'claude-mods');
    const plugins = stubPluginService({
      enabledPluginIds: ['fixture-runtime'],
      sessionStarts: [],
      summaries: ['fixture-runtime', ...Object.keys(others)].map(id => ({ id, enabled: true, state: 'ok' })),
    });
    plugins.getPluginInfo = async ({ id }) => id === 'fixture-runtime' ? stubPluginInfo(root, api) : { ...stubPluginInfo(path.join(root, id), 'claude-mods'), id };
    const bootstrap = stubBootstrap(storeRoot);
    const host = new PluginRuntimeHost(
      plugins,
      stubFlag((id: string) => (id === PLUGIN_RUNTIME_FLAG_ID ? enabled : false)),
      stubLog(),
      { ...bootstrap,args:{...bootstrap.args,nonInteractive} },
    );
    await host.ready;
    return host;
  }

  it('loads Mods TSX, folds nouns, matches objects and dispatches owned callbacks', async () => {
    const host = await makeHost(`
      export function register(on) {
        on('engine.create', async (_, e, next) => ({ ...await next(e), counter: { read: () => ({ value: -1 }) } }));
        on('counter.read', async ($) => ({ value: (await $.state.get({plugin:'fixture-runtime',key:'count'})).value ?? 0 }));
        on('command.run', { command: 'demo' }, async $ => { await $.ui.open({id:'demo', title:'Demo'}); return {paneId:'demo'} });
        on('ui.render', { component: 'Pane', requestId: 'demo' }, ($, e) => {
          const {Box, Text, Button, Select} = $.ui.resolve(e);
          return Box({children:[Text({children:'hello'}), Button({key:'increment',children:'Increment',onPress:async () => {
            const ref={plugin:'fixture-runtime',key:'count'};
            const current=await $.state.get(ref);
            await $.state.set(ref, (current.value ?? 0)+1,{ifVersion:current.version});
          }}), Select({key:'choice',options:[{value:'a'}],onSelect:()=>{}})]});
        });
      }
    `, true, 'claude-mods');
    const context = {cwd:root, sessionId:'mods', clientId:'one'};
    await host.runCommand('fixture-runtime:demo', '', context);
    expect(await host.call('fixture-runtime.counter.read', {}, context)).toBe(0);
    const tree = await host.renderPane('demo', 80, context) as import('#/app/plugin/mods').RenderElement;
    expect(tree.type).toBe('Box');
    const button = tree.children![1] as import('#/app/plugin/mods').RenderElement;
    const key = 'callback:' + JSON.stringify({handle:button.props!['callback']});
    await expect(host.dispatchKey('demo',key,{...context,clientId:'other'})).rejects.toThrow('foreign');
    await host.dispatchKey('demo',key,context);
    expect(await host.call('fixture-runtime.counter.read',{},context)).toBe(1);
    await host.renderPane('demo',80,context);
    await host.dispatchKey('demo',key,context);
    expect(await host.call('fixture-runtime.counter.read',{},context)).toBe(2);
    const select = tree.children![2] as import('#/app/plugin/mods').RenderElement;
    await expect(host.dispatchKey('demo','callback:'+JSON.stringify({handle:select.props!['callback'],value:'bad'}),context)).rejects.toThrow();
    host.dispose();
    await expect(host.dispatchKey('demo',key,context)).rejects.toThrow();
  });

  it('composes persistent sites across mods and routes client-owned controls', async () => {
    const host = await makeHost(`
      import {atom,read,update} from 'claude-code';
      const count=atom({plugin:'fixture-runtime',key:'count'},0);
      export function register(on) {
        on('ui.render',{component:'AbovePrompt'},async($,e,next)=>{
          const {Box,Text,Button}=$.ui.resolve(e);
          return Box({children:[Text({children:['outer '+e.props.bodyColumns+' '+await read($,count)]}),await next(e),Button({key:'more',label:'More',onPress:()=>update($,count,n=>n+1)})]});
        });
        on('ui.render',{component:'ToolResult'},($,e)=>$.ui.resolve(e).Button({key:'more',label:'Result',onPress:()=>update($,count,n=>n+1)}));
      }
    `,true,'claude-mods',{other:`export function register(on){on('ui.render',{component:'AbovePrompt'},($,e)=>$.ui.resolve(e).Text({children:['inner']}))}`});
    const context={cwd:root,sessionId:'sites',clientId:'one'};
    const request={component:'AbovePrompt',width:80,rows:10};
    const tree=await host.renderSite(request,context) as import('#/app/plugin/mods').RenderElement;
    expect(JSON.stringify(tree)).toContain('outer 80 0');
    expect(JSON.stringify(tree)).toContain('inner');
    expect(host.listPanes(context)).toEqual([]);
    const button=tree.children![2] as import('#/app/plugin/mods').RenderElement;
    const key='callback:'+JSON.stringify({handle:button.props!['callback']});
    await expect(host.dispatchSiteKey({component:'AbovePrompt',key},{...context,clientId:'two'})).rejects.toThrow('foreign');
    await host.dispatchSiteKey({component:'AbovePrompt',key},context);
    expect(JSON.stringify(await host.renderSite(request,context))).toContain('outer 80 1');
    const first = await host.renderSite({...request,requestId:'message-one'},context) as import('#/app/plugin/mods').RenderElement;
    const second = await host.renderSite({...request,requestId:'message-two'},context) as import('#/app/plugin/mods').RenderElement;
    const firstKey = 'callback:'+JSON.stringify({handle:(first.children![2] as import('#/app/plugin/mods').RenderElement).props!['callback']});
    const secondKey = 'callback:'+JSON.stringify({handle:(second.children![2] as import('#/app/plugin/mods').RenderElement).props!['callback']});
    const result = await host.renderSite({component:'ToolResult',width:80,rows:10,requestId:'message-one'},context) as import('#/app/plugin/mods').RenderElement;
    const resultKey = 'callback:'+JSON.stringify({handle:result.props!['callback']});
    await expect(host.dispatchSiteKey({component:'AbovePrompt',requestId:'message-one',key:resultKey},context)).rejects.toThrow('foreign');
    await expect(host.dispatchSiteKey({component:'AbovePrompt',requestId:'message-two',key:firstKey},context)).rejects.toThrow('foreign');
    await host.dispatchSiteKey({component:'AbovePrompt',requestId:'message-one',key:firstKey},context);
    await host.dispatchSiteKey({component:'AbovePrompt',requestId:'message-two',key:secondKey},context);
    expect(JSON.stringify(await host.renderSite(request,context))).toContain('outer 80 3');
    expect(await host.renderSite(request,{...context,sessionId:'another'})).toMatchObject({type:'Box'});
    expect(JSON.stringify(await host.renderSite(request,{...context,sessionId:'another'}))).toContain('outer 80 0');
    host.dispose();
  });

  it('passes a native render tree through next so a mod can wrap it', async () => {
    const host = await makeHost(`export function register(on) {
      on('ui.render', {component:'Spinner'}, async ($, e, next) => {
        const {Box,Text} = $.ui.resolve(e);
        return Box({children:[Text({children:['Before']}),await next({...e,props:{...e.props,word:'Changed'}}),Text({children:['After']})]});
      });
    }`,true,'claude-mods');
    const native = {type:'Text' as const,props:{key:'kimi-native-Spinner'},children:['Working']};
    const tree = await host.renderSite({component:'Spinner',width:80,rows:1,props:{word:'Working'},defaultTree:native},{cwd:root,sessionId:'native'});
    expect(tree).toMatchObject({type:'Box',children:[{type:'Text',children:['Before']},{...native,children:['Changed']},{type:'Text',children:['After']}]});
    expect(await host.renderSite({component:'ContextUsage',width:80,rows:1,defaultTree:native},{cwd:root,sessionId:'native'})).toEqual(native);
    host.dispose();
  });

  it('moves Atelier gauges to the native footer while preserving other band content', async () => {
    const adapter = await readFile(new URL('../../../../core-plugins/kimi-atelier-footer/runtime/index.ts', import.meta.url), 'utf8');
    const host = await makeHost(adapter, true, 'claude-mods', { atelier: `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.state.set({plugin:'atelier',key:'usage'}, {contextPercent:12,fiveHour:{percent:42},sevenDay:{percent:15,resetsAt:'2099-06-01T12:00:00Z'}});
          return next(e);
        });
        on('ui.render', {component:'AbovePrompt'}, async ($, e) => {
          const {Box,Text,Svg,Button} = $.ui.resolve(e);
          if ((await $.state.get({plugin:'atelier',key:'isHidden'})).value) return Text({children:['Hidden']});
          const gauges = e.surface === 'terminal' ? [Text({children:['ctx 12%']}),Text({children:['5 h 42%']}),Text({children:['7 j 15%']})] : [Svg({source:'<svg xmlns="http://www.w3.org/2000/svg"/>',alt:'Quotas : context 12% · Conso : 7'})];
          return Box({children:[Box({key:'ligne-quotas',children:[...gauges,Button({key:'keep',label:'Keep',onPress:async()=>{await $.state.set({plugin:'atelier',key:'pressed'},true)}})]}),Text({children:['Other content']})]});
        });
        on('command.run', {command:'hide'}, async $ => { await $.state.set({plugin:'atelier',key:'isHidden'},true); return {}; });
        on('command.run', {command:'check'}, async $ => ({value:(await $.state.get({plugin:'atelier',key:'pressed'})).value}));
      }
    ` });
    const context={cwd:root,sessionId:'atelier-footer',clientId:'one'};
    await host.dispatch('SessionStart',{cwd:root,sessionId:'atelier-footer'});
    const original = {type:'Text' as const,props:{key:'kimi-native-ContextUsage'},children:['context: 12%']};
    const footer = () => host.renderSite({component:'ContextUsage',width:80,rows:1,clientId:'one',props:{text:'context: 12%'},defaultTree:original},context);
    expect(await footer()).toEqual(original);
    const band = await host.renderSite({component:'AbovePrompt',surface:'desktop',width:80,rows:10,clientId:'one',props:{hasSurvey:false}},context);
    expect(JSON.stringify(band)).not.toContain('Quotas :');
    expect(JSON.stringify(band)).toContain('Conso : 7');
    expect(JSON.stringify(band)).toContain('Keep');
    expect(JSON.stringify(band)).toContain('Other content');
    expect(band?.type).toBe('Box');
    if (band?.type !== 'Box') throw new Error('Expected a box');
    const line = band.children![0] as import('#/app/plugin/mods').RenderElement;
    const button = line.children![1] as import('#/app/plugin/mods').RenderElement;
    await host.dispatchSiteKey({component:'AbovePrompt',key:'callback:'+JSON.stringify({handle:button.props!['callback']})},context);
    expect(await host.runCommand('atelier:check','',context)).toMatchObject({value:true});
    const footerText = JSON.stringify(await footer());
    expect(footerText).toContain('5h 42% · 7d 15%');
    expect(footerText).toContain(new Date('2099-06-01T12:00:00Z').toLocaleDateString(undefined, {day:'2-digit',month:'2-digit'}));
    expect(footerText).toContain('context: 12%');
    const narrow = await host.renderSite({component:'ContextUsage',width:14,rows:1,clientId:'one',props:{text:'context: 12%'},defaultTree:original},context);
    expect(JSON.stringify(narrow)).toContain('context: 12%');
    expect(JSON.stringify(narrow)).not.toContain('5h');
    const terminal = await host.renderSite({component:'AbovePrompt',surface:'terminal',width:80,rows:10,clientId:'one'},context);
    expect(JSON.stringify(terminal)).not.toContain('ctx 12%');
    expect(JSON.stringify(terminal)).not.toContain('5 h 42%');
    expect(JSON.stringify(terminal)).toContain('Keep');
    expect(await host.renderSite({component:'ContextUsage',width:80,rows:1,clientId:'two',props:{text:'context: 12%'},defaultTree:original},{...context,clientId:'two'})).toEqual(original);
    await host.runCommand('atelier:hide','',context);
    await host.renderSite({component:'AbovePrompt',width:80,rows:10,clientId:'one'},context);
    expect(await footer()).toEqual(original);
    host.dispose();
  });

  it('renders SVG on requested surfaces and preserves the surface on owned callbacks', async () => {
    const host = await makeHost(`
      export function register(on) {
        on('ui.render',{component:'AbovePrompt'},async($,e)=> {
          const {Box,Text,Svg,Button}=$.ui.resolve(e);
          return Box({children:[e.surface==='terminal'?Text({children:['Text fallback']}):Svg({source:'<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',alt:'Square',width:100,height:40}),Button({key:'surface',label:'Surface',onPress:async event=>{await $.store.set('pressed',event.surface);await $.ui.open({id:'card',title:'Card'})}})]});
        });
      }
    `,true,'claude-mods');
    const context={cwd:root,sessionId:'svg',clientId:'graphics'};
    expect(JSON.stringify(await host.renderSite({component:'AbovePrompt',width:80,rows:10},context))).toContain('Text fallback');
    const tree=await host.renderSite({component:'AbovePrompt',surface:'desktop',width:80,rows:10},context) as import('#/app/plugin/mods').RenderElement;
    expect(tree.children?.[0]).toMatchObject({type:'Svg',props:{alt:'Square',width:100,height:40}});
    const button=tree.children![1] as import('#/app/plugin/mods').RenderElement;
    await host.dispatchSiteKey({component:'AbovePrompt',key:'callback:'+JSON.stringify({handle:button.props!['callback']})},context);
    expect(await readFile(path.join(storeRoot,'plugin-runtime','fixture-runtime.json'),'utf8')).toContain('desktop');
    expect(host.getView(context)).toMatchObject({paneId:'card',revision:1});
    await host.closePane('card',context);
    expect(host.listPanes(context)).toEqual([]);
    expect(host.getView(context).paneId).toBeUndefined();
    await host.dispatchSiteKey({component:'AbovePrompt',key:'callback:'+JSON.stringify({handle:button.props!['callback']})},context);
    expect(host.getView(context)).toMatchObject({paneId:'card',revision:3});
    host.dispose();
  });

  it('scopes status and expiring toasts to the session without losing newer status updates', async () => {
    const host=await makeHost(`export function register(on){
      on('command.run',{command:'notify'},async $=>{await $.ui.toast('Temporary',{timeoutMs:100});await $.ui.status('Pinned');return {}});
      on('command.run',{command:'clear'},async $=>{await $.ui.status();return {}});
    }`,true,'claude-mods');
    const context={cwd:root,sessionId:'chrome'};
    await host.runCommand('fixture-runtime:notify','',context);
    const site=(component:string)=>host.renderSite({component,width:80,rows:10},context);
    expect(JSON.stringify(await site('StatusLine'))).toContain('Pinned');
    expect(JSON.stringify(await site('Toast'))).toContain('Temporary');
    expect(await host.renderSite({component:'Toast',width:80,rows:10},{...context,sessionId:'other'})).toBeUndefined();
    await new Promise(resolve=>setTimeout(resolve,130));
    expect(await site('Toast')).toBeUndefined();
    expect(JSON.stringify(await site('StatusLine'))).toContain('Pinned');
    await host.runCommand('fixture-runtime:clear','',context);
    expect(await site('StatusLine')).toBeUndefined();
    host.dispose();
  });

  it('keeps persistent UI absent in explicit headless hosts', async () => {
    const host=await makeHost(`export function register(on){
      on('command.run',{command:'notify'},async $=>{await $.ui.status('Hidden');await $.ui.toast('Hidden');return {}});
      on('ui.render',{component:'AbovePrompt'},($,e)=>$.ui.resolve(e).Text({children:['Hidden']}));
    }`,true,'claude-mods',{},true);
    const context={cwd:root,sessionId:'headless'};
    await host.runCommand('fixture-runtime:notify','',context);
    expect(await host.renderSite({component:'AbovePrompt',width:80,rows:10},context)).toBeUndefined();
    expect(await host.renderSite({component:'StatusLine',width:80,rows:10},context)).toBeUndefined();
    await expect(host.dispatchSiteKey({component:'AbovePrompt',key:'action:refresh'},context)).rejects.toThrow('interactive host');
    host.dispose();
  });

  it('refuses render writes, preserves snapshots until a CAS conflict and refreshes retries', async () => {
    const host = await makeHost(`
      const ref={plugin:'fixture-runtime',key:'value'};
      export function register(on) {
        on('engine.create',async (_,e,next)=>({...await next(e),check:{run:()=>({value:null})}}));
        on('check.run',async $=>{
          const first=await $.state.get(ref);
          const set=await $.state.set(ref,1,{ifVersion:first.version});
          const stale=await $.state.set(ref,2,{ifVersion:first.version});
          const second=await $.state.get(ref);
          let owner=false;
          try{await $.state.set({...ref,plugin:'another'},3)}catch{owner=true}
          return {value:{first,second,set,stale,owner}};
        });
        on('ui.render',{component:'KimiTasks'},async $=>{await $.state.set(ref,9);return {type:'Text',children:['bad']}});
      }
    `,true,'claude-mods');
    const context={cwd:root,sessionId:'mods'};
    const result=await host.call('fixture-runtime.check.run',{},context);
    expect(result).toEqual({first:{value:undefined,version:0},second:{value:1,version:1},set:{isSet:true,version:1},stale:{isSet:false,version:1},owner:true});
    expect(await host.openSite({component:'KimiTasks'},context)).toBeUndefined();
    host.dispose();
  });

  it('loads state helper imports with frozen defaults, falsey values and family addresses', async () => {
    const host = await makeHost(`
      import { atom, read } from 'claude-code';
      const ref={plugin:'fixture-runtime',key:'family',id:'first'};
      const initial={rows:[]};
      const family=atom(ref,initial);
      const nullable=atom({plugin:'fixture-runtime',key:'nullable'},5);
      const zero=atom({plugin:'fixture-runtime',key:'zero'},5);
      const flag=atom({plugin:'fixture-runtime',key:'flag'},true);
      ref.id='second';initial.rows.push('outside');
      export function register(on) {
        on('engine.create',async(_,e,next)=>({...await next(e),helpers:{read:()=>{},seed:()=>{}}}));
        on('helpers.read',async $=>({value:{
          family:await read($,family), missing:await read($,{plugin:'fixture-runtime',key:'missing'}),
          nullable:await read($,nullable),zero:await read($,zero),flag:await read($,flag),
          id:family.ref.id,frozen:Object.isFrozen(family)&&Object.isFrozen(family.ref)&&Object.isFrozen(family.initial.rows)
        }}));
        on('helpers.seed',async $=>{
          await $.state.set(nullable.ref,null);await $.state.set(zero.ref,0);await $.state.set(flag.ref,false);
          await $.state.set(family.ref,{rows:['first']});return {value:true};
        });
      }
    `, true, 'claude-mods');
    const context = { cwd: root, sessionId: 'helpers' };
    expect(await host.call('fixture-runtime.helpers.read', {}, context)).toEqual({family:{rows:[]},missing:undefined,nullable:5,zero:5,flag:true,id:'first',frozen:true});
    await host.call('fixture-runtime.helpers.seed', {}, context);
    expect(await host.call('fixture-runtime.helpers.read', {}, context)).toEqual({family:{rows:['first']},missing:undefined,nullable:null,zero:0,flag:false,id:'first',frozen:true});
    host.dispose();
  });

  it('retries competing state helper updates and keeps sessions isolated', async () => {
    const host = await makeHost(`
      import { atom, read, update } from 'claude-code';
      const count=atom({plugin:'fixture-runtime',key:'count'},0);
      export function register(on) {
        on('engine.create',async(_,e,next)=>({...await next(e),counter:{read:()=>{},increment:()=>{},twice:()=>{}}}));
        on('counter.read',async $=>({value:await read($,count)}));
        on('counter.increment',async $=>({value:await update($,count,n=>n+1)}));
        on('counter.twice',async $=>({value:[await update($,count,n=>n+1),await update($,count.ref,n=>(n??0)+1)]}));
      }
    `, true, 'claude-mods');
    const context = { cwd: root, sessionId: 'helpers' };
    expect(await host.call('fixture-runtime.counter.twice', {}, context)).toEqual([1,2]);
    const values = await Promise.all(Array.from({length:12}, () => host.call('fixture-runtime.counter.increment', {}, context)));
    expect(values.toSorted((a,b) => Number(a)-Number(b))).toEqual(Array.from({length:12}, (_,i) => i+3));
    expect(await host.call('fixture-runtime.counter.read', {}, context)).toBe(14);
    expect(await host.call('fixture-runtime.counter.read', {}, {...context,sessionId:'another'})).toBe(0);
    host.dispose();
  });

  it('replaces mismatched atom shapes without altering an unwritten default', async () => {
    const host = await makeHost(`
      import { atom, read, update } from 'claude-code';
      const value=atom({plugin:'fixture-runtime',key:'shaped'},7,{shape:'v2'});
      export function register(on) {
        on('engine.create',async(_,e,next)=>({...await next(e),shapes:{seed:()=>{},read:()=>{},increment:()=>{}}}));
        on('shapes.seed',async $=>{await $.state.set(value.ref,{shape:'v1',value:99});return {value:true}});
        on('shapes.read',async $=>({value:{decoded:await read($,value),raw:(await $.state.get(value.ref)).value}}));
        on('shapes.increment',async $=>({value:await update($,value,n=>n+1)}));
      }
    `, true, 'claude-mods');
    const context = { cwd: root, sessionId: 'helpers' };
    expect(await host.call('fixture-runtime.shapes.read', {}, context)).toEqual({decoded:7,raw:undefined});
    await host.call('fixture-runtime.shapes.seed', {}, context);
    expect(await host.call('fixture-runtime.shapes.read', {}, context)).toEqual({decoded:7,raw:{shape:'v1',value:99}});
    expect(await host.call('fixture-runtime.shapes.increment', {}, context)).toBe(8);
    expect(await host.call('fixture-runtime.shapes.read', {}, context)).toEqual({decoded:8,raw:{shape:'v2',value:8}});
    host.dispose();
  });

  it('keeps helper writes behind ownership and render checks and rejects async reducers', async () => {
    const host = await makeHost(`
      import { atom, read, update } from 'claude-code';
      const count=atom({plugin:'fixture-runtime',key:'count'},0);
      const foreign=atom({plugin:'another',key:'count'},0);
      export function register(on) {
        on('engine.create',async(_,e,next)=>({...await next(e),helpers:{guard:()=>{}}}));
        on('helpers.guard',async $=>{
          let owner,asyncChange;
          try { await update($,foreign,n=>n+1) } catch(e) { owner=e.message }
          try { await update($,count,async n=>n+1) } catch(e) { asyncChange=e.message }
          return {value:{owner,asyncChange,count:await read($,count)}};
        });
        on('ui.render',{component:'KimiTasks'},async($,e)=>{
          let error;
          try { await update($,count,n=>n+1) } catch(e) { error=e.message }
          return $.ui.resolve(e).Text({children:[error]});
        });
      }
    `, true, 'claude-mods');
    const context = { cwd: root, sessionId: 'helpers' };
    expect(await host.call('fixture-runtime.helpers.guard', {}, context)).toEqual({owner:'Only the state owner may write it',asyncChange:'State updates must be synchronous',count:0});
    const site = await host.openSite({component:'KimiTasks'}, context);
    expect(site).toBe('site:KimiTasks');
    expect(await host.renderPane(site!,80,context)).toMatchObject({type:'Text',children:['State writes during ui.render are refused']});
    expect(await host.call('fixture-runtime.helpers.guard', {}, context)).toMatchObject({count:0});
    host.dispose();
  });

  it('routes host operations through middleware with rewritten input and explicit unsupported API errors', async () => {
    const host = await makeHost(`
      export function register(on) {
        on('engine.create',async (_,e,next)=>({...await next(e),probe:{run:()=>{}}}));
        on('store.set',{key:'before'},($,e,next)=>next({...e,key:'after',value:42}));
        const order=[];
        on('probe.run',($,e,next)=>{order.push('exact');return next(e)});
        on('probe.*',($,e,next)=>{if(next.is('probe.run',e))order.push('glob');return next(e)});
        on('probe.run',async $=>{
          await $.store.set('before',0);
          let error='';try{await $.ui.unsupported()}catch(e){error=e.message}
          return {value:{before:await $.store.get('before'),after:await $.store.get('after'),error,order}};
        });
      }
    `,true,'claude-mods');
    expect(await host.call('fixture-runtime.probe.run',{}, {cwd:root})).toEqual({before:0,after:undefined,error:'Unsupported Mods API: ui.unsupported',order:['exact','glob']});
    expect(await host.invoke('store.set', { key: 'before', value: 0 }, { cwd: root }, e => e)).toEqual({ key: 'after', value: 42 });
    host.dispose();
  });

  it('keeps instruction provenance coherent between frozen prompt context handlers', async () => {
    const host = await makeHost(`
      export function register(on) {
        on('prompt.context', async ($, e, next) => {
          if (!Object.isFrozen(e.instructionFiles[0])) throw new Error('Mutable event');
          return next({...e, instructionFiles: [...e.instructionFiles, {path:'/added.md',kind:'managed',content:'added'}]});
        });
        on('prompt.context', {instructionFiles:{path:'/added.md'}}, async ($, e, next) => {
          if (!e.blocks[0].text.includes('added')) throw new Error('Stale rendered instructions');
          if (!e.instructionFiles[1].isUnverified) throw new Error('Untrusted managed provenance');
          return next({...e, blocks:[{name:'claudeMd',text:'redacted'}]});
        });
        on('prompt.context', async ($, e, next) => {
          if (e.instructionFiles !== undefined) throw new Error('Stale file provenance');
          $.ui.invalidate('prompt.context');
          return next(e);
        });
      }
    `, true, 'claude-mods');
    const generation = host.generation;
    const original = { blocks: [{ name: 'claudeMd', text: 'original' }], instructionFiles: [{ path: '/original.md', kind: 'project', content: 'original' }] };
    expect(await host.invoke('prompt.context', original, { cwd: root, sessionId: 'context' }, e => e)).toEqual({ blocks: [{ name: 'claudeMd', text: 'redacted' }], instructionFiles: undefined });
    expect(host.generation).toBe(generation + 1);
    expect(original.instructionFiles).toHaveLength(1);
    expect(original.blocks[0]?.text).toBe('original');
    host.dispose();
  });

  it('seals catch registrations and refuses duplicate handlers and engine.create catches', async () => {
    const host = await makeHost(`export function register(on) {
      const errors=[];
      const registration=on('probe.registration', () => ({ok:true}));
      registration.catch(() => ({}));
      try { registration.catch(() => ({})); } catch(e) { errors.push(e.message); }
      try { on('engine.create', (_,e,next) => next(e)).catch(() => ({})); } catch(e) { errors.push(e.message); }
      on('probe.inspect', () => {
        try { registration.catch(() => ({})); } catch(e) { return {errors:[...errors,e.message]}; }
      });
    }`, true, 'claude-mods');
    expect(await host.invoke('probe.inspect', {}, {cwd:root,sessionId:'registration'}, e => e)).toEqual({errors:[
      'A hook accepts only one .catch handler', 'engine.create does not support .catch', 'Cannot attach .catch after register returned',
    ]});
    host.dispose();
  });

  it('removes partial providers after a registration error and keeps other plugins usable', async () => {
    const host=await makeHost(`export function register(on) {
      on('engine.create',async(_,e,next)=>({...await next(e),broken:{read:()=>({value:'leaked'})}})).catch(()=>({}));
    }`,true,'claude-mods',{'healthy':`export function register(on) {
      on('engine.create',async(_,e,next)=>({...await next(e),healthy:{read:()=>({value:42})}}));
    }`});
    await expect(host.call('fixture-runtime.broken.read',{}, {cwd:root})).rejects.toThrow('Unknown plugin method');
    expect(await host.call('healthy.healthy.read',{}, {cwd:root})).toBe(42);
    host.dispose();
  });

  it.each(['before', 'after', 'retry'])('fails open without repeating execution when a hook throws %s next', async mode => {
    const host = await makeHost(`export function register(on) {
      on('tool.call', async ($,e,next) => {
        if(e.mode==='before') throw new Error('before');
        await next(e);
        if(e.mode==='retry') await next({...e,attempt:2});
        throw new Error('after');
      });
    }`, true, 'claude-mods');
    const terminal = vi.fn(e => ({result:e['attempt'] ?? 1}));
    expect(await host.invoke('tool.call', {tool:'Echo',mode}, {cwd:root}, terminal)).toEqual({result:mode==='retry'?2:1});
    expect(terminal).toHaveBeenCalledTimes(mode==='retry'?2:1);
    host.dispose();
  });

  it.each(['before', 'after', 'retry'])('recovers with frozen catch metadata and replay-safe next after %s failure', async mode => {
    const host = await makeHost(`export function register(on) {
      on('tool.call', async ($,e,next) => {
        if(e.mode==='before') throw new Error('failed');
        await next(e);
        if(e.mode==='retry') await next({...e,attempt:2});
        throw new Error('failed');
      }).catch(async ($,e,next) => {
        if (!Object.isFrozen(next.error) || !Object.isFrozen(next.origin) || !Object.isFrozen(e)) throw new Error('Mutable metadata');
        const called=next.called;
        if(!called) return {deny:next.error.kind+':'+next.error.message};
        const first=await next(e);
        const second=await next(new Proxy({}, {get:()=>{throw new Error('Replay read its argument')}}));
        return {...first,replayed:JSON.stringify(first)===JSON.stringify(second),called,budget:next.budget.ms};
      });
    }`, true, 'claude-mods');
    const terminal = vi.fn(e => ({result:e['attempt'] ?? 1}));
    expect(await host.invoke('tool.call', {tool:'Echo',mode}, {cwd:root}, terminal)).toEqual(mode==='before' ? {deny:'throw:failed'} : {result:mode==='retry'?2:1,replayed:true,called:true,budget:1000});
    expect(terminal).toHaveBeenCalledTimes(mode==='before'?0:mode==='retry'?2:1);
    host.dispose();
  });

  it.each(['throw', 'undefined', 'timeout'])('uses the original continuation once when catch ends with %s', async mode => {
    const host = await makeHost(`export function register(on) {
      on('tool.call', async ($,e,next) => { await next(e); throw new Error('failed'); }).catch(async () => {
        if (${JSON.stringify(mode)}==='throw') throw new Error('catch failed');
        if (${JSON.stringify(mode)}==='timeout') await new Promise(resolve=>setTimeout(resolve,5000));
      });
    }`, true, 'claude-mods');
    if (mode==='timeout') vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
    const terminal = vi.fn(() => ({result:'once'}));
    const result = host.invoke('tool.call', {tool:'Echo'}, {cwd:root}, terminal);
    if (mode==='timeout') await vi.advanceTimersByTimeAsync(1001);
    expect(await result).toEqual({result:'once'});
    expect(terminal).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it('routes invalid render and tool results through the registered catch', async () => {
    const host = await makeHost(`export function register(on) {
      on('tool.call', () => 'invalid').catch(($,e,next) => ({deny:next.error.kind}));
      on('ui.render', {component:'KimiTasks'}, () => ({type:'Unknown'})).catch(($,e,next) => ({type:'Text',children:[next.error.kind]}));
    }`, true, 'claude-mods');
    const context={cwd:root,sessionId:'invalid'};
    const terminal = vi.fn(() => ({result:'unexpected'}));
    expect(await host.invoke('tool.call',{tool:'Echo'},context,terminal)).toEqual({deny:'throw'});
    expect(terminal).not.toHaveBeenCalled();
    const site=await host.openSite({component:'KimiTasks'},context);
    expect(await host.renderPane(site!,80,context)).toMatchObject({type:'Text',children:['throw']});
    host.dispose();
  });

  it('excludes overlapping host calls and next waits from the own-time budget', async () => {
    const host = await makeHost(`export function register(on) {
      on('probe.budget', async ($,e,next) => {
        await new Promise(resolve=>setTimeout(resolve,500));
        const before=next.budget.remainingMs;
        await Promise.all([$.kimi.agent.run({prompt:'first',model:'haiku'}),$.kimi.agent.run({prompt:'second',model:'haiku'})]);
        const afterHost=next.budget.remainingMs;
        const result=await next(e);
        return {before,afterHost,afterNext:next.budget.remainingMs,result,ms:next.budget.ms};
      });
    }`, true, 'claude-mods');
    const context={cwd:root,sessionId:'budget'};
    host.bindContext({context,signal:new AbortController().signal,activities:()=>[],output:async()=>'',runProcess:async()=>{throw new Error('Unexpected process')},runAgent:async options => {
      await new Promise(resolve=>setTimeout(resolve,options.prompt==='first'?30000:45000));
      return {agentId:options.prompt,taskId:options.prompt,text:'done'};
    }});
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
    const result=host.invoke('probe.budget',{},context,async()=>{await new Promise(resolve=>setTimeout(resolve,50000));return 'next'});
    await vi.advanceTimersByTimeAsync(96000);
    expect(await result).toEqual({before:9500,afterHost:9500,afterNext:9500,result:'next',ms:10000});
    host.dispose();
  });

  it('does not apply the legacy wall timeout around Mods commands waiting on native work', async () => {
    const host = await makeHost(`export function register(on) {
      on('command.run',{command:'wait'},async $ => {await $.kimi.agent.run({prompt:'wait',model:'haiku'});return {text:'done'};});
    }`, true, 'claude-mods');
    const context={cwd:root,sessionId:'command-budget'};
    host.bindContext({context,signal:new AbortController().signal,activities:()=>[],output:async()=>'',runProcess:async()=>{throw new Error('Unexpected process')},runAgent:async()=>{await new Promise(resolve=>setTimeout(resolve,45000));return {agentId:'worker',taskId:'task',text:'done'}}});
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
    const result=host.runCommand('fixture-runtime:wait','',context);
    await vi.advanceTimersByTimeAsync(45001);
    expect(await result).toEqual({text:'done'});
    host.dispose();
  });

  it.each([false,true])('times out own work, replays called=%s and blocks stale next and host writes', async called => {
    const host = await makeHost(`export function register(on) {
      const trail=[];
      on('tool.call',async ($,e,next)=>{
        if(e.called) await next(e);
        await new Promise(resolve=>setTimeout(resolve,20000));
        trail.push(next.signal.aborted);
        try { await $.store.set('late',true); } catch { trail.push('host blocked'); }
        try { await next(e); } catch { trail.push('next blocked'); }
        return {result:'late'};
      }).catch(async ($,e,next)=>next.called ? next(e) : {deny:next.error.kind});
      on('probe.inspect',async $=>({trail,late:await $.store.get('late')}));
    }`, true, 'claude-mods');
    const context={cwd:root,sessionId:'timeout'};
    const terminal=vi.fn(()=>({result:'once'}));
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
    const result=host.invoke('tool.call',{tool:'Echo',called},context,terminal);
    await vi.advanceTimersByTimeAsync(10001);
    expect(await result).toEqual(called?{result:'once'}:{deny:'timeout'});
    await vi.advanceTimersByTimeAsync(10000);
    expect(await host.invoke('probe.inspect',{},context,e=>e)).toEqual({trail:[true,'host blocked','next blocked'],late:undefined});
    expect(terminal).toHaveBeenCalledTimes(called?1:0);
    host.dispose();
  });

  it('keeps engine and plugin origins immutable and skips self hooks from callbacks and APIs', async () => {
    const host=await makeHost(`export function register(on) {
      const skipped=[];
      on('probe.fire',async ($,e,next)=>{await $.store.set('outer',{origin:{plugin:'engine',tier:'core'}});return {origin:next.origin,frozen:Object.isFrozen(next.origin)};});
      on('store.set',()=>{throw new Error('Self hook ran')}).catch(async ($,e,next)=>{
        skipped.push({kind:next.error.kind,called:next.called,origin:next.origin});
        if(e.key==='outer') await $.store.set('inner',true);
        await next(e);return next(e);
      });
      on('probe.timer',$=>{$.clock.after(10,()=>$.store.set('timer',true));return {};});
      on('probe.inspect',()=>({skipped}));
    }`,true,'claude-mods',{'observer':`export function register(on) {
      const seen=[];
      on('store.set',($,e,next)=>{seen.push({key:e.key,origin:next.origin});return next({...e,origin:{plugin:'forged',tier:'prepend'}});});
      on('store.set',($,e,next)=>{if(next.origin.plugin!=='fixture-runtime')throw new Error('Origin changed');return next(e);});
      on('observer.inspect',()=>({seen}));
    }`});
    const context={cwd:root,sessionId:'origin'};
    expect(await host.invoke('probe.fire',{origin:{plugin:'forged',tier:'prepend'}},context,e=>e)).toEqual({origin:{plugin:'engine',tier:'core'},frozen:true});
    await host.invoke('probe.timer',{},context,e=>e);
    await expect.poll(async()=>((await host.invoke('observer.inspect',{},context,e=>e)) as {seen:unknown[]}).seen.length).toBe(3);
    expect(await host.invoke('observer.inspect',{},context,e=>e)).toEqual({seen:['inner','outer','timer'].map(key=>({key,origin:{plugin:'fixture-runtime',tier:'user'}}))});
    expect(await host.invoke('probe.inspect',{},context,e=>e)).toEqual({skipped:[0,1].map(()=>({kind:'re-entry',called:false,origin:{plugin:'fixture-runtime',tier:'user'}}))});
    host.dispose();
  });

  it('replays a synchronous continuation failure without executing it again', async () => {
    const host=await makeHost(`export function register(on) {
      on('tool.call',($,e,next)=>next(e)).catch(($,e,next)=>next(e));
    }`,true,'claude-mods');
    const terminal=vi.fn(()=>{throw new Error('native failure');});
    await expect(host.invoke('tool.call',{tool:'Echo'},{cwd:root},terminal)).rejects.toThrow('native failure');
    expect(terminal).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it('waits for an in-flight continuation before entering catch and preserves external cancellation', async () => {
    const host=await makeHost(`export function register(on) {
      on('tool.call',($,e,next)=>{void next(e);throw new Error('failed while pending');}).catch(async ($,e,next)=>({...await next(e),caught:true}));
    }`,true,'claude-mods');
    let finish!: (value: {result:string})=>void;
    const terminal=vi.fn(()=>new Promise<{result:string}>(resolve=>{finish=resolve;}));
    const context={cwd:root,sessionId:'pending'};
    const result=host.invoke('tool.call',{tool:'Echo'},context,terminal);
    await expect.poll(()=>terminal.mock.calls.length).toBe(1);
    finish({result:'finished'});
    expect(await result).toEqual({result:'finished',caught:true});
    const controller=new AbortController();
    const cancelled=host.invoke('tool.call',{tool:'Echo'},{...context,signal:controller.signal},terminal);
    const rejection=expect(cancelled).rejects.toThrow('cancelled');
    await expect.poll(()=>terminal.mock.calls.length).toBe(2);
    controller.abort(new Error('cancelled'));
    await rejection;
    finish({result:'late'});
    expect(terminal).toHaveBeenCalledTimes(2);
    host.dispose();
  });

  it('reports rewritten re-entry without allowing payloads to change the origin', async () => {
    const host=await makeHost(`export function register(on) {
      on('probe.fire',async $=>$.tool.call({tool:'Echo',value:1}));
      on('tool.check',()=>{throw new Error('Self check ran')}).catch(($,e,next)=>({decision:'deny',reason:next.error.cause+':'+next.origin.plugin}));
    }`,true,'claude-mods',{'observer':`export function register(on) {
      on('tool.call',($,e,next)=>next({...e,value:2,origin:{plugin:'engine',tier:'core'}}));
    }`});
    const context={cwd:root,sessionId:'rewritten'};
    host.bindContext({context,signal:new AbortController().signal,activities:()=>[],output:async()=>'',runAgent:async()=>{throw new Error('Unexpected agent')},runProcess:async()=>{throw new Error('Unexpected process')},callTool:input=>host.invoke('tool.call',input,context,()=>host.invoke('tool.check',{tool:'Echo'},context,()=>({decision:'allow'}))) as never});
    expect(await host.invoke('probe.fire',{},context,e=>e)).toEqual({decision:'deny',reason:'rewritten:fixture-runtime'});
    host.dispose();
  });

  it('blocks cross-plugin cycles through a lent namespace and isolates concurrent root dispatches', async () => {
    const host=await makeHost(`export function register(on) {
      on('tool.call',async $=>({result:await $.bridge.call({})})).catch(($,e,next)=>({result:next.error.cause+':'+next.origin.plugin}));
    }`,true,'claude-mods',{'bridge':`export function register(on) {
      on('engine.create',async (_,e,next)=>({...await next(e),bridge:{call:()=>{throw new Error('Missing provider')}}}));
      on('bridge.call',async $=>({value:(await $.tool.call({tool:'Echo'})).result}));
    }`});
    const context={cwd:root,sessionId:'lent'};
    const terminal=vi.fn(()=>({result:'unexpected'}));
    host.bindContext({context,signal:new AbortController().signal,activities:()=>[],output:async()=>'',runAgent:async()=>{throw new Error('Unexpected agent')},runProcess:async()=>{throw new Error('Unexpected process')},callTool:input=>host.invoke('tool.call',input,context,terminal) as never});
    expect(await Promise.all([host.invoke('tool.call',{tool:'Echo'},context,terminal),host.invoke('tool.call',{tool:'Echo'},context,terminal)])).toEqual([{result:'lent:bridge'},{result:'lent:bridge'}]);
    expect(terminal).not.toHaveBeenCalled();
    host.dispose();
  });

  it('replays the first catch continuation once and excludes its host waits from the grace', async () => {
    const host=await makeHost(`export function register(on) {
      on('tool.call',()=>{throw new Error('failed')}).catch(async ($,e,next)=>{
        const before=next.budget.remainingMs;
        const first=await next(e);
        const second=await next(e);
        return {...first,same:first===second,called:next.called,before,after:next.budget.remainingMs};
      });
    }`,true,'claude-mods');
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
    const terminal=vi.fn(async()=>{await new Promise(resolve=>setTimeout(resolve,45000));return {result:'done'};});
    const result=host.invoke('tool.call',{tool:'Echo'},{cwd:root},terminal);
    await vi.advanceTimersByTimeAsync(45001);
    expect(await result).toEqual({result:'done',same:true,called:false,before:1000,after:1000});
    expect(terminal).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it('preserves declared background tasks after their initiating hook and turn finish', async () => {
    const host=await makeHost(`export function register(on) {
      on('probe.start',$=>({id:$.kimi.tasks.start({id:'background',title:'Background'},async signal=>{
        await new Promise(resolve=>setTimeout(resolve,20));
        await $.kimi.agent.run({prompt:'background',model:'haiku',signal});
        await $.store.set('finished',true);
      })}));
      on('probe.inspect',async $=>({finished:await $.store.get('finished')}));
    }`,true,'claude-mods');
    const controller=new AbortController();
    const context={cwd:root,sessionId:'background'};
    const runAgent=vi.fn(async options=>{options.signal.throwIfAborted();return {agentId:'worker',taskId:'task',text:'done'};});
    host.bindContext({context,signal:new AbortController().signal,activities:()=>[],output:async()=>'',runAgent,runProcess:async()=>{throw new Error('Unexpected process')}});
    expect(await host.invoke('probe.start',{}, {...context,signal:controller.signal},e=>e)).toEqual({id:'background'});
    controller.abort(new Error('Turn finished'));
    await expect.poll(async()=>((await host.invoke('probe.inspect',{},context,e=>e)) as {finished?:boolean}).finished).toBe(true);
    expect(runAgent).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it('uses only the latest next rejection in timeout metadata', async () => {
    const host=await makeHost(`export function register(on) {
      on('tool.call',async($,e,next)=>{
        void next({...e,attempt:1}).catch(()=>{});
        await next({...e,attempt:2});
        await new Promise(resolve=>setTimeout(resolve,20000));
        return {result:'late'};
      }).catch(($,e,next)=>({result:next.error.message ?? 'no rejection from latest'}));
    }`,true,'claude-mods');
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
    const terminal=vi.fn(async e=>{
      if(e['attempt']===1){await new Promise(resolve=>setTimeout(resolve,100));throw new Error('older call failed');}
      return {result:'latest'};
    });
    const result=host.invoke('tool.call',{tool:'Echo'},{cwd:root},terminal);
    await vi.advanceTimersByTimeAsync(10101);
    expect(await result).toEqual({result:'no rejection from latest'});
    expect(terminal).toHaveBeenCalledTimes(2);
    host.dispose();
  });

  it('cancels a hook waiting on host work when its agent binding closes', async () => {
    const host=await makeHost(`export function register(on) {
      on('probe.wait',async $=>$.kimi.agent.run({prompt:'wait',model:'haiku'})).catch(()=>({recovered:true}));
    }`,true,'claude-mods');
    const controller=new AbortController();
    const context={cwd:root,sessionId:'closed'};
    const runAgent=vi.fn(()=>new Promise<never>(()=>{}));
    host.bindContext({context,signal:controller.signal,activities:()=>[],output:async()=>'',runAgent,runProcess:async()=>{throw new Error('Unexpected process')}});
    const waiting=host.invoke('probe.wait',{},context,e=>e);
    const rejection=expect(waiting).rejects.toThrow('Agent closed');
    await expect.poll(()=>runAgent.mock.calls.length).toBe(1);
    controller.abort(new Error('Agent closed'));
    await rejection;
    host.dispose();
  });

  it('raises UI input and reactive redraws as fresh engine events', async () => {
    const host=await makeHost(`export function register(on) {
      const origins=[];
      const ref={plugin:'fixture-runtime',key:'count'};
      on('ui.render',{component:'KimiTasks'},async($,e,next)=>{
        origins.push(next.origin);
        const count=(await $.state.get(ref)).value ?? 0;
        const {Box,Text,Button}=$.ui.resolve(e);
        return Box({children:[Text({children:['Count '+count]}),Button({key:'add',label:'Add',onPress:async()=>{await $.state.set(ref,1)}})]});
      });
      on('ui.press',async($,e,next)=>{await $.store.set('inputOrigin',next.origin);return next(e);});
      on('probe.inspect',async $=>({inputOrigin:await $.store.get('inputOrigin'),origins}));
    }`,true,'claude-mods');
    const context={cwd:root,sessionId:'ui-origin'};
    const id=(await host.openSite({component:'KimiTasks'},context))!;
    const tree=await host.renderPane(id,80,context) as import('#/app/plugin/mods').RenderElement;
    const button=tree.children![1] as import('#/app/plugin/mods').RenderElement;
    const refreshes: Promise<unknown>[]=[];
    const subscription=host.onDidChange(()=>{refreshes.push(host.renderPane(id,80,context));});
    await host.dispatchKey(id,'callback:'+JSON.stringify({handle:button.props!['callback']}),context);
    subscription.dispose();
    const refreshed=await Promise.all(refreshes);
    expect(refreshed.length).toBeGreaterThan(0);
    expect(refreshed.map(value=>JSON.stringify(value)).some(value=>value.includes('Count 1'))).toBe(true);
    const inspected=await host.invoke('probe.inspect',{},context,e=>e) as {inputOrigin:unknown;origins:unknown[]};
    expect(inspected.inputOrigin).toEqual({plugin:'engine',tier:'core'});
    expect(inspected.origins).toEqual(inspected.origins.map(()=>({plugin:'engine',tier:'core'})));
    host.dispose();
  });

  it('gives a timer created during render a writable fresh state frame', async () => {
    const host=await makeHost(`export function register(on) {
      let scheduled=false;
      const ref={plugin:'fixture-runtime',key:'value'};
      on('ui.render',{component:'KimiTasks'},async($,e)=>{
        if(!scheduled){scheduled=true;$.clock.after(10,async()=>{await $.state.set(ref,1);});}
        return $.ui.resolve(e).Text({children:['Value '+((await $.state.get(ref)).value ?? 0)]});
      });
    }`,true,'claude-mods');
    const context={cwd:root,sessionId:'render-timer'};
    const id=(await host.openSite({component:'KimiTasks'},context))!;
    await expect.poll(async()=>JSON.stringify(await host.renderPane(id,80,context))).toContain('Value 1');
    host.dispose();
  });

  it('compiles JSX against the portable element kit and leaves missing sites to the host', async () => {
    await writeFixturePlugin(root, '');
    await writeFile(path.join(root,'runtime','view.tsx'), `export const draw = ({Text}) => <Text bold>portable</Text>`);
    const host = await makeHost(`
      import {draw} from './view.tsx';
      export function register(on) {
        on('ui.render',{component:'KimiTasks'},($,e)=>draw($.ui.resolve(e)));
      }
    `,true,'claude-mods');
    const context={cwd:root,sessionId:'jsx'};
    const id=await host.openSite({component:'KimiTasks'},context);
    expect(id).toBe('site:KimiTasks');
    expect(await host.renderPane(id!,80,context)).toMatchObject({type:'Text',props:{bold:true},children:['portable']});
    expect(await host.openSite({component:'Unknown'},context)).toBeUndefined();
    host.dispose();
  });

  it('renders the workflow task replacement when native tasks exist', async () => {
    const entry = path.resolve(__dirname, '../../../../core-plugins/kimi-workflow-ui/runtime/index.ts');
    const host = await makeHost(`
      import { register as registerView } from ${JSON.stringify(entry)};
      export function register(on) {
        on('engine.create', async (_, e, next) => ({ ...await next(e), workflow: {
          status: () => [], tasks: () => [{ id: 'native-task', title: 'Native task', kind: 'plugin', status: 'completed' }], output: () => ''
        } }));
        registerView(on);
      }
    `, true, 'claude-mods');
    const context = { cwd: root, sessionId: 'task-view' };
    expect(await host.openSite({ component: 'KimiTasks' }, context)).toBe('site:KimiTasks');
    const tree = await host.renderPane('site:KimiTasks', 80, context);
    expect(JSON.stringify(tree)).toContain('Native task');
    expect(tree).toMatchObject({ type: 'Box' });
    host.dispose();
  });

  it('loads a runtime module and dispatches an event to its handler', async () => {
    const host = await makeHost(`
      export function register(on) {
        on('PreToolUse', async ($, e, next) => {
          await $.store.set('lastEvent', e.event);
          return next(e);
        });
      }
    `);

    const results = await host.dispatch('PreToolUse', { cwd: root });

    expect(results).toEqual([]);
    expect(host.hasHandlers('PreToolUse')).toBe(true);
    expect(host.summary()).toEqual({ PreToolUse: 1 });
  });

  it('persists store values across host restarts', async () => {
    const source = `
      export function register(on) {
        on('SessionStart', async ($, e, next) => {
          const count = ((await $.store.get('starts')) ?? 0) + 1;
          await $.store.set('starts', count);
          return next(e);
        });
      }
    `;
    const first = await makeHost(source);
    await first.dispatch('SessionStart', { cwd: root });

    const second = await makeHost(source);
    await second.dispatch('SessionStart', { cwd: root });

    const { readFile } = await import('node:fs/promises');
    const stored = JSON.parse(
      await readFile(path.join(storeRoot, 'plugin-runtime', 'fixture-runtime.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(stored['starts']).toBe(2);
  });

  it('propagates a block result from a handler', async () => {
    const host = await makeHost(`
      export function register(on) {
        on('PreToolUse', 'Bash', async ($, e) => {
          return { block: 'refused by fixture' };
        });
      }
    `);

    const matched = await host.dispatch('PreToolUse', { cwd: root, matcherValue: 'Bash' });
    const unmatched = await host.dispatch('PreToolUse', { cwd: root, matcherValue: 'Read' });

    expect(matched).toEqual([{ action: 'block', reason: 'refused by fixture' }]);
    expect(unmatched).toEqual([]);
  });

  it('runs chained handlers in registration order', async () => {
    const calls: string[] = [];
    const host = await makeHost(`
      export function register(on) {
        on('PostToolUse', async ($, e, next) => {
          globalThis.__runtimeCalls.push('first');
          return next(e);
        });
        on('PostToolUse', async ($, e, next) => {
          globalThis.__runtimeCalls.push('second');
          return next(e);
        });
      }
    `);
    (globalThis as Record<string, unknown>)['__runtimeCalls'] = calls;

    await host.dispatch('PostToolUse', { cwd: root });
    expect(calls).toEqual(['first', 'second']);
    delete (globalThis as Record<string, unknown>)['__runtimeCalls'];
  });

  it('stays inert when the experimental flag is off', async () => {
    const host = await makeHost(
      `
      export function register(on) {
        on('PreToolUse', async ($, e, next) => next(e));
      }
    `,
      false,
    );

    expect(host.hasHandlers('PreToolUse')).toBe(false);
    expect(await host.dispatch('PreToolUse', { cwd: root })).toEqual([]);
  });

  it('survives a handler that throws (fail-open)', async () => {
    const host = await makeHost(`
      export function register(on) {
        on('PreToolUse', async () => {
          throw new Error('boom');
        });
      }
    `);

    const results = await host.dispatch('PreToolUse', { cwd: root });
    expect(results).toEqual([]);
  });

  it('exposes Workflow as a plugin tool and executes workers only through the bound harness', async () => {
    const pluginRoot = path.resolve(__dirname, '../../../../core-plugins/kimi-workflow');
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'kimi.plugin.json'), 'utf8'));
    const plugins = stubPluginService({ enabledPluginIds: ['kimi-workflow'], sessionStarts: [], summaries: [{ id: 'kimi-workflow', enabled: true, state: 'ok' }] });
    plugins.getPluginInfo = async () => ({ ...stubPluginInfo(pluginRoot, 'claude-mods'), id: 'kimi-workflow', manifest });
    const host = new PluginRuntimeHost(plugins, stubFlag(id => id === PLUGIN_RUNTIME_FLAG_ID), stubLog(), stubBootstrap(storeRoot));
    await host.ready;
    expect(host.listTools()).toEqual([expect.objectContaining({ name: 'Workflow', method: 'kimi-workflow.workflow.run' })]);
    expect(host.hasHandlers('Stop')).toBe(false);
    expect(host.hasHandlers('UserPromptSubmit')).toBe(false);
    let processCalls = 0;
    const workers: string[] = [];
    const controller = new AbortController();
    const context = { cwd: root, sessionId: 'native-workflow', agentId: 'main' };
    host.bindContext({ context, signal: controller.signal, activities: () => [], output: async () => '',
      runProcess: async () => { processCalls++; throw new Error('Workflow must not spawn CLI workers'); },
      runAgent: async options => { workers.push(options.model); return { agentId: 'worker', taskId: 'task', text: options.prompt }; },
    });
    await expect(host.call('kimi-workflow.workflow.run', { source: '', concurrency: 100 }, context)).rejects.toThrow('Concurrency must be');
    const { runId } = await host.call('kimi-workflow.workflow.run', { source: `return agent('Inspect example.ts', { model: 'haiku' });` }, context) as { runId: string };
    await expect.poll(async () => (await host.call('kimi-workflow.workflow.status', { runId }, context) as { status: string }).status).toBe('completed');
    expect(workers).toEqual(['haiku']);
    expect(processCalls).toBe(0);
    controller.abort(); host.dispose();
  });

  it('serves plugin panes through the UI host channel', async () => {
    const host = await makeHost(`
      let count = 0;
      export function register(on) {
        on('SessionStart', async ($, e, next) => {
          await $.ui.open({ id: 'demo-pane', title: 'Demo' });
          return next(e);
        });
        on('ui.render', async ($, e, next) => {
          if (e.data.requestId !== 'demo-pane') return next();
          return { type: 'box', direction: 'column', children: [
            { type: 'text', text: 'count: ' + count, color: 'primary' },
          ] };
        });
        on('ui.key', async ($, e) => {
          if (e.data.key === 'enter') count += 1;
        });
      }
    `);

    await host.dispatch('SessionStart', { cwd: root });

    const uiHost = host;

    expect(uiHost.listPanes()).toEqual([{ id: 'demo-pane', title: 'Demo', pluginId: 'fixture-runtime' }]);

    const first = (await uiHost.renderPane('demo-pane', 80)) as unknown as {
      type: string;
      children: { text: string }[];
    };
    expect(first.children[0]?.text).toBe('count: 0');

    await uiHost.dispatchKey('demo-pane', 'enter');
    const second = (await uiHost.renderPane('demo-pane', 80)) as unknown as {
      children: { text: string }[];
    };
    expect(second.children[0]?.text).toBe('count: 1');

    const missing = await uiHost.renderPane('no-such-pane', 80);
    expect(missing).toBeUndefined();
  });
  it('validates domain boundaries and applies middleware rewrites', async () => {
    const host = await makeHost(`
      export function register(on) {
        on.domain('math', { double: {
          input: { type: 'number' }, output: { type: 'number' },
          handler: (_, event) => event.data.input * 2,
        } });
        on('fixture-runtime.math.double', ($, e, next) => next({ ...e, data: { input: e.data.input + 1 } }));
      }
    `);
    expect(await host.call('fixture-runtime.math.double', 2, { cwd: root })).toBe(6);
    await expect(host.call('fixture-runtime.math.double', 'bad', { cwd: root })).rejects.toThrow('Invalid input');
    host.dispose();
  });

  it('keeps panes and client view state isolated between sessions', async () => {
    const host = await makeHost(`
      export function register(on) {
        on.command('open', 'Open', ($) => $.ui.open({ id: 'same', title: 'View' }));
        on('ui.key', ($, e) => { $.view.set('key', e.data.key); $.state.set('shared', e.data.key); });
        on.domain('state', { read: { input: {}, handler: ($) => $.state.get('shared') } });
        on('ui.render', ($) => ({ type: 'text', text: $.view.get('key') ?? 'empty' }));
      }
    `);
    const a = { cwd: root, sessionId: 'a', clientId: 'one' };
    const b = { cwd: root, sessionId: 'b', clientId: 'one' };
    await host.runCommand('fixture-runtime:open', '', a);
    expect(host.listPanes(b)).toEqual([]);
    await host.dispatchKey('same', 'down', a);
    expect(await host.renderPane('same', 80, a)).toEqual({ type: 'text', text: 'down' });
    expect(await host.renderPane('same', 80, { ...a, clientId: 'two' })).toEqual({ type: 'text', text: 'empty' });
    expect(await host.call('fixture-runtime.state.read', {}, { ...a, clientId: 'two' })).toBe('down');
    host.dispose();
  });

  it('rejects undeclared capabilities at a domain boundary', async () => {
    const host = await makeHost(`export function register(on) {
      on.domain('restricted', { run: { input: {}, handler: ($) => $.process.run(['echo', 'denied']) } });
    }`);
    await expect(host.call('fixture-runtime.restricted.run', {}, { cwd: root })).rejects.toThrow('requires runtime capability: process');
    host.dispose();
  });

  it('pauses queued native calls and cancels active workers', async () => {
    const entry = path.resolve(__dirname, '../../../../core-plugins/kimi-workflow/runtime/index.ts');
    const host = await makeHost(`export { register } from ${JSON.stringify(entry)};`, true, 'claude-mods');
    const controller = new AbortController();
    const releases: (() => void)[] = [];
    const context = { cwd: root, sessionId: 'workflow-control', agentId: 'main' };
    host.bindContext({ context, signal: controller.signal, activities: () => [], output: async () => '', runProcess: async () => ({ exitCode: 0, stdout: '', stderr: '' }), runAgent: async (options) => {
      await new Promise<void>((resolve, reject) => {
        releases.push(resolve);
        options.signal?.addEventListener('abort', () => { reject(new Error('worker stopped')); }, { once: true });
      });
      return { agentId: 'worker', taskId: 'task', text: options.prompt };
    } });
    const { runId } = await host.call('fixture-runtime.workflow.run', { concurrency: 1, source: `return parallel(['one', 'two'].map(prompt => () => agent(prompt, { model: 'haiku' })));` }, context) as { runId: string };
    const status = async () => host.call('fixture-runtime.workflow.status', { runId }, context) as Promise<{ status: string; calls: { status: string }[] }>;
    await expect.poll(() => releases.length).toBe(1);
    await host.call('fixture-runtime.workflow.control', { runId, action: 'pause' }, context);
    releases[0]!();
    await expect.poll(async () => (await status()).calls[0]?.status).toBe('completed');
    expect((await status()).status).toBe('paused');
    expect(releases).toHaveLength(1);
    await host.call('fixture-runtime.workflow.control', { runId, action: 'resume' }, context);
    await expect.poll(() => releases.length).toBe(2);
    await host.call('fixture-runtime.workflow.control', { runId, action: 'cancel' }, context);
    expect((await status()).status).toBe('cancelled');
    expect((await status()).calls[1]?.status).toBe('cancelled');
    controller.abort(); host.dispose();
  });

  it('atomically updates a store shared by concurrent handlers', async () => {
    const host = await makeHost(`
      export function register(on) {
        on('Tick', ($) => $.store.update('count', (value = 0) => value + 1));
      }
    `);
    await Promise.all(Array.from({ length: 16 }, () => host.dispatch('Tick', { cwd: root })));
    const stored = JSON.parse(await readFile(path.join(storeRoot, 'plugin-runtime', 'fixture-runtime.json'), 'utf8'));
    expect(stored.count).toBe(16);
    host.dispose();
  });

  it('runs native workflow agents in the background, bounds concurrency, and replays results', async () => {
    const pluginEntry = path.resolve(__dirname, '../../../../core-plugins/kimi-workflow/runtime/index.ts');
    const host = await makeHost(`export { register } from ${JSON.stringify(pluginEntry)};`, true, 'claude-mods');
    const controller = new AbortController();
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    const context = { cwd: root, sessionId: 'workflow-test', agentId: 'main' };
    host.bindContext({ context, signal: controller.signal, activities: () => [], output: async () => '', runProcess: async () => ({ exitCode: 0, stdout: '', stderr: '' }), runAgent: async (options) => {
      calls.push(options.prompt); active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      options.onStarted?.('worker', 'task', options.model);
      return { agentId: 'worker', taskId: 'task', text: options.prompt.toUpperCase() };
    } });
    const input = { name: 'Native', concurrency: 2, source: `await phase('Check'); return pipeline(['a', 'b', 'c'], item => agent(item, { model: 'haiku' }), item => agent(item + '!', { model: 'haiku' }));` };
    const started = await host.call('fixture-runtime.workflow.run', input, context) as { runId: string };
    const status = async () => host.call('fixture-runtime.workflow.status', { runId: started.runId }, context) as Promise<{ status: string; result: unknown; calls: unknown[] }>;
    await expect.poll(async () => (await status()).status).toBe('completed');
    expect((await status()).result).toEqual(['A!', 'B!', 'C!']);
    expect((await status()).calls).toHaveLength(6);
    expect(peak).toBe(2);
    const before = calls.length;
    await host.call('fixture-runtime.workflow.control', { runId: started.runId, action: 'restart' }, context);
    await expect.poll(async () => (await status()).status).toBe('completed');
    expect(calls).toHaveLength(before);
    await host.call('fixture-runtime.workflow.run', { ...input, resume: started.runId, source: `await phase('Check'); return pipeline(['a', 'z'], item => agent(item, { model: 'haiku' }));` }, context);
    await expect.poll(async () => (await status()).status).toBe('completed');
    expect(calls.slice(before)).toEqual(['z']);
    expect(host.listPanes(context)).toHaveLength(0);
    controller.abort(); host.dispose();
  }, 20_000);

  it('preserves pipeline inputs and isolates failed branches with Claude workflow metadata', async () => {
    const entry = path.resolve(__dirname, '../../../../core-plugins/kimi-workflow/runtime/index.ts');
    const host = await makeHost(`export { register } from ${JSON.stringify(entry)};`, true, 'claude-mods');
    const controller = new AbortController();
    const context = { cwd: root, sessionId: 'workflow-branches', agentId: 'main' };
    host.bindContext({ context, signal: controller.signal, activities: () => [], output: async () => '', runProcess: async () => { throw new Error('Unexpected process'); }, runAgent: async (options) => {
      if (options.prompt === 'bad') throw new Error('Worker failed');
      return { agentId: 'worker', taskId: 'task', text: options.prompt.toUpperCase() };
    } });
    const { runId } = await host.call('fixture-runtime.workflow.run', { source: `
      export const meta = { name: 'branches', description: 'Review files', phases: [{ title: 'Review', detail: 'One worker per file', model: 'haiku' }] };
      await phase('Review');
      const piped = await pipeline(['a', 'bad', 'c'],
        item => agent(item, { model: 'haiku' }),
        (value, originalItem, index) => originalItem + ':' + index + ':' + value);
      const joined = await parallel([
        () => agent('left', { model: 'haiku' }),
        () => { throw new Error('Branch failed'); },
        () => agent('right', { model: 'haiku' }),
      ]);
      return { piped, joined };
    ` }, context) as { runId: string };
    const status = async () => host.call('fixture-runtime.workflow.status', { runId }, context) as Promise<{ status: string; result: unknown; phases: unknown[]; calls: { status: string; error?: string }[]; logs: string[] }>;
    await expect.poll(async () => (await status()).status).toBe('completed');
    const result = await status();
    expect(result.result).toEqual({ piped: ['a:0:A', null, 'c:2:C'], joined: ['LEFT', null, 'RIGHT'] });
    expect(result.phases).toEqual([{ name: 'Review', description: 'One worker per file', model: 'haiku' }]);
    expect(result.calls.filter(call => call.status === 'failed')).toMatchObject([{ error: 'Worker failed' }]);
    expect(result.logs).toContain('Branch failed: Worker failed');
    expect(result.logs).toContain('Branch failed: Branch failed');
    const direct = await host.call('fixture-runtime.workflow.run', { source: `return agent('bad', { model: 'haiku' });` }, context) as { runId: string };
    await expect.poll(async () => (await host.call('fixture-runtime.workflow.status', { runId: direct.runId }, context) as { status: string }).status).toBe('failed');
    for (const source of [
      `return parallel([() => agent('bad', { model: 'haiku' })], { failFast: true });`,
      `return pipeline(['bad'], item => agent(item, { model: 'haiku' }), { failFast: true });`,
    ]) {
      const strict = await host.call('fixture-runtime.workflow.run', { source }, context) as { runId: string };
      await expect.poll(async () => (await host.call('fixture-runtime.workflow.status', { runId: strict.runId }, context) as { status: string }).status).toBe('failed');
    }
    controller.abort(); host.dispose();
  });

  it('requires explicit inputs for workflow time and randomness', async () => {
    const entry = path.resolve(__dirname, '../../../../core-plugins/kimi-workflow/runtime/index.ts');
    const host = await makeHost(`export { register } from ${JSON.stringify(entry)};`, true, 'claude-mods');
    const controller = new AbortController();
    const context = { cwd: root, sessionId: 'workflow-determinism', agentId: 'main' };
    host.bindContext({ context, signal: controller.signal, activities: () => [], output: async () => '', runProcess: async () => { throw new Error('Unexpected process'); }, runAgent: async () => { throw new Error('Unexpected agent'); } });
    for (const expression of ['Date.now()', 'new Date()', 'Date()', 'Math.random()', 'globalThis.Date.now()', 'new Date.prototype.constructor()']) {
      const { runId } = await host.call('fixture-runtime.workflow.run', { source: `return ${expression};` }, context) as { runId: string };
      const status = async () => host.call('fixture-runtime.workflow.status', { runId }, context) as Promise<{ status: string; error: string }>;
      await expect.poll(async () => (await status()).status).toBe('failed');
      expect((await status()).error).toContain('must be passed through args');
    }
    const { runId } = await host.call('fixture-runtime.workflow.run', { source: 'return [new Date(args.time).toISOString(), Date.parse(args.time), Math.floor(1.5)];', args: { time: '2026-01-01T00:00:00.000Z' } }, context) as { runId: string };
    const status = async () => host.call('fixture-runtime.workflow.status', { runId }, context) as Promise<{ status: string; result: unknown }>;
    await expect.poll(async () => (await status()).status).toBe('completed');
    expect((await status()).result).toEqual(['2026-01-01T00:00:00.000Z', 1767225600000, 1]);
    controller.abort(); host.dispose();
  });

  it('reconstructs incremental workflow journals and replays them after a host restart', async () => {
    const entry = path.resolve(__dirname, '../../../../core-plugins/kimi-workflow/runtime/index.ts');
    const module = `export { register } from ${JSON.stringify(entry)};`;
    let host = await makeHost(module, true, 'claude-mods');
    const controller = new AbortController();
    const context = { cwd: root, sessionId: 'workflow-journal', agentId: 'main' };
    let calls = 0;
    const adapter = { context, signal: controller.signal, activities: () => [], output: async () => '', runProcess: async () => { throw new Error('Unexpected process'); }, runAgent: async (options: import('#/app/plugin/runtime').RuntimeAgentOptions) => { calls++; return { agentId: 'worker', taskId: 'task', text: options.prompt }; } };
    host.bindContext(adapter);
    const source = `return agent('journal-value', { model: 'haiku' });`;
    const { runId } = await host.call('fixture-runtime.workflow.run', { source }, context) as { runId: string };
    const status = async () => host.call('fixture-runtime.workflow.status', { runId }, context) as Promise<{ status: string; result: unknown }>;
    await expect.poll(async () => (await status()).status).toBe('completed');
    host.dispose();
    host = await makeHost(module, true, 'claude-mods');
    host.bindContext(adapter);
    expect(await status()).toMatchObject({ status: 'completed', result: 'journal-value' });
    await host.call('fixture-runtime.workflow.run', { source, resume: runId }, context);
    await expect.poll(async () => (await status()).status).toBe('completed');
    expect(calls).toBe(1);
    const dir = path.join(storeRoot, 'plugin-runtime');
    const logs = (await readdir(dir)).filter(file => file.endsWith('.jsonl'));
    expect(logs).toHaveLength(1);
    const entries = (await readFile(path.join(dir, logs[0]!), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.metadata.source !== undefined)).toHaveLength(2);
    expect(entries.length).toBeGreaterThan(2);
    controller.abort(); host.dispose();
  });

  it('shares the token budget across workers and stops scheduling when exhausted', async () => {
    const entry = path.resolve(__dirname, '../../../../core-plugins/kimi-workflow/runtime/index.ts');
    const host = await makeHost(`export { register } from ${JSON.stringify(entry)};`, true, 'claude-mods');
    const controller = new AbortController();
    const context = { cwd: root, sessionId: 'workflow-budget', agentId: 'main' };
    let calls = 0;
    host.bindContext({ context, signal: controller.signal, activities: () => [], output: async () => '', runProcess: async () => { throw new Error('Unexpected process'); }, runAgent: async () => {
      calls++;
      return { agentId: 'worker', taskId: 'task', text: 'ok', usage: { input: 10, output: 6 } };
    } });
    const { runId } = await host.call('fixture-runtime.workflow.run', { tokenBudget: 10, source: `await agent('one', { model: 'haiku' }); await agent('two', { model: 'haiku' }); return agent('three', { model: 'haiku' });` }, context) as { runId: string };
    const status = async () => host.call('fixture-runtime.workflow.status', { runId }, context) as Promise<{ status: string; tokensSpent: number; error?: string }>;
    await expect.poll(async () => (await status()).status).toBe('failed');
    expect(calls).toBe(2);
    expect(await status()).toMatchObject({ tokensSpent: 12, error: expect.stringContaining('budget exceeded') });
    const unlimited = await host.call('fixture-runtime.workflow.run', { source: 'return [budget.total, budget.spent(), budget.remaining() === Infinity];' }, context) as { runId: string };
    await expect.poll(async () => (await host.call('fixture-runtime.workflow.status', { runId: unlimited.runId }, context) as { status: string }).status).toBe('completed');
    expect(await host.call('fixture-runtime.workflow.status', { runId: unlimited.runId }, context)).toMatchObject({ result: [null, 0, true] });
    controller.abort(); host.dispose();
  });

  it('holds matching workers until their shared prefix starts responding', async () => {
    const entry = path.resolve(__dirname, '../../../../core-plugins/kimi-workflow/runtime/index.ts');
    const host = await makeHost(`export { register } from ${JSON.stringify(entry)};`, true, 'claude-mods');
    const controller = new AbortController();
    const context = { cwd: root, sessionId: 'workflow-prefix', agentId: 'main' };
    const started: string[] = [];
    const completions: (() => void)[] = [];
    let response: (() => void) | undefined;
    host.bindContext({ context, signal: controller.signal, activities: () => [], output: async () => '', runProcess: async () => { throw new Error('Unexpected process'); }, runAgent: async options => {
      started.push(options.prompt);
      if (started.length === 1) response = () => options.onProgress?.({ model: options.model, toolCalls: 0, elapsedMs: 1, firstResponseAt: Date.now() });
      await new Promise<void>(resolve => { completions.push(resolve); });
      return { agentId: 'worker', taskId: 'task', text: options.prompt };
    } });
    const { runId } = await host.call('fixture-runtime.workflow.run', { concurrency: 2, prefixStaggerMs: 5000, source: `return parallel(['one', 'two'].map(prompt => () => agent(prompt, { model: 'haiku' })));` }, context) as { runId: string };
    await expect.poll(() => started).toEqual(['one']);
    response!();
    await expect.poll(() => started).toEqual(['one', 'two']);
    completions.forEach(resolve => { resolve(); });
    await expect.poll(async () => (await host.call('fixture-runtime.workflow.status', { runId }, context) as { status: string }).status).toBe('completed');
    controller.abort(); host.dispose();
  });

});

describe('isolated runtime scripts', () => {
  it('accepts required pattern properties and rejects impossible closed result schemas', async () => {
    expect(() => new RuntimeStructuredOutput({ type: 'object', required: ['missing'], additionalProperties: false })).toThrow('forbids required property');
    const tool = new RuntimeStructuredOutput({ type: 'object', patternProperties: { '^item_': { type: 'integer' } }, required: ['item_count'], additionalProperties: false });
    expect(tool.resolveExecution({ item_count: 'invalid' })).toMatchObject({ isError: true });
    const execution = tool.resolveExecution({ item_count: 2 });
    if (execution.isError === true) throw new Error('Valid structured result was rejected');
    await execution.execute({ turnId: 0, toolCallId: 'result', signal: new AbortController().signal });
    expect(tool.result()).toEqual({ item_count: 2 });
  });
  it('bridges asynchronous JSON values without exposing Node globals', async () => {
    const result = await runRuntimeScript({ source: "return [typeof process, typeof require, typeof fetch, await host('twice', 4)];", invoke: async (_method, value) => Number(value) * 2 });
    expect(result).toEqual(['undefined', 'undefined', 'undefined', 8]);
  });
  it('interrupts loops and supports cancellation while awaiting the host', async () => {
    await expect(runRuntimeScript({ source: 'while (true) {}', invoke: async () => null, timeoutMs: 50 })).rejects.toThrow();
    const controller = new AbortController();
    const run = runRuntimeScript({ source: "return host('wait', null);", signal: controller.signal, invoke: () => new Promise(() => {}) });
    setTimeout(() => controller.abort(new Error('test stop')), 20);
    await expect(run).rejects.toThrow('test stop');
  });
});
