import { instructionFileSchema, type InstructionFile } from '#/agent/profile/instructionFile';
import { renderInstructionFiles } from '#/agent/profile/instructionPrompt';
import type { ModsEvent } from './mods';

export function synchronizePromptContext(previous: ModsEvent, result: ModsEvent): ModsEvent {
  if (result === null || typeof result !== 'object') throw new Error('Invalid prompt.context result');
  const blocks = result['blocks'] ?? previous['blocks'];
  if (!Array.isArray(blocks) || blocks.some(block => block === null || typeof block !== 'object' || typeof block.name !== 'string' || typeof block.text !== 'string') || new Set(blocks.map(block => block.name)).size !== blocks.length) throw new Error('Invalid prompt context blocks');
  let files = result['instructionFiles'] ?? previous['instructionFiles'];
  if (files !== undefined && (!Array.isArray(files) || files.some(file => !instructionFileSchema.safeParse(file).success))) throw new Error('Invalid instruction files');
  const oldBlocks = previous['blocks'] as { name: string; text: string }[] | undefined;
  const before = oldBlocks?.find(block => block.name === 'claudeMd')?.text;
  const after = blocks.find(block => block.name === 'claudeMd')?.text;
  const changedFiles = result['instructionFiles'] !== undefined && JSON.stringify(result['instructionFiles']) !== JSON.stringify(previous['instructionFiles']);
  if (changedFiles) {
    const previousFiles = previous['instructionFiles'] as InstructionFile[] | undefined;
    files = (files as InstructionFile[]).map(file => {
      const before = previousFiles?.find(item => item.path === file.path && item.kind === 'managed' && item.content === file.content && item.parent === file.parent);
      return file.kind !== 'managed' ? file : { ...file, isUnverified: before === undefined || before.isUnverified === true ? true : undefined };
    });
    const text = renderInstructionFiles(files as InstructionFile[]);
    const next = blocks.filter(block => block.name !== 'claudeMd');
    const index = blocks.findIndex(block => block.name === 'claudeMd');
    next.splice(Math.max(0, index), 0, { name: 'claudeMd', text });
    return { ...result, blocks: next, instructionFiles: files };
  }
  if (before !== after) files = undefined;
  return { ...result, blocks, instructionFiles: files };
}

export function freezeEvent<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeEvent(child);
    Object.freeze(value);
  }
  return value;
}
