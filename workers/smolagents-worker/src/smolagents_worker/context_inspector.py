from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ContextFinding:
    severity: str
    title: str
    detail: str
    action: str


def load_context_inspection(path: str) -> dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("context inspection JSON must be an object")
    return value


def analyze_context_package(inspection: dict[str, Any]) -> list[ContextFinding]:
    summary = _record(inspection.get("summary"))
    findings: list[ContextFinding] = []
    input_tokens = _int(summary.get("inputTokens"))
    file_count = _int(summary.get("fileCount"))
    tool_schema_count = _int(summary.get("toolSchemaCount"))
    mcp_server_count = _int(summary.get("mcpServerCount"))
    memory_count = _int(summary.get("memoryCount"))
    sensitive_flag_count = _int(summary.get("sensitiveFlagCount"))
    repeated_count = _int(summary.get("repeatedRegionCount"))
    stale_count = _int(summary.get("staleItemCount"))

    if input_tokens >= 200_000:
        findings.append(
            ContextFinding(
                "breakglass",
                "Context is in breakglass territory",
                f"The package is {input_tokens} input tokens before reserved output.",
                "Require explicit user approval, compact first, or move to a high-context/local route.",
            )
        )
    elif input_tokens >= 50_000:
        findings.append(
            ContextFinding(
                "high",
                "Context is large",
                f"The package is {input_tokens} input tokens.",
                "Inspect the largest files, stale items, and tool schemas before using a premium model.",
            )
        )
    elif input_tokens >= 20_000:
        findings.append(
            ContextFinding(
                "medium",
                "Context is moderately large",
                f"The package is {input_tokens} input tokens.",
                "Prefer a cheaper model or compact low-value logs/docs if the task is routine.",
            )
        )

    if tool_schema_count > 10:
        findings.append(
            ContextFinding(
                "high",
                "Too many tool schemas",
                f"{tool_schema_count} tool schemas are included.",
                "Drop unused MCP servers/tools before the model call.",
            )
        )
    elif tool_schema_count > 5:
        findings.append(
            ContextFinding(
                "medium",
                "Large tool schema set",
                f"{tool_schema_count} tool schemas are included.",
                "Keep only tools that are needed for this turn.",
            )
        )

    if mcp_server_count > 5:
        findings.append(
            ContextFinding(
                "medium",
                "Many MCP servers are in context",
                f"{mcp_server_count} MCP servers are represented.",
                "Disable or omit irrelevant servers for this call.",
            )
        )

    if sensitive_flag_count > 0:
        flags = ", ".join(str(item) for item in _list(inspection.get("sensitiveFlags")))
        findings.append(
            ContextFinding(
                "breakglass",
                "Sensitive context is present",
                flags or f"{sensitive_flag_count} sensitive flags are present.",
                "Require human approval and consider removing secrets, cookies, production data, or external-action context.",
            )
        )

    if repeated_count > 0:
        findings.append(
            ContextFinding(
                "medium",
                "Repeated context detected",
                f"{repeated_count} repeated regions were reported.",
                "Remove duplicated file/log/doc blocks before paying for a premium model.",
            )
        )

    if stale_count > 0:
        findings.append(
            ContextFinding(
                "medium",
                "Stale context detected",
                f"{stale_count} stale items were reported.",
                "Drop old logs, obsolete files, and context not used in recent turns.",
            )
        )

    unverified_memories = [item for item in _list(inspection.get("memories")) if _record(item).get("verified") is False or _record(item).get("verifierStatus") == "unverified"]
    if unverified_memories:
        findings.append(
            ContextFinding(
                "medium",
                "Unverified memories are present",
                f"{len(unverified_memories)} unverified memories are included out of {memory_count}.",
                "Use verified memories only for automatic injection; keep these as browseable context or ask for confirmation.",
            )
        )

    if file_count == 0 and tool_schema_count == 0 and mcp_server_count == 0 and not inspection.get("tokenBreakdown"):
        findings.append(
            ContextFinding(
                "high",
                "Context breakdown is missing",
                "The caller did not provide files, tools, MCP servers, or token breakdown metadata.",
                "Treat the preflight as low-confidence and improve client instrumentation before trusting routing decisions.",
            )
        )

    if not findings:
        findings.append(ContextFinding("low", "No obvious context waste detected", "The sanitized package did not trigger the default waste heuristics.", "Allow the call if the model route and budget are appropriate."))
    return findings


