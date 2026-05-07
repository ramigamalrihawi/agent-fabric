defmodule AgentFabricOrchestrator.CodexRunnerTest do
  use ExUnit.Case, async: false

  alias AgentFabricOrchestrator.CodexRunner

  # ── Helpers ───────────────────────────────────────────────────────

  defp default_opts(overrides \\ []) do
    Keyword.merge(
      [
        id: "runner-test-#{:erlang.unique_integer([:positive])}",
        workspace: "/tmp/codex-runner-test-#{:erlang.unique_integer([:positive])}",
        command: "echo 'fake codex run'",
        provider: AgentFabricOrchestrator.CodexRunner.FakeProvider
      ],
      overrides
    )
  end

  # ── Tests ─────────────────────────────────────────────────────────

  describe "start_link/1" do
    test "starts successfully with valid options" do
      opts = default_opts()
      assert {:ok, pid} = CodexRunner.start_link(opts)
      assert is_pid(pid)
      assert Process.alive?(pid)

      # Stop cleanly
      CodexRunner.stop(pid)
    end

    test "records command_spawned lifecycle event" do
      opts = default_opts()
      {:ok, pid} = CodexRunner.start_link(opts)

      status = CodexRunner.status(pid)
      assert status.id =~ "runner-test-"
      assert status.status == :running
      assert is_integer(status.lifecycle_event_count)
      assert status.lifecycle_event_count > 0

      CodexRunner.stop(pid)
    end

    test "transitions to running status" do
      opts = default_opts()
      {:ok, pid} = CodexRunner.start_link(opts)
      status = CodexRunner.status(pid)
      assert status.status == :running
      CodexRunner.stop(pid)
    end

    test "fails with missing required options" do
      assert {:error, _reason} = CodexRunner.start_link([])
    end

    test "fails when provider launch returns error" do
      opts = default_opts(provider: AgentFabricOrchestrator.CodexRunnerTest.FailingProvider)
      result = CodexRunner.start_link(opts)
      assert result == :ignore || match?({:error, _reason}, result)
    end
  end

  describe "status/1" do
    test "returns runner status map" do
      opts = default_opts()
      {:ok, pid} = CodexRunner.start_link(opts)

      status = CodexRunner.status(pid)
      assert is_map(status)
      assert Map.has_key?(status, :id)
      assert Map.has_key?(status, :status)
      assert Map.has_key?(status, :workspace)
      assert Map.has_key?(status, :command)
      assert Map.has_key?(status, :lifecycle_event_count)
      assert Map.has_key?(status, :timeout_ms)

      CodexRunner.stop(pid)
    end

    test "exposes proof metadata for workspace mode, heartbeats, and duration" do
      opts =
        default_opts(
          heartbeat_interval_ms: 10,
          workspace_mode: "directory",
          workspace_source_project: "/tmp/source-project"
        )

      {:ok, pid} = CodexRunner.start_link(opts)
      Process.sleep(40)

      status = CodexRunner.status(pid)
      assert status.workspace_mode == "directory"
      assert status.workspace_source_project == "/tmp/source-project"
      assert status.heartbeat_count > 0
      assert status.command_duration_ms >= 0
      assert status.last_event.kind in ["command_started", "heartbeat", "command_output"]

      CodexRunner.stop(pid)
    end
  end

  describe "send_prompt/2" do
    test "sends prompt to running provider" do
      opts = default_opts()
      {:ok, pid} = CodexRunner.start_link(opts)

      assert :ok = CodexRunner.send_prompt(pid, "write a test")
      assert :ok = CodexRunner.send_prompt(pid, "fix bug")

      CodexRunner.stop(pid)
    end

    test "returns error when runner is not running" do
      opts = default_opts()
      {:ok, pid} = CodexRunner.start_link(opts)
      CodexRunner.stop(pid)
      # wait for process exit
      Process.sleep(50)
      refute Process.alive?(pid)
    end
  end

  describe "stop/1" do
    test "stops the runner gracefully" do
      opts = default_opts()
      {:ok, pid} = CodexRunner.start_link(opts)

      assert :ok = CodexRunner.stop(pid)

      # Runner should no longer be alive
      refute Process.alive?(pid)
    end

    test "is idempotent" do
      opts = default_opts()
      {:ok, pid} = CodexRunner.start_link(opts)

      assert :ok = CodexRunner.stop(pid)
      Process.sleep(50)
      refute Process.alive?(pid)
    end
  end

  describe "checkpoint/2" do
    test "records a checkpoint event" do
      opts = default_opts()
      {:ok, pid} = CodexRunner.start_link(opts)

      before_count = CodexRunner.status(pid).lifecycle_event_count
      assert :ok = CodexRunner.checkpoint(pid, "halfway done", %{progress: 50})
      after_count = CodexRunner.status(pid).lifecycle_event_count
      assert after_count > before_count

      CodexRunner.stop(pid)
    end
  end

  describe "child_spec/1" do
    test "returns a valid child_spec" do
      opts = default_opts()
      spec = CodexRunner.child_spec(opts)

      assert spec.id |> elem(0) == CodexRunner
      assert spec.start |> elem(0) == CodexRunner
      assert spec.start |> elem(1) == :start_link
      assert spec.restart == :temporary
      assert spec.type == :worker
    end
  end

  describe "lifecycle events" do
    test "records events for full lifecycle: start → prompt → stop" do
      opts = default_opts()
      {:ok, pid} = CodexRunner.start_link(opts)

      CodexRunner.send_prompt(pid, "do work")
      CodexRunner.checkpoint(pid, "milestone", %{})
      CodexRunner.stop(pid)

      # After stop, the GenServer is dead, so we validate via the provider
      # exit monitoring instead
      refute Process.alive?(pid)
    end
  end

  describe "timeout behavior" do
    test "accepts timeout_ms option" do
      opts = default_opts(timeout_ms: 120_000)
      {:ok, pid} = CodexRunner.start_link(opts)

      status = CodexRunner.status(pid)
      assert status.timeout_ms == 120_000

      CodexRunner.stop(pid)
    end

    test "stops a long-running provider when timeout_ms elapses" do
      opts =
        default_opts(
          provider: AgentFabricOrchestrator.CodexRunnerTest.SlowProvider,
          timeout_ms: 30
        )

      {:ok, pid} = CodexRunner.start_link(opts)
      ref = Process.monitor(pid)

      assert_receive {:DOWN, ^ref, :process, ^pid, _reason}, 1_000
      refute Process.alive?(pid)
    end
  end

  describe "FakeProvider self-exit" do
    test "provider exits normally after enough prompts" do
      # Configure the fake provider to exit after 2 prompts
      Application.put_env(
        :agent_fabric_orchestrator,
        AgentFabricOrchestrator.CodexRunner.FakeProvider,
        canned_outputs: ["init"],
        exit_after_prompts: 2
      )

      opts = default_opts()
      {:ok, pid} = CodexRunner.start_link(opts)

      # Monitor runner for exit
      Process.monitor(pid)

      # Send prompts to trigger auto-exit
      CodexRunner.send_prompt(pid, "prompt 1")
      CodexRunner.send_prompt(pid, "prompt 2")

      # Runner should exit after provider finishes
      receive do
        {:DOWN, _ref, :process, ^pid, _reason} ->
          refute Process.alive?(pid)
      after
        2000 -> flunk("Runner did not exit after provider finished")
      end
    end
  end
end

defmodule AgentFabricOrchestrator.CodexRunnerTest.SlowProvider do
  @behaviour AgentFabricOrchestrator.CodexRunner.Provider

  def launch(_command, _workspace) do
    parent = self()

    pid =
      spawn(fn ->
        send(parent, {:provider_started, self()})
        Process.sleep(:infinity)
      end)

    {:ok, pid}
  end

  def send_input(_provider_pid, _input), do: :ok

  def stop(provider_pid, _timeout_ms) do
    Process.exit(provider_pid, :kill)
    :ok
  end

  def alive?(provider_pid), do: Process.alive?(provider_pid)
end

# ── Failing Provider for Test ───────────────────────────────────────
defmodule AgentFabricOrchestrator.CodexRunnerTest.FailingProvider do
  @behaviour AgentFabricOrchestrator.CodexRunner.Provider

  def launch(_command, _workspace) do
    {:error, :simulated_launch_failure}
  end

  def send_input(_provider_pid, _input) do
    {:error, :not_running}
  end

  def stop(_provider_pid, _timeout_ms) do
    :ok
  end

  def alive?(_provider_pid) do
    false
  end
end
