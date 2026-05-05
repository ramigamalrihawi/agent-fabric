from __future__ import annotations

import json
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from smolagents_worker import cli
from smolagents_worker.cli import main
from smolagents_worker.fabric_client import FabricSession


class CliTest(unittest.TestCase):
    def test_run_project_mining_dry_run_writes_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            root.mkdir()
            (root / "README.md").write_text("# Demo\nhello\n", encoding="utf-8")
            prompt = Path(tmp) / "prompt.md"
            prompt.write_text("Find useful ideas.", encoding="utf-8")
            output = Path(tmp) / "out"

            code = main(
                [
                    "run-project-mining",
                    "--project",
                    str(root),
                    "--prompt-file",
                    str(prompt),
                    "--output-dir",
                    str(output),
                    "--dry-run",
                ]
            )

            self.assertEqual(code, 0)
            report = output / "project-mining-report.md"
            self.assertTrue(report.exists())
            text = report.read_text(encoding="utf-8")
            self.assertIn("Mode: `dry_run`", text)
            self.assertIn("`README.md`", text)
            self.assertIn("No model was called", text)

    def test_create_task_mode_reports_lifecycle_to_fabric(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            root.mkdir()
            (root / "README.md").write_text("# Demo\nhello\n", encoding="utf-8")
            prompt = Path(tmp) / "prompt.md"
            prompt.write_text("Find useful ideas.", encoding="utf-8")
            output = Path(tmp) / "out"
            FakeFabricClient.calls = []

            with patch.object(cli, "FabricClient", FakeFabricClient):
                code = main(
                    [
                        "run-project-mining",
                        "--project",
                        str(root),
                        "--prompt-file",
                        str(prompt),
                        "--output-dir",
                        str(output),
                        "--create-task",
                        "--require-fabric",
                        "--dry-run",
                    ]
                )

            self.assertEqual(code, 0)
            tools = [entry[0] for entry in FakeFabricClient.calls]
            self.assertEqual(
                tools,
                [
                    "fabric_task_create",
                    "fabric_task_start_worker",
                    "fabric_task_event",
                    "fabric_task_event",
                    "fabric_task_checkpoint",
                    "fabric_task_event",
                    "fabric_task_finish",
                ],
            )
            self.assertEqual(FakeFabricClient.calls[0][1]["requestedBy"], "smolagents-worker")
            self.assertEqual(FakeFabricClient.calls[1][1]["worker"], "smolagents")
            self.assertEqual(FakeFabricClient.calls[1][1]["contextPolicy"], "read_only_project_mining")

    def test_inspect_context_from_file_writes_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context_file = Path(tmp) / "context.json"
            context_file.write_text(json.dumps(sample_context_inspection()), encoding="utf-8")
            output = Path(tmp) / "out"

            code = main(["inspect-context", "--input-file", str(context_file), "--output-dir", str(output)])

            self.assertEqual(code, 0)
            report = output / "context-inspection-report.md"
            self.assertTrue(report.exists())
            text = report.read_text(encoding="utf-8")
            self.assertIn("HIGH: Context is large", text)
            self.assertIn("BREAKGLASS: Sensitive context is present", text)
            self.assertIn("`logs/big.log`", text)

    def test_inspect_context_from_fabric_request_reports_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            FakeFabricClient.calls = []
            output = Path(tmp) / "out"

            with patch.object(cli, "FabricClient", FakeFabricClient):
                code = main(
                    [
                        "inspect-context",
                        "--request-id",
                        "llmpf_test",
                        "--workspace-root",
                        tmp,
                        "--output-dir",
                        str(output),
                        "--create-task",
                        "--require-fabric",
                    ]
                )

            self.assertEqual(code, 0)
            tools = [entry[0] for entry in FakeFabricClient.calls]
            self.assertEqual(
                tools,
                [
                    "fabric_inspect_context_package",
                    "fabric_task_create",
                    "fabric_task_start_worker",
                    "fabric_task_event",
                    "fabric_task_event",
                    "fabric_task_finish",
                ],
            )
            self.assertEqual(FakeFabricClient.calls[2][1]["contextPolicy"], "context_inspector")
            self.assertEqual(FakeFabricClient.calls[4][1]["metadata"]["highestSeverity"], "breakglass")

    def test_extract_memory_candidates_from_file_writes_report_and_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            task_file = Path(tmp) / "task-status.json"
            task_file.write_text(json.dumps(sample_task_status()), encoding="utf-8")
            output = Path(tmp) / "out"

            code = main(["extract-memory-candidates", "--input-file", str(task_file), "--output-dir", str(output)])

            self.assertEqual(code, 0)
            report = output / "memory-candidates-report.md"
            data = output / "memory-candidates.json"
            self.assertTrue(report.exists())
            self.assertTrue(data.exists())
            text = report.read_text(encoding="utf-8")
            self.assertIn("anti_pattern", text)
            self.assertIn("Test failed during task_source", text)
            candidates = json.loads(data.read_text(encoding="utf-8"))
            self.assertTrue(any(item["type"] == "procedural" for item in candidates))

    def test_extract_memory_candidates_from_fabric_task_reports_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            FakeFabricClient.calls = []
            output = Path(tmp) / "out"

            with patch.object(cli, "FabricClient", FakeFabricClient):
                code = main(
                    [
                        "extract-memory-candidates",
                        "--source-task-id",
                        "task_source",
                        "--workspace-root",
                        tmp,
                        "--output-dir",
                        str(output),
                        "--create-task",
                        "--require-fabric",
                    ]
                )

            self.assertEqual(code, 0)
            tools = [entry[0] for entry in FakeFabricClient.calls]
            self.assertEqual(
                tools,
                [
                    "fabric_task_status",
                    "fabric_task_create",
                    "fabric_task_start_worker",
                    "fabric_task_event",
                    "fabric_task_event",
                    "fabric_task_finish",
                ],
            )
            self.assertEqual(FakeFabricClient.calls[2][1]["contextPolicy"], "memory_candidate_extractor")
            self.assertGreater(FakeFabricClient.calls[4][1]["metadata"]["candidateCount"], 0)

    def test_extract_memory_candidates_can_write_pending_memories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            FakeFabricClient.calls = []
            FakeFabricClient.registrations = []
            output = Path(tmp) / "out"

            with patch.object(cli, "FabricClient", FakeFabricClient):
                code = main(
                    [
                        "extract-memory-candidates",
                        "--source-task-id",
                        "task_source",
                        "--workspace-root",
                        tmp,
                        "--output-dir",
                        str(output),
                        "--create-task",
                        "--require-fabric",
                        "--write-pending-memories",
                    ]
                )

            self.assertEqual(code, 0)
            memory_write_calls = [entry for entry in FakeFabricClient.calls if entry[0] == "memory_write"]
            self.assertGreater(len(memory_write_calls), 0)
            for _, payload in memory_write_calls:
                self.assertEqual(payload["source"], "auto")
                self.assertEqual(payload["derivation"], "session_transcript")
                self.assertIn(payload["severity"], {"low", "normal", "high"})

            results = output / "memory-write-results.json"
            self.assertTrue(results.exists())
            data = json.loads(results.read_text(encoding="utf-8"))
            self.assertTrue(all(item["result"]["status"] == "pending_review" for item in data))
            self.assertEqual(FakeFabricClient.calls[2][1]["metadata"]["permissionTier"], "pending_memory_write")
            self.assertEqual(FakeFabricClient.calls[3][1]["metadata"]["permissionTier"], "pending_memory_write")

    def test_extract_memory_candidates_write_from_file_uses_task_project_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            FakeFabricClient.calls = []
            FakeFabricClient.registrations = []
            project = Path(tmp) / "source-project"
            project.mkdir()
            task_file = Path(tmp) / "task-status.json"
            task_status = sample_task_status()
            task_status["projectPath"] = str(project)
            task_file.write_text(json.dumps(task_status), encoding="utf-8")
            output = Path(tmp) / "out"

            with patch.object(cli, "FabricClient", FakeFabricClient):
                code = main(
                    [
                        "extract-memory-candidates",
                        "--input-file",
                        str(task_file),
                        "--output-dir",
                        str(output),
                        "--require-fabric",
                        "--write-pending-memories",
                    ]
                )

            self.assertEqual(code, 0)
            self.assertEqual(FakeFabricClient.registrations, [str(project)])
            self.assertTrue(any(entry[0] == "memory_write" for entry in FakeFabricClient.calls))

    def test_doctor_json_reports_environment(self) -> None:
        output = StringIO()
        with patch("sys.stdout", output):
            code = main(["doctor", "--json", "--fabric-socket", "/tmp/missing-agent-fabric.sock"])

        self.assertEqual(code, 0)
        data = json.loads(output.getvalue())
        self.assertIn("python", data)
        self.assertIn("optionalDependencies", data)
        self.assertFalse(data["fabric"]["socketExists"])


class FakeFabricClient:
    calls: list[tuple[str, dict]] = []
    registrations: list[str] = []

    def __init__(self, socket_path: str) -> None:
        self.socket_path = socket_path

    def available(self) -> bool:
        return True

    def register(self, project_path: str, *, test_mode: bool = False) -> FabricSession:
        self.registrations.append(project_path)
        return FabricSession(session_id="session_test", session_token="token_test", origin_peer_id="peer_test")

    def call(self, session: FabricSession, tool: str, input_payload: dict, *, idempotency_key: str | None = None, feature_tag: str = "smolagents-worker") -> dict:
        self.calls.append((tool, input_payload))
        if tool == "fabric_task_create":
            return {"taskId": "task_test", "status": "created"}
        if tool == "fabric_task_start_worker":
            return {"taskId": input_payload["taskId"], "workerRunId": "wrun_test", "status": "running", "workspacePath": input_payload["workspacePath"]}
        if tool == "fabric_task_event":
            return {"eventId": "wevt_test", "taskId": input_payload["taskId"], "workerRunId": input_payload["workerRunId"]}
        if tool == "fabric_task_checkpoint":
            return {"checkpointId": "wchk_test", "taskId": input_payload["taskId"]}
        if tool == "fabric_task_finish":
            return {"taskId": input_payload["taskId"], "status": input_payload["status"]}
        if tool == "fabric_inspect_context_package":
            inspection = sample_context_inspection()
            inspection["requestId"] = input_payload["requestId"]
            inspection["workspaceRoot"] = input_payload.get("workspaceRoot", inspection["workspaceRoot"])
            return inspection
        if tool == "fabric_task_status":
            task_status = sample_task_status()
            task_status["taskId"] = input_payload["taskId"]
            return task_status
        if tool == "memory_write":
            return {
                "action": "added",
                "id": f"mem_{len([entry for entry in self.calls if entry[0] == 'memory_write'])}",
                "status": "pending_review",
                "injectable": False,
                "conflicts": [],
            }
        raise AssertionError(f"Unexpected tool: {tool}")


def sample_context_inspection() -> dict:
    return {
        "requestId": "llmpf_test",
        "contextPackageId": "ctxpkg_test",
        "capturedAt": "2026-04-30T00:00:00.000Z",
        "workspaceRoot": "/tmp/workspace",
        "client": "test",
        "taskType": "code_edit",
        "rawContentStored": False,
        "summary": {
            "inputTokens": 60_000,
            "fileCount": 2,
            "toolSchemaCount": 6,
            "mcpServerCount": 1,
            "memoryCount": 1,
            "sensitiveFlagCount": 1,
            "repeatedRegionCount": 1,
            "staleItemCount": 1,
        },
        "tokenBreakdown": {"files": 40_000, "tools": 20_000},
        "files": [
            {"path": "src/server.ts", "tokens": 18_000, "reason": "open editor"},
            {"path": "logs/big.log", "tokens": 22_000, "reason": "diagnostic"},
        ],
        "toolSchemas": [{"name": f"tool_{idx}", "estimatedTokens": 1000} for idx in range(6)],
        "mcpServers": [{"name": "agent-fabric", "toolCount": 20}],
        "memories": [{"id": "mem_1", "verified": False}],
        "sensitiveFlags": ["production_data"],
        "repeatedRegions": [{"kind": "file", "path": "src/server.ts", "tokens": 1000}],
        "staleItems": [{"kind": "log", "path": "logs/big.log", "ageTurns": 10}],
        "warnings": ["Large context package (60000 tokens)."],
    }


def sample_task_status() -> dict:
    return {
        "taskId": "task_source",
        "status": "completed",
        "title": "Fix test failure",
        "goal": "Repair failing tests.",
        "projectPath": "/tmp/workspace",
        "summary": "Fixed failing tests.",
        "events": [
            {
                "eventId": "wevt_fail",
                "kind": "test_result",
                "body": "pytest failed in test_login.py",
                "metadata": {"status": "failed", "command": "pytest"},
            },
            {
                "eventId": "wevt_done",
                "kind": "completed",
                "body": "Patched login fixture and tests passed.",
                "metadata": {},
            },
        ],
        "checkpoints": [
            {
                "checkpointId": "wchk_1",
                "summary": {
                    "decisions": ["Use isolated fixture state for login tests"],
                    "blockers": [],
                    "commandsRun": ["pytest"],
                    "failingTests": ["test_login.py::test_reuses_session"],
                },
            }
        ],
    }


if __name__ == "__main__":
    unittest.main()
