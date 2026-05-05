from __future__ import annotations

import json
import os
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class FabricClientError(RuntimeError):
    pass


@dataclass(frozen=True)
class FabricSession:
    session_id: str
    session_token: str
    origin_peer_id: str


class FabricClient:
    def __init__(self, socket_path: str | None = None, timeout_seconds: float = 5.0) -> None:
        self.socket_path = socket_path or default_socket_path()
        self.timeout_seconds = timeout_seconds
        self._next_request_id = 0

    def available(self) -> bool:
        return Path(self.socket_path).exists()

    def register(self, project_path: str, *, test_mode: bool = False) -> FabricSession:
        payload = {
            "bridgeVersion": "0.1.0",
            "agent": {
                "id": "smolagents-worker",
                "displayName": "smolagents Worker",
                "vendor": "huggingface",
            },
            "host": {
                "name": "smolagents-worker",
                "version": "0.1.0",
                "transport": "uds",
            },
            "workspace": {
                "root": str(Path(project_path).resolve()),
                "source": "explicit",
            },
            "capabilities": {
                "roots": True,
                "notifications": False,
                "notificationsVisibleToAgent": {"declared": "no", "observed": "no"},
                "sampling": False,
                "streamableHttp": False,
                "litellmRouteable": True,
                "outcomeReporting": "explicit",
            },
            "notificationSelfTest": {"observed": "no", "detail": "sidecar has no user-visible notification surface"},
            "testMode": test_mode,
        }
        result = self._request({"type": "register", "payload": payload})
        return FabricSession(
            session_id=str(result["sessionId"]),
            session_token=str(result["sessionToken"]),
            origin_peer_id=str(result["originPeerId"]),
        )

    def call(
        self,
        session: FabricSession,
        tool: str,
        input_payload: dict[str, Any],
        *,
        idempotency_key: str | None = None,
        feature_tag: str = "smolagents-worker",
    ) -> dict[str, Any]:
        context: dict[str, Any] = {
            "sessionId": session.session_id,
            "sessionToken": session.session_token,
            "featureTag": feature_tag,
        }
        if idempotency_key:
            context["idempotencyKey"] = idempotency_key
        result = self._request({"type": "call", "tool": tool, "input": input_payload, "context": context})
        if isinstance(result, dict):
            return result
        raise FabricClientError(f"Unexpected fabric response for {tool}: {result!r}")

    def _request(self, request: dict[str, Any]) -> Any:
        self._next_request_id += 1
        request = {"id": self._next_request_id, **request}
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(self.timeout_seconds)
                client.connect(self.socket_path)
                client.sendall((json.dumps(request) + "\n").encode("utf-8"))
                chunks: list[bytes] = []
                while True:
                    chunk = client.recv(65536)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    if b"\n" in chunk:
                        break
        except OSError as exc:
            raise FabricClientError(f"Unable to reach agent-fabric socket {self.socket_path}: {exc}") from exc

        line = b"".join(chunks).split(b"\n", 1)[0]
        if not line:
            raise FabricClientError("Empty response from agent-fabric")
        response = json.loads(line.decode("utf-8"))
        if response.get("ok") is True:
            return response.get("result")
        error = response.get("error") or {}
        code = error.get("code", "FABRIC_ERROR")
        message = error.get("message", "agent-fabric call failed")
        raise FabricClientError(f"{code}: {message}")


def default_socket_path() -> str:
    if os.environ.get("AGENT_FABRIC_SOCKET"):
        return os.environ["AGENT_FABRIC_SOCKET"]
    home = Path(os.environ.get("AGENT_FABRIC_HOME", Path.home() / ".agent-fabric"))
    return str(home / "agent.sock")
