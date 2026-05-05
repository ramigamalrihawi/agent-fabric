from __future__ import annotations

import argparse
import json
import os
import sys
from importlib import metadata
from pathlib import Path
from typing import Any
from uuid import uuid4

from .context_inspector import analyze_context_package, load_context_inspection, render_context_report, write_context_report
from .fabric_client import FabricClient, FabricClientError, FabricSession, default_socket_path
from .memory_candidates import MemoryCandidate, extract_memory_candidates, load_task_status, write_memory_candidates, write_memory_write_results
from .project_scan import DEFAULT_INCLUDE_PATTERNS, ProjectInventory, scan_project
from .report import render_project_mining_report, write_report
from .smolagents_runner import run_model_backed_notes


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "run-project-mining":
            run_project_mining(args)
            return 0
        if args.command == "inspect-context":
            inspect_context(args)
            return 0
        if args.command == "extract-memory-candidates":
            extract_memory(args)
            return 0
        if args.command == "doctor":
            doctor(args)
            return 0
        parser.print_help()
        return 2
    except (FabricClientError, RuntimeError, ValueError) as exc:
        parser.exit(1, f"agent-fabric-smolagents-worker: error: {exc}\n")
        return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-fabric-smolagents-worker")
    subcommands = parser.add_subparsers(dest="command")
    run = subcommands.add_parser("run-project-mining", help="Run a read-only project-mining scan/report.")
    run.add_argument("--project", required=True, help="Project directory to scan.")
    run.add_argument("--prompt-file", required=True, help="Prompt document guiding the mining run.")
    run.add_argument("--output-dir", required=True, help="Directory where the report will be written.")
    run.add_argument("--task-id", help="Existing agent-fabric task id to attach to.")
    run.add_argument("--create-task", action="store_true", help="Create a durable fabric task when --task-id is not provided.")
    run.add_argument("--task-title", help="Title to use with --create-task.")
    run.add_argument("--task-goal", help="Goal to use with --create-task.")
    run.add_argument("--priority", choices=["low", "normal", "high"], default="normal", help="Priority to use with --create-task.")
    run.add_argument("--requested-by", default="smolagents-worker", help="requestedBy value to use with --create-task.")
    run.add_argument("--fabric-socket", default=default_socket_path(), help="agent-fabric Unix socket path.")
    run.add_argument("--require-fabric", action="store_true", help="Fail if agent-fabric is unavailable.")
    run.add_argument("--dry-run", action="store_true", help="Do not call a model; write deterministic scan output only.")
    run.add_argument("--use-smolagents", action="store_true", help="Call smolagents for model-backed synthesis after preflight.")
    run.add_argument("--allow-uncovered-model-call", action="store_true", help="Allow model-backed mode without fabric preflight.")
    run.add_argument("--approval-token", help="Approval token from llm_approve for a model-backed call.")
    run.add_argument("--model-id", default="deepseek/deepseek-v4-pro", help="LiteLLM model id for model-backed notes.")
    run.add_argument("--provider", default="openrouter", help="Requested provider for preflight metadata.")
    run.add_argument("--api-base", default=os.environ.get("OPENAI_BASE_URL"), help="Optional LiteLLM/OpenAI-compatible base URL.")
    run.add_argument("--api-key", default=os.environ.get("OPENAI_API_KEY") or os.environ.get("OPENROUTER_API_KEY"), help="Optional model API key.")
    run.add_argument("--include", action="append", dest="includes", help="Additional include glob. Can be repeated.")
    run.add_argument("--max-files", type=int, default=200, help="Maximum files to scan.")
    run.add_argument("--max-bytes-per-file", type=int, default=80_000, help="Maximum bytes to read per file.")
    run.add_argument("--test-mode", action="store_true", help="Register fabric writes as test-mode.")
    inspect = subcommands.add_parser("inspect-context", help="Inspect a sanitized context package from JSON or fabric.")
    inspect.add_argument("--input-file", help="Path to fabric_inspect_context_package JSON output.")
    inspect.add_argument("--request-id", help="llm_preflight request id to inspect through agent-fabric.")
    inspect.add_argument("--workspace-root", help="Workspace root for fabric_inspect_context_package.")
    inspect.add_argument("--output-dir", required=True, help="Directory where the context report will be written.")
    inspect.add_argument("--task-id", help="Existing agent-fabric task id to attach to.")
    inspect.add_argument("--create-task", action="store_true", help="Create a durable fabric task when --task-id is not provided.")
    inspect.add_argument("--task-title", help="Title to use with --create-task.")
    inspect.add_argument("--task-goal", help="Goal to use with --create-task.")
    inspect.add_argument("--priority", choices=["low", "normal", "high"], default="normal", help="Priority to use with --create-task.")
    inspect.add_argument("--requested-by", default="smolagents-worker", help="requestedBy value to use with --create-task.")
    inspect.add_argument("--fabric-socket", default=default_socket_path(), help="agent-fabric Unix socket path.")
    inspect.add_argument("--require-fabric", action="store_true", help="Fail if agent-fabric is unavailable.")
    inspect.add_argument("--test-mode", action="store_true", help="Register fabric writes as test-mode.")
    memory = subcommands.add_parser("extract-memory-candidates", help="Extract review-only memory candidates from task status.")
    memory.add_argument("--input-file", help="Path to fabric_task_status JSON output with events/checkpoints.")
    memory.add_argument("--source-task-id", help="Existing fabric task id to read with fabric_task_status.")
    memory.add_argument("--workspace-root", help="Workspace root for fabric session registration.")
    memory.add_argument("--output-dir", required=True, help="Directory where memory candidate reports will be written.")
    memory.add_argument("--task-id", help="Existing agent-fabric task id to attach the extraction worker to.")
    memory.add_argument("--create-task", action="store_true", help="Create a durable extraction task when --task-id is not provided.")
    memory.add_argument("--task-title", help="Title to use with --create-task.")
    memory.add_argument("--task-goal", help="Goal to use with --create-task.")
    memory.add_argument("--priority", choices=["low", "normal", "high"], default="normal", help="Priority to use with --create-task.")
    memory.add_argument("--requested-by", default="smolagents-worker", help="requestedBy value to use with --create-task.")
    memory.add_argument("--fabric-socket", default=default_socket_path(), help="agent-fabric Unix socket path.")
    memory.add_argument("--require-fabric", action="store_true", help="Fail if agent-fabric is unavailable.")
    memory.add_argument("--test-mode", action="store_true", help="Register fabric writes as test-mode.")
    memory.add_argument("--write-pending-memories", action="store_true", help="Write candidates through memory_write as pending_review memories.")
    doctor = subcommands.add_parser("doctor", help="Report sidecar environment and optional dependency status.")
    doctor.add_argument("--fabric-socket", default=default_socket_path(), help="agent-fabric Unix socket path.")
    doctor.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    return parser


