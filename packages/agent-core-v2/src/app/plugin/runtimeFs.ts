import type { EnvironmentPath } from '#/environment/environment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { isHostFsNotFound, isHostFsNotDirectory } from '#/os/interface/hostFsErrors';
import type { RuntimeFsAncestor, RuntimeFsAncestorPart, RuntimeFsAncestorsRequest } from './runtime';

export async function readAncestors(input: RuntimeFsAncestorsRequest, host: { fs: IHostFileSystem; path: EnvironmentPath; cwd: string; home: string; canRead: (path: string) => Promise<boolean> }): Promise<readonly RuntimeFsAncestor[]> {
  const { fs, path, cwd, home } = host;
  if (!Array.isArray(input.names) || input.names.length === 0 || input.names.length > 64 || input.names.some(name => typeof name !== 'string' || !/\.md$/i.test(name) || path.isAbsolute(name) || name.split(/[\\/]/).includes('..'))) throw new Error('ancestors.names must contain relative Markdown filenames');
  const absolute = (value: string, base = cwd): string => path.resolve(value === '~' ? home : value.startsWith('~/') || value.startsWith('~\\') ? path.join(home, value.slice(2)) : path.resolve(base, value));
  const target = input.of === undefined ? cwd : path.dirname(absolute(input.of));
  const below = input.below === undefined ? undefined : absolute(input.below);
  const isBelow = (candidate: string, base: string): boolean => {
    const relative = path.relative(base, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.separator) && !path.isAbsolute(relative);
  };
  if (below !== undefined && !isBelow(target, below)) return [];
  const directories: string[] = [];
  for (let dir = target; dir !== below; dir = path.dirname(dir)) {
    directories.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  const result: RuntimeFsAncestor[] = [];
  const visit = async (filename: string, seen: Set<string>, depth: number): Promise<RuntimeFsAncestorPart[]> => {
    if (depth > 16 || seen.size >= 128) throw new Error('Instruction imports exceed their depth or file limit');
    let real: string;
    try { real = await fs.realpath(filename); }
    catch (error) { if (isHostFsNotFound(error) || isHostFsNotDirectory(error)) return []; throw error; }
    if (seen.has(real) || !await host.canRead(filename) || real !== filename && !await host.canRead(real)) return [];
    seen.add(real);
    const stat = await fs.stat(real);
    if (!stat.isFile) return [];
    if (stat.size > 10_000_000) throw new Error('Instruction file exceeds 10 MB');
    const content = (await fs.readText(real, { errors: 'ignore' })).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replaceAll(/<!--[\s\S]*?-->/g, '');
    const parts: RuntimeFsAncestorPart[] = [{ path: filename, content }];
    const imports = content.replaceAll(/^(```|~~~)[\s\S]*?^\1.*$/gm, '').replaceAll(/`[^`\n]*`/g, '');
    for (const match of imports.matchAll(/(?:^|\s)@([^\s<>"'`]+\.md)\b/gm)) parts.push(...await visit(absolute(match[1]!, path.dirname(filename)), seen, depth + 1));
    return parts;
  };
  for (const dir of directories.toReversed()) for (const name of input.names) {
    const parts = await visit(path.join(dir, name), new Set(), 0);
    if (parts.length > 0) result.push({ dir, name, parts, content: parts.map(part => part.content).join('\n\n') });
  }
  return result;
}
