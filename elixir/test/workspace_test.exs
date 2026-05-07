defmodule AgentFabricOrchestrator.WorkspaceTest do
  use ExUnit.Case, async: true

  alias AgentFabricOrchestrator.Workspace

  defp tmp_root(prefix) do
    path = Path.join(System.tmp_dir!(), "#{prefix}-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf(path) end)
    path
  end

  test "creates deterministic workspace and runs after_create once" do
    tmp_root = tmp_root("af-workspace-test")
    issue = %{identifier: "ENG-77", title: "Add workspace manager"}

    assert {:ok, first} =
             Workspace.ensure_workspace(tmp_root, issue,
               after_create: fn path -> {:ok, %{path: path, ran: true}} end
             )

    assert first.created?
    assert first.hook.ran
    assert File.dir?(first.path)

    assert {:ok, second} =
             Workspace.ensure_workspace(tmp_root, issue,
               after_create: fn _path -> flunk("hook should not run twice") end
             )

    refute second.created?
  end

  test "runs argv after_create hook without shell metadata" do
    tmp_root = tmp_root("af-workspace-argv")
    issue = %{identifier: "ENG-78", title: "Argv hook"}

    assert {:ok, result} =
             Workspace.ensure_workspace(tmp_root, issue,
               after_create: ["sh", "-c", "printf ok > hook.txt"]
             )

    assert result.hook.shell == false
    assert result.hook.exit_status == 0
    assert File.read!(Path.join(result.path, "hook.txt")) == "ok"
  end

  test "marks string after_create hook as shell-backed" do
    tmp_root = tmp_root("af-workspace-shell")
    issue = %{identifier: "ENG-79", title: "Shell hook"}

    assert {:ok, result} =
             Workspace.ensure_workspace(tmp_root, issue,
               after_create: "printf shell > shell-hook.txt"
             )

    assert result.hook.shell == true
    assert File.read!(Path.join(result.path, "shell-hook.txt")) == "shell"
  end

  test "fails closed for unsupported hook shape" do
    tmp_root = tmp_root("af-workspace-bad-hook")
    issue = %{identifier: "ENG-80", title: "Bad hook"}

    assert {:error, {:unsupported_after_create_hook, %{unknown: true}}} =
             Workspace.ensure_workspace(tmp_root, issue, after_create: %{unknown: true})
  end

  test "fails closed when argv after_create exits non-zero" do
    tmp_root = tmp_root("af-workspace-bad-argv")
    issue = %{identifier: "ENG-81", title: "Bad argv"}

    assert {:error, {:after_create_failed, 7, _output}} =
             Workspace.ensure_workspace(tmp_root, issue, after_create: ["sh", "-c", "exit 7"])
  end

  test "fails closed for argv hook with non-binary arguments" do
    tmp_root = tmp_root("af-workspace-argv-nonbinary")
    issue = %{identifier: "ENG-84", title: "Non-binary argv"}

    assert {:error, {:unsupported_after_create_hook, ["sh", 123]}} =
             Workspace.ensure_workspace(tmp_root, issue, after_create: ["sh", 123])
  end

  test "fails closed for argv hook with empty command" do
    tmp_root = tmp_root("af-workspace-argv-empty")
    issue = %{identifier: "ENG-85", title: "Empty argv command"}

    assert {:error, {:unsupported_after_create_hook, ["", "arg"]}} =
             Workspace.ensure_workspace(tmp_root, issue, after_create: ["", "arg"])
  end

  test "runs string-keyed map after_create hook as argv" do
    tmp_root = tmp_root("af-workspace-map-hook")
    issue = %{identifier: "ENG-86", title: "Map argv hook"}

    assert {:ok, result} =
             Workspace.ensure_workspace(tmp_root, issue,
               after_create: %{"command" => "sh", "args" => ["-c", "printf map > hook.txt"]}
             )

    assert result.hook.shell == false
    assert result.hook.argv == ["sh", "-c", "printf map > hook.txt"]
    assert File.read!(Path.join(result.path, "hook.txt")) == "map"
  end

  test "runs atom-keyed map after_create hook as argv" do
    tmp_root = tmp_root("af-workspace-atom-map-hook")
    issue = %{identifier: "ENG-87", title: "Atom map argv hook"}

    assert {:ok, result} =
             Workspace.ensure_workspace(tmp_root, issue,
               after_create: %{command: "sh", args: ["-c", "printf atom > hook.txt"]}
             )

    assert result.hook.shell == false
    assert result.hook.argv == ["sh", "-c", "printf atom > hook.txt"]
    assert File.read!(Path.join(result.path, "hook.txt")) == "atom"
  end

  test "fails closed when map after_create hook exits non-zero" do
    tmp_root = tmp_root("af-workspace-map-fail")
    issue = %{identifier: "ENG-88", title: "Map argv failure"}

    assert {:error, {:after_create_failed, 7, _output}} =
             Workspace.ensure_workspace(tmp_root, issue,
               after_create: %{"command" => "sh", "args" => ["-c", "exit 7"]}
             )
  end

  test "fails closed when string after_create hook exits non-zero" do
    tmp_root = tmp_root("af-workspace-string-fail")
    issue = %{identifier: "ENG-89", title: "String hook failure"}

    assert {:error, {:after_create_failed, 7, _output}} =
             Workspace.ensure_workspace(tmp_root, issue, after_create: "exit 7")
  end

  test "creates and reuses git worktree workspace" do
    source = create_git_repo!()
    tmp_root = tmp_root("af-workspace-git")
    issue = %{identifier: "ENG-82", title: "Git worktree"}

    assert {:ok, first} =
             Workspace.ensure_workspace(tmp_root, issue,
               mode: "git_worktree",
               source_project: source
             )

    assert first.mode == "git_worktree"
    assert first.source_project == source
    assert first.created?
    assert File.exists?(Path.join(first.path, ".git"))

    assert {:ok, second} =
             Workspace.ensure_workspace(tmp_root, issue,
               mode: "git_worktree",
               source_project: source
             )

    refute second.created?
    assert second.path == first.path
  end

  test "git worktree mode rejects missing source and invalid existing path" do
    tmp_root = tmp_root("af-workspace-git-fail")
    issue = %{identifier: "ENG-83", title: "Git failure"}

    assert {:error, :git_worktree_source_project_required} =
             Workspace.ensure_workspace(tmp_root, issue, mode: "git_worktree")

    source = create_git_repo!()
    workspace = Workspace.path(tmp_root, issue)
    File.mkdir_p!(workspace)
    File.write!(Path.join(workspace, "plain.txt"), "not a worktree")

    assert {:error, {:workspace_exists_not_git_worktree, ^workspace}} =
             Workspace.ensure_workspace(tmp_root, issue,
               mode: "git_worktree",
               source_project: source
             )
  end

  defp create_git_repo! do
    repo = tmp_root("af-workspace-source")
    File.mkdir_p!(repo)
    git!(repo, ["init"])
    git!(repo, ["config", "user.email", "test@example.com"])
    git!(repo, ["config", "user.name", "Agent Fabric Test"])
    File.write!(Path.join(repo, "README.md"), "# Test\n")
    git!(repo, ["add", "README.md"])
    git!(repo, ["commit", "-m", "initial"])
    repo
  end

  defp git!(cwd, args) do
    case System.cmd("git", ["-C", cwd | args], stderr_to_stdout: true) do
      {_output, 0} ->
        :ok

      {output, status} ->
        flunk("git #{Enum.join(args, " ")} failed with #{status}: #{output}")
    end
  end
end