def run_project_mining(args: argparse.Namespace) -> None:
    project = Path(args.project).resolve()
    prompt_file = Path(args.prompt_file).resolve()
    if not prompt_file.exists():
        raise ValueError(f"Prompt file does not exist: {prompt_file}")

    include_patterns = tuple(DEFAULT_INCLUDE_PATTERNS) + tuple(args.includes or ())
    fabric_client = FabricClient(args.fabric_socket)
    session: FabricSession | None = None
    worker_run_id: str | None = None
    task_id = args.task_id
    if (task_id or args.create_task) and fabric_client.available():
        session = fabric_client.register(str(project), test_mode=args.test_mode)
        if not task_id:
            task_id = create_task(fabric_client, session, args, project, prompt_file)
        worker_run_id = start_worker(fabric_client, session, args, project, task_id)
        emit_event(fabric_client, session, task_id, worker_run_id, "started", "smolagents project-mining worker started.", {"permissionTier": "read_only"})
    elif args.require_fabric or args.create_task:
        raise FabricClientError(f"agent-fabric socket not available: {args.fabric_socket}")

    inventory = scan_project(str(project), include_patterns=include_patterns, max_files=args.max_files, max_bytes_per_file=args.max_bytes_per_file)
    if session and worker_run_id and task_id:
        emit_event(
            fabric_client,
            session,
            task_id,
            worker_run_id,
            "thought_summary",
            "Read-only project scan complete.",
            {"filesScanned": len(inventory.files), "bytesRead": inventory.total_bytes_read},
        )
        checkpoint(fabric_client, session, task_id, worker_run_id, inventory, "Optional model-backed analysis or report writing.")

    prompt_text = prompt_file.read_text(encoding="utf-8")
    model_notes: str | None = None
    dry_run = bool(args.dry_run or not args.use_smolagents)
    if args.use_smolagents:
        ensure_model_call_allowed(fabric_client, session, args, inventory, prompt_text)
        model_notes = run_model_backed_notes(prompt_text=prompt_text, inventory=inventory, model_id=args.model_id, api_base=args.api_base, api_key=args.api_key)

    report = render_project_mining_report(inventory=inventory, prompt_file=str(prompt_file), dry_run=dry_run, model_id=args.model_id if args.use_smolagents else None, model_notes=model_notes)
    report_path = write_report(args.output_dir, report)

    if session and worker_run_id and task_id:
        emit_event(
            fabric_client,
            session,
            task_id,
            worker_run_id,
            "completed",
            "smolagents project-mining report written.",
            {"artifactPath": str(report_path), "mode": "model_backed" if args.use_smolagents else "dry_run"},
            refs=[str(report_path)],
        )
        finish_task(fabric_client, session, task_id, worker_run_id, report_path, artifact_kind="project-mining")

    print(str(report_path))


