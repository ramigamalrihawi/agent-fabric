defmodule AgentFabricOrchestrator.Workflow.PollingConfig do
  @moduledoc "Polling configuration."
  defstruct interval_ms: 30_000
  @type t :: %__MODULE__{interval_ms: integer()}
end
