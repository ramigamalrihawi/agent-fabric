defmodule AgentFabricOrchestrator.StateStoreTest do
  use ExUnit.Case, async: true

  alias AgentFabricOrchestrator.StateStore

  test "saves and reloads issue queue mappings" do
    path = Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

    state =
      StateStore.empty()
      |> Map.put("queue_id", "pqueue_1")
      |> StateStore.put_issue("ENG-1", %{
        "queue_task_id" => "pqtask_1",
        "fabric_task_id" => "task_1",
        "status" => "queued"
      })

    assert :ok = StateStore.save(path, state)
    assert {:ok, loaded} = StateStore.load(path)
    assert loaded["queue_id"] == "pqueue_1"
    assert StateStore.get_issue(loaded, "ENG-1")["queue_task_id"] == "pqtask_1"
  end

  test "missing state file returns an empty state document" do
    path =
      Path.join(System.tmp_dir!(), "af-state-missing-#{System.unique_integer([:positive])}.json")

    assert {:ok, loaded} = StateStore.load(path)
    assert loaded["version"] == 1
    assert loaded["issues"] == %{}
  end

  test "saves and reloads poll cursor metadata" do
    path = Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

    state =
      StateStore.empty()
      |> Map.put("poll_cursor", %{
        "after" => "cursor_1",
        "previous_after" => nil,
        "last_end_cursor" => "cursor_1",
        "has_next_page" => true,
        "page_size" => 25,
        "last_page_count" => 25,
        "wrapped" => false
      })

    assert :ok = StateStore.save(path, state)
    assert {:ok, loaded} = StateStore.load(path)
    assert loaded["poll_cursor"]["after"] == "cursor_1"
    assert loaded["poll_cursor"]["has_next_page"] == true
    assert loaded["poll_cursor"]["page_size"] == 25
  end

  test "normalizes legacy string poll cursor metadata" do
    path = Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

    assert :ok =
             StateStore.save(path, Map.put(StateStore.empty(), "poll_cursor", "legacy_cursor"))

    assert {:ok, loaded} = StateStore.load(path)
    assert loaded["poll_cursor"]["after"] == nil
    assert loaded["poll_cursor"]["legacy_value"] == "legacy_cursor"
  end

  test "workflow paths produce stable hashed state paths" do
    first = StateStore.path("/tmp/project/WORKFLOW.md", state_dir: "/tmp/af-state")
    second = StateStore.path("/tmp/project/WORKFLOW.md", state_dir: "/tmp/af-state")
    assert first == second
    assert String.ends_with?(first, ".json")
  end

  test "persists and reloads terminal issue state deterministically across save cycles" do
    path = Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

    state =
      StateStore.empty()
      |> Map.put("queue_id", "pqueue_terminal")
      |> StateStore.put_issue("ENG-DONE", %{
        "issue" => %{"identifier" => "ENG-DONE", "state" => "Done"},
        "queue_task_id" => "pqtask_done",
        "fabric_task_id" => "task_done",
        "workspace_path" => "/tmp/ws-done",
        "status" => "terminal"
      })

    assert :ok = StateStore.save(path, state)
    assert {:ok, loaded} = StateStore.load(path)
    assert loaded["issues"]["ENG-DONE"]["status"] == "terminal"
    assert loaded["issues"]["ENG-DONE"]["queue_task_id"] == "pqtask_done"
    assert loaded["issues"]["ENG-DONE"]["workspace_path"] == "/tmp/ws-done"

    # Reload is deterministic (same result)
    assert {:ok, reloaded} = StateStore.load(path)
    assert reloaded["issues"]["ENG-DONE"]["status"] == "terminal"
    assert reloaded["issues"]["ENG-DONE"]["queue_task_id"] == "pqtask_done"
  end

  test "cursor wrap state is persisted and resumes deterministically" do
    path = Path.join(System.tmp_dir!(), "af-state-#{System.unique_integer([:positive])}.json")

    state =
      StateStore.empty()
      |> Map.put("queue_id", "pqueue_cursor")
      |> Map.put("poll_cursor", %{
        "after" => nil,
        "previous_after" => "cursor_final",
        "last_end_cursor" => "cursor_final",
        "has_next_page" => false,
        "page_size" => 50,
        "last_page_count" => 3,
        "wrapped" => true
      })

    assert :ok = StateStore.save(path, state)
    assert {:ok, loaded} = StateStore.load(path)
    assert loaded["poll_cursor"]["after"] == nil
    assert loaded["poll_cursor"]["wrapped"] == true
    assert loaded["poll_cursor"]["last_end_cursor"] == "cursor_final"
    assert loaded["poll_cursor"]["last_page_count"] == 3

    # Second load is identical
    assert {:ok, loaded2} = StateStore.load(path)
    assert loaded2["poll_cursor"]["after"] == nil
    assert loaded2["poll_cursor"]["wrapped"] == true
  end
end