def inspect_context(args: argparse.Namespace) -> None:
    if not args.input_file and not args.request_id:
        raise ValueError("inspect-context requires --input-file or --request-id")
    if args.input_file and args.request_id:
        raise ValueError("inspect-context accepts only one of --input-file or --request-id")

    fabric_client = FabricClient(args.fabric_socket)
    session: FabricSession | None = None
    task_id = args.task_id
    worker_run_id: str | None = None

    needs_fabric = bool(args.request_id or args.task_id or args.create_task or args.require_fabric)
    if needs_fabric and fabric_client.available():
        workspace_root = args.workspace_root or str(Path.cwd())
        session = fabric_client.register(workspace_root, test_mode=args.test_mode)
        if args.request_id:
            inspection = fabric_client.call(
                session,
                "fabric_inspect_context_package",
                {"requestId": args.request_id, "workspaceRoot": args.workspace_root} if args.workspace_root else {"requestId": args.request_id},
            )
        else:
            inspection = load_context_inspection(args.input_file)
        if not task_id and args.create_task:
            task_id = create_context_task(fabric_client, session, args, inspection)
        if task_id:
            worker_run_id = start_context_worker(fabric_client, session, args, task_id, inspection)
            emit_event(fabric_client, session, task_id, worker_run_id, "started", "smolagents context-inspection worker started.", {"permissionTier": "read_only"})
    elif args.request_id or args.create_task or args.require_fabric:
        raise FabricClientError(f"agent-fabric socket not available: {args.fabric_socket}")
    else:
        inspection = load_context_inspection(args.input_file)

    findings = analyze_context_package(inspection)
    report_path = write_context_report(args.output_dir, render_context_report(inspection, findings))

    if session and task_id and worker_run_id:
        emit_event(
            fabric_client,
            session,
            task_id,
            worker_run_id,
            "completed",
            "smolagents context inspection report written.",
            {"artifactPath": str(report_path), "findingCount": len(findings), "highestSeverity": highest_severity(findings)},
            refs=[str(report_path)],
        )
        finish_task(fabric_client, session, task_id, worker_run_id, report_path, artifact_kind="context-inspection")

    print(str(report_path))


