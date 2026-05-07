defmodule AgentFabricOrchestrator.IssueTaskPlannerTest do
  use ExUnit.Case, async: true

  alias AgentFabricOrchestrator.{IssueTaskPlanner, Linear, Workflow}

  test "builds rich queue task metadata from labels and issue sections" do
    issue = %Linear.Issue{
      identifier: "ENG-42",
      title: "Move orchestration into Elixir",
      description: """
      Shift more task shaping into the Elixir layer.

      Expected files:
      - elixir/lib/agent_fabric_orchestrator/issue_task_planner.ex
      - elixir/test/issue_task_planner_test.exs

      Context refs:
      - elixir/lib/agent_fabric_orchestrator/orchestrator.ex

      Acceptance criteria:
      - Queue task shape is deterministic.
      - Worker packets include proof requirements.
      """,
      state: "Todo",
      team_key: "ENG",
      labels: [
        "priority:urgent",
        "risk:high",
        "type:implementation",
        "area:elixir",
        "serial",
        "file:elixir/README.md",
        "context:WORKFLOW.example.md"
      ]
    }

    task = IssueTaskPlanner.build_task(%{}, issue, "Work on {{ issue.identifier }}")

    assert task.clientKey == "ENG-42"
    assert task.title == "ENG-42: Move orchestration into Elixir"
    assert task.priority == "urgent"
    assert task.risk == "high"
    assert task.category == "implementation"
    assert task.workstream == "elixir"
    assert task.parallelSafe == false
    assert "elixir/README.md" in task.expectedFiles
    assert "elixir/lib/agent_fabric_orchestrator/issue_task_planner.ex" in task.expectedFiles
    assert "WORKFLOW.example.md" in task.requiredContextRefs
    assert "elixir/lib/agent_fabric_orchestrator/orchestrator.ex" in task.requiredContextRefs
    assert "Queue task shape is deterministic." in task.acceptanceCriteria
    assert Enum.any?(task.acceptanceCriteria, &String.contains?(&1, "proof of work"))
  end

  test "applies workflow task defaults when labels do not override them" do
    {:ok, workflow} =
      Workflow.parse("""
      ---
      tracker:
        type: linear
      workspace:
        root: /tmp/workspaces
      codex:
        command: codex
      runner:
        concurrency: 2
      agent_fabric:
        project_path: /tmp/project
        task_defaults:
          phase: roadmap
          workstream: backend
          category: verification
          priority: high
          risk: low
          parallel_safe: false
          expected_files:
            - lib/example.ex
          required_context_refs:
            - README.md
          acceptance_criteria:
            - Run the focused test suite.
          required_tools:
            - shell
      ---
      Ship {{ issue.identifier }}.
      """)

    issue = %Linear.Issue{
      identifier: "ENG-7",
      title: "Add tests",
      description: "Plain issue",
      state: "Todo",
      team_key: "ENG",
      labels: []
    }

    task = IssueTaskPlanner.build_task(workflow, issue, Workflow.render_prompt(workflow, issue))

    assert task.phase == "roadmap"
    assert task.workstream == "backend"
    assert task.category == "verification"
    assert task.priority == "high"
    assert task.risk == "low"
    assert task.parallelSafe == false
    assert task.expectedFiles == ["lib/example.ex"]
    assert task.requiredContextRefs == ["README.md"]
    assert "Run the focused test suite." in task.acceptanceCriteria
    assert task.requiredTools == ["shell"]
  end

  test "normalizes shorthand priority and risk labels" do
    issue = %Linear.Issue{
      identifier: "ENG-9",
      title: "Review cleanup",
      description: "",
      labels: ["p1", "low-risk", "component:queue"]
    }

    task = IssueTaskPlanner.build_task(%{}, issue, "Review")

    assert task.priority == "high"
    assert task.risk == "low"
    assert task.workstream == "queue"
  end
end
