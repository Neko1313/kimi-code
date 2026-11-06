import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import type { Register } from './mods';
// oxlint-disable-next-line import/default, import/extensions
import stateHelpers from './modsState.ts?raw';

export async function loadModsModule(filename: string, home: string): Promise<{ register: Register }> {
  const directory = path.join(home, 'plugin-runtime', 'modules');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const helpers = `export function h(type, props, ...children) {
    const flat = children.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false);
    return typeof type === 'function' ? type({...props, children: flat}) : {type, props: props || {}, children: flat};
  }
  export function Fragment({children}) { return {type: 'Box', props: {flexDirection: 'column'}, children}; }
  ${stateHelpers}`;
  const result = await build({ entryPoints: [filename], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24',
    tsconfigRaw: { compilerOptions: { target: 'ESNext', useDefineForClassFields: true } },
    jsxFactory: 'h', jsxFragment: 'Fragment', inject: ['kimi-mods:jsx'],
    plugins: [{ name: 'kimi-mods', setup(builder) {
      builder.onResolve({ filter: /^(claude-code|kimi-mods:jsx)$/ }, () => ({ path: 'helpers', namespace: 'kimi-mods' }));
      builder.onLoad({ filter: /.*/, namespace: 'kimi-mods' }, () => ({ contents: helpers, loader: 'ts' }));
    } }],
  });
  const destination = path.join(directory, `${randomUUID()}.mjs`);
  await writeFile(destination, result.outputFiles[0]!.contents, { mode: 0o600 });
  return import(pathToFileURL(destination).href);
}
