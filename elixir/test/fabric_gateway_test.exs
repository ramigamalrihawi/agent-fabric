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
end
