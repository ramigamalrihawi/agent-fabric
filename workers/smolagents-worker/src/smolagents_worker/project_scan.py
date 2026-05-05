from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from pathlib import Path


DEFAULT_INCLUDE_PATTERNS = (
    "README.md",
    "PLAN.md",
    "ARCHITECTURE.md",
    "api/**/*.md",
    "decisions/**/*.md",
    "docs/**/*.md",
    "pillars/**/*.md",
    "research/**/*.md",
    "src/**/*.ts",
    "test/**/*.ts",
)

DEFAULT_SKIP_DIRS = {
    ".git",
    ".venv",
    "__pycache__",
    "dist",
    "node_modules",
    ".pytest_cache",
    ".mypy_cache",
}


@dataclass(frozen=True)
class ScannedFile:
    path: str
    bytes_read: int
    total_bytes: int
    line_count: int
    first_heading: str | None
    truncated: bool


@dataclass(frozen=True)
class ProjectInventory:
    project_path: str
    include_patterns: tuple[str, ...]
    files: tuple[ScannedFile, ...]
    skipped_count: int
    total_bytes_read: int
    total_lines: int


def scan_project(
    project_path: str,
    *,
    include_patterns: tuple[str, ...] = DEFAULT_INCLUDE_PATTERNS,
    max_files: int = 200,
    max_bytes_per_file: int = 80_000,
) -> ProjectInventory:
    root = Path(project_path).resolve()
    if not root.exists() or not root.is_dir():
        raise ValueError(f"Project path does not exist or is not a directory: {root}")

    scanned: list[ScannedFile] = []
    skipped_count = 0
    for path in sorted(root.rglob("*")):
        if len(scanned) >= max_files:
            skipped_count += 1
            continue
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if _should_skip(relative):
            skipped_count += 1
            continue
        if not _matches(relative, include_patterns):
            skipped_count += 1
            continue
        scanned.append(_scan_file(path, relative, max_bytes_per_file))

    return ProjectInventory(
        project_path=str(root),
        include_patterns=tuple(include_patterns),
        files=tuple(scanned),
        skipped_count=skipped_count,
        total_bytes_read=sum(item.bytes_read for item in scanned),
        total_lines=sum(item.line_count for item in scanned),
    )


def _matches(relative: str, include_patterns: tuple[str, ...]) -> bool:
    for pattern in include_patterns:
        if fnmatch.fnmatch(relative, pattern):
            return True
        if "/**/" in pattern and fnmatch.fnmatch(relative, pattern.replace("/**/", "/")):
            return True
    return False


def _should_skip(relative: str) -> bool:
    parts = set(relative.split("/"))
    return any(part in DEFAULT_SKIP_DIRS for part in parts)


def _scan_file(path: Path, relative: str, max_bytes_per_file: int) -> ScannedFile:
    total_bytes = path.stat().st_size
    raw = path.read_bytes()[:max_bytes_per_file]
    text = raw.decode("utf-8", errors="replace")
    return ScannedFile(
        path=relative,
        bytes_read=len(raw),
        total_bytes=total_bytes,
        line_count=text.count("\n") + (1 if text else 0),
        first_heading=_first_heading(text),
        truncated=total_bytes > len(raw),
    )


def _first_heading(text: str) -> str | None:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped[:160]
    return None
