defmodule AgentFabricOrchestrator do
  @moduledoc """
  Elixir orchestration layer for Agent Fabric.

  This application borrows the durable-supervision ideas from Symphony-style
  issue automation while keeping the TypeScript Agent Fabric daemon and SQLite
  store authoritative. Elixir owns polling, process supervision, workspace
  setup, and runner lifecycle glue; Agent Fabric owns queues, worker identity,
  approvals, heartbeats, artifacts, patches, cost ledgers, and review state.
  """

  alias AgentFabricOrchestrator.Workflow

  @doc """
  Load a repo-owned workflow file.
  """
  def load_workflow(path \\ configured_workflow_path()) do
    Workflow.load(path)
  end

  @doc """
  Return the configured Agent Fabric Unix socket path.
  """
  def socket_path do
    Application.get_env(:agent_fabric_orchestrator, :socket_path)
  end

  defp configured_workflow_path do
    Application.get_env(:agent_fabric_orchestrator, :workflow_path, "WORKFLOW.md")
  end
end
