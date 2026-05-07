defmodule AgentFabricOrchestrator.DashboardTest do
  use ExUnit.Case, async: false

  alias AgentFabricOrchestrator.Dashboard

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
    assert is_binary(parsed["data"]["note"])
  end

  test "GET /api/lanes returns empty when orchestrator not running" do
    {status, body} = http_get(~c"/api/lanes")
    assert status == 200
    {:ok, parsed} = Jason.decode(body)
    assert parsed["source"] == "runtime"
    assert parsed["lanes"] == []
    assert parsed["orchestator_alive"] == false
  end

  test "GET /api/progress returns combined runtime+durable structure" do
    {status, body} = http_get(~c"/api/progress")
    assert status == 200
    {:ok, parsed} = Jason.decode(body)
    assert parsed["runtime"]["source"] =~ "runtime"
    assert parsed["durable"]["source"] =~ "durable"
    assert parsed["runtime"]["data"]["orchestator_alive"] == false
    assert is_map(parsed["durable"]["data"])
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
end
