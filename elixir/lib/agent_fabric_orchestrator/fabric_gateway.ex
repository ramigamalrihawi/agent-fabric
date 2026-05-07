defmodule AgentFabricOrchestrator.FabricGateway do
  @moduledoc """
  Migration seam for Agent Fabric daemon calls.

  The Elixir runtime talks to Agent Fabric through this behaviour instead of
  scattering raw `FabricClient.call/5` invocations through orchestration code.
  The first implementation is UDS-backed and deliberately uses only public
  bridge tools. Agent Fabric's TypeScript daemon remains canonical for queues,
  worker runs, lifecycle events, approvals, costs, patch review, and SQLite.
  """

  alias AgentFabricOrchestrator.FabricClient

  @type session :: FabricClient.Session.t()
  @type socket_path :: String.t()
  @type result :: {:ok, map()} | {:error, term()}

  @callback register(socket_path(), map(), keyword()) :: {:ok, session()} | {:error, term()}
  @callback close_session(socket_path(), session(), keyword()) :: result()
  @callback create_queue(socket_path(), session(), map(), keyword()) :: result()
  @callback queue_status(socket_path(), session(), String.t(), keyword()) :: result()
  @callback progress_report(socket_path(), session(), String.t(), keyword()) :: result()
  @callback dashboard(socket_path(), session(), String.t(), map(), keyword()) :: result()
  @callback agent_lanes(socket_path(), session(), String.t(), map(), keyword()) :: result()
  @callback timeline(socket_path(), session(), String.t(), map(), keyword()) :: result()
  @callback cleanup_queues(socket_path(), session(), map(), keyword()) :: result()
  @callback recover_stale(socket_path(), session(), map(), keyword()) :: result()
  @callback decide_queue(socket_path(), session(), String.t(), String.t(), String.t(), keyword()) ::
              result()
  @callback add_task(socket_path(), session(), String.t(), map(), keyword()) :: result()
  @callback claim_next(socket_path(), session(), String.t(), map(), keyword()) :: result()
  @callback assign_worker(socket_path(), session(), String.t(), String.t(), String.t(), keyword()) ::
              result()
  @callback update_task(
              socket_path(),
              session(),
              String.t(),
              String.t(),
              String.t(),
              map(),
              keyword()
            ) ::
              result()
  @callback start_worker(socket_path(), session(), map(), keyword()) :: result()
  @callback event(socket_path(), session(), map(), keyword()) :: result()
  @callback heartbeat(socket_path(), session(), map(), keyword()) :: result()
  @callback checkpoint(socket_path(), session(), map(), keyword()) :: result()
  @callback finish(socket_path(), session(), map(), keyword()) :: result()
  @callback task_status(socket_path(), session(), String.t(), keyword()) :: result()

  # --- Read-only wrappers for new queue APIs ---
  @callback worker_health(socket_path(), session(), String.t(), keyword()) :: result()
  @callback task_tail(socket_path(), session(), String.t(), String.t(), keyword()) :: result()
  @callback patch_review_plan(socket_path(), session(), String.t(), keyword()) :: result()
  @callback collab_summary(socket_path(), session(), String.t(), keyword()) :: result()
end

