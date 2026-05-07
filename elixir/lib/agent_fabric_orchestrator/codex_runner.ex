defmodule AgentFabricOrchestrator.CodexRunner do
  @moduledoc """
  OTP-supervised Codex App Server worker runner.

  Launches a command in the issue workspace, sends/receives prompts,
  streams lifecycle events to Agent Fabric, heartbeats, checkpoints,
  and stops on request.

  Uses a `CodexRunner.Provider` behaviour so that tests can inject a
  fake process when the real Codex App Server is unavailable.

  ## Lifecycle

      1. `start_link/1` or `child_spec/1` — spawn the runner
      2. Provider process is launched → `command_spawned` event
      3. Provider connects/initializes → `command_started` event
      4. Heartbeat timer fires every `heartbeat_interval_ms`
      5. `command_finished` event when provider exits normally
      6. Stop/timeout → graceful termination with `:stopped` event

  ## Configuration

      config :agent_fabric_orchestrator, AgentFabricOrchestrator.CodexRunner,
        heartbeat_interval_ms: 30_000,
        default_timeout_ms: 600_000,
        provider: AgentFabricOrchestrator.CodexRunner.RealProvider
  """

  use GenServer

  require Logger

  alias AgentFabricOrchestrator.FabricClient

  # ── Struct ────────────────────────────────────────────────────────

  defstruct [
    :id,
    :workspace,
    :command,
    :provider_mod,
    :provider_pid,
    :fabric_session,
    :task_id,
    :worker_run_id,
    :socket_path,
    :project_path,
    :workspace_mode,
    :model_profile,
    :queue_id,
    :queue_task_id,
    :workflow_path,
    :issue_identifier,
    :heartbeat_interval_ms,
    :heartbeat_timer,
    :timeout_timer,
    :started_at,
    status: :initializing,
    lifecycle_events: [],
    timeout_ms: 600_000
  ]

  @type t :: %__MODULE__{
          id: String.t(),
          workspace: String.t(),
          command: String.t(),
          provider_mod: module(),
          provider_pid: pid() | nil,
          fabric_session: FabricClient.Session.t() | nil,
          task_id: String.t() | nil,
          worker_run_id: String.t() | nil,
          socket_path: String.t() | nil,
          project_path: String.t() | nil,
          workspace_mode: String.t(),
          model_profile: String.t(),
          queue_id: String.t() | nil,
          queue_task_id: String.t() | nil,
          workflow_path: String.t() | nil,
          issue_identifier: String.t() | nil,
          heartbeat_interval_ms: pos_integer(),
          heartbeat_timer: reference() | nil,
          timeout_timer: reference() | nil,
          started_at: DateTime.t(),
          status: :initializing | :running | :completed | :failed | :stopped,
          lifecycle_events: [lifecycle_event()],
          timeout_ms: pos_integer()
        }

  @type lifecycle_event :: %{
          kind: String.t(),
          timestamp: DateTime.t(),
          body: String.t() | nil,
          metadata: map()
        }

  @type option ::
          {:id, String.t()}
          | {:workspace, String.t()}
          | {:command, String.t()}
          | {:provider, module()}
          | {:socket_path, String.t()}
          | {:task_id, String.t()}
          | {:worker_run_id, String.t()}
          | {:project_path, String.t()}
          | {:workspace_mode, String.t()}
          | {:model_profile, String.t()}
          | {:queue_id, String.t()}
          | {:queue_task_id, String.t()}
          | {:workflow_path, String.t()}
          | {:issue_identifier, String.t()}
          | {:heartbeat_interval_ms, pos_integer()}
          | {:timeout_ms, pos_integer()}

  # ── Client API ────────────────────────────────────────────────────

  @doc """
  Returns a child_spec for use in a supervision tree.

  ## Options

    * `:id` — unique runner identifier (required)
    * `:workspace` — workspace directory path (required)
    * `:command` — command to launch (required)
    * `:provider` — provider module (default: configured provider)
    * `:socket_path` — Agent Fabric UDS path (default: from config)
    * `:task_id` — existing Agent Fabric task id to attach to
    * `:worker_run_id` — existing worker run id, when already registered
    * `:project_path` — project root reported to Agent Fabric
    * `:workspace_mode` — Agent Fabric workspace mode, default `"git_worktree"`
    * `:model_profile` — model/runtime profile, default `"codex-app-server"`
    * `:timeout_ms` — runner-level timeout (default: 600_000)
  """
  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts) do
    id = Keyword.fetch!(opts, :id)

    %{
      id: {__MODULE__, id},
      start: {__MODULE__, :start_link, [opts]},
      restart: :temporary,
      shutdown: 15_000,
      type: :worker
    }
  end

  @doc """
  Start a new CodexRunner GenServer (linked to caller).
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    genserver_opts =
      case Keyword.get(opts, :name) do
        nil -> []
        name -> [name: name]
      end

    GenServer.start_link(__MODULE__, opts, genserver_opts)
  end

  @doc """
  Send a prompt to the running Codex process.
  """
  @spec send_prompt(GenServer.server(), String.t()) :: :ok | {:error, term()}
  def send_prompt(server, prompt) when is_binary(prompt) do
    GenServer.call(server, {:send_prompt, prompt})
  end

  @doc """
  Request the runner to stop gracefully within `timeout_ms`.
  """
  @spec stop(GenServer.server(), pos_integer()) :: :ok
  def stop(server, timeout_ms \\ 15_000) do
    GenServer.call(server, {:stop, timeout_ms})
  end

  @doc """
  Get the runner's current status.
  """
  @spec status(GenServer.server()) :: map()
  def status(server) do
    GenServer.call(server, :status)
  end

  @doc """
  Record a checkpoint with an optional message and metadata.
  """
  @spec checkpoint(GenServer.server(), String.t(), map()) :: :ok
  def checkpoint(server, message, metadata \\ %{}) do
    GenServer.call(server, {:checkpoint, message, metadata})
  end

  # ── GenServer Callbacks ───────────────────────────────────────────

  @impl true
  def init(opts) do
    id = Keyword.fetch!(opts, :id)
    workspace = Keyword.fetch!(opts, :workspace)
    command = Keyword.fetch!(opts, :command)
    provider_mod = Keyword.get(opts, :provider, default_provider())
    socket_path = Keyword.get(opts, :socket_path, FabricClient.default_socket_path())
    timeout_ms = Keyword.get(opts, :timeout_ms, default_timeout_ms())
    task_id = Keyword.get(opts, :task_id)
    project_path = Keyword.get(opts, :project_path, workspace)
    workspace_mode = Keyword.get(opts, :workspace_mode, "git_worktree")
    model_profile = Keyword.get(opts, :model_profile, "codex-app-server")
    heartbeat_interval_ms = Keyword.get(opts, :heartbeat_interval_ms, heartbeat_interval_ms())

    state = %__MODULE__{
      id: id,
      workspace: workspace,
      command: command,
      provider_mod: provider_mod,
      socket_path: socket_path,
      task_id: task_id,
      worker_run_id: Keyword.get(opts, :worker_run_id),
      project_path: project_path,
      workspace_mode: workspace_mode,
      model_profile: model_profile,
      queue_id: Keyword.get(opts, :queue_id),
      queue_task_id: Keyword.get(opts, :queue_task_id),
      workflow_path: Keyword.get(opts, :workflow_path),
      issue_identifier: Keyword.get(opts, :issue_identifier),
      heartbeat_interval_ms: heartbeat_interval_ms,
      timeout_ms: timeout_ms,
      started_at: DateTime.utc_now(),
      status: :initializing,
      lifecycle_events: []
    }

    # Register a Fabric bridge session so lifecycle events are queue-visible
    state =
      case FabricClient.register(socket_path, register_payload(state)) do
        {:ok, session} ->
          %{state | fabric_session: session}

        {:error, reason} ->
          Logger.warning(
            "CodexRunner #{id}: could not register Fabric session: #{inspect(reason)}"
          )

          state
      end

    state = ensure_fabric_worker_run(state)

    # Launch the provider process
    case apply(provider_mod, :launch, [command, workspace]) do
      {:ok, provider_pid} ->
        Process.monitor(provider_pid)

        state =
          record_event(state, "command_spawned", "Launched command process", %{
            pid: inspect(provider_pid),
            command: command,
            workspace: workspace
          })

        send_lifecycle_event(state, "command_spawned")

        # Start heartbeat timer
        heartbeat_timer = Process.send_after(self(), :heartbeat, state.heartbeat_interval_ms)
        timeout_timer = Process.send_after(self(), :runtime_timeout, timeout_ms)

        Logger.info("CodexRunner #{id} started. Provider pid: #{inspect(provider_pid)}")
        state = record_event(state, "command_started", "Provider initialized", %{})
        send_lifecycle_event(state, "command_started")

        {:ok,
         %{
           state
           | status: :running,
             provider_pid: provider_pid,
             heartbeat_timer: heartbeat_timer,
             timeout_timer: timeout_timer
         }}

      {:error, reason} ->
        Logger.error("CodexRunner #{id} failed to launch: #{inspect(reason)}")
        state = record_event(state, "command_failed", "Failed to launch", %{error: reason})
        send_lifecycle_event(state, "command_failed")
        {:stop, reason}
    end
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply, status_map(state), state}
  end

  @impl true
  def handle_call({:send_prompt, prompt}, _from, state) do
    if state.status != :running do
      {:reply, {:error, :not_running}, state}
    else
      case apply(state.provider_mod, :send_input, [state.provider_pid, prompt]) do
        :ok ->
          state = record_event(state, "prompt_sent", prompt, %{})
          send_lifecycle_event(state, "prompt_sent")
          {:reply, :ok, state}

        {:error, reason} ->
          {:reply, {:error, reason}, state}
      end
    end
  end

  @impl true
  def handle_call({:stop, timeout_ms}, _from, state) do
    if state.provider_pid && apply(state.provider_mod, :alive?, [state.provider_pid]) do
      apply(state.provider_mod, :stop, [state.provider_pid, timeout_ms])
    end

    state = record_event(state, "command_stopping", "Stop requested", %{timeout_ms: timeout_ms})
    send_lifecycle_event(state, "command_stopping")
    state = cancel_timers(state)
    finish_fabric_task(state, "canceled", "Runner stopped by request")
    {:stop, :normal, :ok, %{state | status: :stopped}}
  end

  @impl true
  def handle_call({:checkpoint, message, metadata}, _from, state) do
    state = record_event(state, "checkpoint", message, metadata)
    send_lifecycle_event(state, "checkpoint")
    {:reply, :ok, state}
  end

  @impl true
  def handle_info({:provider_started, pid}, state) do
    Logger.debug("Provider #{inspect(pid)} confirmed start for runner #{state.id}")
    {:noreply, state}
  end

  @impl true
  def handle_info(:heartbeat, state) do
    if state.status == :running do
      Logger.debug("Heartbeat from runner #{state.id}")
      send_lifecycle_event(state, "heartbeat")

      timer = Process.send_after(self(), :heartbeat, state.heartbeat_interval_ms)
      {:noreply, %{state | heartbeat_timer: timer}}
    else
      {:noreply, state}
    end
  end

  @impl true
  def handle_info({:provider_output, output}, state) do
    state = record_event(state, "command_output", output, %{})
    send_lifecycle_event(state, "command_output")
    send_checkpoint(state, "Command output checkpoint", %{stdout_tail: tail(output)})
    {:noreply, state}
  end

  @impl true
  def handle_info({:provider_finished, status, metadata}, state) do
    kind = if status == :completed, do: "command_finished", else: "command_failed"
    body = if status == :completed, do: "Provider completed", else: "Provider failed"

    state =
      record_event(state, kind, body, Map.merge(%{provider_status: status}, metadata || %{}))

    send_lifecycle_event(state, kind)
    final_kind = if status == :completed, do: "completed", else: "failed"

    state =
      record_event(
        state,
        final_kind,
        body,
        Map.merge(%{provider_status: status}, metadata || %{})
      )

    send_lifecycle_event(state, final_kind)
    finish_status = if status == :completed, do: "completed", else: "failed"
    state = cancel_timers(state)
    finish_fabric_task(state, finish_status, body)
    {:stop, :normal, %{state | status: status, provider_pid: nil}}
  end

  @impl true
  def handle_info(:runtime_timeout, state) do
    if state.status == :running do
      Logger.warning("CodexRunner #{state.id} exceeded timeout #{state.timeout_ms}ms")

      if state.provider_pid && apply(state.provider_mod, :alive?, [state.provider_pid]) do
        apply(state.provider_mod, :stop, [state.provider_pid, 5_000])
      end

      state =
        record_event(state, "command_failed", "Runtime timeout exceeded", %{
          timeout_ms: state.timeout_ms
        })

      send_lifecycle_event(state, "command_failed")

      state =
        record_event(state, "failed", "Runtime timeout exceeded", %{timeout_ms: state.timeout_ms})

      send_lifecycle_event(state, "failed")
      finish_fabric_task(state, "failed", "Runtime timeout exceeded")
      {:stop, :normal, %{state | status: :failed, provider_pid: nil}}
    else
      {:noreply, state}
    end
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, reason}, state) do
    if state.provider_pid == pid do
      kind = if reason == :normal, do: "command_finished", else: "command_failed"

      state =
        record_event(state, kind, "Provider process exited: #{inspect(reason)}", %{
          reason: reason
        })

      final_status = if reason == :normal, do: :completed, else: :failed

      send_lifecycle_event(state, kind)
      final_kind = if final_status == :completed, do: "completed", else: "failed"

      state =
        record_event(state, final_kind, "Provider process exited: #{inspect(reason)}", %{
          reason: reason
        })

      send_lifecycle_event(state, final_kind)
      state = cancel_timers(state)

      finish_fabric_task(
        state,
        if(final_status == :completed, do: "completed", else: "failed"),
        "Provider process exited: #{inspect(reason)}"
      )

      {:stop, reason, %{state | status: final_status, provider_pid: nil}}
    else
      {:noreply, state}
    end
  end

  @impl true
  def handle_info({_ref, result} = msg, state) do
    case result do
      {:ok, output} ->
        send(self(), {:provider_finished, :completed, %{exit_code: 0, stdout_tail: tail(output)}})

      {:error, exit_code, output} ->
        send(
          self(),
          {:provider_finished, :failed, %{exit_code: exit_code, stdout_tail: tail(output)}}
        )

      _ ->
        Logger.debug("Runner #{state.id} received Task.async result: #{inspect(msg)}")
    end

    {:noreply, state}
  end

  @impl true
  def terminate(reason, state) do
    if state.heartbeat_timer do
      Process.cancel_timer(state.heartbeat_timer)
    end

    if state.timeout_timer do
      Process.cancel_timer(state.timeout_timer)
    end

    # Attempt graceful provider shutdown
    if state.provider_pid && state.status == :running do
      apply(state.provider_mod, :stop, [state.provider_pid, 5_000])
    end

    send_lifecycle_event(state, "runner_terminated")

    # Close Fabric session (best-effort — don't crash on failure)
    if state.fabric_session do
      try do
        _ = FabricClient.close_session(state.socket_path, state.fabric_session)
      catch
        _, _ -> :ok
      end
    end

    Logger.info("CodexRunner #{state.id} terminated: #{inspect(reason)}")
    :ok
  end

  # ── Private Helpers ───────────────────────────────────────────────

  defp record_event(state, kind, body, metadata) do
    event = %{
      kind: kind,
      timestamp: DateTime.utc_now(),
      body: body,
      metadata: metadata
    }

    %{state | lifecycle_events: [event | state.lifecycle_events]}
  end

  defp cancel_timers(state) do
    if state.heartbeat_timer do
      Process.cancel_timer(state.heartbeat_timer)
    end

    if state.timeout_timer do
      Process.cancel_timer(state.timeout_timer)
    end

    %{state | heartbeat_timer: nil, timeout_timer: nil}
  end

  defp send_lifecycle_event(state, kind) do
    if state.fabric_session == nil or state.task_id == nil or state.worker_run_id == nil do
      :ok
    else
      tool = if kind == "heartbeat", do: "fabric_task_heartbeat", else: "fabric_task_event"
      input = lifecycle_input(state, kind)

      case FabricClient.call(state.socket_path, state.fabric_session, tool, input,
             workspace_root: state.project_path
           ) do
        {:ok, _result} ->
          Logger.debug("Lifecycle event #{kind} sent for runner #{state.id}")

        {:error, reason} ->
          Logger.warning("Failed to send lifecycle event #{kind}: #{inspect(reason)}")
      end

      :ok
    end
  end

  defp register_payload(state) do
    put_in(FabricClient.default_register_payload(), [:workspace, :root], state.project_path)
  end

  defp send_checkpoint(state, current_goal, metadata) do
    if state.fabric_session == nil or state.task_id == nil or state.worker_run_id == nil do
      :ok
    else
      input = %{
        taskId: state.task_id,
        workerRunId: state.worker_run_id,
        summary: %{
          currentGoal: current_goal,
          filesTouched: [],
          commandsRun: [state.command],
          testsRun: [],
          failingTests: [],
          decisions: [],
          assumptions: [],
          blockers: [],
          nextAction: "Continue monitoring runner output",
          metadata: json_safe(Map.merge(base_metadata(state), metadata || %{}))
        }
      }

      case FabricClient.call(
             state.socket_path,
             state.fabric_session,
             "fabric_task_checkpoint",
             input,
             workspace_root: state.project_path
           ) do
        {:ok, _} -> :ok
        {:error, reason} -> Logger.warning("Failed to send checkpoint: #{inspect(reason)}")
      end
    end
  end

  defp finish_fabric_task(state, status, summary) do
    if state.fabric_session == nil or state.task_id == nil do
      :ok
    else
      input = %{
        taskId: state.task_id,
        workerRunId: state.worker_run_id,
        status: status,
        summary: summary
      }

      case FabricClient.call(state.socket_path, state.fabric_session, "fabric_task_finish", input,
             workspace_root: state.project_path
           ) do
        {:ok, _} ->
          :ok

        {:error, reason} ->
          Logger.warning("Failed to finish Fabric task #{state.task_id}: #{inspect(reason)}")
      end

      if state.queue_id && state.queue_task_id do
        queue_status = if status == "canceled", do: "canceled", else: status

        _ =
          FabricClient.call(
            state.socket_path,
            state.fabric_session,
            "project_queue_update_task",
            %{
              queueId: state.queue_id,
              queueTaskId: state.queue_task_id,
              workerRunId: state.worker_run_id,
              status: queue_status,
              summary: summary
            },
            workspace_root: state.project_path
          )
      end

      :ok
    end
  end

  defp ensure_fabric_worker_run(%{fabric_session: nil} = state), do: state
  defp ensure_fabric_worker_run(%{task_id: nil} = state), do: state

  defp ensure_fabric_worker_run(%{worker_run_id: worker_run_id} = state)
       when is_binary(worker_run_id),
       do: state

  defp ensure_fabric_worker_run(state) do
    input = %{
      taskId: state.task_id,
      worker: "codex-app-server",
      projectPath: state.project_path,
      workspaceMode: state.workspace_mode,
      modelProfile: state.model_profile,
      workspacePath: state.workspace,
      command: [state.command],
      metadata: %{
        runnerId: state.id,
        launchSource: "agent_fabric_elixir_orchestrator",
        workflowPath: state.workflow_path,
        issueIdentifier: state.issue_identifier,
        queueId: state.queue_id,
        queueTaskId: state.queue_task_id,
        runnerPid: inspect(self()),
        heartbeatIntervalMs: state.heartbeat_interval_ms,
        maxRuntimeMs: state.timeout_ms,
        command: state.command,
        workspace: state.workspace
      }
    }

    case FabricClient.call(
           state.socket_path,
           state.fabric_session,
           "fabric_task_start_worker",
           input,
           workspace_root: state.project_path
         ) do
      {:ok, %{"workerRunId" => worker_run_id}} ->
        %{state | worker_run_id: worker_run_id}

      {:ok, %{workerRunId: worker_run_id}} ->
        %{state | worker_run_id: worker_run_id}

      {:error, reason} ->
        Logger.warning(
          "CodexRunner #{state.id}: could not start Fabric worker run: #{inspect(reason)}"
        )

        state
    end
  end

  defp lifecycle_input(state, "heartbeat") do
    %{
      taskId: state.task_id,
      workerRunId: state.worker_run_id,
      task: state.id,
      metadata: base_metadata(state)
    }
  end

  defp lifecycle_input(state, kind) do
    latest = List.first(state.lifecycle_events) || %{body: nil, metadata: %{}}

    %{
      taskId: state.task_id,
      workerRunId: state.worker_run_id,
      kind: event_kind(kind),
      body: latest.body,
      metadata: json_safe(Map.merge(base_metadata(state), latest.metadata || %{}))
    }
  end

  defp base_metadata(state) do
    %{
      runnerId: state.id,
      launchSource: "agent_fabric_elixir_orchestrator",
      workflowPath: state.workflow_path,
      issueIdentifier: state.issue_identifier,
      queueId: state.queue_id,
      queueTaskId: state.queue_task_id,
      runnerPid: inspect(self()),
      workspace: state.workspace,
      command: state.command,
      status: Atom.to_string(state.status),
      heartbeatIntervalMs: state.heartbeat_interval_ms,
      maxRuntimeMs: state.timeout_ms,
      timestamp: DateTime.utc_now() |> DateTime.to_iso8601(),
      lifecycleEventCount: length(state.lifecycle_events)
    }
  end

  defp json_safe(value) when is_map(value) do
    value
    |> Enum.map(fn {key, item} -> {key, json_safe(item)} end)
    |> Map.new()
  end

  defp json_safe(value) when is_list(value), do: Enum.map(value, &json_safe/1)
  defp json_safe(value) when is_atom(value), do: Atom.to_string(value)
  defp json_safe(value) when is_pid(value), do: inspect(value)
  defp json_safe(value) when is_tuple(value), do: inspect(value)
  defp json_safe(value), do: value

  defp event_kind("command_spawned"), do: "command_spawned"
  defp event_kind("command_started"), do: "command_started"
  defp event_kind("command_finished"), do: "command_finished"
  defp event_kind("command_failed"), do: "failed"
  defp event_kind("completed"), do: "completed"
  defp event_kind("failed"), do: "failed"
  defp event_kind("checkpoint"), do: "checkpoint"
  defp event_kind("prompt_sent"), do: "thought_summary"
  defp event_kind("command_output"), do: "thought_summary"
  defp event_kind("command_stopping"), do: "checkpoint"
  defp event_kind("runner_terminated"), do: "checkpoint"
  defp event_kind(_kind), do: "checkpoint"

  defp status_map(state) do
    %{
      id: state.id,
      status: state.status,
      workspace: state.workspace,
      command: state.command,
      started_at: state.started_at,
      provider_pid: state.provider_pid && inspect(state.provider_pid),
      task_id: state.task_id,
      worker_run_id: state.worker_run_id,
      lifecycle_event_count: length(state.lifecycle_events),
      queue_id: state.queue_id,
      queue_task_id: state.queue_task_id,
      heartbeat_interval_ms: state.heartbeat_interval_ms,
      timeout_ms: state.timeout_ms
    }
  end

  defp tail(nil), do: nil

  defp tail(output) when is_binary(output) do
    if byte_size(output) > 4_000 do
      binary_part(output, byte_size(output), -4_000)
    else
      output
    end
  end

  defp tail(other), do: inspect(other)

  # ── Configuration ─────────────────────────────────────────────────

  defp heartbeat_interval_ms do
    Application.get_env(:agent_fabric_orchestrator, __MODULE__, [])
    |> Keyword.get(:heartbeat_interval_ms, 30_000)
  end

  defp default_timeout_ms do
    Application.get_env(:agent_fabric_orchestrator, __MODULE__, [])
    |> Keyword.get(:default_timeout_ms, 600_000)
  end

  defp default_provider do
    Application.get_env(:agent_fabric_orchestrator, __MODULE__, [])
    |> Keyword.get(:provider, AgentFabricOrchestrator.CodexRunner.RealProvider)
  end
end

# ── Provider Behaviour ──────────────────────────────────────────────

defmodule AgentFabricOrchestrator.CodexRunner.Provider do
  @moduledoc """
  Behaviour for CodexRunner process providers.

  A provider manages the low-level lifecycle of a command process.
  Real implementations launch OS processes; fake implementations
  simulate them for testing.
  """

  @doc """
  Launch a command process in the given workspace.
  Returns `{:ok, provider_pid}` or `{:error, reason}`.
  """
  @callback launch(command :: String.t(), workspace :: String.t()) ::
              {:ok, pid()} | {:error, term()}

  @doc """
  Send input to the running process.
  """
  @callback send_input(provider_pid :: pid(), input :: String.t()) :: :ok | {:error, term()}

  @doc """
  Stop the process gracefully within `timeout_ms`.
  """
  @callback stop(provider_pid :: pid(), timeout_ms :: pos_integer()) :: :ok | {:error, term()}

  @doc """
  Check if the process is alive.
  """
  @callback alive?(provider_pid :: pid()) :: boolean()

  @doc false
  def launch(provider_mod, command, workspace) do
    provider_mod.launch(command, workspace)
  end

  @doc false
  def send_input(provider_mod, provider_pid, input) do
    provider_mod.send_input(provider_pid, input)
  end

  @doc false
  def stop(provider_mod, provider_pid, timeout_ms) do
    provider_mod.stop(provider_pid, timeout_ms)
  end

  @doc false
  def alive?(provider_mod, provider_pid) do
    provider_mod.alive?(provider_pid)
  end
end

# ── Real Provider ───────────────────────────────────────────────────

defmodule AgentFabricOrchestrator.CodexRunner.RealProvider do
  @moduledoc """
  Real Codex App Server provider that launches actual OS processes via `System.cmd/3`.

  The process is wrapped in a Task so the runner can monitor it via
  process monitors. Provider process sends output back to the parent
  runner via message passing.
  """

  @behaviour AgentFabricOrchestrator.CodexRunner.Provider

  require Logger

  @impl true
  def launch(command, workspace) do
    parent = self()

    pid =
      spawn(fn ->
        Logger.info("Launching command in #{workspace}: #{command}")
        send(parent, {:provider_started, self()})

        case System.cmd("sh", ["-c", command], cd: workspace, stderr_to_stdout: true) do
          {output, 0} ->
            send(parent, {:provider_output, output})
            send(parent, {:provider_finished, :completed, %{exit_code: 0, stdout_tail: output}})

          {output, exit_code} ->
            send(parent, {:provider_output, output})

            send(
              parent,
              {:provider_finished, :failed, %{exit_code: exit_code, stdout_tail: output}}
            )
        end
      end)

    {:ok, pid}
  end

  @impl true
  def send_input(provider_pid, _input) do
    # Real providers don't accept interactive input via this channel;
    # prompts are passed as CLI args at launch time.
    Logger.warning("send_input not supported for RealProvider (pid: #{inspect(provider_pid)})")
    {:error, :not_supported}
  end

  @impl true
  def stop(provider_pid, timeout_ms) do
    ref = Process.monitor(provider_pid)

    # Attempt graceful shutdown
    Process.exit(provider_pid, :shutdown)

    receive do
      {:DOWN, ^ref, :process, ^provider_pid, _reason} -> :ok
    after
      timeout_ms ->
        Process.exit(provider_pid, :kill)
        :ok
    end
  end

  @impl true
  def alive?(provider_pid) do
    Process.alive?(provider_pid)
  end
end

# ── Fake Provider (for test use only) ───────────────────────────────

defmodule AgentFabricOrchestrator.CodexRunner.FakeProvider do
  @moduledoc """
  Fake Codex App Server provider for testing.

  Simulates a running process that responds to prompts with configurable
  outputs and can be stopped on request. Does not launch real OS processes.

  ## Configuration

      config :agent_fabric_orchestrator, AgentFabricOrchestrator.CodexRunner.FakeProvider,
        canned_outputs: ["Build successful", "Tests passed"],
        exit_after_prompts: 3,
        exit_reason: :normal
  """

  @behaviour AgentFabricOrchestrator.CodexRunner.Provider

  require Logger

  @doc false
  @impl true
  def launch(command, workspace) do
    parent = self()
    canned = canned_outputs()
    exit_after = exit_after_prompts()

    pid =
      spawn(fn ->
        Process.put(:fake_prompt_count, 0)
        Process.put(:fake_exit_after, exit_after)
        Process.put(:fake_canned, canned)
        Process.put(:fake_command, command)
        Process.put(:fake_workspace, workspace)

        send(parent, {:provider_started, self()})

        # Send initial canned output
        Enum.each(canned, fn output ->
          send(parent, {:provider_output, output})
          Process.sleep(10)
        end)

        # Wait for prompts or exit signal
        case fake_loop(parent) do
          {:ok, output} ->
            send(parent, {:provider_finished, :completed, %{stdout_tail: output}})

          {:error, reason} ->
            send(parent, {:provider_finished, :failed, %{error: reason}})
        end
      end)

    {:ok, pid}
  end

  @impl true
  def send_input(provider_pid, input) do
    send(provider_pid, {:fake_prompt, input, self()})
    :ok
  end

  @impl true
  def stop(provider_pid, timeout_ms) do
    ref = Process.monitor(provider_pid)

    send(provider_pid, {:fake_stop, timeout_ms})

    receive do
      {:DOWN, ^ref, :process, ^provider_pid, _reason} -> :ok
    after
      timeout_ms ->
        Process.exit(provider_pid, :kill)
        :ok
    end
  end

  @impl true
  def alive?(provider_pid) do
    Process.alive?(provider_pid)
  end

  # ── Fake Loop ─────────────────────────────────────────────────────

  defp fake_loop(parent) do
    receive do
      {:fake_prompt, input, _sender} ->
        count = Process.get(:fake_prompt_count, 0) + 1
        Process.put(:fake_prompt_count, count)

        if count >= Process.get(:fake_exit_after, 999) do
          send(parent, {:provider_output, "[Fake] exiting after #{count} prompts"})
          {:ok, "fake completed after #{count} prompts"}
        else
          send(parent, {:provider_output, "[Fake] received: #{input} (prompt ##{count})"})
          fake_loop(parent)
        end

      {:fake_stop, _timeout} ->
        send(parent, {:provider_output, "[Fake] stopping on request"})
        {:ok, "fake stopped"}

      msg ->
        Logger.debug("FakeProvider received unexpected: #{inspect(msg)}")
        fake_loop(parent)
    end
  end

  # ── Configuration ─────────────────────────────────────────────────

  defp canned_outputs do
    Application.get_env(:agent_fabric_orchestrator, __MODULE__, [])
    |> Keyword.get(:canned_outputs, [])
  end

  defp exit_after_prompts do
    Application.get_env(:agent_fabric_orchestrator, __MODULE__, [])
    |> Keyword.get(:exit_after_prompts, 3)
  end
end
