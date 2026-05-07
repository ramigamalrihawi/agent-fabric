defmodule AgentFabricOrchestrator.RunnerSupervisor do
  @moduledoc """
  DynamicSupervisor for Codex App Server worker runner processes.

  Each runner is a short-lived child that executes one shell command and records
  lifecycle events/checkpoints through Agent Fabric before terminating normally.
  """

  use DynamicSupervisor

  def start_link(opts) do
    DynamicSupervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    DynamicSupervisor.init(strategy: :one_for_one)
  end
end
