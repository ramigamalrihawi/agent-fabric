from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class MemoryCandidate:
    type: str
    body: str
    intent_keys: list[str]
    refs: list[str]
    confidence: float
    derivation: str
    severity: str
    reason: str
    status: str = "pending_review"


def load_task_status(path: str) -> dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("task status JSON must be an object")
    return value


def extract_memory_candidates(task_status: dict[str, Any]) -> list[MemoryCandidate]:
    task_id = str(task_status.get("taskId") or "unknown-task")
    project_path = str(task_status.get("projectPath") or "")
    refs = [f"fabric_task:{task_id}"]
    candidates: list[MemoryCandidate] = []

    for event in _list(task_status.get("events")):
        record = _record(event)
        kind = str(record.get("kind") or "")
        body = str(record.get("body") or "").strip()
        metadata = _record(record.get("metadata"))
        event_ref = str(record.get("eventId") or task_id)
        combined_refs = refs + [f"worker_event:{event_ref}"]
        if kind in {"failed", "test_result", "command_finished"} and _looks_failed(kind, body, metadata):
            candidates.append(
                MemoryCandidate(
                    type="anti_pattern",
                    body=_sentence(f"Failure observed in {task_id}: {body or _metadata_summary(metadata)}"),
                    intent_keys=_intent_keys(project_path, metadata, prefix="failure"),
                    refs=combined_refs,
                    confidence=0.45,
                    derivation="structured_tool_outcome" if metadata else "session_transcript",
                    severity="high" if kind == "failed" else "normal",
                    reason=f"Worker event kind `{kind}` indicates a failure path.",
                )
            )
        if kind == "completed" and body:
            candidates.append(
                MemoryCandidate(
                    type="episodic",
                    body=_sentence(f"Completed task {task_id}: {body}"),
                    intent_keys=_intent_keys(project_path, metadata, prefix="task_completed"),
                    refs=combined_refs,
                    confidence=0.35,
                    derivation="session_transcript",
                    severity="low",
                    reason="Completion event may be useful for retrospective browsing, not auto-injection.",
                )
            )

    for checkpoint in _list(task_status.get("checkpoints")):
        record = _record(checkpoint)
        summary = _record(record.get("summary"))
        checkpoint_ref = str(record.get("checkpointId") or task_id)
        combined_refs = refs + [f"worker_checkpoint:{checkpoint_ref}"]
        for decision in _string_list(summary.get("decisions")):
            candidates.append(
                MemoryCandidate(
                    type="procedural",
                    body=_sentence(f"For similar work in {project_path or task_id}, remember decision: {decision}"),
                    intent_keys=_intent_keys(project_path, summary, prefix="decision"),
                    refs=combined_refs,
                    confidence=0.4,
                    derivation="session_transcript",
                    severity="normal",
                    reason="Checkpoint decision recorded by a worker.",
                )
            )
        for blocker in _string_list(summary.get("blockers")):
            candidates.append(
                MemoryCandidate(
                    type="anti_pattern",
                    body=_sentence(f"Blocker encountered in {task_id}: {blocker}"),
                    intent_keys=_intent_keys(project_path, summary, prefix="blocker"),
                    refs=combined_refs,
                    confidence=0.45,
                    derivation="session_transcript",
                    severity="normal",
                    reason="Checkpoint blocker may prevent repeated failed work.",
                )
            )
        failing_tests = _string_list(summary.get("failingTests"))
        commands = _string_list(summary.get("commandsRun"))
        for test in failing_tests:
            body = f"Test failed during {task_id}: {test}"
            if commands:
                body += f" after commands: {', '.join(commands[:3])}"
            candidates.append(
                MemoryCandidate(
                    type="anti_pattern",
                    body=_sentence(body),
                    intent_keys=_intent_keys(project_path, summary, prefix="test_failure"),
                    refs=combined_refs,
                    confidence=0.5,
                    derivation="structured_tool_outcome",
                    severity="high",
                    reason="Checkpoint explicitly listed failing tests.",
                )
            )

    return _dedupe(candidates)


