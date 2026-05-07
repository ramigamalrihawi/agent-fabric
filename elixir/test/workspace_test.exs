defmodule AgentFabricOrchestrator.WorkspaceTest do
  use ExUnit.Case, async: true

  alias AgentFabricOrchestrator.Workspace

  test "creates deterministic workspace and runs after_create once" do
    tmp_root = Path.join(System.tmp_dir!(), "af-workspace-test-#{System.unique_integer([:positive])}")
    issue = %{identifier: "ENG-77", title: "Add workspace manager"}

    on_exit(fn -> File.rm_rf(tmp_root) end)

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
end
