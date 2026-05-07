defmodule AgentFabricOrchestrator.OrchestratorTest do
  use ExUnit.Case, async: false

  alias AgentFabricOrchestrator.{FabricClient, Orchestrator, Linear, StateStore, Workflow}

  # ── helpers ─────────────────────────────────────────────────────────────────

  defp sample_workflow do
    text = """
    ---
    tracker:
      type: linear
      active_states:
        - Todo
        - "In Progress"
      terminal_states:
        - Done
        - Cancelled
    workspace:
      root: ~/agent-fabric-work
    codex:
      command: codex
      args:
        - exec
      model_profile: execute.cheap
      max_runtime_minutes: 30
    agent_fabric:
      project_path: /tmp/agent-fabric-project
      queue_title: Test Queue
    ---
    Ship {{ issue.identifier }}: {{ issue.title }}
    State: {{ issue.state }}
    Labels: {{ issue.labels }}
    URL: {{ issue.url }}
    """

    {:ok, wf} = Workflow.parse(text)
    wf
  end

  defp sample_issue(overrides) do
    defaults = %{
      "id" => "issue-001",
      "identifier" => "ENG-1",
      "title" => "Implement feature X",
      "description" => "We need feature X for the project.",
      "url" => "https://linear.app/team/ENG-1",
      "team" => %{"key" => "ENG"},
      "assignee" => %{"id" => "user-1"},
      "labels" => %{"nodes" => [%{"name" => "backend"}, %{"name" => "agent-fabric"}]}
    }

    # Always set state as a nested map
    state_name = Keyword.get(overrides, :state, "Todo")
    raw = Map.put(defaults, "state", %{"name" => state_name})

    # Apply other overrides (flattened)
    raw =
      overrides
      |> Keyword.delete(:state)
      |> Enum.reduce(raw, fn {k, v}, acc -> Map.put(acc, to_string(k), v) end)

    Linear.normalize_issue(raw)
  end

  # ── sync_once: basic classification ────────────────────────────────────────

  describe "sync_once" do
    test "classifies new active issues as queued" do
      workflow = sample_workflow()
      issues = [sample_issue(identifier: "ENG-1", state: "Todo")]

      tracker = fn _config -> {:ok, issues} end

      state =
        struct!(Orchestrator,
          workflow: workflow,
          socket_path: stub_socket_path(),
          tracker: tracker,
          concurrency: 4
        )

      {:ok, result} = Orchestrator.sync_once(state)

      assert Map.has_key?(result.issues, "ENG-1")
      assert result.issues["ENG-1"].status == :queued
      assert result.issues["ENG-1"].issue.identifier == "ENG-1"
      assert result.consecutive_failures == 0
    end

    test "marks known active issues as terminal when state becomes Done" do
      workflow = sample_workflow()
      done_issue = sample_issue(identifier: "ENG-1", state: "Done")

      tracker = fn _config -> {:ok, [done_issue]} end

      # Pre-populate with a running issue record
      existing_rec = %Orchestrator.IssueRecord{
        issue: sample_issue(identifier: "ENG-1", state: "Todo"),
        fabric_task_id: "task_abc123",
        queue_id: "pqueue_test",
        workspace_path: "/tmp/ws",
        status: :running,
        runner_pid: nil
      }

      state =
        struct!(Orchestrator,
          workflow: workflow,
          socket_path: stub_socket_path(),
          tracker: tracker,
          concurrency: 4,
          issues: %{"ENG-1" => existing_rec}
        )

      {:ok, result} = Orchestrator.sync_once(state)

      assert result.issues["ENG-1"].status == :terminal
      assert result.issues["ENG-1"].runner_pid == nil
    end

    test "terminal issue finishes linked worker run through the gateway" do
      owner_name = :orchestrator_fake_gateway_owner

      if Process.whereis(owner_name), do: Process.unregister(owner_name)
      Process.register(self(), owner_name)

      on_exit(fn ->
        if Process.whereis(owner_name) == self(), do: Process.unregister(owner_name)
      end)

      workflow = sample_workflow()
      done_issue = sample_issue(identifier: "ENG-1", state: "Done")
      tracker = fn _config -> {:ok, [done_issue]} end

      existing_rec = %Orchestrator.IssueRecord{
        issue: sample_issue(identifier: "ENG-1", state: "Todo"),
        fabric_task_id: "task_abc123",
        queue_task_id: "pqtask_abc123",
        queue_id: "pqueue_test",
        worker_run_id: "wrun_abc123",
        workspace_path: "/tmp/ws",
        status: :running,
        runner_pid: nil
      }

      state =
        struct!(Orchestrator,
          workflow: workflow,
          socket_path: stub_socket_path(),
          fabric_session: %FabricClient.Session{
            session_id: "sess_test",
            session_token: "tok_test"
          },
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          queue_id: "pqueue_test",
          tracker: tracker,
          concurrency: 0,
          issues: %{"ENG-1" => existing_rec}
        )

      {:ok, result} = Orchestrator.sync_once(state)

      assert result.issues["ENG-1"].status == :terminal

      assert_receive {:gateway_finish,
                      %{
                        taskId: "task_abc123",
                        workerRunId: "wrun_abc123",
                        status: "completed"
                      }}

      assert_receive {:gateway_update_task, "pqtask_abc123", "completed",
                      %{workerRunId: "wrun_abc123"}}
    end

    test "ignores unknown terminal issues" do
      workflow = sample_workflow()
      issues = [sample_issue(identifier: "ENG-2", state: "Done")]

      tracker = fn _config -> {:ok, issues} end

      state =
        struct!(Orchestrator,
          workflow: workflow,
          socket_path: stub_socket_path(),
          tracker: tracker,
          concurrency: 4
        )

      {:ok, result} = Orchestrator.sync_once(state)

      # Terminal issue that was never tracked should not appear
      refute Map.has_key?(result.issues, "ENG-2")
    end

    test "respects active_states from workflow config" do
      workflow = sample_workflow()
      backlog_issue = sample_issue(identifier: "ENG-3", state: "Backlog")

      tracker = fn _config -> {:ok, [backlog_issue]} end

      state =
        struct!(Orchestrator,
          workflow: workflow,
          socket_path: stub_socket_path(),
          tracker: tracker,
          concurrency: 4
        )

      {:ok, result} = Orchestrator.sync_once(state)

      # Backlog is not in active_states, so issue should not be tracked
      refute Map.has_key?(result.issues, "ENG-3")
    end

    test "does not re-create terminal issues" do
      workflow = sample_workflow()
      done_issue = sample_issue(identifier: "ENG-4", state: "Done")

      tracker = fn _config -> {:ok, [done_issue]} end

      existing_rec = %Orchestrator.IssueRecord{
        issue: done_issue,
        fabric_task_id: "task_done",
        queue_id: "pqueue_test",
        workspace_path: "/tmp/ws",
        status: :terminal,
        runner_pid: nil
      }

      state =
        struct!(Orchestrator,
          workflow: workflow,
          socket_path: stub_socket_path(),
          tracker: tracker,
          concurrency: 4,
          issues: %{"ENG-4" => existing_rec}
        )

      {:ok, result} = Orchestrator.sync_once(state)

      # Status should remain terminal, no new record created
      assert result.issues["ENG-4"].status == :terminal
    end

    test "returns error when tracker fails" do
      workflow = sample_workflow()
      tracker = fn _config -> {:error, :api_unreachable} end

      state =
        struct!(Orchestrator,
          workflow: workflow,
          socket_path: stub_socket_path(),
          tracker: tracker,
          concurrency: 4
        )

      assert {:error, :api_unreachable} = Orchestrator.sync_once(state)
    end
  end

  # ── backoff computation ─────────────────────────────────────────────────────

  describe "backoff" do
    test "IssueRecord with nil backoff is not in backoff" do
      rec = %Orchestrator.IssueRecord{status: :failed, failure_count: 1}
      refute in_backoff?(rec)
    end

    test "IssueRecord with future backoff_until is in backoff" do
      future = DateTime.add(DateTime.utc_now(), 60, :second)
      rec = %Orchestrator.IssueRecord{status: :failed, failure_count: 1, backoff_until: future}
      assert in_backoff?(rec)
    end

    test "IssueRecord with past backoff_until is not in backoff" do
      past = DateTime.add(DateTime.utc_now(), -60, :second)
      rec = %Orchestrator.IssueRecord{status: :failed, failure_count: 1, backoff_until: past}
      refute in_backoff?(rec)
    end
  end

  # ── multiple issues / concurrency ──────────────────────────────────────────

  describe "sync_once with multiple issues" do
    test "tracks multiple new active issues" do
      workflow = sample_workflow()

      issues = [
        sample_issue(identifier: "ENG-1", state: "Todo"),
        sample_issue(identifier: "ENG-2", state: "In Progress"),
        sample_issue(identifier: "ENG-3", state: "Todo")
      ]

      tracker = fn _config -> {:ok, issues} end

      state =
        struct!(Orchestrator,
          workflow: workflow,
          socket_path: stub_socket_path(),
          tracker: tracker,
          concurrency: 4
        )

      {:ok, result} = Orchestrator.sync_once(state)

      assert map_size(result.issues) == 3
      assert Enum.all?(result.issues, fn {_k, v} -> v.status == :queued end)
    end

    test "handles mix of new, active, and terminal in one poll" do
      workflow = sample_workflow()

      issues = [
        sample_issue(identifier: "ENG-1", state: "Todo"),
        sample_issue(identifier: "ENG-2", state: "Done"),
        sample_issue(identifier: "ENG-3", state: "In Progress")
      ]

      tracker = fn _config -> {:ok, issues} end

      # ENG-1 was previously tracked and running
      existing_rec = %Orchestrator.IssueRecord{
        issue: sample_issue(identifier: "ENG-1", state: "Todo"),
        fabric_task_id: "task_abc",
        queue_id: "pqueue_test",
        workspace_path: "/tmp/ws-1",
        status: :running,
        runner_pid: nil
      }

      state =
        struct!(Orchestrator,
          workflow: workflow,
          socket_path: stub_socket_path(),
          tracker: tracker,
          concurrency: 4,
          issues: %{"ENG-1" => existing_rec}
        )

      {:ok, result} = Orchestrator.sync_once(state)

      # ENG-1 still active, ENG-2 new & terminal (not tracked), ENG-3 new & active
      assert result.issues["ENG-1"].status in [:running, :queued]
      refute Map.has_key?(result.issues, "ENG-2")
      assert result.issues["ENG-3"].status in [:queued, :running]
    end
  end

  describe "queue-visible poll_once" do
    test "creates queue task mapping and starts a claimed codex-app-server runner through gateway" do
      workflow_path = write_queue_workflow()
      issue = sample_issue(identifier: "ENG-55", state: "Todo")
      tracker = fn _config -> {:ok, [issue]} end

      {:ok, pid} =
        Orchestrator.start_link(
          workflow_path: workflow_path,
          socket_path: "/tmp/fake-agent-fabric.sock",
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          tracker: tracker,
          concurrency: 1,
          start_execution: true,
          name: nil
        )

      {:ok, status} = Orchestrator.poll_once(pid)

      assert status.queue_id == "pqueue_fake"
      assert status.issue_mapping["ENG-55"].queue_task_id == "pqtask_ENG-55"
      assert status.issue_mapping["ENG-55"].fabric_task_id == "task_ENG-55"
      assert status.issue_mapping["ENG-55"].worker_run_id == "wrun_ENG-55"
      assert status.active_runners == 1

      GenServer.stop(pid)
      cleanup_runner("ENG-55")
    end

    test "uses workflow git_worktree mode and source project for workspace and worker metadata" do
      owner_name = :orchestrator_fake_gateway_owner

      if Process.whereis(owner_name), do: Process.unregister(owner_name)
      Process.register(self(), owner_name)

      on_exit(fn ->
        if Process.whereis(owner_name) == self(), do: Process.unregister(owner_name)
      end)

      source_project = create_git_repo!()

      workflow_path =
        write_queue_workflow(
          workspace_extra: """
            mode: git_worktree
            source_project: #{source_project}
          """
        )

      issue = sample_issue(identifier: "ENG-55", state: "Todo")
      cleanup_runner("ENG-55")

      {:ok, pid} =
        Orchestrator.start_link(
          workflow_path: workflow_path,
          socket_path: "/tmp/fake-agent-fabric.sock",
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          tracker: fn _config -> {:ok, [issue]} end,
          concurrency: 1,
          start_execution: true,
          name: nil
        )

      {:ok, status} = Orchestrator.poll_once(pid)
      mapping = status.issue_mapping["ENG-55"]

      assert mapping.workspace_mode == "git_worktree"
      assert mapping.workspace_source_project == source_project
      assert File.exists?(Path.join(mapping.workspace_path, ".git"))

      assert_receive {:gateway_start_worker,
                      %{
                        workspaceMode: "git_worktree",
                        metadata: %{
                          workspaceMode: "git_worktree",
                          workspaceSourceProject: ^source_project
                        }
                      }}

      GenServer.stop(pid)
      cleanup_runner("ENG-55")
    end

    test "persists queue task mapping immediately after task creation" do
      workflow_path = write_queue_workflow()
      {:ok, workflow} = Workflow.load(workflow_path)

      state_store_path =
        Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

      issue = sample_issue(identifier: "ENG-77", state: "Todo")
      tracker = fn _config -> {:ok, [issue]} end

      state =
        struct!(Orchestrator,
          workflow: workflow,
          socket_path: stub_socket_path(),
          fabric_session: %FabricClient.Session{
            session_id: "sess_test",
            session_token: "tok_test"
          },
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          state_store_path: state_store_path,
          queue_id: "pqueue_fake",
          tracker: tracker,
          concurrency: 0,
          issues: %{}
        )

      {:ok, result} = Orchestrator.sync_once(state)

      assert result.issues["ENG-77"].queue_task_id == "pqtask_ENG-77"
      assert {:ok, persisted} = StateStore.load(state_store_path)
      assert persisted["issues"]["ENG-77"]["queue_task_id"] == "pqtask_ENG-77"
      assert persisted["issues"]["ENG-77"]["fabric_task_id"] == "task_ENG-77"
    end

    test "uses Elixir issue task planner for queue task shape" do
      owner_name = :orchestrator_fake_gateway_owner

      if Process.whereis(owner_name), do: Process.unregister(owner_name)
      Process.register(self(), owner_name)

      on_exit(fn ->
        if Process.whereis(owner_name) == self(), do: Process.unregister(owner_name)
      end)

      workflow_path =
        write_queue_workflow(
          agent_fabric_extra: """
            task_defaults:
              phase: roadmap
              acceptance_criteria:
                - Include verification evidence.
          """
        )

      {:ok, workflow} = Workflow.load(workflow_path)

      issue =
        sample_issue(
          identifier: "ENG-123",
          state: "Todo",
          description: """
          Move worker quality rules into Elixir.

          Expected files:
          - elixir/lib/agent_fabric_orchestrator/issue_task_planner.ex

          Context refs:
          - elixir/lib/agent_fabric_orchestrator/orchestrator.ex
          """,
          labels: %{
            "nodes" => [
              %{"name" => "priority:urgent"},
              %{"name" => "risk:high"},
              %{"name" => "area:elixir"},
              %{"name" => "serial"}
            ]
          }
        )

      state =
        struct!(Orchestrator,
          workflow: workflow,
          socket_path: stub_socket_path(),
          fabric_session: %FabricClient.Session{
            session_id: "sess_test",
            session_token: "tok_test"
          },
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          queue_id: "pqueue_fake",
          tracker: fn _config -> {:ok, [issue]} end,
          concurrency: 0,
          issues: %{}
        )

      {:ok, result} = Orchestrator.sync_once(state)

      assert result.issues["ENG-123"].queue_task_id == "pqtask_ENG-123"

      assert_receive {:gateway_add_task, "ENG-123", task}
      assert task.phase == "roadmap"
      assert task.priority == "urgent"
      assert task.risk == "high"
      assert task.workstream == "elixir"
      assert task.parallelSafe == false
      assert "Include verification evidence." in task.acceptanceCriteria
      assert "elixir/lib/agent_fabric_orchestrator/issue_task_planner.ex" in task.expectedFiles
      assert "elixir/lib/agent_fabric_orchestrator/orchestrator.ex" in task.requiredContextRefs
    end

    test "accepts reused queue task mapping from idempotent gateway response" do
      workflow_path = write_queue_workflow()
      {:ok, workflow} = Workflow.load(workflow_path)

      state_store_path =
        Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

      issue = sample_issue(identifier: "ENG-110", state: "Todo")
      tracker = fn _config -> {:ok, [issue]} end

      state =
        struct!(Orchestrator,
          workflow: workflow,
          socket_path: stub_socket_path(),
          fabric_session: %FabricClient.Session{
            session_id: "sess_test",
            session_token: "tok_test"
          },
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeReuseGateway,
          state_store_path: state_store_path,
          queue_id: "pqueue_fake",
          tracker: tracker,
          concurrency: 0,
          issues: %{}
        )

      {:ok, result} = Orchestrator.sync_once(state)

      assert result.issues["ENG-110"].queue_task_id == "pqtask_reused_ENG-110"
      assert result.issues["ENG-110"].fabric_task_id == "task_reused_ENG-110"
      assert {:ok, persisted} = StateStore.load(state_store_path)
      assert persisted["issues"]["ENG-110"]["queue_task_id"] == "pqtask_reused_ENG-110"
      assert persisted["issues"]["ENG-110"]["fabric_task_id"] == "task_reused_ENG-110"
    end

    test "restored running issue is restart-safe and not linked to a stale local worker" do
      workflow_path = write_queue_workflow()

      state_store_path =
        Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

      issue = sample_issue(identifier: "ENG-88", state: "Todo")

      state_doc =
        StateStore.empty()
        |> Map.put("queue_id", "pqueue_fake")
        |> StateStore.put_issue("ENG-88", %{
          "issue" => Map.from_struct(issue),
          "queue_id" => "pqueue_fake",
          "queue_task_id" => "pqtask_ENG-88",
          "fabric_task_id" => "task_ENG-88",
          "worker_run_id" => "wrun_stale",
          "workspace_path" => "/tmp/eng-88",
          "status" => "running"
        })

      assert :ok = StateStore.save(state_store_path, state_doc)

      {:ok, pid} =
        Orchestrator.start_link(
          workflow_path: workflow_path,
          socket_path: "/tmp/fake-agent-fabric.sock",
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          tracker: fn _config -> {:ok, []} end,
          state_store_path: state_store_path,
          poll_interval_ms: 60_000,
          name: nil
        )

      status = Orchestrator.status(pid)

      assert status.queue_id == "pqueue_fake"
      assert status.issue_mapping["ENG-88"].status == :queued
      assert status.issue_mapping["ENG-88"].worker_run_id == nil

      GenServer.stop(pid)
    end

    test "restored queued mapping is not recreated as a duplicate queue task" do
      owner_name = :orchestrator_fake_gateway_owner

      if Process.whereis(owner_name), do: Process.unregister(owner_name)
      Process.register(self(), owner_name)

      on_exit(fn ->
        if Process.whereis(owner_name) == self(), do: Process.unregister(owner_name)
      end)

      workflow_path = write_queue_workflow()

      state_store_path =
        Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

      issue = sample_issue(identifier: "ENG-99", state: "Todo")

      state_doc =
        StateStore.empty()
        |> Map.put("queue_id", "pqueue_fake")
        |> StateStore.put_issue("ENG-99", %{
          "issue" => Map.from_struct(issue),
          "queue_id" => "pqueue_fake",
          "queue_task_id" => "pqtask_ENG-99",
          "fabric_task_id" => "task_ENG-99",
          "workspace_path" => "/tmp/eng-99",
          "status" => "queued"
        })

      assert :ok = StateStore.save(state_store_path, state_doc)

      {:ok, pid} =
        Orchestrator.start_link(
          workflow_path: workflow_path,
          socket_path: "/tmp/fake-agent-fabric.sock",
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          tracker: fn _config -> {:ok, [issue]} end,
          state_store_path: state_store_path,
          poll_interval_ms: 60_000,
          name: nil
        )

      {:ok, status} = Orchestrator.poll_once(pid)

      assert status.issue_mapping["ENG-99"].queue_task_id == "pqtask_ENG-99"
      assert status.issue_mapping["ENG-99"].fabric_task_id == "task_ENG-99"
      refute_receive {:gateway_add_task, "ENG-99"}

      GenServer.stop(pid)
    end

    test "poll failure records actionable status and recent failure context" do
      workflow_path = write_queue_workflow()

      {:ok, pid} =
        Orchestrator.start_link(
          workflow_path: workflow_path,
          socket_path: "/tmp/fake-agent-fabric.sock",
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          tracker: fn _config -> {:error, :api_timeout} end,
          concurrency: 1,
          name: nil
        )

      {:ok, status1} = Orchestrator.poll_once(pid)
      {:ok, status2} = Orchestrator.poll_once(pid)

      assert status1.consecutive_failures == 1
      assert status2.consecutive_failures == 2
      assert status2.last_error == :api_timeout
      assert status2.last_poll_result.error =~ "api_timeout"
      assert [%{subject: "poll", reason: reason} | _] = status2.recent_failures
      assert reason =~ "api_timeout"

      GenServer.stop(pid)
    end

    test "advances persisted Linear cursor one page per poll and wraps after final page" do
      owner = self()
      workflow_path = write_queue_workflow()

      state_store_path =
        Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

      first_issue = sample_issue(identifier: "ENG-101", state: "Todo")
      second_issue = sample_issue(identifier: "ENG-102", state: "Todo")

      tracker = fn config ->
        after_cursor = get_in(config, ["tracker", "after_cursor"])
        send(owner, {:tracker_after, after_cursor})

        case after_cursor do
          nil ->
            {:ok,
             %{
               issues: [first_issue],
               page_info: %{has_next_page: true, end_cursor: "cursor_1"}
             }}

          "cursor_1" ->
            {:ok,
             %{
               issues: [second_issue],
               page_info: %{has_next_page: false, end_cursor: "cursor_2"}
             }}
        end
      end

      {:ok, pid} =
        Orchestrator.start_link(
          workflow_path: workflow_path,
          socket_path: "/tmp/fake-agent-fabric.sock",
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          tracker: tracker,
          state_store_path: state_store_path,
          concurrency: 0,
          name: nil
        )

      {:ok, first_status} = Orchestrator.poll_once(pid)

      assert_receive {:tracker_after, nil}
      assert first_status.poll_cursor.after == "cursor_1"
      assert first_status.poll_cursor.has_next_page == true

      assert first_status.last_poll_result.page_info == %{
               has_next_page: true,
               end_cursor: "cursor_1"
             }

      assert first_status.issue_mapping["ENG-101"].queue_task_id == "pqtask_ENG-101"

      assert {:ok, persisted_first} = StateStore.load(state_store_path)
      assert persisted_first["poll_cursor"]["after"] == "cursor_1"

      {:ok, second_status} = Orchestrator.poll_once(pid)

      assert_receive {:tracker_after, "cursor_1"}
      assert second_status.poll_cursor.after == nil
      assert second_status.poll_cursor.wrapped == true
      assert second_status.poll_cursor.last_end_cursor == "cursor_2"
      assert second_status.issue_mapping["ENG-102"].queue_task_id == "pqtask_ENG-102"

      assert {:ok, persisted_second} = StateStore.load(state_store_path)
      assert persisted_second["poll_cursor"]["after"] == nil
      assert persisted_second["poll_cursor"]["wrapped"] == true

      GenServer.stop(pid)
    end

    test "does not advance persisted cursor after a failed poll" do
      workflow_path = write_queue_workflow()

      state_store_path =
        Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

      state_doc =
        StateStore.empty()
        |> Map.put("queue_id", "pqueue_fake")
        |> Map.put("poll_cursor", %{
          "after" => "cursor_keep",
          "last_end_cursor" => "cursor_keep",
          "has_next_page" => true
        })

      assert :ok = StateStore.save(state_store_path, state_doc)

      {:ok, pid} =
        Orchestrator.start_link(
          workflow_path: workflow_path,
          socket_path: "/tmp/fake-agent-fabric.sock",
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          tracker: fn _config -> {:error, :linear_down} end,
          state_store_path: state_store_path,
          concurrency: 0,
          name: nil
        )

      {:ok, status} = Orchestrator.poll_once(pid)

      assert status.consecutive_failures == 1
      assert status.poll_cursor.after == "cursor_keep"
      assert status.last_poll_result.poll_cursor.after == "cursor_keep"

      assert {:ok, persisted} = StateStore.load(state_store_path)
      assert persisted["poll_cursor"]["after"] == "cursor_keep"

      GenServer.stop(pid)
    end

    test "restored wrapped cursor nil does not fall back to configured after_cursor" do
      workflow_path = write_queue_workflow(after_cursor: "configured_cursor")

      state_store_path =
        Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

      state_doc =
        StateStore.empty()
        |> Map.put("queue_id", "pqueue_fake")
        |> Map.put("poll_cursor", %{
          "after" => nil,
          "previous_after" => "cursor_1",
          "last_end_cursor" => "cursor_2",
          "has_next_page" => false,
          "wrapped" => true
        })

      assert :ok = StateStore.save(state_store_path, state_doc)

      {:ok, pid} =
        Orchestrator.start_link(
          workflow_path: workflow_path,
          socket_path: "/tmp/fake-agent-fabric.sock",
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          tracker: fn _config -> {:ok, []} end,
          state_store_path: state_store_path,
          poll_interval_ms: 60_000,
          name: nil
        )

      status = Orchestrator.status(pid)

      assert status.poll_cursor.after == nil
      assert status.poll_cursor.wrapped == true

      GenServer.stop(pid)
    end

    test "keeps current cursor when Linear reports hasNextPage without endCursor" do
      workflow_path = write_queue_workflow()

      state_store_path =
        Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

      state_doc =
        StateStore.empty()
        |> Map.put("queue_id", "pqueue_fake")
        |> Map.put("poll_cursor", %{
          "after" => "cursor_keep",
          "last_end_cursor" => "cursor_keep",
          "has_next_page" => true
        })

      assert :ok = StateStore.save(state_store_path, state_doc)

      tracker = fn _config ->
        {:ok, %{issues: [], page_info: %{has_next_page: true, end_cursor: nil}}}
      end

      {:ok, pid} =
        Orchestrator.start_link(
          workflow_path: workflow_path,
          socket_path: "/tmp/fake-agent-fabric.sock",
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          tracker: tracker,
          state_store_path: state_store_path,
          concurrency: 0,
          name: nil
        )

      {:ok, status} = Orchestrator.poll_once(pid)

      assert status.poll_cursor.after == "cursor_keep"
      assert status.poll_cursor.wrapped == false
      assert status.last_poll_result.cursor_warning == "linear_has_next_page_without_end_cursor"

      assert {:ok, persisted} = StateStore.load(state_store_path)
      assert persisted["poll_cursor"]["after"] == "cursor_keep"

      GenServer.stop(pid)
    end

    test "full lifecycle creates queue task, starts runner, and finishes terminal issue" do
      owner_name = :orchestrator_fake_gateway_owner

      if Process.whereis(owner_name), do: Process.unregister(owner_name)
      Process.register(self(), owner_name)

      on_exit(fn ->
        if Process.whereis(owner_name) == self(), do: Process.unregister(owner_name)
      end)

      workflow_path = write_queue_workflow()
      cleanup_runner("ENG-55")

      {:ok, issues} =
        Agent.start_link(fn -> [sample_issue(identifier: "ENG-55", state: "Todo")] end)

      {:ok, pid} =
        Orchestrator.start_link(
          workflow_path: workflow_path,
          socket_path: "/tmp/fake-agent-fabric.sock",
          gateway: AgentFabricOrchestrator.OrchestratorTest.FakeGateway,
          tracker: fn _config -> {:ok, Agent.get(issues, & &1)} end,
          concurrency: 1,
          name: nil
        )

      {:ok, status1} = Orchestrator.poll_once(pid)

      assert status1.queue_id == "pqueue_fake"
      assert status1.issue_mapping["ENG-55"].queue_task_id == "pqtask_ENG-55"
      assert status1.issue_mapping["ENG-55"].fabric_task_id == "task_ENG-55"
      assert status1.issue_mapping["ENG-55"].worker_run_id == "wrun_ENG-55"
      assert status1.active_runners == 1

      Agent.update(issues, fn _ -> [sample_issue(identifier: "ENG-55", state: "Done")] end)

      {:ok, status2} = Orchestrator.poll_once(pid)

      assert status2.issue_mapping["ENG-55"].status == :terminal
      assert status2.active_runners == 0

      assert_receive {:gateway_finish,
                      %{
                        taskId: "task_ENG-55",
                        workerRunId: "wrun_ENG-55",
                        status: "completed"
                      }}

      assert_receive {:gateway_update_task, "pqtask_ENG-55", "completed",
                      %{workerRunId: "wrun_ENG-55"}}

      GenServer.stop(pid)
      Agent.stop(issues)
      cleanup_runner("ENG-55")
    end
  end

  # ── legacy sync_once fallback ──────────────────────────────────────────────

  describe "sync_once with raw map state" do
    test "filters terminal issues for legacy callers" do
      config = %{"tracker" => %{"terminal_states" => ["Done"]}}

      issues = [
        %Linear.Issue{state: "Todo", identifier: "A"},
        %Linear.Issue{state: "Done", identifier: "B"}
      ]

      {:ok, result} = Orchestrator.sync_once(%{issues: issues, workflow_config: config})
      assert length(result.active) == 1
    end
  end

  # ── helpers ─────────────────────────────────────────────────────────────────

  defp stub_socket_path do
    Path.join(System.tmp_dir!(), "af-orch-test-#{System.unique_integer([:positive])}.sock")
  end

  defp in_backoff?(rec) do
    rec.backoff_until && DateTime.compare(DateTime.utc_now(), rec.backoff_until) == :lt
  end

  defp cleanup_runner(issue_identifier) do
    case AgentFabricOrchestrator.RunnerRegistry.lookup(issue_identifier) do
      nil ->
        :ok

      pid ->
        if Process.alive?(pid) do
          DynamicSupervisor.terminate_child(AgentFabricOrchestrator.RunnerSupervisor, pid)
        end

        AgentFabricOrchestrator.RunnerRegistry.unregister(issue_identifier)
    end
  rescue
    _ -> :ok
  end

  defp write_queue_workflow(opts \\ []) do
    root = Path.join(System.tmp_dir!(), "af-orch-#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    path = Path.join(root, "WORKFLOW.md")
    after_cursor = Keyword.get(opts, :after_cursor)
    after_cursor_line = if after_cursor, do: "  after_cursor: #{after_cursor}\n", else: ""
    workspace_extra = Keyword.get(opts, :workspace_extra, "")
    agent_fabric_extra = Keyword.get(opts, :agent_fabric_extra, "")

    File.write!(path, """
    ---
    tracker:
      type: linear
      active_states: ["Todo"]
      terminal_states: ["Done"]
    #{after_cursor_line}workspace:
      root: #{root}
    #{workspace_extra}
    codex:
      command: sleep
      args: ["1"]
      max_runtime_minutes: 1
    runner:
      concurrency: 1
      heartbeat_ms: 100
      state_dir: #{root}
    agent_fabric:
      project_path: #{root}
      queue_title: Fake Queue
      auto_start_execution: true
    #{agent_fabric_extra}
    ---
    Work on {{ issue.identifier }}.
    """)

    path
  end

  defp create_git_repo! do
    root = Path.join(System.tmp_dir!(), "af-orch-source-#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf(root) end)
    git!(root, ["init"])
    git!(root, ["config", "user.email", "test@example.com"])
    git!(root, ["config", "user.name", "Agent Fabric Test"])
    File.write!(Path.join(root, "README.md"), "# Test\n")
    git!(root, ["add", "README.md"])
    git!(root, ["commit", "-m", "initial"])
    root
  end

  defp git!(cwd, args) do
    case System.cmd("git", ["-C", cwd | args], stderr_to_stdout: true) do
      {_output, 0} -> :ok
      {output, status} -> flunk("git #{Enum.join(args, " ")} failed with #{status}: #{output}")
    end
  end
end

defmodule AgentFabricOrchestrator.OrchestratorTest.FakeGateway do
  alias AgentFabricOrchestrator.FabricClient

  def register(_socket_path, _payload, _opts \\ []) do
    {:ok, %FabricClient.Session{session_id: "sess_fake", session_token: "tok_fake"}}
  end

  def close_session(_socket_path, _session, _opts \\ []), do: {:ok, %{}}

  def create_queue(_socket_path, _session, _input, _opts \\ []) do
    {:ok, %{"queueId" => "pqueue_fake"}}
  end

  def queue_status(_socket_path, _session, _queue_id, _opts \\ []), do: {:ok, %{}}
  def progress_report(_socket_path, _session, _queue_id, _opts \\ []), do: {:ok, %{}}

  def decide_queue(_socket_path, _session, _queue_id, _decision, _reason, _opts \\ []),
    do: {:ok, %{}}

  def add_task(_socket_path, _session, _queue_id, %{clientKey: client_key} = task, _opts \\ []) do
    if owner = Process.whereis(:orchestrator_fake_gateway_owner) do
      send(owner, {:gateway_add_task, client_key, task})
    end

    {:ok,
     %{
       "created" => [
         %{
           "queueTaskId" => "pqtask_#{client_key}",
           "fabricTaskId" => "task_#{client_key}"
         }
       ]
     }}
  end

  def claim_next(_socket_path, _session, _queue_id, _input, _opts \\ []) do
    {:ok, %{"claimed" => %{"queueTaskId" => "pqtask_ENG-55"}}}
  end

  def assign_worker(
        _socket_path,
        _session,
        _queue_id,
        _queue_task_id,
        _worker_run_id,
        _opts \\ []
      ) do
    {:ok, %{"assigned" => true}}
  end

  def update_task(_socket_path, _session, _queue_id, queue_task_id, status, input, _opts \\ []) do
    if owner = Process.whereis(:orchestrator_fake_gateway_owner) do
      send(owner, {:gateway_update_task, queue_task_id, status, input})
    end

    {:ok, %{}}
  end

  def start_worker(socket_path, session, input, opts \\ [])

  def start_worker(_socket_path, _session, %{metadata: %{issueIdentifier: issue}} = input, _opts) do
    if owner = Process.whereis(:orchestrator_fake_gateway_owner) do
      send(owner, {:gateway_start_worker, input})
    end

    {:ok, %{"workerRunId" => "wrun_#{issue}"}}
  end

  def start_worker(_socket_path, _session, input, _opts) do
    if owner = Process.whereis(:orchestrator_fake_gateway_owner) do
      send(owner, {:gateway_start_worker, input})
    end

    {:ok, %{"workerRunId" => "wrun_fake"}}
  end

  def event(_socket_path, _session, _input, _opts \\ []), do: {:ok, %{}}
  def heartbeat(_socket_path, _session, _input, _opts \\ []), do: {:ok, %{}}
  def checkpoint(_socket_path, _session, _input, _opts \\ []), do: {:ok, %{}}

  def finish(_socket_path, _session, input, _opts \\ []) do
    if owner = Process.whereis(:orchestrator_fake_gateway_owner) do
      send(owner, {:gateway_finish, input})
    end

    {:ok, %{}}
  end

  def task_status(_socket_path, _session, _task_id, _opts \\ []), do: {:ok, %{}}
end

defmodule AgentFabricOrchestrator.OrchestratorTest.FakeReuseGateway do
  def add_task(_socket_path, _session, _queue_id, %{clientKey: client_key}, _opts \\ []) do
    {:ok,
     %{
       "reused" => [
         %{
           "queueTaskId" => "pqtask_reused_#{client_key}",
           "fabricTaskId" => "task_reused_#{client_key}",
           "reused" => true
         }
       ]
     }}
  end
end
