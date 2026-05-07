import Config

config :agent_fabric_orchestrator,
  poll_interval_ms: 100,
  workflow_path: "WORKFLOW.example.md",
  socket_path: System.get_env("AGENT_FABRIC_SOCKET", "/tmp/agent-fabric-test.sock"),
  autostart: false,
  daemon_endpoint: "http://127.0.0.1:4573",
  dashboard_port: 9457,
  dashboard_enabled: true
