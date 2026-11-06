import type { PluginCommandDef, RuntimeCommand } from '@moonshot-ai/kimi-code-sdk';

import type { KimiSlashCommand } from './types';

export interface PluginSlashCommands {
  readonly commands: readonly KimiSlashCommand[];
  /** Maps a namespaced command name (`plugin:command`) to its markdown body. */
  readonly commandMap: ReadonlyMap<string, string>;
}

export function pluginCommandName(pluginId: string, name: string): string {
  return `${pluginId}:${name}`;
}

export function buildPluginSlashCommands(defs: readonly PluginCommandDef[]): PluginSlashCommands {
  const commandMap = new Map<string, string>();
  const commands = defs.map((def) => {
    const commandName = pluginCommandName(def.pluginId, def.name);
    commandMap.set(commandName, def.body);
    return {
      name: commandName,
      aliases: [],
      description: def.description,
    } satisfies KimiSlashCommand;
  });
  return { commands, commandMap };
}

export function buildRuntimeSlashCommands(defs: readonly RuntimeCommand[], reserved: readonly KimiSlashCommand[]): readonly KimiSlashCommand[] {
  const occupied = new Set(reserved.flatMap(command => [command.name, ...(command.aliases ?? [])]));
  const counts = new Map<string, number>();
  for (const command of defs) {
    const short = command.name.split(':').at(-1)!;
    counts.set(short, (counts.get(short) ?? 0) + 1);
  }
  return defs.filter(command => !occupied.has(command.name)).map(command => {
    const short = command.name.split(':').at(-1)!;
    const useShort = counts.get(short) === 1 && !occupied.has(short);
    return { name: useShort ? short : command.name, aliases: useShort ? [command.name] : [], description: command.description };
  });
}
