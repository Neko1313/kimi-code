# kimi-workflow

A plan-as-data workflow orchestrator built on the experimental in-process plugin runtime (`plugin_runtime` flag). It interprets a JSON plan instead of executing model-generated code: stages fan work out over worker processes, track results, feed failures forward, and loop until clean — the dynamic-workflow patterns as a plain plugin.

## Plan shape

```json
{
  "name": "audit",
  "stages": [
    {
      "id": "review",
      "type": "fanout",
      "items": ["src/a.ts", "src/b.ts"],
      "maxConcurrency": 4,
      "worker": { "command": "kimi", "argsTemplate": ["-p", "Review {{item}}"], "timeoutMs": 120000 }
    },
    {
      "id": "recheck",
      "type": "fanout",
      "itemsFrom": "review.failed",
      "worker": { "command": "kimi", "argsTemplate": ["-p", "Re-check {{item}}"] }
    },
    {
      "id": "hunt",
      "type": "loop",
      "items": ["log-a", "log-b"],
      "maxRounds": 5,
      "worker": { "command": "probe", "argsTemplate": ["{{item}}"] }
    }
  ]
}
```

Stage types:

- `sequential`: runs the worker once for the whole stage.
- `fanout`: runs the worker per item, bounded by `maxConcurrency`; a stage whose `itemsFrom` references `<stage>.failed` still runs after an upstream failure and receives only the failed items.
- `loop`: re-runs failed items round by round until clean or `maxRounds`.

`{{item}}` in `argsTemplate` is substituted with the item text. Successful item-runs are cached in the runtime store, so re-running a plan resumes from missing work.

## Running

With the runtime flag enabled and the plugin installed, submit:

```
/workflow run {"name":"audit","stages":[...]}
```

Progress and per-stage summaries go to the plugin logs; results persist under `workflow.<name>.runs` in the runtime store. `/workflow status <name>` prints recorded runs.

## Status

Proof of concept. Known gaps: worker fan-out spawns processes rather than native subagents (waiting on a `$.agent` capability), no TUI pane yet (Phase 2 of the runtime proposal), and plan authoring is manual JSON.