defmodule AgentFabricOrchestrator.FabricGateway.Uds do
  @moduledoc """
  Public-tool UDS implementation of `AgentFabricOrchestrator.FabricGateway`.
  """

  @behaviour AgentFabricOrchestrator.FabricGateway

  alias AgentFabricOrchestrator.FabricClient

  @impl true
  def register(socket_path, payload \\ FabricClient.default_register_payload(), opts \\ []) do
    FabricClient.register(socket_path, payload, opts)
  end

  @impl true
  def close_session(socket_path, session, opts \\ []) do
    FabricClient.close_session(socket_path, session, opts)
  end

  @impl true
  def create_queue(socket_path, session, input, opts \\ []) do
    call(socket_path, session, "project_queue_create", input, opts)
  end

  @impl true
  def queue_status(socket_path, session, queue_id, opts \\ []) do
    call(socket_path, session, "project_queue_status", %{queueId: queue_id}, opts)
  end

  @impl true
  def progress_report(socket_path, session, queue_id, opts \\ []) do
    call(socket_path, session, "project_queue_progress_report", %{queueId: queue_id}, opts)
  end

  @impl true
  def dashboard(socket_path, session, queue_id, input \\ %{}, opts \\ []) do
    payload = Map.put(input, :queueId, queue_id)
    call(socket_path, session, "project_queue_dashboard", payload, opts)
  end

  @impl true
  def agent_lanes(socket_path, session, queue_id, input \\ %{}, opts \\ []) do
    payload = Map.put(input, :queueId, queue_id)
    call(socket_path, session, "project_queue_agent_lanes", payload, opts)
  end

  @impl true
  def timeline(socket_path, session, queue_id, input \\ %{}, opts \\ []) do
    payload = Map.put(input, :queueId, queue_id)
    call(socket_path, session, "project_queue_timeline", payload, opts)
  end

  @impl true
  def cleanup_queues(socket_path, session, input, opts \\ []) do
    payload =
      input
      |> Map.delete("dryRun")
      |> Map.put(:dryRun, true)

    call(socket_path, session, "project_queue_cleanup", payload, opts)
  end

  @impl true
  def recover_stale(socket_path, session, input, opts \\ []) do
    payload =
      input
      |> Map.delete("dryRun")
      |> Map.put(:dryRun, true)

    call(socket_path, session, "project_queue_recover_stale", payload, opts)
  end

  @impl true
  def decide_queue(socket_path, session, queue_id, decision, note, opts \\ []) do
    call(
      socket_path,
      session,
      "project_queue_decide",
      %{queueId: queue_id, decision: decision, note: note},
      opts
    )
  end

  @impl true
  def add_task(socket_path, session, queue_id, task, opts \\ []) do
    call(
      socket_path,
      session,
      "project_queue_add_tasks",
      %{queueId: queue_id, tasks: [task]},
      opts
    )
  end

  @impl true
  def claim_next(socket_path, session, queue_id, input, opts \\ []) do
    call(
      socket_path,
      session,
      "project_queue_claim_next",
      Map.put(input, :queueId, queue_id),
      opts
    )
  end

  @impl true
  def assign_worker(socket_path, session, queue_id, queue_task_id, worker_run_id, opts \\ []) do
    call(
      socket_path,
      session,
      "project_queue_assign_worker",
      %{queueId: queue_id, queueTaskId: queue_task_id, workerRunId: worker_run_id},
      opts
    )
  end

  @impl true
  def update_task(socket_path, session, queue_id, queue_task_id, status, input, opts \\ []) do
    payload =
      input
      |> Map.put(:queueId, queue_id)
      |> Map.put(:queueTaskId, queue_task_id)
      |> Map.put(:status, status)

    call(socket_path, session, "project_queue_update_task", payload, opts)
  end

  @impl true
  def start_worker(socket_path, session, input, opts \\ []) do
    call(socket_path, session, "fabric_task_start_worker", input, opts)
  end

  @impl true
  def event(socket_path, session, input, opts \\ []) do
    call(socket_path, session, "fabric_task_event", input, opts)
  end

  @impl true
  def heartbeat(socket_path, session, input, opts \\ []) do
    call(socket_path, session, "fabric_task_heartbeat", input, opts)
  end

  @impl true
  def checkpoint(socket_path, session, input, opts \\ []) do
    call(socket_path, session, "fabric_task_checkpoint", input, opts)
  end

  @impl true
  def finish(socket_path, session, input, opts \\ []) do
    call(socket_path, session, "fabric_task_finish", input, opts)
  end

  @impl true
  def task_status(socket_path, session, task_id, opts \\ []) do
    input = %{
      taskId: task_id,
      includeEvents: opts[:include_events] || false,
      includeCheckpoints: opts[:include_checkpoints] || false
    }

    call(socket_path, session, "fabric_task_status", input, opts)
  end

  # --- Read-only wrappers for new queue APIs ---

  @impl true
  def worker_health(socket_path, session, queue_id, opts \\ []) do
    payload =
      %{
        queueId: queue_id,
        staleAfterMinutes: Keyword.get(opts, :stale_after_minutes)
      }
      |> compact_payload()

    call(socket_path, session, "project_queue_worker_health", payload, opts)
  end

  @impl true
  def task_tail(socket_path, session, queue_id, queue_task_id, opts \\ []) do
    payload =
      %{
        queueId: queue_id,
        queueTaskId: queue_task_id,
        maxLines: Keyword.get(opts, :max_lines, Keyword.get(opts, :max_events_per_run, 200)),
        maxBytes: Keyword.get(opts, :max_bytes)
      }
      |> compact_payload()

    call(socket_path, session, "fabric_task_tail", payload, opts)
  end

  @impl true
  def patch_review_plan(socket_path, session, queue_id, opts \\ []) do
    call(socket_path, session, "project_queue_patch_review_plan", %{queueId: queue_id}, opts)
  end

  @impl true
  def collab_summary(socket_path, session, queue_id, opts \\ []) do
    call(socket_path, session, "project_queue_collab_summary", %{queueId: queue_id}, opts)
  end

  defp compact_payload(payload) do
    payload
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp call(socket_path, session, tool, input, opts) do
    FabricClient.call(socket_path, session, tool, stringify_keys(input), opts)
  end

  defp stringify_keys(value) when is_map(value) do
    Map.new(value, fn {key, item} -> {key_to_string(key), stringify_keys(item)} end)
  end

  defp stringify_keys(value) when is_list(value), do: Enum.map(value, &stringify_keys/1)
  defp stringify_keys(value), do: value

  defp key_to_string(key) when is_atom(key), do: Atom.to_string(key)
  defp key_to_string(key), do: key
end
