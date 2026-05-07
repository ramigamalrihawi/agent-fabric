defmodule Mix.Tasks.Af.Status do
  @moduledoc """
  Print Elixir runtime state and Agent Fabric queue health when available.

      mix af.status
      mix af.status --queue pqueue_123 --json
      mix af.status --queue pqueue_123 --project /path/to/project --json
      mix af.status --queue pqueue_123 --cleanup-dry-run --json
  """

  use Mix.Task

  alias AgentFabricOrchestrator.{FabricClient, FabricGateway}

  @shortdoc "Show Agent Fabric Elixir runtime and queue status"

  @impl true
  def run(argv) do
    Mix.Task.run("app.config")

    {opts, _args, invalid} =
      OptionParser.parse(argv,
        strict: [
          queue: :string,
          project: :string,
          socket: :string,
          json: :boolean,
          cleanup_dry_run: :boolean,
          cleanup_older_than_days: :integer,
          cleanup_limit: :integer
        ],
        aliases: [q: :queue]
      )

    reject_invalid!(invalid)

    payload = %{
      runtime: runtime_status(),
      queue: queue_status(opts)
    }

    if opts[:json] do
      Mix.shell().info(Jason.encode!(payload, pretty: true))
    else
      emit_text(payload)
    end
  end

  defp runtime_status do
    try do
      case Process.whereis(AgentFabricOrchestrator.Orchestrator) do
        nil ->
          %{orchestrator_alive: false, orchestator_alive: false}

        pid ->
          AgentFabricOrchestrator.Orchestrator.status(pid)
      end
    catch
      :exit, reason -> %{orchestrator_alive: false, error: inspect(reason)}
    end
  end

  defp queue_status(opts) do
    queue_id = opts[:queue]

    base =
      if queue_id in [nil, ""] do
        %{requested: false}
      else
        with {:ok, report} <-
               with_fabric_session(opts, fn socket_path, session, call_opts ->
                 FabricGateway.Uds.progress_report(socket_path, session, queue_id, call_opts)
               end) do
          %{requested: true, queue_id: queue_id, report: report}
        else
          {:error, reason} ->
            %{requested: true, queue_id: queue_id, error: inspect(reason)}
        end
      end

    if opts[:cleanup_dry_run] do
      Map.put(base, :cleanup, cleanup_preview(opts))
    else
      base
    end
  end

  defp cleanup_preview(opts) do
    queue_id = opts[:queue]
    project_path = opts[:project]

    if queue_id in [nil, ""] and project_path in [nil, ""] do
      %{requested: true, error: "--cleanup-dry-run requires --queue or --project"}
    else
      input =
        %{
          dryRun: true,
          queueId: queue_id,
          projectPath: project_path,
          olderThanDays: cleanup_older_than_days(opts),
          limit: cleanup_limit(opts)
        }
        |> Enum.reject(fn {_key, value} -> value in [nil, ""] end)
        |> Map.new()

      with {:ok, result} <-
             with_fabric_session(opts, fn socket_path, session, call_opts ->
               FabricGateway.Uds.cleanup_queues(socket_path, session, input, call_opts)
             end) do
        %{requested: true, dry_run: true, result: result}
      else
        {:error, reason} ->
          %{requested: true, dry_run: true, error: inspect(reason)}
      end
    end
  end

  defp with_fabric_session(opts, fun) do
    socket_path = socket_path(opts)
    project_root = project_root(opts)
    call_opts = fabric_call_opts(project_root)

    with {:ok, session} <-
           FabricGateway.Uds.register(socket_path, register_payload(project_root)) do
      result = fun.(socket_path, session, call_opts)
      _ = FabricGateway.Uds.close_session(socket_path, session, call_opts)
      result
    end
  end

  defp emit_text(%{runtime: runtime, queue: queue}) do
    Mix.shell().info(
      "orchestrator_alive: #{runtime[:orchestrator_alive] || runtime["orchestrator_alive"] || false}"
    )

    if runtime[:queue_id] || runtime["queue_id"] do
      Mix.shell().info("runtime_queue: #{runtime[:queue_id] || runtime["queue_id"]}")
    end

    if cursor =
         runtime[:poll_cursor] || runtime["poll_cursor"] || runtime[:last_poll_cursor] ||
           runtime["last_poll_cursor"] do
      Mix.shell().info("poll_cursor_after: #{cursor[:after] || cursor["after"] || "start"}")

      Mix.shell().info(
        "poll_cursor_has_next: #{cursor[:has_next_page] || cursor["has_next_page"] || false}"
      )
    end

    if queue[:requested] do
      Mix.shell().info("queue: #{queue[:queue_id]}")

      cond do
        queue[:error] ->
          Mix.shell().error("queue_error: #{queue[:error]}")

        report = queue[:report] ->
          status = get_in(report, ["summary", "status"]) || get_in(report, [:summary, :status])

          active =
            get_in(report, ["summary", "counts", "activeWorkers"]) ||
              get_in(report, [:summary, :counts, :activeWorkers])

          Mix.shell().info("queue_status: #{status || "unknown"}")
          Mix.shell().info("active_workers: #{active || 0}")

        true ->
          :ok
      end
    end

    if cleanup = queue[:cleanup] do
      emit_cleanup(cleanup)
    end
  end

  defp emit_cleanup(%{error: error}), do: Mix.shell().error("cleanup_error: #{error}")

  defp emit_cleanup(%{result: result}) do
    candidate_count = result["candidateCount"] || result[:candidateCount] || 0
    protected_count = result["protectedCount"] || result[:protectedCount] || 0
    totals = result["totals"] || result[:totals] || %{}
    estimated = totals["estimatedDeletedRows"] || totals[:estimatedDeletedRows] || 0

    Mix.shell().info("cleanup_dry_run: true")
    Mix.shell().info("cleanup_candidates: #{candidate_count}")
    Mix.shell().info("cleanup_protected: #{protected_count}")
    Mix.shell().info("cleanup_estimated_deleted_rows: #{estimated}")
  end

  defp emit_cleanup(_cleanup), do: :ok

  defp socket_path(opts) do
    opts[:socket] ||
      env_or_config("AGENT_FABRIC_SOCKET", :socket_path, FabricClient.default_socket_path())
  end

  defp project_root(opts) do
    case opts[:project] do
      nil -> nil
      "" -> nil
      path -> Path.expand(path)
    end
  end

  defp register_payload(nil), do: FabricClient.default_register_payload()

  defp register_payload(project_root) do
    FabricClient.default_register_payload()
    |> put_in([:workspace, :root], project_root)
    |> put_in([:workspace, :source], "project")
  end

  defp fabric_call_opts(nil), do: []
  defp fabric_call_opts(project_root), do: [workspace_root: project_root]

  defp cleanup_older_than_days(opts) do
    value = opts[:cleanup_older_than_days] || 7

    if is_integer(value) and value >= 0 do
      value
    else
      Mix.raise("--cleanup-older-than-days must be a non-negative integer")
    end
  end

  defp cleanup_limit(opts) do
    value = opts[:cleanup_limit] || 50

    if is_integer(value) and value > 0 do
      value
    else
      Mix.raise("--cleanup-limit must be a positive integer")
    end
  end

  defp env_or_config(env, key, default) do
    System.get_env(env) || Application.get_env(:agent_fabric_orchestrator, key, default)
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
