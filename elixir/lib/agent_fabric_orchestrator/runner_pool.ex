defmodule AgentFabricOrchestrator.RunnerPool do
  @moduledoc """
  OTP-facing runner pool for queue-visible Codex App Server lanes.

  The pool is the Elixir runtime seam that owns local runner process lifecycle:
  it prevents duplicate runners for the same issue identifier, starts children
  under `RunnerSupervisor`, monitors exits, and exposes compact status for
  operators and dashboard consumers. Agent Fabric remains the durable source of
  truth for queue tasks, worker runs, lifecycle events, patches, approvals, and
  costs.
  """

  use GenServer

  require Logger

  alias AgentFabricOrchestrator.{CodexRunner, RunnerRegistry, RunnerSupervisor}

  @type runner_info :: %{
          issue_identifier: String.t(),
          pid: pid(),
          runner: module(),
          started_at: DateTime.t(),
          alive: boolean()
        }

  defstruct max_runners: nil,
            runners: %{},
            refs: %{}

  @doc "Start the runner pool."
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    genserver_opts = if name, do: [name: name], else: []
    GenServer.start_link(__MODULE__, opts, genserver_opts)
  end

  @doc """
  Start one runner for an issue identifier.

  The duplicate guard is based on the issue identifier, not the runner id, so
  retry paths cannot accidentally launch a second local process for the same
  queue-visible unit of work.
  """
  def start_runner(issue_identifier, runner_args)
      when is_binary(issue_identifier) and is_list(runner_args) do
    start_runner(__MODULE__, issue_identifier, CodexRunner, runner_args)
  end

  def start_runner(issue_identifier, runner_module, runner_args)
      when is_binary(issue_identifier) and is_atom(runner_module) and is_list(runner_args) do
    start_runner(__MODULE__, issue_identifier, runner_module, runner_args)
  end

  def start_runner(server, issue_identifier, runner_module, runner_args)
      when is_binary(issue_identifier) and is_atom(runner_module) and is_list(runner_args) do
    case resolve_server(server) do
      nil ->
        start_runner_without_pool(issue_identifier, runner_module, runner_args)

      resolved ->
        GenServer.call(resolved, {:start_runner, issue_identifier, runner_module, runner_args})
    end
  end

  @doc "Stop and unregister the runner for an issue identifier. Missing runners are treated as already stopped."
  def stop_runner(server \\ __MODULE__, issue_identifier) when is_binary(issue_identifier) do
    case resolve_server(server) do
      nil -> stop_runner_without_pool(issue_identifier)
      resolved -> GenServer.call(resolved, {:stop_runner, issue_identifier})
    end
  end

  @doc "Return all live or recently-known runner entries."
  def list_runners(server \\ __MODULE__) do
    case resolve_server(server) do
      nil -> registry_entries()
      resolved -> GenServer.call(resolved, :list_runners)
    end
  end

  @doc "Return runner status for one issue identifier."
  def runner_status(server \\ __MODULE__, issue_identifier) when is_binary(issue_identifier) do
    case resolve_server(server) do
      nil -> fallback_runner_status(issue_identifier)
      resolved -> GenServer.call(resolved, {:runner_status, issue_identifier})
    end
  end

  @doc "Return pool status suitable for JSON dashboards and Mix task output."
  def status(server \\ __MODULE__) do
    case resolve_server(server) do
      nil ->
        runners = registry_entries()

        %{
          alive: false,
          max_runners: nil,
          active: Enum.count(runners, & &1.alive),
          runners: runners
        }

      resolved ->
        GenServer.call(resolved, :status)
    end
  end

  @doc "Return active live runner count."
  def active_count(server \\ __MODULE__) do
    status(server).active
  end

  @impl true
  def init(opts) do
    RunnerRegistry.ensure_table()

    {:ok,
     %__MODULE__{
       max_runners: Keyword.get(opts, :max_runners)
     }}
  end

  @impl true
  def handle_call({:start_runner, issue_identifier, runner_module, runner_args}, _from, state) do
    state = prune_dead_runner(state, issue_identifier)

    cond do
      active_runner?(issue_identifier) ->
        {:reply,
         {:error,
          {:runner_already_active, issue_identifier, RunnerRegistry.lookup(issue_identifier)}},
         state}

      at_capacity?(state) ->
        {:reply, {:error, :at_capacity}, state}

      true ->
        case start_runner_child(issue_identifier, runner_module, runner_args) do
          {:ok, pid} ->
            ref = Process.monitor(pid)

            next = %{
              state
              | runners:
                  Map.put(state.runners, issue_identifier, %{
                    issue_identifier: issue_identifier,
                    pid: pid,
                    runner: runner_module,
                    started_at: DateTime.utc_now(),
                    alive: true
                  }),
                refs: Map.put(state.refs, ref, issue_identifier)
            }

            {:reply, {:ok, pid}, next}

          {:error, reason} ->
            {:reply, {:error, reason}, state}
        end
    end
  end

  @impl true
  def handle_call({:stop_runner, issue_identifier}, _from, state) do
    pid =
      RunnerRegistry.lookup(issue_identifier) || get_in(state.runners, [issue_identifier, :pid])

    if is_pid(pid) and Process.alive?(pid) do
      _ = DynamicSupervisor.terminate_child(RunnerSupervisor, pid)
    end

    RunnerRegistry.unregister(issue_identifier)
    {:reply, :ok, remove_runner(state, issue_identifier)}
  end

  @impl true
  def handle_call(:list_runners, _from, state) do
    {:reply, runner_entries(state), state}
  end

  @impl true
  def handle_call({:runner_status, issue_identifier}, _from, state) do
    {:reply, runner_status_from_state(state, issue_identifier), state}
  end

  @impl true
  def handle_call(:status, _from, state) do
    runners = runner_entries(state)

    {:reply,
     %{
       alive: true,
       max_runners: state.max_runners,
       active: Enum.count(runners, & &1.alive),
       runners: runners
     }, state}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, pid, reason}, state) do
    case Map.pop(state.refs, ref) do
      {nil, refs} ->
        {:noreply, %{state | refs: refs}}

      {issue_identifier, refs} ->
        Logger.info(
          "Runner #{issue_identifier} exited (pid #{inspect(pid)}, reason #{inspect(reason)})"
        )

        if RunnerRegistry.lookup(issue_identifier) == pid do
          RunnerRegistry.unregister(issue_identifier)
        end

        {:noreply, %{remove_runner(state, issue_identifier) | refs: refs}}
    end
  end

  defp start_runner_without_pool(issue_identifier, runner_module, runner_args) do
    cond do
      active_runner?(issue_identifier) ->
        {:error,
         {:runner_already_active, issue_identifier, RunnerRegistry.lookup(issue_identifier)}}

      true ->
        case start_runner_child(issue_identifier, runner_module, runner_args) do
          {:ok, _pid} = ok -> ok
          {:error, _reason} = error -> error
        end
    end
  end

  defp stop_runner_without_pool(issue_identifier) do
    case RunnerRegistry.lookup(issue_identifier) do
      nil ->
        :ok

      pid ->
        if Process.alive?(pid) do
          _ = DynamicSupervisor.terminate_child(RunnerSupervisor, pid)
        end

        RunnerRegistry.unregister(issue_identifier)
        :ok
    end
  end

  defp start_runner_child(issue_identifier, runner_module, runner_args) do
    case RunnerRegistry.lookup(issue_identifier) do
      pid when is_pid(pid) ->
        if Process.alive?(pid) do
          {:error, {:runner_already_active, issue_identifier, pid}}
        else
          RunnerRegistry.unregister(issue_identifier)
          do_start_runner_child(issue_identifier, runner_module, runner_args)
        end

      _ ->
        do_start_runner_child(issue_identifier, runner_module, runner_args)
    end
  end

  defp do_start_runner_child(issue_identifier, runner_module, runner_args) do
    case DynamicSupervisor.start_child(RunnerSupervisor, {runner_module, runner_args}) do
      {:ok, pid} ->
        RunnerRegistry.register(issue_identifier, pid)
        {:ok, pid}

      {:ok, pid, _info} ->
        RunnerRegistry.register(issue_identifier, pid)
        {:ok, pid}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp resolve_server(pid) when is_pid(pid), do: if(Process.alive?(pid), do: pid, else: nil)

  defp resolve_server(name) when is_atom(name) do
    case Process.whereis(name) do
      nil -> nil
      pid -> pid
    end
  end

  defp resolve_server(_), do: nil

  defp active_runner?(issue_identifier) do
    case RunnerRegistry.lookup(issue_identifier) do
      pid when is_pid(pid) -> Process.alive?(pid)
      _ -> false
    end
  end

  defp at_capacity?(%{max_runners: nil}), do: false
  defp at_capacity?(%{max_runners: max}) when not is_integer(max), do: false

  defp at_capacity?(%{max_runners: max} = state),
    do: Enum.count(runner_entries(state), & &1.alive) >= max

  defp prune_dead_runner(state, issue_identifier) do
    case RunnerRegistry.lookup(issue_identifier) do
      pid when is_pid(pid) ->
        if Process.alive?(pid) do
          state
        else
          RunnerRegistry.unregister(issue_identifier)
          remove_runner(state, issue_identifier)
        end

      _ ->
        remove_runner(state, issue_identifier)
    end
  end

  defp remove_runner(state, issue_identifier) do
    refs =
      state.refs
      |> Enum.reject(fn {_ref, value} -> value == issue_identifier end)
      |> Map.new()

    %{state | runners: Map.delete(state.runners, issue_identifier), refs: refs}
  end

  defp runner_entries(state) do
    state.runners
    |> Map.values()
    |> Enum.map(fn info -> %{info | alive: Process.alive?(info.pid)} end)
    |> Kernel.++(unknown_registry_entries(state))
    |> Enum.sort_by(& &1.issue_identifier)
  end

  defp unknown_registry_entries(state) do
    known = MapSet.new(Map.keys(state.runners))

    registry_entries()
    |> Enum.reject(&MapSet.member?(known, &1.issue_identifier))
  end

  defp registry_entries do
    RunnerRegistry.entries()
    |> Enum.map(fn {issue_identifier, pid} ->
      %{
        issue_identifier: issue_identifier,
        pid: pid,
        runner: nil,
        started_at: nil,
        alive: is_pid(pid) and Process.alive?(pid)
      }
    end)
  end

  defp runner_status_from_state(state, issue_identifier) do
    case Map.get(state.runners, issue_identifier) do
      %{pid: pid, runner: runner} = info ->
        status_for_pid(pid, runner, info)

      nil ->
        fallback_runner_status(issue_identifier)
    end
  end

  defp fallback_runner_status(issue_identifier) do
    case RunnerRegistry.lookup(issue_identifier) do
      pid when is_pid(pid) ->
        status_for_pid(pid, CodexRunner, %{
          issue_identifier: issue_identifier,
          pid: pid,
          runner: CodexRunner,
          started_at: nil
        })

      _ ->
        nil
    end
  end

  defp status_for_pid(pid, runner, info) do
    alive = Process.alive?(pid)

    runner_status =
      if alive and function_exported?(runner, :status, 1) do
        try do
          runner.status(pid)
        catch
          _, reason -> %{error: inspect(reason)}
        end
      else
        nil
      end

    info
    |> Map.put(:alive, alive)
    |> Map.put(:status, runner_status)
  end
end
