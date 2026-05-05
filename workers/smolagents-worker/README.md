# agent-fabric smolagents worker

Safe Python worker adapter for bounded project-mining, context-inspection, and memory-candidate extraction jobs.

This worker is intentionally not part of the TypeScript daemon. `agent-fabric` owns durable state, cost policy, memory, collab, task records, and checkpoints. This sidecar does bounded analysis work and reports lifecycle events through the existing `fabric_task_*` tools.

## Current slice

Implemented first:

- read-only project scan
- markdown report generation
- sanitized context-package inspection reports
- review-only memory candidate extraction from task status/events/checkpoints
- explicit pending-review memory persistence with `--write-pending-memories`
- optional durable task creation with `--create-task`
- optional `agent-fabric` UDS reporting when `--task-id` or `--create-task` is provided
- optional model-backed notes behind `--use-smolagents`
- fail-closed behavior for model calls unless fabric preflight is available or `--allow-uncovered-model-call` is explicitly set

Not implemented yet:

- file edits
- shell execution
- remote Hub tools
- automatic or active memory writes
- context-inspector approval UI integration
- Docker/E2B/Modal/Blaxel sandbox launcher

## Install

For the safe read-only path:

```bash
cd /path/to/agent-fabric/workers/smolagents-worker
python3 -m pip install -e .
```

For model-backed smolagents runs, use Python 3.10+ because upstream `smolagents` requires it:

```bash
python3.10 -m pip install -e ".[agent]"
```

## Dry run

This scans a project and writes a deterministic report without calling a model or requiring the daemon:

```bash
agent-fabric-smolagents-worker run-project-mining \
  --project /path/to/agent-fabric \
  --prompt-file /path/to/prompt.md \
  --output-dir /tmp/agent-fabric-smolagents-worker \
  --dry-run
```

Output:

```text
/tmp/agent-fabric-smolagents-worker/project-mining-report.md
```

## Doctor

Check Python version, fabric socket visibility, and optional dependency availability:

```bash
PYTHONPATH=src python3 -m smolagents_worker doctor --json
```

If `supportsSmolagentsExtra` is `false`, use Python 3.10+ for model-backed mode. The read-only modes still work with Python 3.9.

## Fabric-backed run

The simplest fabric-backed path creates its own durable task:

```bash
AGENT_FABRIC_HTTP_PORT=off npm run dev:daemon
```

In another shell:

```bash
cd /path/to/agent-fabric/workers/smolagents-worker
PYTHONPATH=src python3 -m smolagents_worker run-project-mining \
  --project /path/to/project \
  --prompt-file /path/to/prompt.md \
  --output-dir /path/to/output \
  --create-task \
  --require-fabric \
  --dry-run
```

Use `--task-title`, `--task-goal`, `--priority`, and `--requested-by` to control the created task metadata.

When a durable task already exists:

```bash
agent-fabric-smolagents-worker run-project-mining \
  --task-id task_... \
  --project /path/to/project \
  --prompt-file /path/to/prompt.md \
  --output-dir /path/to/output \
  --fabric-socket ~/.agent-fabric/agent.sock \
  --require-fabric
```

The worker registers as:

```text
agent id: smolagents-worker
host: smolagents-worker
worker type: smolagents
context policy: read_only_project_mining
permission tier: read_only
```

## Context inspection

From a saved `fabric_inspect_context_package` JSON file:

```bash
PYTHONPATH=src python3 -m smolagents_worker inspect-context \
  --input-file /path/to/context-inspection.json \
  --output-dir /tmp/agent-fabric-context-inspection
```

From a live `llm_preflight` request id:

```bash
PYTHONPATH=src python3 -m smolagents_worker inspect-context \
  --request-id llmpf_... \
  --workspace-root /path/to/project \
  --output-dir /tmp/agent-fabric-context-inspection \
  --create-task \
  --require-fabric
```

This writes:

```text
/tmp/agent-fabric-context-inspection/context-inspection-report.md
```

The report uses only the daemon's sanitized metadata: token counts, file paths, tool names, MCP server names, memory verification flags, stale/repeated item metadata, and warnings. It does not require or store raw prompt, file, tool schema, or memory bodies.

## Memory-candidate extraction

From saved `fabric_task_status` JSON with events/checkpoints:

