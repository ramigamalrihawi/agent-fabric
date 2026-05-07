defmodule AgentFabricOrchestrator.Workflow.WorkspaceConfig do
  @moduledoc "Workspace configuration."
  defstruct [:root]
  @type t :: %__MODULE__{root: String.t() | nil}
end
