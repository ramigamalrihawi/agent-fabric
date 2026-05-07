defmodule AgentFabricOrchestrator.MixProject do
  use Mix.Project

  def project do
    [
      app: :agent_fabric_orchestrator,
      version: "0.1.0",
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger, :inets, :ssl],
      mod: {AgentFabricOrchestrator.Application, []}
    ]
  end

  defp deps do
    [
      {:jason, "~> 1.4"},
      {:yaml_elixir, "~> 2.12"}
    ]
  end
end
