from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from .project_scan import ProjectInventory


def render_project_mining_report(
    *,
    inventory: ProjectInventory,
    prompt_file: str,
    dry_run: bool,
    model_id: str | None = None,
    model_notes: str | None = None,
) -> str:
    prompt_path = Path(prompt_file)
    lines = [
        "# smolagents project-mining report",
        "",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        f"Project: `{inventory.project_path}`",
        f"Prompt file: `{prompt_path}`",
        f"Mode: `{'dry_run' if dry_run else 'model_backed'}`",
        "",
        "## Safety Envelope",
        "",
        "- Permission tier: `read_only`",
        "- Project files are read only.",
        "- Report output is written only to the requested output directory.",
        "- Shell execution is disabled in this slice.",
        "- Remote Hub tools are disabled in this slice.",
        "",
        "## Scan Summary",
        "",
        f"- Files scanned: {len(inventory.files)}",
        f"- Files skipped by pattern/limit: {inventory.skipped_count}",
        f"- Bytes read: {inventory.total_bytes_read}",
        f"- Lines scanned: {inventory.total_lines}",
        "",
        "## Include Patterns",
        "",
    ]
    for pattern in inventory.include_patterns:
        lines.append(f"- `{pattern}`")
    lines.extend(["", "## Files Scanned", ""])
    for item in inventory.files:
        truncated = " yes" if item.truncated else " no"
        heading = f" - {item.first_heading}" if item.first_heading else ""
        lines.append(f"- `{item.path}` ({item.line_count} lines, {item.bytes_read}/{item.total_bytes} bytes, truncated:{truncated}){heading}")

    lines.extend(
        [
            "",
            "## Model Notes",
            "",
        ]
    )
    if model_notes:
        lines.append(model_notes.strip())
    elif model_id:
        lines.append(f"Model `{model_id}` was requested, but no model notes were produced.")
    else:
        lines.append("No model was called. This report is deterministic scan output only.")

    lines.extend(
        [
            "",
            "## Next Actions",
            "",
            "- Feed this report and the prompt file to a model-backed reviewer if deeper synthesis is needed.",
            "- Keep any generated recommendations as review artifacts until a human or stronger reviewer accepts them.",
            "- Do not promote generated memory candidates without the normal `pending_review` path.",
            "",
        ]
    )
    return "\n".join(lines)


def write_report(output_dir: str, report: str, *, filename: str = "project-mining-report.md") -> Path:
    output_path = Path(output_dir).resolve()
    output_path.mkdir(parents=True, exist_ok=True)
    target = output_path / filename
    target.write_text(report, encoding="utf-8")
    return target