def render_context_report(inspection: dict[str, Any], findings: list[ContextFinding]) -> str:
    summary = _record(inspection.get("summary"))
    lines = [
        "# context inspection report",
        "",
        f"Request: `{inspection.get('requestId', 'unknown')}`",
        f"Context package: `{inspection.get('contextPackageId', 'unknown')}`",
        f"Workspace: `{inspection.get('workspaceRoot', 'unknown')}`",
        f"Client: `{inspection.get('client', 'unknown')}`",
        f"Task type: `{inspection.get('taskType', 'unknown')}`",
        f"Raw content stored: `{inspection.get('rawContentStored', False)}`",
        "",
        "## Summary",
        "",
    ]
    for key in (
        "inputTokens",
        "fileCount",
        "toolSchemaCount",
        "mcpServerCount",
        "memoryCount",
        "sensitiveFlagCount",
        "repeatedRegionCount",
        "staleItemCount",
    ):
        lines.append(f"- {key}: `{summary.get(key, 0)}`")

    lines.extend(["", "## Findings", ""])
    for finding in findings:
        lines.extend(
            [
                f"### {finding.severity.upper()}: {finding.title}",
                "",
                finding.detail,
                "",
                f"Action: {finding.action}",
                "",
            ]
        )

    lines.extend(["## Largest Files", ""])
    for item in _largest_items(_list(inspection.get("files"))):
        lines.append(_format_item(item))
    if len(lines) >= 2 and lines[-1] == "## Largest Files":
        lines.append("No file metadata supplied.")

    lines.extend(["", "## Tool Schemas", ""])
    for item in _largest_items(_list(inspection.get("toolSchemas"))):
        lines.append(_format_item(item))
    if lines[-1] == "## Tool Schemas":
        lines.append("No tool schema metadata supplied.")

    lines.extend(["", "## MCP Servers", ""])
    for item in _list(inspection.get("mcpServers")):
        lines.append(_format_item(_record(item)))
    if lines[-1] == "## MCP Servers":
        lines.append("No MCP server metadata supplied.")

    warnings = [str(item) for item in _list(inspection.get("warnings"))]
    lines.extend(["", "## Daemon Warnings", ""])
    if warnings:
        lines.extend(f"- {warning}" for warning in warnings)
    else:
        lines.append("No daemon warnings supplied.")
    lines.append("")
    return "\n".join(lines)


def write_context_report(output_dir: str, report: str, *, filename: str = "context-inspection-report.md") -> Path:
    output_path = Path(output_dir).resolve()
    output_path.mkdir(parents=True, exist_ok=True)
    target = output_path / filename
    target.write_text(report, encoding="utf-8")
    return target


def _largest_items(items: list[Any], limit: int = 10) -> list[dict[str, Any]]:
    records = [_record(item) for item in items]
    records.sort(key=lambda item: _item_size(item), reverse=True)
    return records[:limit]


def _item_size(item: dict[str, Any]) -> int:
    for key in ("tokens", "estimatedTokens", "inputTokens", "bytes", "size"):
        value = _int(item.get(key))
        if value:
            return value
    return 0


def _format_item(item: dict[str, Any]) -> str:
    name = item.get("path") or item.get("name") or item.get("server") or item.get("tool") or item.get("id") or "unknown"
    size = _item_size(item)
    reason = item.get("reason")
    suffix = f", reason={reason}" if reason else ""
    return f"- `{name}` ({size} tokens/bytes{suffix})"


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    return 0
