defmodule AgentFabricOrchestrator.Orchestrator do
  @moduledoc """
  Tracker-to-Agent-Fabric orchestration loop.

  The orchestrator polls the tracker (Linear), normalizes issues, and manages the
  full lifecycle: creates or resumes Agent Fabric queue/task state, starts
  supervised Codex runners under concurrency limits, reconciles terminal issues by
  stopping active runs, and records failures with exponential backoff.

  Queue-task idempotency relies on immediately persisting issue mappings after
  queue task creation. On restart, restored `running` records are converted back
  to queueable records with stale local process links cleared, so the orchestrator
  can resume from durable Agent Fabric state without pretending an old local PID
  still exists.

  It never writes SQLite directly. All durable state flows through the Agent
  Fabric daemon's public tools via `AgentFabricOrchestrator.FabricGateway`.
  """

  use GenServer
  require Logger

  alias AgentFabricOrchestrator.{
    FabricClient,
    FabricGateway,
    IssueTaskPlanner,
    Linear,
    RunnerPool,
    StateStore,
    Workflow,
    Workspace
  }

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
      :workspace_mode,
      :workspace_source_project,
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
            workspace_mode: String.t() | nil,
            workspace_source_project: String.t() | nil,
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
    :gateway,
    :state_store_path,
    :queue_id,
    :poll_cursor,
    poll_interval_ms: @default_poll_interval_ms,
    concurrency: @default_concurrency,
    tracker: AgentFabricOrchestrator.Linear,
    runner: AgentFabricOrchestrator.CodexRunner,
    start_execution: false,
    issues: %{},
    active_runners: 0,
    last_error: nil,
    consecutive_failures: 0,
    last_poll_result: nil,
    recent_failures: []
  ]

  @type state :: %__MODULE__{
          workflow: Workflow.t(),
          socket_path: String.t(),
          fabric_session: FabricClient.Session.t() | nil,
          gateway: module() | nil,
          state_store_path: String.t() | nil,
          queue_id: String.t() | nil,
          poll_cursor: map() | nil,
          poll_interval_ms: pos_integer(),
          concurrency: pos_integer(),
          tracker: module(),
          runner: module(),
          start_execution: boolean(),
          issues: %{String.t() => IssueRecord.t()},
          active_runners: non_neg_integer(),
          last_error: term(),
          consecutive_failures: non_neg_integer(),
          last_poll_result: map() | nil,
          recent_failures: [map()]
        }

  # ── Client API ─────────────────────────────────────────────────────────────

  def start_link(opts) do
    genserver_opts =
      case Keyword.get(opts, :name, __MODULE__) do
        nil -> []
        name -> [name: name]
      end

    GenServer.start_link(__MODULE__, opts, genserver_opts)
  end

  @doc "Return the orchestrator's runtime state map."
  def status(server \\ __MODULE__) do
    GenServer.call(server, :status)
  end

  @doc "Trigger an immediate poll cycle."
  def poll_now(server \\ __MODULE__) do
    GenServer.cast(server, :poll_now)
  end

  @doc "Run one synchronous poll cycle and return the runtime status."
  def poll_once(server \\ __MODULE__) do
    GenServer.call(server, :poll_once, :infinity)
  end

  # ── GenServer Callbacks ─────────────────────────────────────────────────────

  @impl true
  def init(opts) do
    workflow_path = Keyword.fetch!(opts, :workflow_path)
    socket_path = Keyword.get(opts, :socket_path, FabricClient.default_socket_path())

    workflow =
      case Workflow.load(workflow_path) do
        {:ok, wf} -> wf
        {:error, reason} -> raise ArgumentError, "cannot load workflow: #{reason}"
      end

    gateway = Keyword.get(opts, :gateway, FabricGateway.Uds)
    state_store_path = Keyword.get(opts, :state_store_path, StateStore.path(workflow))
    persisted = load_state_store(state_store_path)

    state = %__MODULE__{
      workflow: workflow,
      socket_path: socket_path,
      gateway: gateway,
      state_store_path: state_store_path,
      poll_interval_ms:
        Keyword.get(opts, :poll_interval_ms) ||
          get_in(workflow.config, ["polling", "interval_ms"]) ||
          @default_poll_interval_ms,
      concurrency:
        Keyword.get(
          opts,
          :concurrency,
          Workflow.runner_concurrency(workflow, @default_concurrency)
        ),
      tracker: Keyword.get(opts, :tracker, Linear),
      runner: Keyword.get(opts, :runner, AgentFabricOrchestrator.CodexRunner),
      start_execution:
        Keyword.get(opts, :start_execution, Workflow.auto_start_execution?(workflow)),
      queue_id: Workflow.queue_id(workflow) || persisted["queue_id"],
      poll_cursor:
        restore_poll_cursor(persisted["poll_cursor"], Workflow.tracker_after_cursor(workflow)),
      issues: restore_issues(persisted["issues"] || %{}),
      recent_failures: persisted["recent_failures"] || []
    }

    # Ensure a bridge session exists before the first poll
    with {:ok, session} <- gateway.register(state.socket_path, register_payload(state)) do
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
    {:reply, status_reply(state), state}
  end

  @impl true
  def handle_call(:poll_once, _from, state) do
    next = do_poll(state)
    persist_state(next)
    {:reply, {:ok, status_reply(next)}, next}
  end

  @impl true
  def handle_cast(:poll_now, state) do
    handle_info(:poll, state)
  end

  @impl true
  def handle_info(:poll, state) do
    next = do_poll(state)
    persist_state(next)
    schedule_poll(next)
    {:noreply, next}
  end

  @impl true
  def handle_info({:runner_done, issue_identifier, result}, state) do
    Logger.info(
      "Runner done for #{issue_identifier}: #{inspect(Map.take(result, [:status, :exit_code]))}"
    )

    AgentFabricOrchestrator.RunnerRegistry.unregister(issue_identifier)

    next =
      update_in(state.issues[issue_identifier], fn rec ->
        case result do
          %{status: :ok} ->
            update_queue_task(state, rec, "completed", "Runner completed for #{issue_identifier}")
            %{rec | status: :terminal, runner_pid: nil}

          %{status: :error} ->
            update_queue_task(state, rec, "failed", "Runner failed for #{issue_identifier}")

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

    next = %{next | active_runners: max(0, next.active_runners - 1)}
    persist_state(next)
    {:noreply, next}
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, reason}, state) do
    # A runner process crashed; find the issue record and clean up
    case Enum.find(state.issues, fn {_id, rec} -> rec.runner_pid == pid end) do
      {issue_id, rec} ->
        log_runner_exit(issue_id, reason)
        AgentFabricOrchestrator.RunnerRegistry.unregister(issue_id)

        status = if reason in [:normal, :shutdown], do: :terminal, else: :failed

        next_rec =
          if status == :terminal do
            %{rec | status: :terminal, runner_pid: nil}
          else
            %{
              rec
              | status: :failed,
                runner_pid: nil,
                failure_count: (rec.failure_count || 0) + 1,
                last_failure_at: DateTime.utc_now(),
                last_error: reason
            }
          end

        next = put_in(state.issues[issue_id], next_rec)

        next =
          if status == :failed do
            %{
              next
              | active_runners: max(0, next.active_runners - 1),
                recent_failures: remember_failure(state, issue_id, reason)
            }
          else
            %{next | active_runners: max(0, next.active_runners - 1)}
          end

        persist_state(next)
        {:noreply, next}

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
         state = %{state | fabric_session: session},
         {:ok, queue_id} <- ensure_queue(state),
         state = %{state | queue_id: queue_id},
         :ok <- persist_state(state),
         :ok <- maybe_start_queue_execution(state),
         {:ok, page} <- fetch_tracker_page(state, config) do
      issues = page.issues
      {state, cursor_warning} = advance_poll_cursor(state, page)
      state = %{state | consecutive_failures: 0, last_error: nil}

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

      _ = maybe_start_queue_execution(state)
      state = maybe_start_runners(state, config)

      %{
        state
        | last_poll_result: %{
            new: length(new_issues),
            active: length(active_issues),
            terminal: length(terminal_issues),
            active_runners: state.active_runners,
            queue_id: state.queue_id,
            page_info: page.page_info,
            poll_cursor: state.poll_cursor,
            cursor_warning: cursor_warning,
            polled_at: DateTime.utc_now() |> DateTime.to_iso8601()
          }
      }
    else
      {:error, reason} ->
        backoff = compute_backoff(state.consecutive_failures)

        Logger.warning(
          "Orchestrator poll failed (attempt #{state.consecutive_failures + 1}, backoff #{backoff}ms): #{inspect(reason)}"
        )

        %{
          state
          | last_error: reason,
            consecutive_failures: state.consecutive_failures + 1,
            recent_failures: remember_failure(state, "poll", reason),
            last_poll_result: %{
              error: inspect(reason),
              queue_id: state.queue_id,
              poll_cursor: state.poll_cursor,
              polled_at: DateTime.utc_now() |> DateTime.to_iso8601()
            }
        }
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
    cond do
      is_binary(state.queue_id) and state.queue_id != "" ->
        {:ok, state.queue_id}

      state.fabric_session == nil ->
        {:ok, "test_queue"}

      true ->
        project_path = Workflow.project_path(state.workflow)

        input = %{
          projectPath: project_path,
          title: Workflow.queue_title(state.workflow),
          promptSummary: "Elixir orchestrator queue for #{project_path}",
          pipelineProfile:
            get_in(state.workflow.config, ["agent_fabric", "queue_profile"]) || "fast",
          maxParallelAgents: state.concurrency
        }

        case state.gateway.create_queue(
               state.socket_path,
               state.fabric_session,
               input,
               gateway_opts(state)
             ) do
          {:ok, %{"queueId" => queue_id}} ->
            Logger.info("Created Agent Fabric queue: #{queue_id}")
            {:ok, queue_id}

          {:ok, %{queueId: queue_id}} ->
            Logger.info("Created Agent Fabric queue: #{queue_id}")
            {:ok, queue_id}

          {:error, reason} ->
            Logger.error("Failed to create queue: #{inspect(reason)}")
            {:error, reason}
        end
    end
  end

  defp create_queue_task(state, issue, prompt) do
    task = IssueTaskPlanner.build_task(state.workflow, issue, prompt)

    case state.gateway.add_task(
           state.socket_path,
           state.fabric_session,
           state.queue_id,
           task,
           gateway_opts(state)
         ) do
      {:ok, %{"created" => [created | _]}} ->
        {:ok, created["fabricTaskId"] || created[:fabricTaskId],
         created["queueTaskId"] || created[:queueTaskId]}

      {:ok, %{created: [created | _]}} ->
        {:ok, created[:fabricTaskId] || created["fabricTaskId"],
         created[:queueTaskId] || created["queueTaskId"]}

      {:ok, %{"reused" => [reused | _]}} ->
        {:ok, reused["fabricTaskId"] || reused[:fabricTaskId],
         reused["queueTaskId"] || reused[:queueTaskId]}

      {:ok, %{reused: [reused | _]}} ->
        {:ok, reused[:fabricTaskId] || reused["fabricTaskId"],
         reused[:queueTaskId] || reused["queueTaskId"]}

      {:error, reason} ->
        {:error, reason}

      other ->
        {:error, {:unexpected_queue_task_response, other}}
    end
  end

  defp start_worker_run(state, issue, fabric_task_id, workspace) do
    project_path = Workflow.project_path(state.workflow)
    command = get_in(state.workflow.config, ["codex", "command"])
    args = get_in(state.workflow.config, ["codex", "args"]) || []
    max_runtime = get_in(state.workflow.config, ["codex", "max_runtime_minutes"]) || 30

    input = %{
      taskId: fabric_task_id,
      worker: "codex-app-server",
      projectPath: project_path,
      workspaceMode: workspace[:mode] || "git_worktree",
      workspacePath: workspace.path,
      modelProfile:
        get_in(state.workflow.config, ["codex", "model_profile"]) || "codex-app-server",
      contextPolicy: get_in(state.workflow.config, ["codex", "context_policy"]) || "workflow",
      maxRuntimeMinutes: max_runtime,
      command: [Enum.join([command | args], " ")],
      metadata: %{
        launchSource: "agent_fabric_elixir_orchestrator",
        workflowPath: state.workflow.path,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueUrl: issue.url,
        queueId: state.queue_id,
        command: command,
        args: args,
        workspace: workspace.path,
        workspaceMode: workspace[:mode] || "git_worktree",
        workspaceSourceProject: workspace[:source_project],
        heartbeatIntervalMs: Workflow.heartbeat_ms(state.workflow),
        maxRuntimeMinutes: max_runtime
      }
    }

    case state.gateway.start_worker(
           state.socket_path,
           state.fabric_session,
           input,
           gateway_opts(state)
         ) do
      {:ok, %{"workerRunId" => worker_run_id}} ->
        Logger.info("Started worker run #{worker_run_id} for #{issue.identifier}")
        {:ok, worker_run_id}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp finish_fabric_task(state, fabric_task_id, status, reason, worker_run_id) do
    summary =
      case status do
        "completed" -> "Issue resolved by orchestrator: #{reason}"
        "canceled" -> "Issue became terminal: #{reason}"
        "failed" -> "Orchestrator failure: #{reason}"
      end

    case state.gateway.finish(
           state.socket_path,
           state.fabric_session,
           %{
             taskId: fabric_task_id,
             workerRunId: worker_run_id,
             status: status,
             summary: summary
           },
           gateway_opts(state)
         ) do
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
      Logger.info(
        "Issue #{issue.identifier} is now terminal (state: #{issue.state}). Cleaning up."
      )

      # Stop the runner if it's running
      acc =
        if rec.runner_pid && Process.alive?(rec.runner_pid) do
          Logger.info("Stopping runner for #{issue.identifier}")
          _ = RunnerPool.stop_runner(issue.identifier)

          %{acc | active_runners: max(0, acc.active_runners - 1)}
        else
          acc
        end

      # Mark the fabric task as completed/canceled (best-effort; no-op in test mode)
      if rec.fabric_task_id && acc.fabric_session do
        terminal_status = terminal_finish_status(issue)

        try do
          finish_fabric_task(
            acc,
            rec.fabric_task_id,
            terminal_status,
            "Issue moved to #{issue.state}",
            rec.worker_run_id
          )

          update_queue_task(acc, rec, terminal_status, "Issue moved to #{issue.state}")
        rescue
          _ -> :ok
        end
      end

      # Update the record to terminal and persist immediately so a crash does
      # not replay terminal cleanup on the next boot.
      persist_issue_record(acc, issue.identifier, %{
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
    workspace_mode = Workflow.workspace_mode(state.workflow)
    workspace_source_project = Workflow.workspace_source_project(state.workflow)
    after_create = Workflow.workspace_after_create(state.workflow)

    Enum.reduce(new_issues, state, fn {issue, _nil}, acc ->
      prompt = Workflow.render_prompt(acc.workflow, issue)

      with {:ok, workspace} <-
             Workspace.ensure_workspace(workspace_root, issue,
               mode: workspace_mode,
               source_project: workspace_source_project,
               after_create: after_create
             ),
           {:ok, fabric_task_id, queue_task_id} <- create_queue_task(acc, issue, prompt) do
        rec = %IssueRecord{
          issue: issue,
          fabric_task_id: fabric_task_id,
          queue_task_id: queue_task_id,
          queue_id: acc.queue_id,
          workspace_path: workspace.path,
          workspace_mode: workspace.mode,
          workspace_source_project: workspace.source_project,
          status: :queued
        }

        Logger.info(
          "New issue #{issue.identifier} -> queue task #{queue_task_id}, fabric task #{fabric_task_id}, workspace #{workspace.path}"
        )

        persist_issue_record(acc, issue.identifier, rec)
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

          persist_issue_record(acc, issue.identifier, rec)
      end
    end)
  end

  # ── Runner Scheduling ───────────────────────────────────────────────────────

  defp maybe_start_runners(state, config) do
    available_slots = state.concurrency - state.active_runners

    cond do
      available_slots <= 0 ->
        state

      state.fabric_session == nil or state.queue_id == nil ->
        state

      true ->
        claim_and_start_runners(state, config, available_slots)
    end
  end

  defp claim_and_start_runners(state, _config, slots_left) when slots_left <= 0, do: state

  defp claim_and_start_runners(state, config, slots_left) do
    case state.gateway.claim_next(
           state.socket_path,
           state.fabric_session,
           state.queue_id,
           %{},
           gateway_opts(state)
         ) do
      {:ok, %{"claimed" => nil}} ->
        state

      {:ok, %{claimed: nil}} ->
        state

      {:ok, %{"claimed" => claimed}} ->
        start_claimed_runner(state, config, claimed, slots_left)

      {:ok, %{claimed: claimed}} ->
        start_claimed_runner(state, config, claimed, slots_left)

      {:ok, %{"executionBlocked" => true, "blockedReason" => reason}} ->
        Logger.info("Queue #{state.queue_id} is not open for worker claims: #{reason}")
        state

      {:error, reason} ->
        Logger.warning("Could not claim next queue task: #{inspect(reason)}")

        %{
          state
          | last_error: reason,
            recent_failures: remember_failure(state, "claim_next", reason)
        }
    end
  end

  defp start_claimed_runner(state, config, claimed, slots_left) do
    queue_task_id =
      claimed["queueTaskId"] || claimed[:queueTaskId] || claimed["id"] || claimed[:id]

    case find_issue_by_queue_task(state, queue_task_id) do
      {issue_id, rec} ->
        next = start_single_runner(state, issue_id, rec, config)
        claim_and_start_runners(next, config, slots_left - 1)

      nil ->
        Logger.warning("Claimed queue task #{inspect(queue_task_id)} has no local issue mapping")
        state
    end
  end

  defp start_single_runner(state, issue_id, rec, config) do
    with {:ok, worker_run_id} <-
           start_worker_run(state, rec.issue, rec.fabric_task_id, %{
             path: rec.workspace_path,
             mode: rec.workspace_mode,
             source_project: rec.workspace_source_project
           }),
         :ok <- assign_claimed_worker(state, rec.queue_task_id, worker_run_id),
         {:ok, runner_pid} <-
           start_runner(state, rec, worker_run_id, config) do
      Process.monitor(runner_pid)

      updated_rec = %{
        rec
        | status: :running,
          worker_run_id: worker_run_id,
          runner_pid: runner_pid
      }

      Logger.info(
        "Runner started for #{issue_id} (pid #{inspect(runner_pid)}, worker #{worker_run_id})"
      )

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
            backoff_until: backoff_until((rec.failure_count || 0) + 1)
        }

        %{
          state
          | issues: Map.put(state.issues, issue_id, updated_rec),
            recent_failures: remember_failure(state, issue_id, reason)
        }
    end
  end

  defp start_runner(state, rec, worker_run_id, config) do
    if existing = AgentFabricOrchestrator.RunnerRegistry.lookup(issue_identifier(rec)) do
      if Process.alive?(existing) do
        {:error, {:runner_already_active, issue_identifier(rec), existing}}
      else
        AgentFabricOrchestrator.RunnerRegistry.unregister(issue_identifier(rec))
        start_runner_process(state, rec, worker_run_id, config)
      end
    else
      start_runner_process(state, rec, worker_run_id, config)
    end
  end

  defp start_runner_process(state, rec, worker_run_id, config) do
    command = get_in(config, ["codex", "command"])
    args = get_in(config, ["codex", "args"]) || []
    command_line = Enum.join([command | args], " ")

    runner_args = [
      id: "linear-#{rec.issue.identifier}",
      socket_path: state.socket_path,
      command: command_line,
      args: args,
      workspace: rec.workspace_path,
      task_id: rec.fabric_task_id,
      worker_run_id: worker_run_id,
      queue_id: state.queue_id,
      queue_task_id: rec.queue_task_id,
      project_path: Workflow.project_path(state.workflow),
      workspace_mode: rec.workspace_mode || "git_worktree",
      workspace_source_project: rec.workspace_source_project,
      model_profile: get_in(config, ["codex", "model_profile"]) || "codex-app-server",
      workflow_path: state.workflow.path,
      issue_identifier: rec.issue.identifier,
      verification_hints: runner_verification_hints(state.workflow),
      heartbeat_interval_ms: Workflow.heartbeat_ms(state.workflow),
      timeout_ms: (get_in(config, ["codex", "max_runtime_minutes"]) || 30) * 60 * 1000
    ]

    RunnerPool.start_runner(issue_identifier(rec), state.runner, runner_args)
  end

  # ── Session Management ──────────────────────────────────────────────────────

  defp ensure_session(state) do
    if state.fabric_session do
      {:ok, state.fabric_session}
    else
      case state.gateway.register(state.socket_path, register_payload(state)) do
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

  defp maybe_start_queue_execution(%{start_execution: false}), do: :ok
  defp maybe_start_queue_execution(%{queue_id: nil}), do: :ok
  defp maybe_start_queue_execution(%{fabric_session: nil}), do: :ok

  defp maybe_start_queue_execution(state) do
    case state.gateway.decide_queue(
           state.socket_path,
           state.fabric_session,
           state.queue_id,
           "start_execution",
           "Elixir orchestrator auto_start_execution enabled",
           gateway_opts(state)
         ) do
      {:ok, _} ->
        :ok

      {:error, %{"code" => code}}
      when code in ["PROJECT_QUEUE_DECISION_INVALID", "INVALID_INPUT"] ->
        :ok

      {:error, reason} ->
        Logger.debug("Queue start_execution decision was not applied: #{inspect(reason)}")
        :ok
    end
  end

  defp gateway_opts(state) do
    [workspace_root: Workflow.project_path(state.workflow) || File.cwd!()]
  end

  defp register_payload(state) do
    root = Workflow.project_path(state.workflow) || File.cwd!()
    put_in(FabricClient.default_register_payload(), [:workspace, :root], root)
  end

  defp runner_verification_hints(workflow) do
    %{
      taskDefaults: Workflow.task_defaults(workflow),
      workflowPath: workflow.path
    }
  end

  defp terminal_finish_status(issue) do
    case issue.state |> to_string() |> String.downcase() do
      state when state in ["canceled", "cancelled"] -> "canceled"
      _ -> "completed"
    end
  end

  defp assign_claimed_worker(_state, nil, _worker_run_id), do: :ok

  defp assign_claimed_worker(state, queue_task_id, worker_run_id) do
    case state.gateway.assign_worker(
           state.socket_path,
           state.fabric_session,
           state.queue_id,
           queue_task_id,
           worker_run_id,
           gateway_opts(state)
         ) do
      {:ok, %{"assigned" => true}} -> :ok
      {:ok, %{assigned: true}} -> :ok
      {:ok, %{"approvalRequired" => true} = response} -> {:error, {:approval_required, response}}
      {:ok, %{approvalRequired: true} = response} -> {:error, {:approval_required, response}}
      {:ok, _response} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp update_queue_task(_state, nil, _status, _summary), do: :ok
  defp update_queue_task(_state, %{queue_task_id: nil}, _status, _summary), do: :ok
  defp update_queue_task(%{fabric_session: nil}, _rec, _status, _summary), do: :ok

  defp update_queue_task(state, rec, status, summary) do
    case state.gateway.update_task(
           state.socket_path,
           state.fabric_session,
           state.queue_id,
           rec.queue_task_id,
           status,
           %{
             workerRunId: rec.worker_run_id,
             summary: summary
           },
           gateway_opts(state)
         ) do
      {:ok, _} ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to update queue task #{rec.queue_task_id}: #{inspect(reason)}")
    end
  end

  defp find_issue_by_queue_task(state, queue_task_id) do
    Enum.find(state.issues, fn {_issue_id, rec} ->
      rec.queue_task_id == queue_task_id and rec.status in [:queued, :failed] and
        !in_backoff?(rec)
    end)
  end

  defp load_state_store(nil), do: StateStore.empty()

  defp load_state_store(path) do
    case StateStore.load(path) do
      {:ok, loaded} ->
        loaded

      {:error, reason} ->
        Logger.warning("Could not load Elixir state store #{path}: #{inspect(reason)}")
        StateStore.empty()
    end
  end

  defp persist_state(%{state_store_path: nil}), do: :ok

  defp persist_state(state) do
    document = %{
      "version" => 1,
      "queue_id" => state.queue_id,
      "poll_cursor" => json_safe(state.poll_cursor),
      "issues" => Map.new(state.issues, fn {id, rec} -> {id, dump_issue_record(rec)} end),
      "last_poll_result" => json_safe(state.last_poll_result),
      "recent_failures" => Enum.map(state.recent_failures, &json_safe/1),
      "updated_at" => DateTime.utc_now() |> DateTime.to_iso8601()
    }

    case StateStore.save(state.state_store_path, document) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning(
          "Could not save Elixir state store #{state.state_store_path}: #{inspect(reason)}"
        )
    end
  end

  defp persist_issue_record(state, issue_identifier, rec) do
    updated = put_in(state.issues[issue_identifier], rec)
    persist_state(updated)
    updated
  end

  defp dump_issue_record(rec) do
    %{
      "issue" => dump_issue(rec.issue),
      "fabric_task_id" => rec.fabric_task_id,
      "queue_task_id" => rec.queue_task_id,
      "queue_id" => rec.queue_id,
      "worker_run_id" => rec.worker_run_id,
      "workspace_path" => rec.workspace_path,
      "workspace_mode" => rec.workspace_mode,
      "workspace_source_project" => rec.workspace_source_project,
      "failure_count" => rec.failure_count || 0,
      "last_failure_at" => date_to_iso(rec.last_failure_at),
      "backoff_until" => date_to_iso(rec.backoff_until),
      "last_error" => inspect_or_nil(rec.last_error),
      "status" => Atom.to_string(rec.status)
    }
  end

  defp dump_issue(%Linear.Issue{} = issue) do
    issue
    |> Map.from_struct()
    |> json_safe()
  end

  defp restore_issues(raw) when is_map(raw) do
    Map.new(raw, fn {id, rec} -> {id, restore_issue_record(rec)} end)
  end

  defp restore_issues(_), do: %{}

  defp restore_poll_cursor(nil, configured_after_cursor) do
    empty_poll_cursor(configured_after_cursor)
  end

  defp restore_poll_cursor(%{} = cursor, configured_after_cursor) do
    after_cursor =
      cond do
        Map.has_key?(cursor, "after") -> cursor["after"]
        Map.has_key?(cursor, :after) -> cursor[:after]
        true -> configured_after_cursor
      end

    %{
      after: after_cursor,
      previous_after: cursor["previous_after"] || cursor[:previous_after],
      last_end_cursor: cursor["last_end_cursor"] || cursor[:last_end_cursor],
      has_next_page: cursor["has_next_page"] || cursor[:has_next_page] || false,
      page_size: cursor["page_size"] || cursor[:page_size],
      last_page_count: cursor["last_page_count"] || cursor[:last_page_count] || 0,
      wrapped: cursor["wrapped"] || cursor[:wrapped] || false,
      updated_at: cursor["updated_at"] || cursor[:updated_at]
    }
  end

  defp restore_poll_cursor(legacy_value, configured_after_cursor) when is_binary(legacy_value) do
    configured_after_cursor
    |> empty_poll_cursor()
    |> Map.put(:legacy_value, legacy_value)
  end

  defp restore_poll_cursor(_other, configured_after_cursor),
    do: empty_poll_cursor(configured_after_cursor)

  defp empty_poll_cursor(after_cursor) do
    %{
      after: after_cursor,
      previous_after: nil,
      last_end_cursor: nil,
      has_next_page: false,
      page_size: nil,
      last_page_count: 0,
      wrapped: false,
      updated_at: nil
    }
  end

  defp restore_issue_record(rec) when is_map(rec) do
    issue = rec["issue"] || %{}
    restored_status = restore_status(rec["status"])
    recovered_running? = rec["status"] == "running"

    %IssueRecord{
      issue: Linear.normalize_issue(issue),
      fabric_task_id: rec["fabric_task_id"],
      queue_task_id: rec["queue_task_id"],
      queue_id: rec["queue_id"],
      worker_run_id: if(recovered_running?, do: nil, else: rec["worker_run_id"]),
      workspace_path: rec["workspace_path"],
      workspace_mode: rec["workspace_mode"],
      workspace_source_project: rec["workspace_source_project"],
      failure_count: rec["failure_count"] || 0,
      last_failure_at: parse_datetime(rec["last_failure_at"]),
      backoff_until: parse_datetime(rec["backoff_until"]),
      last_error: rec["last_error"],
      status: restored_status
    }
  end

  defp restore_status(status) when is_binary(status) do
    case status do
      "pending" -> :pending
      "queued" -> :queued
      "running" -> :queued
      "terminal" -> :terminal
      "failed" -> :failed
      _ -> :pending
    end
  end

  defp restore_status(_), do: :pending

  defp runner_pool_state(state) do
    pool_status = RunnerPool.status()

    %{
      active: state.active_runners,
      concurrency: state.concurrency,
      pool_alive: pool_status.alive,
      pool_active: pool_status.active,
      pool_max_runners: pool_status.max_runners,
      pool_runners:
        Enum.map(pool_status.runners, fn runner ->
          %{
            issue_identifier: runner.issue_identifier,
            pid: inspect(runner.pid),
            alive: runner.alive,
            started_at: runner.started_at && DateTime.to_iso8601(runner.started_at)
          }
        end),
      runners:
        state.issues
        |> Enum.filter(fn {_id, rec} -> rec.runner_pid != nil end)
        |> Map.new(fn {id, rec} ->
          {id,
           %{
             pid: inspect(rec.runner_pid),
             worker_run_id: rec.worker_run_id,
             queue_task_id: rec.queue_task_id,
             workspace_path: rec.workspace_path,
             workspace_mode: rec.workspace_mode,
             workspace_source_project: rec.workspace_source_project,
             status: rec.status
           }}
        end)
    }
  end

  defp status_reply(state) do
    %{
      active_runners: state.active_runners,
      concurrency: state.concurrency,
      issue_count: map_size(state.issues),
      queue_id: state.queue_id,
      session_id: state.fabric_session && state.fabric_session.session_id,
      workflow_path: state.workflow.path,
      state_store_path: state.state_store_path,
      last_error: state.last_error,
      consecutive_failures: state.consecutive_failures,
      last_poll_result: state.last_poll_result,
      poll_cursor: state.poll_cursor,
      last_poll_cursor: state.poll_cursor,
      recent_failures: state.recent_failures,
      runner_pool: runner_pool_state(state),
      issue_mapping: issue_mapping(state),
      issues_by_status:
        state.issues
        |> Enum.group_by(fn {_k, v} -> v.status end, fn {_k, v} -> v.issue.identifier end)
    }
  end

  defp issue_mapping(state) do
    Map.new(state.issues, fn {id, rec} ->
      {id,
       %{
         fabric_task_id: rec.fabric_task_id,
         queue_task_id: rec.queue_task_id,
         queue_id: rec.queue_id,
         worker_run_id: rec.worker_run_id,
         workspace_path: rec.workspace_path,
         workspace_mode: rec.workspace_mode,
         workspace_source_project: rec.workspace_source_project,
         status: rec.status,
         updated_at: rec.issue.updated_at
       }}
    end)
  end

  defp fetch_tracker_page(state, config) do
    config = put_tracker_after_cursor(config, poll_cursor_after(state))

    opts = [
      first: Workflow.tracker_page_size(state.workflow),
      after: poll_cursor_after(state)
    ]

    case call_tracker_optional(state.tracker, :candidate_issues_page, [config, opts]) do
      {:ok, %{issues: issues} = page} ->
        {:ok,
         %{issues: issues, page_info: normalize_page_info(page[:page_info] || page["page_info"])}}

      {:ok, %{"issues" => issues} = page} ->
        {:ok,
         %{issues: issues, page_info: normalize_page_info(page["page_info"] || page[:page_info])}}

      {:ok, issues} when is_list(issues) ->
        {:ok, %{issues: issues, page_info: %{has_next_page: false, end_cursor: nil}}}

      :unsupported ->
        case call_tracker(state.tracker, :candidate_issues, [config]) do
          {:ok, issues} when is_list(issues) ->
            {:ok, %{issues: issues, page_info: %{has_next_page: false, end_cursor: nil}}}

          other ->
            other
        end

      other ->
        other
    end
  end

  defp advance_poll_cursor(state, %{issues: issues, page_info: page_info}) do
    page_info = normalize_page_info(page_info)
    current_after = poll_cursor_after(state)
    has_next_page = page_info.has_next_page == true
    end_cursor = page_info.end_cursor

    {next_after, wrapped, warning} =
      cond do
        has_next_page and is_binary(end_cursor) and end_cursor != "" ->
          {end_cursor, false, nil}

        has_next_page ->
          {current_after, false, "linear_has_next_page_without_end_cursor"}

        true ->
          {nil, current_after != nil, nil}
      end

    cursor = %{
      after: next_after,
      previous_after: current_after,
      last_end_cursor: end_cursor,
      has_next_page: has_next_page,
      page_size: Workflow.tracker_page_size(state.workflow),
      last_page_count: length(issues || []),
      wrapped: wrapped,
      updated_at: DateTime.utc_now() |> DateTime.to_iso8601()
    }

    {%{state | poll_cursor: cursor}, warning}
  end

  defp normalize_page_info(nil), do: %{has_next_page: false, end_cursor: nil}

  defp normalize_page_info(%{} = page_info) do
    %{
      has_next_page:
        page_info[:has_next_page] || page_info["has_next_page"] ||
          page_info[:hasNextPage] || page_info["hasNextPage"] || false,
      end_cursor:
        page_info[:end_cursor] || page_info["end_cursor"] ||
          page_info[:endCursor] || page_info["endCursor"]
    }
  end

  defp normalize_page_info(_other), do: %{has_next_page: false, end_cursor: nil}

  defp poll_cursor_after(%{poll_cursor: %{} = cursor}),
    do: cursor[:after] || cursor["after"]

  defp poll_cursor_after(_state), do: nil

  defp put_tracker_after_cursor(config, after_cursor) when is_map(config) do
    tracker = Map.get(config, "tracker", %{}) || %{}
    Map.put(config, "tracker", Map.put(tracker, "after_cursor", after_cursor))
  end

  defp put_tracker_after_cursor(config, _after_cursor), do: config

  defp call_tracker_optional(module, fun, args) when is_atom(module) do
    if function_exported?(module, fun, length(args)) do
      apply(module, fun, args)
    else
      :unsupported
    end
  end

  defp call_tracker_optional({mod, func}, _fun, args) when is_atom(mod) and is_atom(func) do
    if function_exported?(mod, func, length(args)) do
      apply(mod, func, args)
    else
      :unsupported
    end
  end

  defp call_tracker_optional(fun, _dispatch, args) when is_function(fun) do
    case Function.info(fun, :arity) do
      {:arity, arity} when arity == length(args) -> apply(fun, args)
      {:arity, arity} when arity == 1 -> apply(fun, [List.first(args)])
      _ -> :unsupported
    end
  end

  defp remember_failure(state, subject, reason) do
    failure = %{
      subject: subject,
      reason: inspect(reason),
      at: DateTime.utc_now() |> DateTime.to_iso8601()
    }

    [failure | state.recent_failures]
    |> Enum.take(20)
  end

  defp log_runner_exit(issue_id, reason) when reason in [:normal, :shutdown] do
    Logger.info("Runner for #{issue_id} exited: #{inspect(reason)}")
  end

  defp log_runner_exit(issue_id, reason) do
    Logger.warning("Runner for #{issue_id} crashed: #{inspect(reason)}")
  end

  defp date_to_iso(nil), do: nil
  defp date_to_iso(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp date_to_iso(other), do: other

  defp parse_datetime(nil), do: nil

  defp parse_datetime(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, dt, _offset} -> dt
      _ -> nil
    end
  end

  defp parse_datetime(_), do: nil

  defp inspect_or_nil(nil), do: nil
  defp inspect_or_nil(value) when is_binary(value), do: value
  defp inspect_or_nil(value), do: inspect(value)

  defp json_safe(%DateTime{} = value), do: DateTime.to_iso8601(value)
  defp json_safe(value) when is_boolean(value) or is_nil(value), do: value

  defp json_safe(value) when is_map(value) do
    Map.new(value, fn {key, item} -> {key, json_safe(item)} end)
  end

  defp json_safe(value) when is_list(value), do: Enum.map(value, &json_safe/1)
  defp json_safe(value) when is_atom(value), do: Atom.to_string(value)
  defp json_safe(value) when is_pid(value), do: inspect(value)
  defp json_safe(value) when is_tuple(value), do: inspect(value)
  defp json_safe(value), do: value

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
        workspace_mode: "directory",
        status: :queued
      }

      Logger.debug("Test mode: tracking #{issue.identifier} -> queued")
      put_in(acc.issues[issue.identifier], rec)
    end)
  end
end
