defmodule AgentFabricOrchestrator.MixTasksTest do
  use ExUnit.Case, async: false

  setup do
    Mix.shell(Mix.Shell.Process)
    Application.delete_env(:agent_fabric_orchestrator, :fabric_transport)

    on_exit(fn ->
      Application.delete_env(:agent_fabric_orchestrator, :fabric_transport)
      Mix.shell(Mix.Shell.IO)
    end)

    :ok
  end

  test "af.orchestrator.run supports dry-run workflow validation" do
    workflow = write_workflow()
    Mix.Task.reenable("af.orchestrator.run")

    Mix.Tasks.Af.Orchestrator.Run.run(["--workflow", workflow, "--once", "--dry-run", "--json"])

    assert_receive {:mix_shell, :info, [json]}
    assert {:ok, parsed} = Jason.decode(json)
    assert parsed["mode"] == "dry_run"
    assert parsed["concurrency"] == 2
    assert parsed["queue_title"] == "Test Queue"
  end

  test "mix tasks reject unknown options" do
    Mix.Task.reenable("af.workflow.check")

    assert_raise Mix.Error, ~r/unknown option/, fn ->
      Mix.Tasks.Af.Workflow.Check.run(["--definitely-not-valid"])
    end
  end

  test "af.status cleanup dry-run requires a queue or project scope before daemon calls" do
    Mix.Task.reenable("af.status")

    Mix.Tasks.Af.Status.run(["--cleanup-dry-run", "--json"])

    assert_receive {:mix_shell, :info, [json]}
    assert {:ok, parsed} = Jason.decode(json)
    assert parsed["queue"]["cleanup"]["error"] =~ "--cleanup-dry-run requires"
  end

  test "af.status stale dry-run requires a queue before daemon calls" do
    Mix.Task.reenable("af.status")

    Mix.Tasks.Af.Status.run(["--stale-dry-run", "--json"])

    assert_receive {:mix_shell, :info, [json]}
    assert {:ok, parsed} = Jason.decode(json)
    assert parsed["queue"]["stale"]["error"] =~ "--stale-dry-run requires --queue"
  end

  test "af.status previews local workspace cleanup without daemon calls" do
    root =
      Path.join(System.tmp_dir!(), "af-status-workspaces-#{System.unique_integer([:positive])}")

    File.mkdir_p!(Path.join(root, "old-workspace"))
    Mix.Task.reenable("af.status")

    Mix.Tasks.Af.Status.run([
      "--workspace-cleanup-dry-run",
      "--workspace-root",
      root,
      "--json"
    ])

    assert_receive {:mix_shell, :info, [json]}
    assert {:ok, parsed} = Jason.decode(json)
    assert parsed["runtime"]["workspace_cleanup"]["root"] == root
    assert parsed["runtime"]["workspace_cleanup"]["candidate_count"] == 1

    File.rm_rf!(root)
  end

  test "af.status --worker-health requires --queue scope" do
    Mix.Task.reenable("af.status")

    Mix.Tasks.Af.Status.run(["--worker-health", "pqueue_123", "--json"])

    assert_receive {:mix_shell, :info, [json]}
    assert {:ok, parsed} = Jason.decode(json)
    assert is_map(parsed["worker_health"])
  end

  test "af.status --worker-health projects nested Agent Fabric lanes" do
    Mix.Task.reenable("af.status")

    Application.put_env(:agent_fabric_orchestrator, :fabric_transport, fn encoded ->
      {:ok, request} = Jason.decode(encoded)

      case {request["type"], request["tool"]} do
        {"register", _} ->
          {:ok, %{"ok" => true, "result" => %{"sessionId" => "sess_fake"}}}

        {_, "project_queue_worker_health"} ->
          {:ok,
           %{
             "ok" => true,
             "result" => %{
               "summary" => %{"total" => 1, "healthy" => 1},
               "workers" => [
                 %{
                   "workerRunId" => "wrun_1",
                   "queueTaskId" => "pqtask_1",
                   "classification" => "healthy",
                   "worker" => "jcode-deepseek"
                 }
               ]
             }
           }}

        _ ->
          {:ok, %{"ok" => true, "result" => %{}}}
      end
    end)

    Mix.Tasks.Af.Status.run(["--worker-health", "pqueue_123", "--json"])

    assert_receive {:mix_shell, :info, [json]}
    assert {:ok, parsed} = Jason.decode(json)
    assert parsed["worker_health"]["active_lanes"] == 1
    assert [lane] = parsed["worker_health"]["lanes"]
    assert lane["queue_task_id"] == "pqtask_1"
    assert lane["worker"] == "jcode-deepseek"
  end

  test "af.status --task-tail requires --queue scope" do
    Mix.Task.reenable("af.status")

    Mix.Tasks.Af.Status.run(["--queue", "pqueue_123", "--task-tail", "pqtask_xyz", "--json"])

    assert_receive {:mix_shell, :info, [json]}
    assert {:ok, parsed} = Jason.decode(json)
    assert is_map(parsed["queue"])
    assert is_map(parsed["queue"]["task_tail"])
  end

  test "af.status --patch-review requires --queue" do
    Mix.Task.reenable("af.status")

    Mix.Tasks.Af.Status.run(["--patch-review", "--json"])

    assert_receive {:mix_shell, :info, [json]}
    assert {:ok, parsed} = Jason.decode(json)
    assert parsed["patch_review"]["error"] =~ "--patch-review requires --queue"
  end

  test "af.status --collab-summary requires --queue" do
    Mix.Task.reenable("af.status")

    Mix.Tasks.Af.Status.run(["--collab-summary", "--json"])

    assert_receive {:mix_shell, :info, [json]}
    assert {:ok, parsed} = Jason.decode(json)
    assert parsed["collab_summary"]["error"] =~ "--collab-summary requires --queue"
  end

  defp write_workflow do
    root = Path.join(System.tmp_dir!(), "af-mix-task-#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    path = Path.join(root, "WORKFLOW.md")

    File.write!(path, """
    ---
    tracker:
      type: linear
      team_key: ENG
    workspace:
      root: #{root}
    codex:
      command: sh
      args: ["-c", "true"]
    runner:
      concurrency: 2
    agent_fabric:
      project_path: #{root}
      queue_title: Test Queue
    ---
    Work on {{ issue.identifier }}.
    """)

    path
  end
end
