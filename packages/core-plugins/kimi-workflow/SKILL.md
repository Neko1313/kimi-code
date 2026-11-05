---
name: workflow
description: Run a multi-step fan-out workflow over worker processes via the kimi-workflow plugin. Use when the user asks to audit, check, investigate, or process many items in parallel.
---

The kimi-workflow plugin executes a plan-as-data workflow. You drive it by writing a plan file; the plugin consumes it when your turn ends.

## Protocol

1. Build the plan JSON (schema below).
2. Create the directory and write the plan to `.kimi-workflow/pending.json` in the working directory (use the Bash tool: `mkdir -p .kimi-workflow`, then Write).
3. End your turn with one short sentence, e.g. "Running workflow `<name>`, results follow."
4. The plugin runs the workflow and injects the result summary as a user message. Read it and present the outcome to the user.

Only write `pending.json` when the user actually asks for a workflow. One plan per turn.

## Plan schema

```json
{
  "name": "audit-auth",
  "stages": [
    {
      "id": "review",
      "type": "fanout",
      "items": ["src/login.ts", "src/session.ts"],
      "maxConcurrency": 4,
      "worker": { "command": "kimi", "argsTemplate": ["-p", "Review {{item}}"], "timeoutMs": 120000 }
    },
    {
      "id": "recheck",
      "type": "fanout",
      "itemsFrom": "review.failed",
      "worker": { "command": "kimi", "argsTemplate": ["-p", "Re-check {{item}}"] }
    }
  ]
}
```

- `sequential` stage: runs the worker once (no items needed).
- `fanout` stage: needs exactly one of `items` (list) or `itemsFrom` (`"<stageId>.failed"` or `"<stageId>.items"`).
- `loop` stage: like fanout, plus `maxRounds`; re-runs failed items until clean.
- `{{item}}` in `argsTemplate` is substituted with the item text.
- `itemsFrom: "<stage>.failed"` lets a stage run even after an upstream failure, receiving only failed items.

## Notes

- Successful item-runs are cached; re-running the same plan resumes from missing work.
- Workers run as processes; keep `timeoutMs` generous for model-backed workers.
- For quick structural scans prefer cheap commands (`ls`, `grep`, `find`) over model workers.
