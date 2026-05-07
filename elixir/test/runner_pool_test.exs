defmodule AgentFabricOrchestrator.RunnerPoolTest do
  use ExUnit.Case, async: false

  alias AgentFabricOrchestrator.{CodexRunner, RunnerPool, RunnerRegistry}

  defp runner_opts(issue_identifier) do
    [
      id: "runner-pool-#{issue_identifier}",
      workspace: Path.join(System.tmp_dir!(), "runner-pool-#{issue_identifier}"),
      command: "fake",
      provider: CodexRunner.FakeProvider,
      heartbeat_interval_ms: 1_000,
      timeout_ms: 60_000
    ]
  end

  setup do
    on_exit(fn ->
      for issue_identifier <- RunnerRegistry.list() do
        if String.starts_with?(issue_identifier, "ENG-POOL") do
          _ = RunnerPool.stop_runner(issue_identifier)
        end
      end
    end)

    :ok
  end

  test "prevents duplicate active runners for one issue identifier" do
    {:ok, pool} = RunnerPool.start_link(name: nil)
    issue_identifier = "ENG-POOL-1"

    assert {:ok, pid} =
             RunnerPool.start_runner(
               pool,
               issue_identifier,
               CodexRunner,
               runner_opts(issue_identifier)
             )

    assert Process.alive?(pid)

    assert {:error, {:runner_already_active, ^issue_identifier, ^pid}} =
             RunnerPool.start_runner(
               pool,
               issue_identifier,
               CodexRunner,
               runner_opts(issue_identifier)
             )

    assert :ok = RunnerPool.stop_runner(pool, issue_identifier)
    refute Process.alive?(pid)
  end

  test "reports active pool status and runner details" do
    {:ok, pool} = RunnerPool.start_link(name: nil)
    issue_identifier = "ENG-POOL-2"

    assert {:ok, pid} =
             RunnerPool.start_runner(
               pool,
               issue_identifier,
               CodexRunner,
               runner_opts(issue_identifier)
             )

    status = RunnerPool.status(pool)
    assert status.alive == true
    assert status.active == 1
    assert [%{issue_identifier: ^issue_identifier, pid: ^pid, alive: true}] = status.runners

    runner_status = RunnerPool.runner_status(pool, issue_identifier)
    assert runner_status.pid == pid
    assert runner_status.status.status == :running

    assert :ok = RunnerPool.stop_runner(pool, issue_identifier)
    assert RunnerPool.status(pool).active == 0
  end

  test "enforces optional concurrency cap" do
    {:ok, pool} = RunnerPool.start_link(name: nil, max_runners: 1)

    assert {:ok, _pid} =
             RunnerPool.start_runner(pool, "ENG-POOL-3", CodexRunner, runner_opts("ENG-POOL-3"))

    assert {:error, :at_capacity} =
             RunnerPool.start_runner(pool, "ENG-POOL-4", CodexRunner, runner_opts("ENG-POOL-4"))

    assert :ok = RunnerPool.stop_runner(pool, "ENG-POOL-3")
  end
end
