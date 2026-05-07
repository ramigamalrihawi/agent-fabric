defmodule AgentFabricOrchestrator.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    AgentFabricOrchestrator.RunnerRegistry.ensure_table()

    # Always start the shared infrastructure
    shared_children = [
      {AgentFabricOrchestrator.RunnerSupervisor, name: AgentFabricOrchestrator.RunnerSupervisor}
    ]

    dashboard_children =
      if Application.get_env(:agent_fabric_orchestrator, :dashboard_enabled, true) do
        [{AgentFabricOrchestrator.Dashboard, []}]
      else
        []
      end

    orchestrator_children =
      if Application.get_env(:agent_fabric_orchestrator, :autostart, false) do
        [
          {AgentFabricOrchestrator.Orchestrator,
           workflow_path: Application.fetch_env!(:agent_fabric_orchestrator, :workflow_path),
           socket_path: Application.fetch_env!(:agent_fabric_orchestrator, :socket_path),
           poll_interval_ms:
             Application.get_env(:agent_fabric_orchestrator, :poll_interval_ms, 30_000),
           concurrency: Application.get_env(:agent_fabric_orchestrator, :concurrency, 4)}
        ]
      else
        []
      end

    children = shared_children ++ dashboard_children ++ orchestrator_children

    Supervisor.start_link(children,
      strategy: :one_for_one,
      name: AgentFabricOrchestrator.Supervisor
    )
  end
end
