import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const commit = '26382c08758260c9f5deb2019d8fe851f89fa9ae';
const repo = resolve(import.meta.dirname, '../../..');
const cache = join(repo, '.tmp', 'claude-mod-compat', commit);
const local = process.argv[2];
const fixture = local === undefined ? join(cache, 'mods/agents-md') : resolve(local);
const files = [];
if (local === undefined) {
  const response = await fetch(`https://api.github.com/repos/anthropics/claude-code/git/trees/${commit}?recursive=1`);
  if (!response.ok) throw new Error(`Upstream tree request failed: ${response.status}`);
  const tree = (await response.json()).tree.filter(entry => entry.type === 'blob' && entry.path.startsWith('mods/agents-md/'));
  let cursor = 0;
  const digest = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < tree.length) {
      const entry = tree[cursor++];
      const filename = join(cache, entry.path);
      let bytes;
      try { bytes = await readFile(filename); } catch {}
      if (bytes === undefined || digest(bytes) !== entry.sha) {
        const result = await fetch(`https://raw.githubusercontent.com/anthropics/claude-code/${commit}/${entry.path}`);
        if (!result.ok) throw new Error(`Upstream file request failed: ${result.status} ${entry.path}`);
        bytes = Buffer.from(await result.arrayBuffer());
        if (digest(bytes) !== entry.sha) throw new Error(`Upstream blob hash mismatch: ${entry.path}`);
        await mkdir(dirname(filename), { recursive: true });
        await writeFile(filename, bytes);
      }
      files.push({ filename, hash: digest(bytes) });
    }
  }));
  process.stdout.write(`Original agents-md: ${commit}, ${files.length} verified upstream files\n`);
}
const env = { ...process.env, CLAUDE_MOD_FIXTURE: fixture };
async function run(args) {
  await new Promise((resolveDone, reject) => {
    const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, { cwd: repo, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) { resolveDone(); return; }
      reject(new Error(`Compatibility tests exited with ${code}`));
    });
  });
}
await run(['--filter', '@moonshot-ai/agent-core-v2', 'exec', 'vitest', 'run', 'test/app/plugin/agentsMdCompatibility.test.ts']);
await run(['--filter', '@moonshot-ai/klient', 'exec', 'vitest', 'run', 'test/memory.test.ts', 'test/ipc.test.ts', '-t', 'runs the original agents-md']);
for (const file of files) {
  const bytes = await readFile(file.filename);
  const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (hash !== file.hash) throw new Error(`Upstream fixture changed during testing: ${file.filename}`);
}
