defmodule AgentFabricOrchestrator.Workflow.TrackerConfig do
  @moduledoc "Typed tracker configuration."
  defstruct [
    :kind,
    :endpoint,
    :api_key,
    :project_slug,
    active_states: ["Todo", "In Progress"],
    terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]
  ]

  @type t :: %__MODULE__{
          kind: String.t() | nil,
          endpoint: String.t(),
          api_key: String.t() | nil,
          project_slug: String.t() | nil,
          active_states: [String.t()],
          terminal_states: [String.t()]
        }
end
