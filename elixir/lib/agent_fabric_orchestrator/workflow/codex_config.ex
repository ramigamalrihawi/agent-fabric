defmodule AgentFabricOrchestrator.Workflow.CodexConfig do
  @moduledoc "Codex configuration."
  defstruct command: "codex app-server",
            approval_policy: nil,
            thread_sandbox: nil,
            turn_sandbox_policy: nil,
            turn_timeout_ms: 3_600_000,
            read_timeout_ms: 5_000,
            stall_timeout_ms: 300_000

  @type t :: %__MODULE__{
          command: String.t(),
          approval_policy: String.t() | nil,
          thread_sandbox: String.t() | nil,
          turn_sandbox_policy: String.t() | nil,
          turn_timeout_ms: integer(),
          read_timeout_ms: integer(),
          stall_timeout_ms: integer()
        }
end