def extract_memory(args: argparse.Namespace) -> None:
    if not args.input_file and not args.source_task_id:
        raise ValueError("extract-memory-candidates requires --input-file or --source-task-id")
    if args.input_file and args.source_task_id:
        raise ValueError("extract-memory-candidates accepts only one of --input-file or --source-task-id")

    fabric_client = FabricClient(args.fabric_socket)
    session: FabricSession | None = None
    task_id = args.task_id
    worker_run_id: str | None = None
    task_status_from_file = load_task_status(args.input_file) if args.input_file else None

    needs_fabric = bool(args.source_task_id or args.task_id or args.create_task or args.require_fabric or args.write_pending_memories)
    if needs_fabric and fabric_client.available():
        workspace_root = args.workspace_root or task_status_project_path(task_status_from_file) or str(Path.cwd())
        session = fabric_client.register(workspace_root, test_mode=args.test_mode)
        if args.source_task_id:
            task_status = fabric_client.call(
                session,
                "fabric_task_status",
                {"taskId": args.source_task_id, "includeEvents": True, "includeCheckpoints": True},
            )
        else:
            task_status = task_status_from_file or load_task_status(args.input_file)
        if not task_id and args.create_task:
            task_id = create_memory_task(fabric_client, session, args, task_status)
        if task_id:
            worker_run_id = start_memory_worker(fabric_client, session, args, task_id, task_status)
            emit_event(
                fabric_client,
                session,
                task_id,
                worker_run_id,
                "started",
                "smolagents memory-candidate extraction started.",
                {"permissionTier": "pending_memory_write" if args.write_pending_memories else "read_only"},
            )
    elif args.source_task_id or args.create_task or args.require_fabric or args.write_pending_memories:
        raise FabricClientError(f"agent-fabric socket not available: {args.fabric_socket}")
    else:
        task_status = task_status_from_file or load_task_status(args.input_file)

    candidates = extract_memory_candidates(task_status)
    report_path, json_path = write_memory_candidates(args.output_dir, task_status, candidates)
    memory_write_results_path: Path | None = None
    memory_write_results: list[dict[str, Any]] = []
    if args.write_pending_memories:
        if session is None:
            raise FabricClientError("--write-pending-memories requires an agent-fabric session")
        memory_write_results = write_pending_memories(fabric_client, session, candidates, report_path, json_path)
        memory_write_results_path = write_memory_write_results(args.output_dir, memory_write_results)
        if task_id and worker_run_id:
            emit_event(
                fabric_client,
                session,
                task_id,
                worker_run_id,
                "thought_summary",
                "Pending-review memory writes complete.",
                {"memoryWriteCount": len(memory_write_results), "memoryWriteResultsPath": str(memory_write_results_path)},
                refs=[str(memory_write_results_path)],
            )

    if session and task_id and worker_run_id:
        refs = [str(report_path), str(json_path)]
        if memory_write_results_path:
            refs.append(str(memory_write_results_path))
        emit_event(
            fabric_client,
            session,
            task_id,
            worker_run_id,
            "completed",
            "smolagents memory candidate report written.",
            {
                "reportPath": str(report_path),
                "jsonPath": str(json_path),
                "candidateCount": len(candidates),
                "memoryWriteCount": len(memory_write_results),
                "memoryWriteResultsPath": str(memory_write_results_path) if memory_write_results_path else None,
            },
            refs=refs,
        )
        finish_task(fabric_client, session, task_id, worker_run_id, report_path, artifact_kind="memory-candidate")

    print(str(report_path))
    print(str(json_path))
    if memory_write_results_path:
        print(str(memory_write_results_path))


def write_pending_memories(
    client: FabricClient,
    session: FabricSession,
    candidates: list[MemoryCandidate],
    report_path: Path,
    json_path: Path,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates, start=1):
        payload = memory_write_payload(candidate, report_path, json_path)
        result = client.call(
            session,
            "memory_write",
            payload,
            idempotency_key=f"smolagents-memory-write:{index}:{uuid4()}",
        )
        results.append(
            {
                "candidateIndex": index,
                "candidateType": candidate.type,
                "candidateOriginalDerivation": candidate.derivation,
                "payloadDerivation": payload["derivation"],
                "payloadSource": payload["source"],
                "result": result,
            }
        )
    return results


