import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PluginRuntimeHost } from '#/app/plugin/runtimeHost';
import { PLUGIN_RUNTIME_FLAG_ID } from '#/app/plugin/runtimeFlag';
import type { PluginInfo } from '#/app/plugin/types';

import { stubFlag } from '../flag/stubs';
import { stubLog } from '../../_base/log/stubs';
import { stubPluginService } from './stubs';

async function writeFixturePlugin(root: string, moduleSource: string): Promise<void> {
  await mkdir(path.join(root, 'runtime'), { recursive: true });
  await writeFile(
    path.join(root, 'kimi.plugin.json'),
    JSON.stringify({
      name: 'fixture-runtime',
      version: '0.0.1',
      runtime: {
        modules: ['./runtime/index.ts'],
        capabilities: ['events', 'store', 'log', 'clock'],
      },
    }),
  );
  await writeFile(path.join(root, 'runtime', 'index.ts'), moduleSource);
}

function stubPluginInfo(root: string): PluginInfo {
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
        modules: ['./runtime/index.ts'],
        capabilities: ['events', 'store', 'log', 'clock'],
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
    delete process.env['KIMI_CODE_HOME'];
    await rm(root, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
  });

  async function makeHost(moduleSource: string, enabled = true): Promise<PluginRuntimeHost> {
    await writeFixturePlugin(root, moduleSource);
    const plugins = stubPluginService({
      enabledPluginIds: ['fixture-runtime'],
      sessionStarts: [],
      summaries: [{ id: 'fixture-runtime', enabled: true, state: 'ok' }],
    });
    plugins.getPluginInfo = async () => stubPluginInfo(root);
    const host = new PluginRuntimeHost(
      plugins,
      stubFlag((id: string) => (id === PLUGIN_RUNTIME_FLAG_ID ? enabled : false)),
      stubLog(),
    );
    await host.ready;
    return host;
  }

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

  it('runs the kimi-workflow plugin end to end', async () => {
    const pluginRoot = path.resolve(__dirname, '../../../../core-plugins/kimi-workflow');
    const plugins = stubPluginService({
      enabledPluginIds: ['kimi-workflow'],
      sessionStarts: [],
      summaries: [{ id: 'kimi-workflow', enabled: true, state: 'ok' }],
    });
    plugins.getPluginInfo = async () =>
      ({
        id: 'kimi-workflow',
        displayName: 'kimi-workflow',
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
        root: pluginRoot,
        diagnostics: [],
        skills: [],
        mcpServers: [],
        manifest: {
          name: 'kimi-workflow',
          runtime: {
            modules: ['./runtime/index.ts'],
            capabilities: ['events', 'log', 'store', 'process', 'clock'],
          },
        },
      }) as PluginInfo;
    const warnings: string[] = [];
    const baseLog = stubLog();
    const host = new PluginRuntimeHost(
      plugins,
      stubFlag((id: string) => id === PLUGIN_RUNTIME_FLAG_ID),
      {
        ...baseLog,
        warn: (msg: string, extra?: unknown) => {
          warnings.push(`${msg} ${JSON.stringify(extra)}`);
          baseLog.warn(msg, extra);
        },
      },
    );
    await host.ready;
    if (!host.hasHandlers('UserPromptSubmit')) {
      throw new Error(`workflow plugin failed to load: ${warnings.join(' | ')}`);
    }

    const plan = JSON.stringify({
      name: 'e2e',
      stages: [
        {
          id: 'check',
          type: 'fanout',
          items: ['a.txt', 'b.txt'],
          worker: { command: 'echo', argsTemplate: ['checking', '{{item}}'] },
        },
      ],
    });
    const results = await host.dispatch('UserPromptSubmit', {
      cwd: root,
      matcherValue: `workflow run ${plan}`,
      data: { prompt: `workflow run ${plan}` },
    });

    expect(results.length).toBe(1);
    expect(results[0]?.action).toBe('block');
    expect(results[0]?.reason).toContain('workflow "e2e": completed');
    expect(results[0]?.reason).toContain('stage check: 2/2 ok');
    const stored = JSON.parse(
      await readFile(path.join(storeRoot, 'plugin-runtime', 'kimi-workflow.json'), 'utf8'),
    ) as Record<string, unknown>;
    const runs = stored['workflow.e2e.runs'] as Array<{ item: string; exitCode: number }>;
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.exitCode === 0)).toBe(true);
  }, 20_000);

  it('runs a pending plan from .kimi-workflow/pending.json on Stop', async () => {
    const pluginRoot = path.resolve(__dirname, '../../../../core-plugins/kimi-workflow');
    const plugins = stubPluginService({
      enabledPluginIds: ['kimi-workflow'],
      sessionStarts: [],
      summaries: [{ id: 'kimi-workflow', enabled: true, state: 'ok' }],
    });
    plugins.getPluginInfo = async () =>
      ({
        id: 'kimi-workflow',
        displayName: 'kimi-workflow',
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
        root: pluginRoot,
        diagnostics: [],
        skills: [],
        mcpServers: [],
        manifest: {
          name: 'kimi-workflow',
          runtime: {
            modules: ['./runtime/index.ts'],
            capabilities: ['events', 'log', 'store', 'process', 'clock'],
          },
        },
      }) as PluginInfo;
    const host = new PluginRuntimeHost(
      plugins,
      stubFlag((id: string) => id === PLUGIN_RUNTIME_FLAG_ID),
      stubLog(),
    );
    await host.ready;

    const pendingDir = path.join(root, '.kimi-workflow');
    await mkdir(pendingDir, { recursive: true });
    await writeFile(
      path.join(pendingDir, 'pending.json'),
      JSON.stringify({
        name: 'from-agent',
        stages: [
          {
            id: 'scan',
            type: 'fanout',
            items: ['one.txt', 'two.txt'],
            worker: { command: 'echo', argsTemplate: ['scan', '{{item}}'] },
          },
        ],
      }),
    );

    const results = await host.dispatch('Stop', { cwd: root });
    expect(results.length).toBe(1);
    expect(results[0]?.action).toBe('block');
    expect(results[0]?.reason).toContain('workflow "from-agent": completed');
    expect(results[0]?.reason).toContain('stage scan: 2/2 ok');

    const gone = await host.dispatch('Stop', { cwd: root });
    expect(gone).toEqual([]);
  }, 20_000);
});
