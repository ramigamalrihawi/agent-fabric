defmodule Mix.Tasks.Af.Orchestrator.Run do
  @moduledoc """
  Run the Agent Fabric Elixir orchestrator.

      mix af.orchestrator.run --workflow WORKFLOW.example.md --once --dry-run
      mix af.orchestrator.run --workflow WORKFLOW.example.md --watch --concurrency 4
  """

  use Mix.Task

  alias AgentFabricOrchestrator.{FabricClient, Orchestrator, Workflow}

  @shortdoc "Run the queue-visible Elixir poll/launch loop"

  @impl true
  def run(argv) do
    Mix.Task.run("app.config")

    {opts, _args, invalid} =
      OptionParser.parse(argv,
        strict: [
          workflow: :string,
          socket: :string,
          once: :boolean,
          watch: :boolean,
          concurrency: :integer,
          dry_run: :boolean,
          start: :boolean,
          json: :boolean
        ],
        aliases: [w: :workflow]
      )

    reject_invalid!(invalid)

    workflow_path =
      opts[:workflow] || env_or_config("AGENT_FABRIC_WORKFLOW", :workflow_path, "WORKFLOW.md")

    socket_path =
      opts[:socket] ||
        env_or_config("AGENT_FABRIC_SOCKET", :socket_path, FabricClient.default_socket_path())

    with {:ok, workflow} <- Workflow.load(workflow_path) do
      concurrency =
        opts[:concurrency] ||
          env_integer("AGENT_FABRIC_ELIXIR_CONCURRENCY") ||
          Workflow.runner_concurrency(
            workflow,
            Application.get_env(:agent_fabric_orchestrator, :concurrency, 4)
          )

      if opts[:dry_run] do
        emit(dry_run_report(workflow, workflow_path, socket_path, concurrency, opts), opts[:json])
      else
        run_orchestrator(workflow, workflow_path, socket_path, concurrency, opts)
      end
    else
      {:error, reason} ->
        Mix.raise("cannot load workflow: #{reason}")
    end
  end

  defp run_orchestrator(workflow, workflow_path, socket_path, concurrency, opts) do
    {:ok, _apps} = Application.ensure_all_started(:agent_fabric_orchestrator)

    {:ok, pid} =
      Orchestrator.start_link(
        workflow_path: workflow_path,
        socket_path: socket_path,
        concurrency: concurrency,
        start_execution: opts[:start] || Workflow.auto_start_execution?(workflow)
      )

    cond do
      opts[:once] || !opts[:watch] ->
        {:ok, status} = Orchestrator.poll_once(pid)
        emit(%{mode: "once", status: status}, opts[:json])
        GenServer.stop(pid, :normal)

      opts[:watch] ->
        Mix.shell().info("Agent Fabric Elixir orchestrator watching #{workflow_path}")
        Process.sleep(:infinity)
    end
  end

  defp dry_run_report(workflow, workflow_path, socket_path, concurrency, opts) do
    %{
      mode: "dry_run",
      workflow_path: workflow_path,
      socket_path: socket_path,
      project_path: Workflow.project_path(workflow),
      queue_id: Workflow.queue_id(workflow),
      queue_title: Workflow.queue_title(workflow),
      auto_start_execution: Workflow.auto_start_execution?(workflow) || opts[:start] || false,
      concurrency: concurrency,
      codex: Map.get(workflow.config, "codex", %{}),
      runner: Workflow.runner_config(workflow),
      state_dir: Workflow.state_dir(workflow)
    }
  end

  defp emit(payload, true), do: Mix.shell().info(Jason.encode!(payload, pretty: true))

  defp emit(%{mode: "dry_run"} = payload, _json) do
    Mix.shell().info("dry-run: #{payload.workflow_path}")
    Mix.shell().info("project: #{payload.project_path}")
    Mix.shell().info("queue: #{payload.queue_id || payload.queue_title}")
    Mix.shell().info("concurrency: #{payload.concurrency}")
    Mix.shell().info("state_dir: #{payload.state_dir}")
  end

  defp emit(payload, _json) do
    Mix.shell().info(Jason.encode!(payload, pretty: true))
  end

  defp env_or_config(env, key, default) do
    System.get_env(env) || Application.get_env(:agent_fabric_orchestrator, key, default)
  end

  defp env_integer(env) do
    case System.get_env(env) do
      nil ->
        nil

      value ->
        case Integer.parse(value) do
          {integer, ""} when integer > 0 -> integer
          _ -> nil
        end
    end
  end

  defp reject_invalid!([]), do: :ok

  defp reject_invalid!(invalid) do
    flags =
      invalid
      |> Enum.map(fn {flag, _value} -> to_string(flag) end)
      |> Enum.join(", ")

    Mix.raise("unknown option(s): #{flags}")
  end
end
