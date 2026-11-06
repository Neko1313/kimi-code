---
name: workflow
description: Run native agent workflows with parallel workers, pipelines, structured results, and a navigable workflow panel.
---

Call the `Workflow` tool directly with input `{ name, source, args?, concurrency? }`. The internal harness starts workers inside the current session. Never launch `kimi`, `claude`, `codex`, headless CLI workers, shell fan-out scripts, or a separate SDK harness to implement this workflow. Do not write `.kimi-workflow/pending.json` or issue `workflow run` commands. If `Workflow` is unavailable but `Plugin` exists, call `kimi-workflow.workflow.run` through `Plugin`; if neither exists, report that the experimental runtime or plugin is unavailable instead of using a shell fallback.

It returns `{ runId }` immediately; work continues in the background. Open `/workflows` to inspect runs or use `kimi-workflow.workflow.status` with `{ runId }` to read the durable journal. Do not poll in a tight loop.

The script is JavaScript with top-level `await` and `return`. It runs in an isolated interpreter, without Node.js, imports, filesystem, network, timers, or provider credentials. Helpers are `agent(prompt, options)`, `parallel(items)`, `pipeline(items, ...stages)`, `phase(name)`, `log(text)`, and JSON `args` supplied by the caller. Await helpers before returning. `parallel` is a barrier; `pipeline` advances each item as soon as its previous stage finishes. Each pipeline stage receives `(previousResult, originalItem, index)`. A failed branch returns `null`, logs its error and skips the item's remaining stages; independent branches continue. Check for `null` before consuming results. To stop the run on the first branch error, use `parallel(tasks, { failFast: true })` or `pipeline(items, stage1, stage2, { failFast: true })`.

Optional `export const meta` supplies the run's `name`, `description` and `phases`. Phase entries accept `{ title, detail?, model }`; the earlier `{ name, description?, model }` form also works. Every phase must explicitly specify its model. Match the phase title in `phase(title)`. Pass timestamps or random seeds through `args`: `Date.now()`, `Date()`, `new Date()` without arguments and `Math.random()` throw so the script can replay consistently. `new Date(args.timestamp)` remains available.

Every `agent()` requires an explicit configured model alias from `[secondary_model.models]`. If the pool is missing, ask the user to configure it; do not bypass the model policy. Follow project instructions for model roles. Where those aliases exist, use sonnet for planning and coverage criticism, haiku for narrow execution, and keep the main session responsible for synthesis. Give every worker a concrete goal, relevant paths, acceptance criteria, and a JSON `schema` when downstream code needs structured data. An agent returns its schema-validated value, or its final text when no schema is supplied. Workers have fresh contexts and inherit engine permissions.

With `schema`, the worker submits its result through `StructuredOutput`. Invalid objects are returned to that same worker for correction, up to five validation failures; contradictory closed-object schemas are rejected before the worker starts. Do not parse prose or fenced JSON in the orchestration script.

The run itself is a native background task. The tool returns its run id; completion delivers the final result through the session's ordinary task notification. Worker results remain in the journal and the run reports failed branches. Do not repeatedly poll the workflow or launch duplicate workers while waiting. Use the UI to inspect progress, or continue useful work until the completion notification arrives.

When the user requests an output-token target, pass it as `tokenBudget` in the tool input. The shared `budget` object exposes `total`, `spent()` and `remaining()` to the script; it reflects the latest reported usage when an agent returns. The host accounts live worker usage, caps individual requests, refuses new workers after exhaustion and cancels remaining work when reported usage exceeds the target. Providers report usage asynchronously, so concurrent requests already in flight can exceed the target. A provider that does not report output-token usage causes a budgeted run to fail explicitly. Never invent a budget the user did not request.

Matching workers share a prompt-cache warm-up gate keyed by model, profile, schema and working directory. Siblings wait for the first response or up to five seconds. `prefixStaggerMs: 0` disables the wait. The engine and provider retain control of actual cache hits.

Example `source` (replace model aliases with configured aliases when needed):

```js
await phase('Plan');
const plan = await agent('List the files that need review. Return tasks with path and goal.', {
  model: 'sonnet',
  schema: {
    type: 'object',
    properties: { tasks: { type: 'array', maxItems: 8, items: {
      type: 'object', properties: { path: { type: 'string' }, goal: { type: 'string' } }, required: ['path', 'goal']
    } } }, required: ['tasks']
  }
});
await phase('Review');
return pipeline(plan.tasks, task => agent(
  `Review ${task.path}. Goal: ${task.goal}. Report concrete findings with file locations.`,
  { model: 'haiku', label: task.path }
));
```

Set explicit bounds: at most 64 concurrent agents (default 8), 1000 calls per run, and 4096 inputs per parallel/pipeline helper. Use small finite retry loops and avoid spawning unbounded work. A script error or a directly awaited `agent()` error stops the run and cancels remaining work. Branch errors inside `parallel` and `pipeline` are isolated unless `failFast` is enabled. Cancelling the whole run always cancels its workers.

Control runs with `kimi-workflow.workflow.control`: `{ runId, action: 'pause' | 'resume' | 'cancel' | 'restart', callId? }`. Pause prevents new agents from starting; active agents finish. Restart replays matching successful calls until the first changed, failed, or cancelled call, then executes the suffix. Supplying `callId` restarts from that call. Cached calls may include past side effects: replay is not a transaction and cannot undo edits. Results are scoped to the session and stored under the plugin runtime directory. Closing a session cancels active runs; interrupted runs can be restarted explicitly.

Panel: `/workflows` opens a dialog in the editor slot, like `/model`. Tab switches controls; arrows select; Enter on a started agent opens its native transcript in fullscreen mode, including thinking and tool results. PgUp/PgDn scroll and Ctrl-O expands thinking and tool output; Escape returns to the workflow dialog, and another Escape restores the editor. Back, filter, pause/resume, stop and retry are buttons. The tasks view stops the selected native task. The workflow keeps running when the dialog closes.
