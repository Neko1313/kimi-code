import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { parseManifest } from '#/app/plugin/manifest';
import { PluginRuntimeHost } from '#/app/plugin/runtimeHost';
import { readAncestors } from '#/app/plugin/runtimeFs';
import type { RuntimeContext, RuntimePromptContext } from '#/app/plugin/runtime';
import { PLUGIN_RUNTIME_FLAG_ID } from '#/app/plugin/runtimeFlag';
import { stubPluginService } from './stubs';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubFlag } from '../flag/stubs';
import { stubLog } from '../../_base/log/stubs';
import { stubConfigService } from '../config/stubs';

const original = process.env['CLAUDE_MOD_FIXTURE'];
const fs = new HostFileSystem();
const paths = { ...path.posix, separator: '/' as const, delimiter: ':' as const };

describe.runIf(original)('original Anthropic agents-md', () => {
  let root: string;
  let host: PluginRuntimeHost | undefined;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'original-mod-')); });
  afterEach(async () => { host?.dispose(); await rm(root, { recursive: true, force: true }); });

  async function load(mode = 'claude-md-or-agents-md'): Promise<PluginRuntimeHost> {
    const parsed = await parseManifest(original!);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.manifestKind).toBe('claude-plugin-dir');
    const plugins = stubPluginService({ sessionStarts: [], summaries: [{ id: 'agents-md', enabled: true, state: 'ok' }] });
    plugins.getPluginInfo = async () => ({ id: 'agents-md', root: original!, manifest: parsed.manifest }) as never;
    const log = stubLog();
    log.warn = (text, detail) => { throw new Error(text + ': ' + JSON.stringify(detail, (_key, value) => value instanceof Error ? value.message : value)); };
    host = new PluginRuntimeHost(plugins, stubFlag(id => id === PLUGIN_RUNTIME_FLAG_ID), log, stubBootstrap(root), stubConfigService({ pluginRuntime: { options: { 'agents-md': { instructionFiles: mode } } } }));
    await host.ready;
    return host;
  }

  function bind(host: PluginRuntimeHost, sessionId = 'example', cwd = root, agentId = 'main', variables: Record<string, string> = {}): RuntimeContext {
    const context = { sessionId, agentId, cwd };
    host.bindContext({ context, signal: new AbortController().signal, activities: () => [], output: async () => '', runAgent: async () => { throw new Error('Unexpected agent'); }, runProcess: async () => { throw new Error('Unexpected process'); }, sessionPath: async () => cwd, getEnv: async name => variables[name], ancestors: input => readAncestors(input, { fs, path: paths, cwd, home: root, canRead: async () => true }) });
    return context;
  }

  const compose = (host: PluginRuntimeHost, context: RuntimeContext, files: RuntimePromptContext['instructionFiles'] = []) => host.invoke('prompt.context', { blocks: [{ name: 'claudeMd', text: '' }], instructionFiles: files }, context, e => e) as Promise<RuntimePromptContext>;
  const read = (host: PluginRuntimeHost, context: RuntimeContext, file: string) => host.invoke('tool.call', { tool: 'Read', file_path: file, agentId: context.agentId === 'main' ? undefined : context.agentId }, context, () => ({ result: 'file content' })) as Promise<{ context?: string[] }>;

  it('loads its original manifest, follows imports and frames project instructions', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), '# Project\n@extra.md\n');
    await writeFile(path.join(root, 'extra.md'), '# Imported\n');
    const runtime = await load();
    expect(await readAncestors({ names: ['AGENTS.md'] }, { fs, path: paths, cwd: root, home: root, canRead: async () => true })).toHaveLength(1);
    const result = await compose(runtime, bind(runtime));
    expect(result.instructionFiles?.map(file => file.path)).toEqual([path.join(root, 'AGENTS.md'), path.join(root, 'extra.md')]);
    expect(result.instructionFiles?.[1]?.parent).toBe(path.join(root, 'AGENTS.md'));
    expect(result.blocks[0]?.text).toContain(`Contents of ${root}/AGENTS.md (project instructions, checked into the codebase):`);
  });

  it('honors fallback, both, managed-only and claude-only options', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), '# Project');
    await writeFile(path.join(root, 'CLAUDE.md'), '# Claude');
    let runtime = await load();
    expect((await compose(runtime, bind(runtime))).instructionFiles).toEqual([]);
    runtime.dispose();
    runtime = await load('claude-md-and-agents-md');
    expect((await compose(runtime, bind(runtime))).instructionFiles).toHaveLength(1);
    runtime.dispose();
    runtime = await load('managed-only');
    const files = ['managed', 'user', 'project', 'local', 'memory'].map(kind => ({ path: `/${kind}.md`, content: kind, kind })) as NonNullable<RuntimePromptContext['instructionFiles']>;
    expect((await compose(runtime, bind(runtime), files)).instructionFiles?.map(file => file.kind)).toEqual(['managed', 'memory']);
    runtime.dispose();
    runtime = await load('claude-md');
    expect((await compose(runtime, bind(runtime), files)).instructionFiles).toEqual(files);
  });

  it('does not duplicate files already supplied by the native loader', async () => {
    const filename = path.join(root, 'AGENTS.md');
    await writeFile(filename, '# Native');
    const runtime = await load();
    const result = await compose(runtime, bind(runtime), [{ path: filename, content: '# Native', kind: 'project' }]);
    expect(result.instructionFiles).toHaveLength(1);
  });

  it('attaches nested instructions once per agent and inherits delivered files on forks', async () => {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/AGENTS.md'), '# Nested\n');
    const runtime = await load();
    const context = bind(runtime);
    await compose(runtime, context);
    expect((await read(runtime, context, 'src/file.ts')).context).toEqual([`Contents of ${root}/src/AGENTS.md:\n\n# Nested\n`]);
    expect((await read(runtime, context, 'src/file.ts')).context).toBeUndefined();
    await runtime.invoke('agent.spawn', { fork: true }, context, () => ({ agentId: 'forked', model: 'example-model' }));
    expect((await read(runtime, bind(runtime, 'example', root, 'forked'), 'src/file.ts')).context).toBeUndefined();
    expect((await read(runtime, bind(runtime, 'example', root, 'fresh'), 'src/file.ts')).context).toHaveLength(1);
  });

  it('isolates registration state between sessions in the same project', async () => {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/AGENTS.md'), '# Isolated');
    const runtime = await load();
    const first = bind(runtime, 'first');
    const second = bind(runtime, 'second');
    await compose(runtime, first);
    await read(runtime, first, 'src/file.ts');
    await compose(runtime, second);
    expect((await read(runtime, first, 'src/file.ts')).context).toBeUndefined();
    expect((await read(runtime, second, 'src/file.ts')).context).toHaveLength(1);
  });

  it('reads attachment switches on every Read and does not attach outside the root', async () => {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/AGENTS.md'), '# Nested');
    const runtime = await load();
    const variables: Record<string, string> = { CLAUDE_CODE_DISABLE_ATTACHMENTS: '1' };
    const context = bind(runtime, 'example', root, 'main', variables);
    await compose(runtime, context);
    expect((await read(runtime, context, 'src/file.ts')).context).toBeUndefined();
    delete variables['CLAUDE_CODE_DISABLE_ATTACHMENTS'];
    expect((await read(runtime, context, '/outside/file.ts')).context).toBeUndefined();
    expect((await read(runtime, context, 'src/file.ts')).context).toHaveLength(1);
  });
});

describe('runtime instruction filesystem', () => {
  it('checks imported paths and symlink targets and bounds a nested walk', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'instruction-fs-'));
    try {
      await mkdir(path.join(root, 'src'));
      await writeFile(path.join(root, 'AGENTS.md'), 'root');
      await writeFile(path.join(root, 'src/AGENTS.md'), 'nested @hidden.md @linked.md');
      await writeFile(path.join(root, 'src/hidden.md'), 'hidden');
      await writeFile(path.join(root, 'src/target.md'), 'target');
      await symlink(path.join(root, 'src/target.md'), path.join(root, 'src/linked.md'));
      const found = await readAncestors({ names: ['AGENTS.md'], of: 'src/file.ts', below: root }, { fs, path: paths, cwd: root, home: root, canRead: async filename => !filename.endsWith('/hidden.md') && !filename.endsWith('/target.md') });
      expect(found).toHaveLength(1);
      expect(found[0]?.parts).toHaveLength(1);
      expect(found[0]?.parts[0]?.path).toBe(path.join(root, 'src/AGENTS.md'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
