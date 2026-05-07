defmodule AgentFabricOrchestrator.MixTasksTest do
  use ExUnit.Case, async: false

  setup do
    Mix.shell(Mix.Shell.Process)
    on_exit(fn -> Mix.shell(Mix.Shell.IO) end)
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