def task_status_project_path(task_status: dict[str, Any] | None) -> str | None:
    if not task_status:
        return None
    project_path = task_status.get("projectPath")
    if isinstance(project_path, str) and project_path.strip():
        return project_path
    return None


def memory_write_payload(candidate: MemoryCandidate, report_path: Path, json_path: Path) -> dict[str, Any]:
    refs = list(candidate.refs)
    refs.extend([f"original_derivation:{candidate.derivation}", str(report_path), str(json_path)])
    return {
        "type": candidate.type,
        "body": candidate.body,
        "intent_keys": candidate.intent_keys,
        "refs": refs,
        "initialConfidence": candidate.confidence,
        "source": "auto",
        "derivation": "session_transcript",
        "severity": memory_write_severity(candidate.severity),
    }


def memory_write_severity(severity: str) -> str:
    if severity in {"low", "normal", "high"}:
        return severity
    if severity == "breakglass":
        return "high"
    return "normal"


def doctor(args: argparse.Namespace) -> None:
    client = FabricClient(args.fabric_socket)
    smolagents_available, smolagents_version = optional_package_status("smolagents")
    litellm_available, litellm_version = optional_package_status("litellm")
    result = {
        "python": {
            "version": sys.version.split()[0],
            "executable": sys.executable,
            "supportsSmolagentsExtra": sys.version_info >= (3, 10),
        },
        "fabric": {
            "socketPath": args.fabric_socket,
            "socketExists": client.available(),
        },
        "optionalDependencies": {
            "smolagents": {"available": smolagents_available, "version": smolagents_version},
            "litellm": {"available": litellm_available, "version": litellm_version},
        },
        "safeModes": ["run-project-mining --dry-run", "inspect-context", "extract-memory-candidates"],
    }
    if args.json:
        print(json.dumps(result, indent=2))
        return
    print("agent-fabric smolagents worker doctor")
    print(f"python: {result['python']['version']} ({result['python']['executable']})")
    print(f"smolagents extra supported by python: {result['python']['supportsSmolagentsExtra']}")
    print(f"fabric socket: {args.fabric_socket} exists={result['fabric']['socketExists']}")
    print(f"smolagents: available={smolagents_available} version={smolagents_version or 'n/a'}")
    print(f"litellm: available={litellm_available} version={litellm_version or 'n/a'}")


def create_task(client: FabricClient, session: FabricSession, args: argparse.Namespace, project: Path, prompt_file: Path) -> str:
    title = args.task_title or f"smolagents project mining: {project.name}"
    goal = args.task_goal or f"Run read-only smolagents project mining for {project} using prompt {prompt_file}."
    result = client.call(
        session,
        "fabric_task_create",
        {
            "title": title,
            "goal": goal,
            "projectPath": str(project),
            "priority": args.priority,
            "refs": [str(prompt_file)],
            "requestedBy": args.requested_by,
        },
        idempotency_key=f"smolagents-create:{project}:{prompt_file}:{uuid4()}",
    )
    return str(result["taskId"])


def create_memory_task(client: FabricClient, session: FabricSession, args: argparse.Namespace, task_status: dict[str, Any]) -> str:
    source_task_id = str(task_status.get("taskId") or args.source_task_id or "unknown")
    project = str(task_status.get("projectPath") or args.workspace_root or Path.cwd())
    title = args.task_title or f"smolagents memory extraction: {source_task_id}"
    goal = args.task_goal or f"Extract review-only memory candidates from fabric task {source_task_id}."
    result = client.call(
        session,
        "fabric_task_create",
        {
            "title": title,
            "goal": goal,
            "projectPath": project,
            "priority": args.priority,
            "refs": [f"fabric_task:{source_task_id}"],
            "requestedBy": args.requested_by,
        },
        idempotency_key=f"smolagents-memory-create:{source_task_id}:{uuid4()}",
    )
    return str(result["taskId"])


