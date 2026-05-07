defmodule AgentFabricOrchestrator.DashboardTest do
  use ExUnit.Case, async: false

  alias AgentFabricOrchestrator.{Dashboard, Workflow}

  # The Dashboard is started by the Application supervisor on this port
  @test_port 9457

  # --- Helpers ---

  defp http_get(uri) do
    case :httpc.request(:get, {~c"http://127.0.0.1:#{@test_port}#{uri}", []}, [{:timeout, 2_000}],
           body_format: :binary
         ) do
      {:ok, {{_, status, _}, _headers, body}} -> {status, body}
      {:error, reason} -> {:error, reason}
    end
  end

  # --- Legacy Snapshot API ---

  describe "snapshot/2 and json/1 (legacy API for Phoenix LiveView mount)" do
    test "builds json-ready snapshot" do
      snapshot =
        Dashboard.snapshot(
          %{active: %{"ENG-1" => %{}}},
          %{
            "queue" => %{"queueId" => "pqueue_1"},
            "summary" => %{"status" => "running", "counts" => %{"activeWorkers" => 3}}
          }
        )

      assert snapshot.runtime.active_issue_count == 1
      assert snapshot.fabric.queue_id == "pqueue_1"
      assert {:ok, json} = Dashboard.json(snapshot)
      assert json =~ "agent_fabric_elixir_orchestrator"
    end

    test "handles nil/empty active" do
      snapshot = Dashboard.snapshot(%{active: %{}}, %{})
      assert snapshot.runtime.active_issue_count == 0
      assert {:ok, _} = Dashboard.json(snapshot)
    end
  end

  # --- HTTP Endpoints (test against Application-started Dashboard) ---

  test "GET /health returns 200 and application info" do
    {status, body} = http_get(~c"/health")
    assert status == 200
    {:ok, parsed} = Jason.decode(body)
    assert parsed["status"] == "ok"
    assert parsed["application"] == "agent_fabric_orchestrator"
  end

  test "GET /api/status returns 200, reports orchestrator not running when not autostarted" do
    {status, body} = http_get(~c"/api/status")
    assert status == 200
    {:ok, parsed} = Jason.decode(body)
    assert parsed["source"] == "runtime"
    assert parsed["data"]["orchestator_alive"] == false
    assert parsed["data"]["orchestrator_alive"] == false
    assert is_binary(parsed["data"]["note"])
  end

  test "GET /api/lanes returns empty when orchestrator not running" do
    {status, body} = http_get(~c"/api/lanes")
    assert status == 200
    {:ok, parsed} = Jason.decode(body)
    assert parsed["source"] == "runtime"
    assert parsed["lanes"] == []
    assert parsed["orchestator_alive"] == false
    assert parsed["orchestrator_alive"] == false
  end

  test "GET /api/progress returns combined runtime+durable structure" do
    {status, body} = http_get(~c"/api/progress")
    assert status == 200
    {:ok, parsed} = Jason.decode(body)
    assert parsed["runtime"]["source"] =~ "runtime"
    assert parsed["durable"]["source"] =~ "durable"
    assert parsed["runtime"]["data"]["orchestator_alive"] == false
    assert parsed["runtime"]["data"]["orchestrator_alive"] == false
    assert is_map(parsed["durable"]["data"])
  end

  describe "with orchestrator runtime state" do
    setup do
      if Process.whereis(AgentFabricOrchestrator.Orchestrator) do
        flunk("test expects the orchestrator not to be autostarted")
      end

      workflow = %Workflow{
        path: "/tmp/WORKFLOW.md",
        config: %{
          "agent_fabric" => %{"project_path" => "/tmp/project"},
          "runner" => %{"concurrency" => 4}
        },
        prompt_template: "Work"
      }

      state = %{
        workflow: workflow,
        queue_id: "pqueue_test",
        concurrency: 4,
        state_store_path: "/tmp/state.json",
        active_runners: 2,
        last_error: nil,
        last_poll_result: %{status: "ok"},
        recent_failures: [%{subject: "poll", reason: "timeout"}],
        issues: %{
          "ENG-1" => %{
            issue: %{title: "Test issue"},
            fabric_task_id: "task_1",
            queue_task_id: "pqtask_1",
            queue_id: "pqueue_test",
            worker_run_id: "wrun_1",
            workspace_path: "/tmp/ws",
            status: "running",
            last_error: nil
          }
        }
      }

      {:ok, pid} = Agent.start_link(fn -> state end, name: AgentFabricOrchestrator.Orchestrator)
      on_exit(fn -> if Process.alive?(pid), do: Agent.stop(pid) end)
      :ok
    end

    test "GET /api/status reports the correctly spelled alive key" do
      {status, body} = http_get(~c"/api/status")
      assert status == 200
      {:ok, parsed} = Jason.decode(body)

      assert parsed["data"]["orchestrator_alive"] == true
      assert parsed["data"]["orchestator_alive"] == true
      assert parsed["data"]["active_issue_count"] == 1
    end

    test "GET /api/lanes and /api/failures include compatibility alive keys" do
      {lanes_status, lanes_body} = http_get(~c"/api/lanes")
      assert lanes_status == 200
      {:ok, lanes} = Jason.decode(lanes_body)
      assert lanes["orchestrator_alive"] == true
      assert lanes["orchestator_alive"] == true
      assert length(lanes["lanes"]) == 1

      {failures_status, failures_body} = http_get(~c"/api/failures")
      assert failures_status == 200
      {:ok, failures} = Jason.decode(failures_body)
      assert failures["orchestrator_alive"] == true
      assert length(failures["recent_failures"]) == 1
    end
  end

  test "GET runtime usability endpoints return JSON when orchestrator is not running" do
    for path <- [
          ~c"/api/workflow",
          ~c"/api/runners",
          ~c"/api/issues",
          ~c"/api/failures",
          ~c"/api/workspaces"
        ] do
      {status, body} = http_get(path)
      assert status == 200
      assert {:ok, parsed} = Jason.decode(body)
      assert parsed["source"] == "runtime"
    end
  end

  test "GET /api/queue-health/:id returns proxy response structure" do
    {status, body} = http_get(~c"/api/queue-health/pqueue_test123")
    assert status == 200
    {:ok, parsed} = Jason.decode(body)
    assert parsed["source"] == "durable"
    assert parsed["queue_id"] == "pqueue_test123"
    assert is_map(parsed["data"])
  end

  test "unknown path returns 404" do
    {status, body} = http_get(~c"/api/nonexistent")
    assert status == 404
    {:ok, parsed} = Jason.decode(body)
    assert parsed["error"] == "not_found"
  end

  test "POST on GET-only path returns 405" do
    {:ok, sock} = :gen_tcp.connect({127, 0, 0, 1}, @test_port, [:binary, active: false], 2000)
    :gen_tcp.send(sock, "POST /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")

    case :gen_tcp.recv(sock, 0, 2000) do
      {:ok, data} ->
        assert data =~ "405" or data =~ "Method Not Allowed"

      {:error, _} ->
        :ok
    end

    :gen_tcp.close(sock)
  end

  test "port returns configured port" do
    assert Dashboard.port() == @test_port
  end

  test "GET /api/sync-health returns structured response when orchestrator is not running" do
    # The /health, /api/status, /api/lanes, /api/progress, /api/workflow,
    # /api/runners, /api/issues, /api/failures, and /api/workspaces endpoints
    # return 200 with not-running payloads.  The /api/sync-health endpoint
    # follows the same contract: it returns 200 with empty data when the
    # orchestrator is down.
    {status, body} = http_get(~c"/api/sync-health")
    assert status == 200
    {:ok, parsed} = Jason.decode(body)
    assert parsed["source"] == "runtime"
    assert parsed["data"]["issues"]["total"] == 0
  end

  describe "GET /api/sync-health with running orchestrator" do
    setup do
      if Process.whereis(AgentFabricOrchestrator.Orchestrator) do
        flunk("test expects the orchestrator not to be autostarted")
      end

      workflow = %Workflow{
        path: "/tmp/WORKFLOW.md",
        config: %{
          "agent_fabric" => %{"project_path" => "/tmp/project"},
          "runner" => %{"concurrency" => 4}
        },
        prompt_template: "Work"
      }

      state = %{
        workflow: workflow,
        queue_id: "pqueue_sync_health",
        concurrency: 4,
        state_store_path: "/tmp/sync_health.json",
        active_runners: 1,
        consecutive_failures: 0,
        last_error: nil,
        recent_failures: [],
        poll_cursor: %{
          after: "cursor_test",
          has_next_page: true,
          wrapped: false,
          page_size: 25,
          last_page_count: 10,
          updated_at: "2026-01-01T00:00:00Z"
        },
        issues: %{
          "ENG-Q" => %{
            issue: %{title: "Queued issue"},
            fabric_task_id: "task_q",
            queue_task_id: "pqtask_q",
            worker_run_id: nil,
            workspace_path: "/tmp/ws-q",
            status: :queued
          },
          "ENG-R" => %{
            issue: %{title: "Running issue"},
            fabric_task_id: "task_r",
            queue_task_id: "pqtask_r",
            worker_run_id: "wrun_r",
            workspace_path: "/tmp/ws-r",
            status: :running
          },
          "ENG-T" => %{
            issue: %{title: "Done issue"},
            fabric_task_id: "task_t",
            queue_task_id: "pqtask_t",
            workspace_path: "/tmp/ws-t",
            status: :terminal
          }
        }
      }

      {:ok, pid} = Agent.start_link(fn -> state end, name: AgentFabricOrchestrator.Orchestrator)
      on_exit(fn -> if Process.alive?(pid), do: Agent.stop(pid) end)
      :ok
    end

    test "returns sync health with cursor, issue counts, and terminal cleanup" do
      {status, body} = http_get(~c"/api/sync-health")
      assert status == 200
      {:ok, parsed} = Jason.decode(body)

      assert parsed["orchestrator_alive"] == true
      assert parsed["orchestator_alive"] == true

      data = parsed["data"]
      assert data["cursor"]["after"] == "cursor_test"
      assert data["cursor"]["has_next_page"] == true
      assert data["issues"]["total"] == 3
      assert data["issues"]["queued"] == 1
      assert data["issues"]["running"] == 1
      assert data["issues"]["terminal"] == 1

      assert length(data["terminal_cleanup"]) == 1
      cleanup = Enum.find(data["terminal_cleanup"], &(&1["identifier"] == "ENG-T"))
      assert cleanup["workspace_path"] == "/tmp/ws-t"
      assert cleanup["fabric_task_id"] == "task_t"
      assert cleanup["queue_task_id"] == "pqtask_t"
    end
  end
end