```bash
PYTHONPATH=src python3 -m smolagents_worker extract-memory-candidates \
  --input-file /path/to/task-status.json \
  --output-dir /tmp/agent-fabric-memory-candidates
```

From a live source task:

```bash
PYTHONPATH=src python3 -m smolagents_worker extract-memory-candidates \
  --source-task-id task_... \
  --workspace-root /path/to/project \
  --output-dir /tmp/agent-fabric-memory-candidates \
  --create-task \
  --require-fabric
```

This writes:

```text
/tmp/agent-fabric-memory-candidates/memory-candidates-report.md
/tmp/agent-fabric-memory-candidates/memory-candidates.json
```

Candidates are review-only by default. To also persist them in the daemon for later review, pass `--write-pending-memories`:

```bash
PYTHONPATH=src python3 -m smolagents_worker extract-memory-candidates \
  --source-task-id task_... \
  --workspace-root /path/to/project \
  --output-dir /tmp/agent-fabric-memory-candidates \
  --create-task \
  --require-fabric \
  --write-pending-memories
```

This writes a third artifact:

```text
/tmp/agent-fabric-memory-candidates/memory-write-results.json
```

The write path deliberately calls `memory_write` with `source=auto` and `derivation=session_transcript`, even when the candidate came from a structured event. That forces daemon status `pending_review` and prevents accidental active injection. Original candidate provenance is preserved in refs.

Review them with `memory_list` filtered to `status: "pending_review"` and decide with `memory_review` (`approve`, `reject`, or `archive`).

## Model-backed run

Model-backed mode requires an agent-fabric preflight unless explicitly overridden. This path uses `LiteLLMModel.generate` directly for synthesis; it does not run `CodeAgent` or execute model-generated Python.

```bash
agent-fabric-smolagents-worker run-project-mining \
  --task-id task_... \
  --project /path/to/project \
  --prompt-file /path/to/prompt.md \
  --output-dir /path/to/output \
  --use-smolagents \
  --model-id deepseek/deepseek-v4-pro \
  --provider openrouter \
  --fabric-socket ~/.agent-fabric/agent.sock \
  --require-fabric
```

Do not run model-backed mode against premium models without fabric preflight. If you deliberately need an uncovered call for a cheap/local test, pass `--allow-uncovered-model-call` and record the reason in the task notes.

## Safety boundary

The default worker path is read-only by design:

- It reads selected project files.
- It writes only to `--output-dir`.
- It does not run shell commands.
- It does not edit project files.
- It does not load remote Hub tools.
- It does not treat `LocalPythonExecutor` as a sandbox.

The only current non-read-only flag is `--write-pending-memories`, which writes daemon memory rows that must remain `pending_review` and non-injectable until reviewed or promoted by the normal memory workflow.

If file-editing is added later, it must run in a git worktree or real sandbox and must claim paths through `agent-fabric` first.

## Validation

```bash
cd /path/to/agent-fabric/workers/smolagents-worker
PYTHONPATH=src python3 -m unittest discover -s tests
PYTHONPATH=src python3 -m smolagents_worker --help
```

End-to-end daemon smoke:

```bash
AGENT_FABRIC_HOME="$(mktemp -d)" AGENT_FABRIC_HTTP_PORT=off npm run dev:daemon
PYTHONPATH=src python3 -m smolagents_worker run-project-mining \
  --project /path/to/agent-fabric \
  --prompt-file /path/to/prompt.md \
  --output-dir /tmp/agent-fabric-smolagents-worker \
  --create-task \
  --require-fabric \
  --dry-run \
  --test-mode
```

Context-inspection daemon smoke:

```bash
PYTHONPATH=src python3 -m smolagents_worker inspect-context \
  --request-id llmpf_... \
  --workspace-root /path/to/project \
  --output-dir /tmp/agent-fabric-context-inspection \
  --create-task \
  --require-fabric \
  --test-mode
```

Memory-candidate daemon smoke:

```bash
PYTHONPATH=src python3 -m smolagents_worker extract-memory-candidates \
  --source-task-id task_... \
  --workspace-root /path/to/project \
  --output-dir /tmp/agent-fabric-memory-candidates \
  --create-task \
  --require-fabric \
  --write-pending-memories \
  --test-mode
```
