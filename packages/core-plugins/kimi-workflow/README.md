# Kimi workflow plugin

Native agent workflows with a durable per-session journal, a Workflow tool and an editor dialog. Enable the experimental runtime and install this directory:

```sh
KIMI_CODE_EXPERIMENTAL_PLUGIN_RUNTIME=1 kimi
```

Inside the CLI:

```text
/plugins install /absolute/path/to/packages/core-plugins/kimi-workflow
/plugins install /absolute/path/to/packages/core-plugins/kimi-workflow-ui
/workflows
```

Both plugins must be enabled in `/plugins`. Load `/skill:kimi-workflow:workflow` for the agent instructions. The runtime executes trusted plugin modules with the user's privileges. Generated workflow scripts run separately in QuickJS with a JSON host bridge, a 64 MiB heap, bounded execution slices, and a 24-hour wall deadline.

The model calls the `Workflow` tool directly with `{ source, name?, args?, concurrency? }`. Workers run through the current session's native subagent service, with inherited permissions and explicit model selection. The plugin does not spawn CLI workers. If the tool is unavailable, enable the runtime and plugin instead of launching another CLI process.

SDK callers can use the same native backend:

```ts
const { runId } = await session.plugins.call({
  method: 'kimi-workflow.workflow.run',
  input: {
    name: 'Review',
    concurrency: 4,
    source: `await phase('Review'); return pipeline(args.files, file => agent('Review ' + file, { model: 'haiku', label: file }));`,
    args: { files: ['src/example.ts', 'src/other.ts'] },
  },
}) as { runId: string };

const status = await session.plugins.call({
  method: 'kimi-workflow.workflow.status', input: { runId },
});
```

`haiku` must be a configured model alias listed in `[secondary_model.models]`; the engine does not silently inherit a model. See [the workflow skill](./SKILL.md) for scripts, controls, limits, and replay behavior.

Pipeline stages receive `(previousResult, originalItem, index)`. Failed branches return `null` with an error in the run log while other items continue; pass `{ failFast: true }` as the final helper argument to retain immediate failure. Phase metadata accepts `{ title, detail?, model }` as well as `{ name, description?, model }`. Pass time and random seeds through `args`; implicit time and `Math.random()` are unavailable during a workflow so resumed calls remain reproducible.

Runs are native background tasks, linked to their initiating tool call. Completion delivers the final result through the normal task notification; stopping the native task cancels its workers. Structured workers use a validated `StructuredOutput` tool and correct invalid answers in the same context. The journal appends changed metadata and calls, reconstructs completed runs after restart, and still reads earlier snapshot records.

Optional `tokenBudget` shares an output-token target across the run; `budget.total`, `budget.spent()` and `budget.remaining()` are available in scripts. Request limits and reported usage stop further work after exhaustion; asynchronous reporting can allow in-flight requests to exceed the target. Missing usage fails explicitly. `prefixStaggerMs` controls the shared prefix warm-up wait (default 5000, 0 disables).

The backend exposes the `workflow` noun through `engine.create` and runs headless. The optional `kimi-workflow-ui` plugin supplies `/workflows`, phase/agent columns, full output, controls and a replacement for `/tasks`. It uses the Claude Mods element/state contract; see [adapter coverage and plan](../../node-sdk/PLUGIN_MODS.md).

Run `/workflows` to open the live phase/agent view in the editor slot, using the same dialog host as `/model`. The transcript keeps its full width. Tab switches controls, arrows navigate, and Enter on an agent opens its native transcript in fullscreen mode. PgUp/PgDn scroll and Ctrl-O expands thinking and tool results. Escape returns to the workflow dialog; cancelling the dialog restores the editor while background work continues. Back, filter, pause/resume, stop and retry are buttons. Selection is scoped to each client. Disabling the UX plugin restores the built-in tasks browser without changing workflow execution.

Pause queues new calls while existing workers finish. Stop aborts the run and workers. Restart reuses a matching completed journal prefix, then reruns the suffix. Script code must await all launched helpers. Edits and external side effects cannot be rolled back. Session shutdown and plugin reload abort running work; a saved interrupted run needs an explicit restart. The journal is bounded to 1000 calls per run, but historical runs remain until plugin data is removed.

Legacy JSON process-plan commands and `.kimi-workflow/pending.json` dispatch are no longer entry points. Use the Workflow tool or `session.plugins.call()` for native execution.