def render_memory_candidates_report(task_status: dict[str, Any], candidates: list[MemoryCandidate]) -> str:
    task_id = str(task_status.get("taskId") or "unknown-task")
    lines = [
        "# memory candidate extraction report",
        "",
        f"Source task: `{task_id}`",
        f"Project: `{task_status.get('projectPath', 'unknown')}`",
        f"Task status: `{task_status.get('status', 'unknown')}`",
        "",
        "## Policy",
        "",
        "- These are review-only memory candidates.",
        "- By default, this worker writes artifacts only and does not call `memory_write`.",
        "- With `--write-pending-memories`, it writes through `memory_write` using `source=auto` and `derivation=session_transcript`, so outputs stay `pending_review`.",
        "- This worker never writes active injectable memories.",
        "",
        "## Summary",
        "",
        f"- Candidates: `{len(candidates)}`",
        f"- Anti-patterns: `{sum(1 for item in candidates if item.type == 'anti_pattern')}`",
        f"- Procedural: `{sum(1 for item in candidates if item.type == 'procedural')}`",
        f"- Episodic: `{sum(1 for item in candidates if item.type == 'episodic')}`",
        "",
        "## Candidates",
        "",
    ]
    if not candidates:
        lines.append("No candidate memories extracted by deterministic rules.")
    for index, candidate in enumerate(candidates, start=1):
        lines.extend(
            [
                f"### {index}. {candidate.type} / {candidate.severity}",
                "",
                candidate.body,
                "",
                f"- status: `{candidate.status}`",
                f"- confidence: `{candidate.confidence}`",
                f"- derivation: `{candidate.derivation}`",
                f"- reason: {candidate.reason}",
                f"- intent_keys: {', '.join(f'`{key}`' for key in candidate.intent_keys) or '`none`'}",
                f"- refs: {', '.join(f'`{ref}`' for ref in candidate.refs) or '`none`'}",
                "",
            ]
        )
    return "\n".join(lines)


def write_memory_candidates(output_dir: str, task_status: dict[str, Any], candidates: list[MemoryCandidate]) -> tuple[Path, Path]:
    output_path = Path(output_dir).resolve()
    output_path.mkdir(parents=True, exist_ok=True)
    report_path = output_path / "memory-candidates-report.md"
    json_path = output_path / "memory-candidates.json"
    report_path.write_text(render_memory_candidates_report(task_status, candidates), encoding="utf-8")
    json_path.write_text(json.dumps([candidate.__dict__ for candidate in candidates], indent=2), encoding="utf-8")
    return report_path, json_path


def write_memory_write_results(output_dir: str, results: list[dict[str, Any]]) -> Path:
    output_path = Path(output_dir).resolve()
    output_path.mkdir(parents=True, exist_ok=True)
    json_path = output_path / "memory-write-results.json"
    json_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    return json_path


def _looks_failed(kind: str, body: str, metadata: dict[str, Any]) -> bool:
    if kind == "failed":
        return True
    exit_code = metadata.get("exitCode") or metadata.get("exit_code")
    if isinstance(exit_code, (int, float)) and int(exit_code) != 0:
        return True
    status = str(metadata.get("status") or metadata.get("outcome") or "").lower()
    if status in {"failed", "failure", "error"}:
        return True
    lower = body.lower()
    return any(marker in lower for marker in ("failed", "failure", "error", "exception", "traceback", "timed out"))


def _intent_keys(project_path: str, metadata: dict[str, Any], *, prefix: str) -> list[str]:
    keys = [prefix]
    if project_path:
        keys.append(f"path:{project_path}")
    command = metadata.get("command") or metadata.get("cmd")
    if isinstance(command, str) and command.strip():
        keys.append(f"cmd:{command.strip()[:120]}")
    for path in _string_list(metadata.get("filesTouched"))[:5]:
        keys.append(f"path:{path}")
    return keys


def _metadata_summary(metadata: dict[str, Any]) -> str:
    if not metadata:
        return "no details supplied"
    interesting = []
    for key in ("command", "cmd", "status", "outcome", "exitCode", "exit_code", "errorCode", "error"):
        if key in metadata:
            interesting.append(f"{key}={metadata[key]}")
    return ", ".join(interesting) or "structured failure metadata was supplied"


def _sentence(value: str) -> str:
    value = " ".join(value.split())
    if not value:
        return value
    return value if value.endswith((".", "!", "?")) else value + "."


def _dedupe(candidates: list[MemoryCandidate]) -> list[MemoryCandidate]:
    seen: set[tuple[str, str]] = set()
    result: list[MemoryCandidate] = []
    for candidate in candidates:
        key = (candidate.type, candidate.body.lower())
        if key in seen:
            continue
        seen.add(key)
        result.append(candidate)
    return result


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _string_list(value: Any) -> list[str]:
    return [str(item) for item in _list(value) if str(item).strip()]
