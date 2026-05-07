defmodule AgentFabricOrchestrator.OrchestratorTest do
  use ExUnit.Case, async: false

  alias AgentFabricOrchestrator.{Orchestrator, Linear, Workflow}

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
end
