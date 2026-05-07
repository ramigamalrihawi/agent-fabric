defmodule AgentFabricOrchestrator.Workflow.AgentConfig do
  @moduledoc "Agent configuration."
  defstruct max_concurrent_agents: 10,
            max_turns: 20,
            max_retry_backoff_ms: 300_000,
            max_concurrent_agents_by_state: %{}

  @type t :: %__MODULE__{
          max_concurrent_agents: integer(),
          max_turns: integer(),
          max_retry_backoff_ms: integer(),
          max_concurrent_agents_by_state: %{String.t() => integer()}
        }
end