def create_context_task(client: FabricClient, session: FabricSession, args: argparse.Namespace, inspection: dict[str, Any]) -> str:
    workspace = str(inspection.get("workspaceRoot") or args.workspace_root or Path.cwd())
    request_id = str(inspection.get("requestId") or args.request_id or "unknown")
    title = args.task_title or f"smolagents context inspection: {request_id}"
    goal = args.task_goal or f"Inspect sanitized context package for preflight request {request_id} and write a review artifact."
    result = client.call(
        session,
        "fabric_task_create",
        {
            "title": title,
            "goal": goal,
            "projectPath": workspace,
            "priority": args.priority,
            "refs": [request_id],
            "requestedBy": args.requested_by,
        },
        idempotency_key=f"smolagents-context-create:{workspace}:{request_id}:{uuid4()}",
    )
    return str(result["taskId"])


def start_worker(client: FabricClient, session: FabricSession, args: argparse.Namespace, project: Path, task_id: str) -> str:
    result = client.call(
        session,
        "fabric_task_start_worker",
        {
            "taskId": task_id,
            "worker": "smolagents",
            "projectPath": str(project),
            "workspaceMode": "in_place",
            "workspacePath": str(project),
            "modelProfile": "research.cheap" if not args.use_smolagents else args.model_id,
            "contextPolicy": "read_only_project_mining",
            "command": ["agent-fabric-smolagents-worker", "run-project-mining"],
            "metadata": {
                "permissionTier": "read_only",
                "promptFile": str(Path(args.prompt_file).resolve()),
                "outputDir": str(Path(args.output_dir).resolve()),
            },
        },
        idempotency_key=f"smolagents-start:{task_id}:{uuid4()}",
    )
    return str(result["workerRunId"])


def start_context_worker(client: FabricClient, session: FabricSession, args: argparse.Namespace, task_id: str, inspection: dict[str, Any]) -> str:
    workspace = str(inspection.get("workspaceRoot") or args.workspace_root or Path.cwd())
    result = client.call(
        session,
        "fabric_task_start_worker",
        {
            "taskId": task_id,
            "worker": "smolagents",
            "projectPath": workspace,
            "workspaceMode": "in_place",
            "workspacePath": workspace,
            "modelProfile": "none",
            "contextPolicy": "context_inspector",
            "command": ["agent-fabric-smolagents-worker", "inspect-context"],
            "metadata": {
                "permissionTier": "read_only",
                "requestId": inspection.get("requestId") or args.request_id,
                "outputDir": str(Path(args.output_dir).resolve()),
            },
        },
        idempotency_key=f"smolagents-context-start:{task_id}:{uuid4()}",
    )
    return str(result["workerRunId"])


def start_memory_worker(client: FabricClient, session: FabricSession, args: argparse.Namespace, task_id: str, task_status: dict[str, Any]) -> str:
    project = str(task_status.get("projectPath") or args.workspace_root or Path.cwd())
    source_task_id = str(task_status.get("taskId") or args.source_task_id or "unknown")
    result = client.call(
        session,
        "fabric_task_start_worker",
        {
            "taskId": task_id,
            "worker": "smolagents",
            "projectPath": project,
            "workspaceMode": "in_place",
            "workspacePath": project,
            "modelProfile": "none",
            "contextPolicy": "memory_candidate_extractor",
            "command": ["agent-fabric-smolagents-worker", "extract-memory-candidates"],
            "metadata": {
                "permissionTier": "pending_memory_write" if args.write_pending_memories else "read_only",
                "sourceTaskId": source_task_id,
                "outputDir": str(Path(args.output_dir).resolve()),
                "writesPendingMemories": bool(args.write_pending_memories),
            },
        },
        idempotency_key=f"smolagents-memory-start:{task_id}:{uuid4()}",
    )
    return str(result["workerRunId"])


