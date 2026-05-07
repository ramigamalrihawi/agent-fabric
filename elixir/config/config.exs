import Config

config :agent_fabric_orchestrator,
  workflow_path: System.get_env("AGENT_FABRIC_WORKFLOW", "WORKFLOW.md"),
  socket_path:
    System.get_env(
      "AGENT_FABRIC_SOCKET",
      Path.join([System.user_home!(), ".agent-fabric", "agent.sock"])
    ),
  poll_interval_ms: String.to_integer(System.get_env("AGENT_FABRIC_ELIXIR_POLL_MS", "30000")),
  autostart: System.get_env("AGENT_FABRIC_ELIXIR_AUTOSTART") in ["1", "true", "yes", "on"],
  daemon_endpoint: System.get_env("AGENT_FABRIC_DAEMON_ENDPOINT", "http://127.0.0.1:4573"),
  dashboard_port: String.to_integer(System.get_env("AGENT_FABRIC_DASHBOARD_PORT", "4574")),
  dashboard_enabled:
    System.get_env("AGENT_FABRIC_ELIXIR_DASHBOARD", "1") in ["1", "true", "yes", "on"]

if config_env() == :test do
  import_config "test.exs"
end
