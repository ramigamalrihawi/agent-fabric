defmodule AgentFabricOrchestrator.Orchestrator do
  @moduledoc """
  Tracker-to-Agent-Fabric orchestration loop.

  The orchestrator polls the tracker (Linear), normalizes issues, and manages the
  full lifecycle: creates or resumes Agent Fabric queue/task state, starts
  supervised Codex runners under concurrency limits, reconciles terminal issues by
  stopping active runs, and records failures with exponential backoff.

  It never writes SQLite directly. All durable state flows through the Agent
  Fabric daemon's UDS API via `AgentFabricOrchestrator.FabricClient`.
  """

  use GenServer
  require Logger

  alias AgentFabricOrchestrator.{Linear, Workflow, Workspace, FabricClient}

  @default_concurrency 4
  @default_poll_interval_ms 30_000
  @backoff_base_ms 10_000
  @backoff_max_ms 600_000
  @backoff_factor 2

  # ── per-issue runtime record ────────────────────────────────────────────────

  defmodule IssueRecord do
    @moduledoc "Orchestrator runtime tracking for one tracked issue."
    defstruct [
      :issue,
      :fabric_task_id,
      :queue_task_id,
      :queue_id,
      :worker_run_id,
      :runner_pid,
      :workspace_path,
      :failure_count,
      :last_failure_at,
      :backoff_until,
      :last_error,
      status: :pending
    ]

    @type t :: %__MODULE__{
            issue: Linear.Issue.t(),
            fabric_task_id: String.t() | nil,
            queue_task_id: String.t() | nil,
            queue_id: String.t() | nil,
            worker_run_id: String.t() | nil,
            runner_pid: pid() | nil,
            workspace_path: String.t() | nil,
            failure_count: non_neg_integer(),
            last_failure_at: DateTime.t() | nil,
            backoff_until: DateTime.t() | nil,
            last_error: term(),
            status: :pending | :queued | :running | :terminal | :failed
          }
  end

  # ── orchestrator GenServer state ────────────────────────────────────────────

  defstruct [
    :workflow,
    :socket_path,
    :fabric_session,
    :queue_id,
    poll_interval_ms: @default_poll_interval_ms,
    concurrency: @default_concurrency,
    tracker: AgentFabricOrchestrator.Linear,
    runner: AgentFabricOrchestrator.CodexRunner,
    issues: %{},
    active_runners: 0,
    last_error: nil,
    consecutive_failures: 0
  ]

  @type state :: %__MODULE__{
          workflow: Workflow.t(),
          socket_path: String.t(),
          fabric_session: FabricClient.Session.t() | nil,
          queue_id: String.t() | nil,
          poll_interval_ms: pos_integer(),
          concurrency: pos_integer(),
          tracker: module(),
          runner: module(),
          issues: %{String.t() => IssueRecord.t()},
          active_runners: non_neg_integer(),
          last_error: term(),
          consecutive_failures: non_neg_integer()
        }

  # ── Client API ─────────────────────────────────────────────────────────────

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc "Return the orchestrator's runtime state map."
  def status do
    GenServer.call(__MODULE__, :status)
  end

  @doc "Trigger an immediate poll cycle."
  def poll_now do
    GenServer.cast(__MODULE__, :poll_now)
  end

  # ── GenServer Callbacks ─────────────────────────────────────────────────────

  @impl true
  def init(opts) do
    workflow_path = Keyword.fetch!(opts, :workflow_path)
    socket_path = Keyword.fetch!(opts, :socket_path)

    workflow =
      case Workflow.load(workflow_path) do
        {:ok, wf} -> wf
        {:error, reason} -> raise ArgumentError, "cannot load workflow: #{reason}"
      end

    state = %__MODULE__{
      workflow: workflow,
      socket_path: socket_path,
      poll_interval_ms: Keyword.get(opts, :poll_interval_ms, @default_poll_interval_ms),
      concurrency: Keyword.get(opts, :concurrency, @default_concurrency),
      tracker: Keyword.get(opts, :tracker, Linear),
      runner: Keyword.get(opts, :runner, AgentFabricOrchestrator.CodexRunner)
    }

    # Ensure a bridge session exists before the first poll
    with {:ok, session} <- FabricClient.register(state.socket_path) do
      Logger.info("Orchestrator registered bridge session #{session.session_id}")
      next = %{state | fabric_session: session}
      schedule_poll(next)
      {:ok, next}
    else
      {:error, reason} ->
        Logger.error("Orchestrator bridge registration failed: #{inspect(reason)}")
        schedule_poll(state)
        {:ok, %{state | last_error: reason}}
    end
  end

  @impl true
  def handle_call(:status, _from, state) do
    reply = %{
      active_runners: state.active_runners,
      concurrency: state.concurrency,
      issue_count: map_size(state.issues),
      queue_id: state.queue_id,
      session_id: state.fabric_session && state.fabric_session.session_id,
      last_error: state.last_error,
      consecutive_failures: state.consecutive_failures,
      issues_by_status:
        state.issues
        |> Enum.group_by(fn {_k, v} -> v.status end, fn {_k, v} -> v.issue.identifier end)
    }

    {:reply, reply, state}
  end

  @impl true
  def handle_cast(:poll_now, state) do
    handle_info(:poll, state)
  end

  @impl true
  def handle_info(:poll, state) do
    next = do_poll(state)
    schedule_poll(next)
    {:noreply, next}
  end

  @impl true
  def handle_info({:runner_done, issue_identifier, result}, state) do
    Logger.info("Runner done for #{issue_identifier}: #{inspect(Map.take(result, [:status, :exit_code]))}")

    next =
      update_in(state.issues[issue_identifier], fn rec ->
        case result do
          %{status: :ok} ->
            %{rec | status: :terminal, runner_pid: nil}

          %{status: :error} ->
            %{
              rec
              | status: :failed,
                runner_pid: nil,
                failure_count: (rec.failure_count || 0) + 1,
                last_failure_at: DateTime.utc_now(),
                last_error: result[:error]
            }
        end
      end)

    {:noreply, %{next | active_runners: max(0, next.active_runners - 1)}}
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, reason}, state) do
    # A runner process crashed; find the issue record and clean up
    case Enum.find(state.issues, fn {_id, rec} -> rec.runner_pid == pid end) do
      {issue_id, rec} ->
        Logger.warning("Runner for #{issue_id} crashed: #{inspect(reason)}")

        next =
          put_in(state.issues[issue_id], %{
            rec
            | status: :failed,
              runner_pid: nil,
              failure_count: (rec.failure_count || 0) + 1,
              last_failure_at: DateTime.utc_now(),
              last_error: reason
          })

        {:noreply, %{next | active_runners: max(0, next.active_runners - 1)}}

      nil ->
        # Unknown pid; not one of our runners
        {:noreply, state}
    end
  end

  @impl true
  def handle_info(msg, state) do
    Logger.debug("Orchestrator unhandled message: #{inspect(msg)}")
    {:noreply, state}
  end

  # ── Poll Loop ───────────────────────────────────────────────────────────────

  defp do_poll(state) do
    config = state.workflow.config

    with {:ok, session} <- ensure_session(state),
         {:ok, issues} <- call_tracker(state.tracker, :candidate_issues, [config]) do
      state = %{state | fabric_session: session, consecutive_failures: 0, last_error: nil}

      # Classify issues: new, active, terminal
      {new_issues, active_issues, terminal_issues} = classify(state, issues)

      Logger.info(
        "Poll: #{length(new_issues)} new, #{length(active_issues)} active, " <>
          "#{length(terminal_issues)} terminal, #{state.active_runners}/#{state.concurrency} runners"
      )

      # Process each category
      state =
        state
        |> handle_terminal_issues(terminal_issues)
        |> handle_new_issues(new_issues, config)
        |> maybe_start_runners(config)

      state
    else
      {:error, reason} ->
        backoff = compute_backoff(state.consecutive_failures)
        Logger.warning("Orchestrator poll failed (attempt #{state.consecutive_failures + 1}, backoff #{backoff}ms): #{inspect(reason)}")
        %{state | last_error: reason, consecutive_failures: state.consecutive_failures + 1}
    end
  end

  # ── Queue / Task Management ─────────────────────────────────────────────────

  @doc """
  Ensure an Agent Fabric queue exists for this orchestrator.

  Creates the queue on first call; returns the existing queue_id on subsequent
  calls. Called internally by the init/sync flow; exposed for testing.
  """
  @spec ensure_queue(map()) :: {:ok, String.t()} | {:error, term()}
  def ensure_queue(state) do
    if state.queue_id do
      {:ok, state.queue_id}
    else
      project_path = get_in(state.workflow.config, ["agent_fabric", "project_path"])
      title = get_in(state.workflow.config, ["agent_fabric", "queue_title"]) || "Orchestrator Queue"

      case FabricClient.call(state.socket_path, state.fabric_session, "project_queue_create", %{
             projectPath: project_path,
             title: title,
             pipelineProfile: "fast",
             maxParallelAgents: state.concurrency
           }) do
        {:ok, %{"queueId" => queue_id}} ->
          Logger.info("Created Agent Fabric queue: #{queue_id}")
          {:ok, queue_id}

        {:error, reason} ->
          Logger.error("Failed to create queue: #{inspect(reason)}")
          {:error, reason}
      end
    end
  end

  defp create_fabric_task(state, issue) do
    case FabricClient.call(state.socket_path, state.fabric_session, "fabric_task_create", %{
           title: issue.identifier <> ": " <> issue.title,
           goal: issue.description || issue.title,
           projectPath: Workflow.expand_path(get_in(state.workflow.config, ["agent_fabric", "project_path"])),
           priority: "normal",
           refs: [issue.url]
         }) do
      {:ok, %{"taskId" => task_id}} ->
        Logger.info("Created fabric task #{task_id} for #{issue.identifier}")
        {:ok, task_id}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp start_worker_run(state, issue, fabric_task_id, workspace) do
    project_path = Workflow.expand_path(get_in(state.workflow.config, ["agent_fabric", "project_path"]))
    command = get_in(state.workflow.config, ["codex", "command"])
    args = get_in(state.workflow.config, ["codex", "args"]) || []
    max_runtime = get_in(state.workflow.config, ["codex", "max_runtime_minutes"]) || 30

    case FabricClient.call(state.socket_path, state.fabric_session, "fabric_task_start_worker", %{
           taskId: fabric_task_id,
           worker: "codex-app-server",
           projectPath: project_path,
           workspaceMode: "git_worktree",
           workspacePath: workspace.path,
           modelProfile: get_in(state.workflow.config, ["codex", "model_profile"]) || "codex-app-server",
           contextPolicy: get_in(state.workflow.config, ["codex", "context_policy"]) || "workflow",
           maxRuntimeMinutes: max_runtime,
           command: [Enum.join([command | args], " ")],
           metadata: %{
             issueIdentifier: issue.identifier,
             issueUrl: issue.url,
             queueId: state.queue_id
           }
         }) do
      {:ok, %{"workerRunId" => worker_run_id}} ->
        Logger.info("Started worker run #{worker_run_id} for #{issue.identifier}")
        {:ok, worker_run_id}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp finish_fabric_task(state, fabric_task_id, status, reason) do
    summary =
      case status do
        "completed" -> "Issue resolved by orchestrator: #{reason}"
        "canceled" -> "Issue became terminal: #{reason}"
        "failed" -> "Orchestrator failure: #{reason}"
      end

    case FabricClient.call(state.socket_path, state.fabric_session, "fabric_task_finish", %{
           taskId: fabric_task_id,
           status: status,
           summary: summary
         }) do
      {:ok, _} ->
        Logger.info("Fabric task #{fabric_task_id} -> #{status}")
        :ok

      {:error, reason} ->
        Logger.warning("Failed to finish fabric task #{fabric_task_id}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  # ── Issue Classification ────────────────────────────────────────────────────

  defp classify(state, issues) do
    config = state.workflow.config

    Enum.reduce(issues, {[], [], []}, fn issue, {new_list, active_list, terminal_list} ->
      case Map.get(state.issues, issue.identifier) do
        nil ->
          # New issue we haven't seen before
          if Linear.active?(issue, config) do
            {[{issue, nil} | new_list], active_list, terminal_list}
          else
            {new_list, active_list, terminal_list}
          end

        %{status: :terminal} = _rec ->
          # Already terminal, skip
          {new_list, active_list, terminal_list}

        rec ->
          if Linear.terminal?(issue, config) do
            {new_list, active_list, [{issue, rec} | terminal_list]}
          else
            {new_list, [{issue, rec} | active_list], terminal_list}
          end
      end
    end)
  end

  # ── Terminal Issue Handling ─────────────────────────────────────────────────

  defp handle_terminal_issues(state, []), do: state

  defp handle_terminal_issues(state, terminal_issues) do
    Enum.reduce(terminal_issues, state, fn {issue, rec}, acc ->
      Logger.info("Issue #{issue.identifier} is now terminal (state: #{issue.state}). Cleaning up.")

      # Stop the runner if it's running
      acc =
        if rec.runner_pid && Process.alive?(rec.runner_pid) do
          Logger.info("Stopping runner for #{issue.identifier}")
          try do
            DynamicSupervisor.terminate_child(AgentFabricOrchestrator.RunnerSupervisor, rec.runner_pid)
          rescue
            _ -> :ok
          end

          %{acc | active_runners: max(0, acc.active_runners - 1)}
        else
          acc
        end

      # Mark the fabric task as completed/canceled (best-effort; no-op in test mode)
      if rec.fabric_task_id && acc.fabric_session do
        try do
          finish_fabric_task(acc, rec.fabric_task_id, "completed", "Issue moved to #{issue.state}")
        rescue
          _ -> :ok
        end
      end

      # Update the record to terminal
      put_in(acc.issues[issue.identifier], %{
        rec
        | issue: issue,
          status: :terminal,
          runner_pid: nil,
          worker_run_id: nil
      })
    end)
  end

  # ── New Issue Handling ─────────────────────────────────────────────────────

  defp handle_new_issues(state, [], _config), do: state

  defp handle_new_issues(state, new_issues, config) do
    workspace_root = Workflow.expand_path(get_in(config, ["workspace", "root"]))

    Enum.reduce(new_issues, state, fn {issue, _nil}, acc ->
      with {:ok, workspace} <-
             Workspace.ensure_workspace(workspace_root, issue,
               after_create: get_in(config, ["workspace", "after_create"])
             ),
           {:ok, fabric_task_id} <- create_fabric_task(acc, issue) do
        prompt = Workflow.render_prompt(acc.workflow, issue)
        _prompt = prompt

        rec = %IssueRecord{
          issue: issue,
          fabric_task_id: fabric_task_id,
          queue_id: acc.queue_id,
          workspace_path: workspace.path,
          status: :queued
        }

        Logger.info("New issue #{issue.identifier} -> fabric task #{fabric_task_id}, workspace #{workspace.path}")
        put_in(acc.issues[issue.identifier], rec)
      else
        {:error, reason} ->
          Logger.error("Failed to handle new issue #{issue.identifier}: #{inspect(reason)}")

          rec = %IssueRecord{
            issue: issue,
            status: :failed,
            failure_count: 1,
            last_failure_at: DateTime.utc_now(),
            last_error: reason
          }

          put_in(acc.issues[issue.identifier], rec)
      end
    end)
  end

  # ── Runner Scheduling ───────────────────────────────────────────────────────

  defp maybe_start_runners(state, config) do
    available_slots = state.concurrency - state.active_runners

    if available_slots <= 0 do
      state
    else
      # Find queued issues that are eligible to start (not in backoff)
      candidates =
        state.issues
        |> Enum.filter(fn {_id, rec} ->
          rec.status == :queued && !in_backoff?(rec) && rec.fabric_task_id
        end)
        |> Enum.sort_by(fn {_id, rec} -> rec.issue.identifier end)
        |> Enum.take(available_slots)

      Enum.reduce(candidates, state, fn {issue_id, rec}, acc ->
        start_single_runner(acc, issue_id, rec, config)
      end)
    end
  end

  defp start_single_runner(state, issue_id, rec, config) do
    with {:ok, worker_run_id} <-
           start_worker_run(state, rec.issue, rec.fabric_task_id, %{path: rec.workspace_path}),
         {:ok, runner_pid} <-
           start_runner(state, rec, worker_run_id, config) do
      Process.monitor(runner_pid)

      updated_rec = %{
        rec
        | status: :running,
          worker_run_id: worker_run_id,
          runner_pid: runner_pid
      }

      Logger.info("Runner started for #{issue_id} (pid #{inspect(runner_pid)}, worker #{worker_run_id})")

      %{
        state
        | issues: Map.put(state.issues, issue_id, updated_rec),
          active_runners: state.active_runners + 1
      }
    else
      {:error, reason} ->
        Logger.error("Failed to start runner for #{issue_id}: #{inspect(reason)}")

        updated_rec = %{
          rec
          | status: :failed,
            failure_count: (rec.failure_count || 0) + 1,
            last_failure_at: DateTime.utc_now(),
            last_error: reason,
            backoff_until: backoff_until(rec.failure_count + 1)
        }

        %{state | issues: Map.put(state.issues, issue_id, updated_rec)}
    end
  end

  defp start_runner(state, rec, _worker_run_id, config) do
    command = get_in(config, ["codex", "command"])
    args = get_in(config, ["codex", "args"]) || []

    runner_args = [
      socket_path: state.socket_path,
      command: command,
      args: args,
      workspace_path: rec.workspace_path,
      fabric_task_id: rec.fabric_task_id,
      queue_id: state.queue_id,
      queue_task_id: rec.queue_task_id,
      project_path: Workflow.expand_path(get_in(config, ["agent_fabric", "project_path"])),
      model_profile: get_in(config, ["codex", "model_profile"]) || "codex-app-server",
      timeout_ms: (get_in(config, ["codex", "max_runtime_minutes"]) || 30) * 60 * 1000,
      name: {:via, Registry, {AgentFabricOrchestrator.RunnerRegistry, issue_identifier(rec)}}
    ]

    DynamicSupervisor.start_child(
      AgentFabricOrchestrator.RunnerSupervisor,
      {state.runner, runner_args}
    )
  end

  # ── Session Management ──────────────────────────────────────────────────────

  defp ensure_session(state) do
    if state.fabric_session do
      {:ok, state.fabric_session}
    else
      case FabricClient.register(state.socket_path) do
        {:ok, session} ->
          Logger.info("Orchestrator registered bridge session #{session.session_id}")
          {:ok, session}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  # ── Backoff ─────────────────────────────────────────────────────────────────

  defp backoff_until(failure_count) do
    delay = compute_backoff(failure_count)
    DateTime.add(DateTime.utc_now(), delay, :millisecond)
  end

  defp compute_backoff(n) when n <= 0, do: @backoff_base_ms

  defp compute_backoff(n) do
    min(round(@backoff_base_ms * :math.pow(@backoff_factor, n - 1)), @backoff_max_ms)
  end

  defp in_backoff?(rec) do
    rec.backoff_until && DateTime.compare(DateTime.utc_now(), rec.backoff_until) == :lt
  end

  # ── Helpers ─────────────────────────────────────────────────────────────────

  defp schedule_poll(state) do
    Process.send_after(self(), :poll, state.poll_interval_ms)
  end

  defp issue_identifier(rec) do
    rec.issue.identifier
  end

  # Accept a module, {module, function} tuple, or anonymous function as tracker
  defp call_tracker(module, fun, args) when is_atom(module) do
    apply(module, fun, args)
  end

  defp call_tracker({mod, func}, _fun, args) when is_atom(mod) and is_atom(func) do
    apply(mod, func, args)
  end

  defp call_tracker(fun, _dispatch, args) when is_function(fun) do
    apply(fun, args)
  end

  # ── Public sync_once for testing ───────────────────────────────────────────

  @doc """
  Reconcile one tracker poll. Accepts a full state map.

  Test harnesses can pass fake `tracker`, `fabric_session`, and `runner`
  functions in the state. When `fabric_session` is nil (testing mode), the
  function skips daemon-dependent operations (queue creation, task creation,
  worker start) and only exercises classification + state transitions.

  The production GenServer calls `do_poll/1` internally.
  """
  @spec sync_once(map()) :: {:ok, map()} | {:error, term()}
  def sync_once(%__MODULE__{workflow: %Workflow{} = wf} = state) do
    config = wf.config

    with {:ok, issues} <- call_tracker(state.tracker, :candidate_issues, [config]) do
      state = %{state | consecutive_failures: 0, last_error: nil}

      {new_issues, _active, terminal_issues} = classify(state, issues)

      state =
        state
        |> handle_terminal_issues(terminal_issues)

      # In test mode (no fabric session), only classify and track;
      # skip workspace/dir/fabric operations.
      state =
        if state.fabric_session do
          state
          |> handle_new_issues(new_issues, config)
          |> maybe_start_runners(config)
        else
          # Lightweight handling: create in-memory records only
          handle_new_issues_test_mode(state, new_issues)
        end

      {:ok, state}
    else
      {:error, reason} ->
        {:error, reason}
    end
  end

  def sync_once(%{issues: issues} = state) when is_list(issues) do
    config = Map.get(state, :workflow_config, %{})
    active = Enum.filter(issues, &(not Linear.terminal?(&1, config)))
    {:ok, Map.put(state, :active, active)}
  end

  # ── Test-mode new issue handler (no daemon ops) ─────────────────────────────

  defp handle_new_issues_test_mode(state, new_issues) do
    Enum.reduce(new_issues, state, fn {issue, _nil}, acc ->
      # Create an in-memory record without any daemon/workspace operations
      rec = %IssueRecord{
        issue: issue,
        fabric_task_id: "test_task_#{issue.identifier}",
        queue_id: state.queue_id || "test_queue",
        workspace_path: "/tmp/test_ws/#{issue.identifier}",
        status: :queued
      }

      Logger.debug("Test mode: tracking #{issue.identifier} -> queued")
      put_in(acc.issues[issue.identifier], rec)
    end)
  end
end
