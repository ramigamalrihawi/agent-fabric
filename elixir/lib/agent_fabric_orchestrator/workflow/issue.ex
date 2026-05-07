defmodule AgentFabricOrchestrator.Workflow.Issue do
  @moduledoc "Normalized issue for prompt rendering."
  defstruct [:id, :identifier, :title, :description, :state, :url, labels: []]

  @type t :: %__MODULE__{
          id: String.t(),
          identifier: String.t(),
          title: String.t(),
          description: String.t() | nil,
          state: String.t(),
          url: String.t() | nil,
          labels: [String.t()]
        }
end
