defmodule AgentFabricOrchestrator.FabricGatewayTest do
  use ExUnit.Case, async: true

  alias AgentFabricOrchestrator.{FabricClient, FabricGateway}

  @session %FabricClient.Session{session_id: "sess_1", session_token: "tok_1"}

  test "UDS gateway wraps public queue and worker tools" do
    session = %FabricClient.Session{session_id: "sess_1", session_token: "tok_1"}

    parent = self()

    transport = fn encoded ->
      {:ok, request} = Jason.decode(encoded)
      send(parent, {:tool_call, request["tool"], request["input"]})

      result =
        case request["tool"] do
          "project_queue_create" ->
            %{"queueId" => "pqueue_1"}

          "project_queue_add_tasks" ->
            %{"created" => [%{"queueTaskId" => "pqtask_1", "fabricTaskId" => "task_1"}]}

          "project_queue_claim_next" ->
            %{"claimed" => %{"queueTaskId" => "pqtask_1"}}

          "project_queue_decide" ->
            %{"decisionId" => "pqdec_1"}

          "fabric_task_start_worker" ->
            %{"workerRunId" => "wrun_1"}
        end

      {:ok, %{"ok" => true, "result" => result}}
    end

    opts = [transport: transport]

    assert {:ok, %{"queueId" => "pqueue_1"}} =
             FabricGateway.Uds.create_queue(
               "/tmp/fake.sock",
               session,
               %{projectPath: "/tmp/p"},
               opts
             )

    assert {:ok, %{"created" => [%{"queueTaskId" => "pqtask_1"}]}} =
             FabricGateway.Uds.add_task(
               "/tmp/fake.sock",
               session,
               "pqueue_1",
               %{title: "T", goal: "G"},
               opts
             )

    assert {:ok, %{"claimed" => %{"queueTaskId" => "pqtask_1"}}} =
             FabricGateway.Uds.claim_next("/tmp/fake.sock", session, "pqueue_1", %{}, opts)

    assert {:ok, %{"decisionId" => "pqdec_1"}} =
             FabricGateway.Uds.decide_queue(
               "/tmp/fake.sock",
               session,
               "pqueue_1",
               "start_execution",
               "Start from Elixir",
               opts
             )

    assert {:ok, %{"workerRunId" => "wrun_1"}} =
             FabricGateway.Uds.start_worker(
               "/tmp/fake.sock",
               session,
               %{taskId: "task_1", worker: "codex-app-server"},
               opts
             )

    assert_received {:tool_call, "project_queue_create", %{"projectPath" => "/tmp/p"}}
    assert_received {:tool_call, "project_queue_add_tasks", %{"queueId" => "pqueue_1"}}
    assert_received {:tool_call, "project_queue_claim_next", %{"queueId" => "pqueue_1"}}

    assert_received {:tool_call, "project_queue_decide",
                     %{
                       "queueId" => "pqueue_1",
                       "decision" => "start_execution",
                       "note" => "Start from Elixir"
                     }}

    assert_received {:tool_call, "fabric_task_start_worker", %{"taskId" => "task_1"}}
  end

  describe "UDS gateway payload coverage" do
    test "progress_report, queue_status, monitoring, and cleanup call public queue tools" do
      parent = self()

      transport = fn encoded ->
        {:ok, request} = Jason.decode(encoded)
        send(parent, {:tool_call, request["tool"], request["input"]})
        {:ok, %{"ok" => true, "result" => %{"ok" => true}}}
      end

      opts = [transport: transport]

      assert {:ok, %{"ok" => true}} =
               FabricGateway.Uds.queue_status("/tmp/fake.sock", @session, "pqueue_1", opts)

      assert {:ok, %{"ok" => true}} =
               FabricGateway.Uds.progress_report("/tmp/fake.sock", @session, "pqueue_1", opts)

      assert {:ok, %{"ok" => true}} =
               FabricGateway.Uds.dashboard(
                 "/tmp/fake.sock",
                 @session,
                 "pqueue_1",
                 %{includeCompletedLanes: true},
                 opts
               )

      assert {:ok, %{"ok" => true}} =
               FabricGateway.Uds.agent_lanes(
                 "/tmp/fake.sock",
                 @session,
                 "pqueue_1",
                 %{maxEventsPerLane: 3},
                 opts
               )

      assert {:ok, %{"ok" => true}} =
               FabricGateway.Uds.timeline(
                 "/tmp/fake.sock",
                 @session,
                 "pqueue_1",
                 %{limit: 10},
                 opts
               )

      assert {:ok, %{"ok" => true}} =
               FabricGateway.Uds.cleanup_queues(
                 "/tmp/fake.sock",
                 @session,
                 %{"dryRun" => false, queueId: "pqueue_1", olderThanDays: 0, limit: 5},
                 opts
               )

      assert {:ok, %{"ok" => true}} =
               FabricGateway.Uds.recover_stale(
                 "/tmp/fake.sock",
                 @session,
                 %{"dryRun" => false, queueId: "pqueue_1", staleAfterMinutes: 15},
                 opts
               )

      assert_received {:tool_call, "project_queue_status", %{"queueId" => "pqueue_1"}}

      assert_received {:tool_call, "project_queue_progress_report", %{"queueId" => "pqueue_1"}}

      assert_received {:tool_call, "project_queue_dashboard",
                       %{"queueId" => "pqueue_1", "includeCompletedLanes" => true}}

      assert_received {:tool_call, "project_queue_agent_lanes",
                       %{"queueId" => "pqueue_1", "maxEventsPerLane" => 3}}

      assert_received {:tool_call, "project_queue_timeline",
                       %{"queueId" => "pqueue_1", "limit" => 10}}

      assert_received {:tool_call, "project_queue_cleanup",
                       %{
                         "queueId" => "pqueue_1",
                         "olderThanDays" => 0,
                         "limit" => 5,
                         "dryRun" => true
                       }}

      assert_received {:tool_call, "project_queue_recover_stale",
                       %{
                         "queueId" => "pqueue_1",
                         "staleAfterMinutes" => 15,
                         "dryRun" => true
                       }}
    end

    test "worker lifecycle calls stringify atom-keyed payloads" do
      parent = self()

      transport = fn encoded ->
        {:ok, request} = Jason.decode(encoded)
        send(parent, {:tool_call, request["tool"], request["input"]})
        {:ok, %{"ok" => true, "result" => %{"ok" => true}}}
      end

      opts = [transport: transport]
      input = %{taskId: "task_1", workerRunId: "wrun_1", summary: %{nextAction: "continue"}}

      assert {:ok, %{"ok" => true}} =
               FabricGateway.Uds.checkpoint("/tmp/fake.sock", @session, input, opts)

      assert {:ok, %{"ok" => true}} =
               FabricGateway.Uds.heartbeat(
                 "/tmp/fake.sock",
                 @session,
                 Map.put(input, :progress, 0.5),
                 opts
               )

      assert {:ok, %{"ok" => true}} =
               FabricGateway.Uds.finish(
                 "/tmp/fake.sock",
                 @session,
                 Map.merge(input, %{status: "completed", patchRefs: [], testRefs: []}),
                 opts
               )

      assert_received {:tool_call, "fabric_task_checkpoint",
                       %{
                         "taskId" => "task_1",
                         "workerRunId" => "wrun_1",
                         "summary" => %{"nextAction" => "continue"}
                       }}

      assert_received {:tool_call, "fabric_task_heartbeat",
                       %{"taskId" => "task_1", "workerRunId" => "wrun_1", "progress" => 0.5}}

      assert_received {:tool_call, "fabric_task_finish",
                       %{
                         "taskId" => "task_1",
                         "workerRunId" => "wrun_1",
                         "status" => "completed",
                         "patchRefs" => [],
                         "testRefs" => []
                       }}
    end

    test "task_status includes requested events and checkpoints flags" do
      parent = self()

      transport = fn encoded ->
        {:ok, request} = Jason.decode(encoded)
        send(parent, {:tool_call, request["tool"], request["input"]})
        {:ok, %{"ok" => true, "result" => %{"status" => "running"}}}
      end

      assert {:ok, %{"status" => "running"}} =
               FabricGateway.Uds.task_status("/tmp/fake.sock", @session, "task_1",
                 transport: transport,
                 include_events: true,
                 include_checkpoints: true
               )

      assert_received {:tool_call, "fabric_task_status",
                       %{
                         "taskId" => "task_1",
                         "includeEvents" => true,
                         "includeCheckpoints" => true
                       }}
    end
  end

  describe "read-only wrappers for new queue APIs" do
    test "worker_health calls project_queue_worker_health" do
      parent = self()

      transport = fn encoded ->
        {:ok, request} = Jason.decode(encoded)
        send(parent, {:tool_call, request["tool"], request["input"]})

        {:ok,
         %{
           "ok" => true,
           "result" => %{
             "summary" => %{"total" => 1, "healthy" => 1},
             "workers" => [
               %{
                 "workerRunId" => "wrun_1",
                 "classification" => "healthy",
                 "worker" => "deepseek-direct"
               }
             ]
           }
         }}
      end

      opts = [transport: transport]

      assert {:ok, result} =
               FabricGateway.Uds.worker_health("/tmp/fake.sock", @session, "pqueue_1", opts)

      workers = result["workers"]
      assert length(workers) == 1
      assert hd(workers)["workerRunId"] == "wrun_1"

      assert_received {:tool_call, "project_queue_worker_health", %{"queueId" => "pqueue_1"}}
    end

    test "worker_health forwards stale threshold when requested" do
      parent = self()

      transport = fn encoded ->
        {:ok, request} = Jason.decode(encoded)
        send(parent, {:tool_call, request["tool"], request["input"]})
        {:ok, %{"ok" => true, "result" => %{"workers" => []}}}
      end

      opts = [transport: transport, stale_after_minutes: 5]

      FabricGateway.Uds.worker_health("/tmp/fake.sock", @session, "pqueue_2", opts)

      assert_received {:tool_call, "project_queue_worker_health",
                       %{"queueId" => "pqueue_2", "staleAfterMinutes" => 5}}
    end

    test "task_tail calls fabric_task_tail" do
      parent = self()

      transport = fn encoded ->
        {:ok, request} = Jason.decode(encoded)
        send(parent, {:tool_call, request["tool"], request["input"]})

        {:ok,
         %{
           "ok" => true,
           "result" => %{
             "taskId" => "task_1",
             "eventCount" => 2,
             "checkpointCount" => 1,
             "events" => [%{"kind" => "command_finished"}],
             "checkpoints" => [%{"checkpointId" => "wchk_1"}]
           }
         }}
      end

      opts = [transport: transport]

      assert {:ok, result} =
               FabricGateway.Uds.task_tail(
                 "/tmp/fake.sock",
                 @session,
                 "pqueue_1",
                 "pqtask_xyz",
                 opts
               )

      assert result["taskId"] == "task_1"
      assert result["eventCount"] == 2

      assert_received {:tool_call, "fabric_task_tail",
                       %{"queueId" => "pqueue_1", "queueTaskId" => "pqtask_xyz"}}
    end

    test "task_tail forwards max line and byte limits" do
      parent = self()

      transport = fn encoded ->
        {:ok, request} = Jason.decode(encoded)
        send(parent, {:tool_call, request["tool"], request["input"]})
        {:ok, %{"ok" => true, "result" => %{"events" => []}}}
      end

      opts = [transport: transport, max_lines: 5, max_bytes: 1024]

      FabricGateway.Uds.task_tail("/tmp/fake.sock", @session, "pq", "pqt", opts)

      assert_received {:tool_call, "fabric_task_tail",
                       %{
                         "queueId" => "pq",
                         "queueTaskId" => "pqt",
                         "maxLines" => 5,
                         "maxBytes" => 1024
                       }}
    end

    test "patch_review_plan calls project_queue_patch_review_plan" do
      parent = self()

      transport = fn encoded ->
        {:ok, request} = Jason.decode(encoded)
        send(parent, {:tool_call, request["tool"], request["input"]})

        {:ok,
         %{
           "ok" => true,
           "result" => %{
             "schema" => "agent-fabric.project-queue-patch-review-plan.v1",
             "entries" => [%{"queueTaskId" => "pqt_1", "status" => "patch_ready"}]
           }
         }}
      end

      opts = [transport: transport]

      assert {:ok, result} =
               FabricGateway.Uds.patch_review_plan("/tmp/fake.sock", @session, "pqueue_1", opts)

      assert result["schema"] == "agent-fabric.project-queue-patch-review-plan.v1"
      assert length(result["entries"]) == 1
      assert_received {:tool_call, "project_queue_patch_review_plan", %{"queueId" => "pqueue_1"}}
    end

    test "collab_summary calls project_queue_collab_summary" do
      parent = self()

      transport = fn encoded ->
        {:ok, request} = Jason.decode(encoded)
        send(parent, {:tool_call, request["tool"], request["input"]})

        {:ok,
         %{
           "ok" => true,
           "result" => %{
             "schema" => "agent-fabric.project-queue-collab-summary.v1",
             "groups" => [%{"queueTask" => %{"queueTaskId" => "pqtask_1"}}]
           }
         }}
      end

      assert {:ok, result} =
               FabricGateway.Uds.collab_summary("/tmp/fake.sock", @session, "pqueue_1",
                 transport: transport
               )

      assert result["schema"] == "agent-fabric.project-queue-collab-summary.v1"
      assert_received {:tool_call, "project_queue_collab_summary", %{"queueId" => "pqueue_1"}}
    end
  end
end
