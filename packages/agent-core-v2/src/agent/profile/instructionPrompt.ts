import { randomUUID } from 'node:crypto';
import { renderAgentProfilePrompt } from '#/app/agentProfileCatalog/profile-shared';
import type { AgentProfile, AgentProfileContext } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { splitAgentsMdFiles } from './context';
import type { InstructionFile, InstructionPrompt } from './instructionFile';

export function prepareInstructionPrompt(profile: AgentProfile, context: AgentProfileContext & { agentsMdPaths?: readonly string[] }, userRoots: readonly string[]): InstructionPrompt | undefined {
  if (context.agentsMdPaths === undefined) return undefined;
  const marker = `kimi-instruction-slot:${randomUUID()}`;
  const template = renderAgentProfilePrompt(profile, { ...context, agentsMd: marker }).text;
  const [prefix, suffix, extra] = template.split(marker);
  if (suffix === undefined || extra !== undefined) return undefined;
  const files = [...splitAgentsMdFiles(context.agentsMd ?? '', context.agentsMdPaths)].map(([path, content]): InstructionFile => ({ path, content, kind: userRoots.some(root => path.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + '/')) ? 'user' : 'project' }));
  return { files, prefix: prefix!, suffix, empty: renderAgentProfilePrompt(profile, { ...context, agentsMd: '' }).text };
}

export function renderInstructionFiles(files: readonly InstructionFile[]): string {
  const labels = { managed: 'organization instructions', user: 'private global instructions', project: 'project instructions, checked into the codebase', local: 'private project instructions', memory: 'memory' };
  return files.map(file => `Contents of ${file.path} (${labels[file.kind]}):\n\n${file.content}`).join('\n\n');
}
