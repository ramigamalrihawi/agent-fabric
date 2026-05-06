# Example Task Packet

Queue: `pqueue_example`
Project: `/path/to/project`
Queue task: `pqtask_example`
Fabric task: `task_example`
Status: `queued`
Risk: `medium`

## Goal

Add a focused regression test for the queue runner's model-approval gate when a DeepSeek-backed worker is selected.

## Task Metadata

Phase: `execution`
Priority: `normal`
Parallel safe: `true`
Depends on: `[]`
Required tools: `["shell"]`
Required MCP servers: `[]`
Required memories: `[]`
Required context refs: `["src/runtime/project-cli.ts", "test/project-cli.test.ts"]`

## Expected Files

- `test/project-cli.test.ts`

## Acceptance Criteria

- Test proves the worker command is not executed before model approval.
- Test verifies the queue result exposes the approval request id.
- Existing project CLI tests still pass.

## Instructions

- Work only on this task unless the queue says otherwise.
- Do not run git operations unless the task or project rules explicitly allow them.
- Prefer `rg` for source search and `jq` for JSON inspection.
- Return evidence: files changed, commands run, tests run, blockers, and next action.
