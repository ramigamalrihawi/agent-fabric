defmodule AgentFabricOrchestrator.Workflow.HooksConfig do
  @moduledoc "Hooks configuration."
  defstruct after_create: nil,
            before_run: nil,
            after_run: nil,
            before_remove: nil,
            timeout_ms: 60_000

  @type t :: %__MODULE__{
          after_create: String.t() | nil,
          before_run: String.t() | nil,
          after_run: String.t() | nil,
          before_remove: String.t() | nil,
          timeout_ms: integer()
        }
end
