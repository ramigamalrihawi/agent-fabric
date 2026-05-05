from __future__ import annotations

from .project_scan import ProjectInventory


def run_model_backed_notes(*, prompt_text: str, inventory: ProjectInventory, model_id: str, api_base: str | None = None, api_key: str | None = None) -> str:
    try:
        from smolagents import LiteLLMModel
    except ImportError as exc:
        raise RuntimeError('Install optional dependencies with: python3 -m pip install -e ".[agent]"') from exc

    kwargs: dict[str, object] = {"model_id": model_id}
    if api_base:
        kwargs["api_base"] = api_base
    if api_key:
        kwargs["api_key"] = api_key
    model = LiteLLMModel(**kwargs)
    task = build_model_task(prompt_text=prompt_text, inventory=inventory)
    result = model.generate([{"role": "user", "content": task}])
    content = getattr(result, "content", result)
    return str(content)


def build_model_task(*, prompt_text: str, inventory: ProjectInventory) -> str:
    file_lines = "\n".join(
        f"- {item.path}: {item.line_count} lines, heading={item.first_heading or 'none'}, truncated={item.truncated}" for item in inventory.files[:200]
    )
    return f"""You are evaluating a project for reusable agent-fabric ideas.

Use only the file inventory below and the user prompt. Do not claim you read file contents not present in the inventory.
Return concise markdown with:
- promising domains
- likely files to inspect next
- integration risks
- what agent-fabric should not copy

User prompt:
{prompt_text[:12000]}

Project inventory:
{file_lines}
"""
