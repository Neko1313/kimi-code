import { describe, expect, it } from 'vitest';

import { buildPluginSlashCommands, buildRuntimeSlashCommands, pluginCommandName } from '#/tui/commands/plugin-commands';

describe('pluginCommandName', () => {
  it('namespaces a command with its plugin id', () => {
    expect(pluginCommandName('my-plugin', 'deploy')).toBe('my-plugin:deploy');
  });
});

describe('buildRuntimeSlashCommands', () => {
  it('suggests unambiguous short names and keeps qualified aliases searchable', () => {
    expect(buildRuntimeSlashCommands([{ name: 'example-ui:workflows', pluginId: 'example-ui', description: 'Browse workflows' }], [])).toEqual([
      { name: 'workflows', aliases: ['example-ui:workflows'], description: 'Browse workflows' },
    ]);
  });

  it('keeps qualified names for ambiguous or reserved names', () => {
    const commands = ['first:workflows', 'second:workflows', 'first:tasks', 'first:w'].map(name => ({ name, pluginId: name.split(':')[0]!, description: name }));
    expect(buildRuntimeSlashCommands(commands, [{ name: 'tasks', aliases: ['w'], description: 'Tasks' }]).map(command => command.name)).toEqual(commands.map(command => command.name));
  });
});

describe('buildPluginSlashCommands', () => {
  it('namespaces commands and maps them to their bodies', () => {
    const { commands, commandMap } = buildPluginSlashCommands([
      {
        pluginId: 'my-plugin',
        name: 'deploy',
        description: 'Deploy',
        body: 'Deploy $ARGUMENTS',
        path: '/p/deploy.md',
      },
    ]);
    expect(commands).toEqual([{ name: 'my-plugin:deploy', aliases: [], description: 'Deploy' }]);
    expect(commandMap.get('my-plugin:deploy')).toBe('Deploy $ARGUMENTS');
  });

  it('returns empty commands for no defs', () => {
    const { commands, commandMap } = buildPluginSlashCommands([]);
    expect(commands).toEqual([]);
    expect(commandMap.size).toBe(0);
  });
});