def ensure_model_call_allowed(client: FabricClient, session: FabricSession | None, args: argparse.Namespace, inventory: ProjectInventory, prompt_text: str) -> None:
    if session is None:
        if args.allow_uncovered_model_call:
            return
        raise FabricClientError("Model-backed smolagents mode requires agent-fabric preflight unless --allow-uncovered-model-call is set.")

    estimated_tokens = estimate_tokens(prompt_text) + max(1, inventory.total_bytes_read // 4)
    result = client.call(
        session,
        "llm_preflight",
        {
            "task": {"type": "project_mining", "permissionTier": "read_only"},
            "client": "smolagents-worker",
            "workspaceRoot": str(Path(args.project).resolve()),
            "candidateModel": args.model_id,
            "requestedReasoning": "medium",
            "requestedProvider": args.provider,
            "budgetScope": "session",
            "contextPackageSummary": {
                "inputTokens": estimated_tokens,
                "estimatedTokens": estimated_tokens,
                "filesScanned": len(inventory.files),
                "bytesRead": inventory.total_bytes_read,
            },
            "approvalToken": args.approval_token,
        },
        idempotency_key=f"smolagents-preflight:{args.task_id or 'standalone'}:{uuid4()}",
    )
    decision = result.get("decision")
    if decision != "allow":
        request_id = result.get("requestId")
        raise FabricClientError(f"Preflight decision was {decision}; approve/compact first. requestId={request_id}")


def emit_event(
    client: FabricClient,
    session: FabricSession,
    task_id: str,
    worker_run_id: str,
    kind: str,
    body: str,
    metadata: dict[str, Any],
    *,
    refs: list[str] | None = None,
) -> None:
    client.call(
        session,
        "fabric_task_event",
        {
            "taskId": task_id,
            "workerRunId": worker_run_id,
            "kind": kind,
            "body": body,
            "refs": refs or [],
            "metadata": metadata,
        },
        idempotency_key=f"smolagents-event:{task_id}:{worker_run_id}:{kind}:{uuid4()}",
    )


def checkpoint(client: FabricClient, session: FabricSession, task_id: str, worker_run_id: str, inventory: ProjectInventory, next_action: str) -> None:
    client.call(
        session,
        "fabric_task_checkpoint",
        {
            "taskId": task_id,
            "workerRunId": worker_run_id,
            "summary": {
                "currentGoal": "Run read-only project mining.",
                "filesTouched": [],
                "commandsRun": [],
                "testsRun": [],
                "decisions": ["Initial smolagents slice is read-only."],
                "assumptions": ["The prompt file is user-approved input."],
                "blockers": [],
                "scannedFiles": len(inventory.files),
                "bytesRead": inventory.total_bytes_read,
                "nextAction": next_action,
            },
        },
        idempotency_key=f"smolagents-checkpoint:{task_id}:{worker_run_id}:{uuid4()}",
    )


def finish_task(client: FabricClient, session: FabricSession, task_id: str, worker_run_id: str, report_path: Path, *, artifact_kind: str) -> None:
    client.call(
        session,
        "fabric_task_finish",
        {
            "taskId": task_id,
            "workerRunId": worker_run_id,
            "status": "completed",
            "summary": f"smolagents {artifact_kind} report written to {report_path}",
            "patchRefs": [],
            "testRefs": [],
            "followups": ["Review report before accepting recommendations."],
        },
        idempotency_key=f"smolagents-finish:{task_id}:{worker_run_id}:{uuid4()}",
    )


def highest_severity(findings: list[Any]) -> str:
    order = {"low": 0, "medium": 1, "high": 2, "breakglass": 3}
    highest = "low"
    for finding in findings:
        severity = getattr(finding, "severity", "low")
        if order.get(severity, 0) > order.get(highest, 0):
            highest = severity
    return highest


def optional_package_status(name: str) -> tuple[bool, str | None]:
    try:
        return True, metadata.version(name)
    except metadata.PackageNotFoundError:
        return False, None


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)
