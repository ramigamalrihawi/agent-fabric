defmodule AgentFabricOrchestrator.LinearTest do
  use ExUnit.Case, async: true

  alias AgentFabricOrchestrator.Linear
  alias AgentFabricOrchestrator.Linear.Issue

  # ─── Issue Struct ────────────────────────────────────────────────────

  describe "Issue struct" do
    test "has Symphony-compatible fields" do
      issue = %Issue{
        id: "i1",
        identifier: "ENG-42",
        title: "Fix bug",
        description: "Something broke",
        state: "Todo",
        url: "https://linear.app/team/ENG-42",
        assignee_id: "usr1",
        team_key: "ENG",
        labels: ["bug"],
        raw: %{}
      }

      assert issue.id == "i1"
      assert issue.identifier == "ENG-42"
      assert issue.title == "Fix bug"
      assert issue.description == "Something broke"
      assert issue.state == "Todo"
      assert issue.url == "https://linear.app/team/ENG-42"
      assert issue.assignee_id == "usr1"
      assert issue.team_key == "ENG"
      assert issue.labels == ["bug"]
      assert is_map(issue.raw)
    end

    test "defaults labels and raw" do
      issue = %Issue{id: "1", state: "Todo"}
      assert issue.labels == []
      assert issue.raw == %{}
    end
  end

  # ─── State Classifiers ────────────────────────────────────────────────

  describe "state_label/2" do
    test "classifies terminal states by default" do
      assert Linear.state_label(%Issue{state: "Done"}) == :terminal
      assert Linear.state_label(%Issue{state: "Canceled"}) == :terminal
      assert Linear.state_label(%Issue{state: "Cancelled"}) == :terminal
      assert Linear.state_label(%Issue{state: "Duplicate"}) == :terminal
      assert Linear.state_label(%Issue{state: "Closed"}) == :terminal
    end

    test "classifies blocked states by default" do
      assert Linear.state_label(%Issue{state: "Blocked"}) == :blocked
      assert Linear.state_label(%Issue{state: "On Hold"}) == :blocked
      assert Linear.state_label(%Issue{state: "Waiting"}) == :blocked
    end

    test "classifies active states" do
      assert Linear.state_label(%Issue{state: "Todo"}) == :active
      assert Linear.state_label(%Issue{state: "In Progress"}) == :active
      assert Linear.state_label(%Issue{state: "Backlog"}) == :active
    end

    test "terminal takes precedence over blocked" do
      config = %{
        "tracker" => %{
          "terminal_states" => ["Done"],
          "blocked_states" => ["Done"]
        }
      }

      assert Linear.state_label(%Issue{state: "Done"}, config) == :terminal
    end
  end

  describe "terminal?/2" do
    test "default terminal states" do
      assert Linear.terminal?(%Issue{state: "Done"})
      assert Linear.terminal?(%Issue{state: "Canceled"})
      assert Linear.terminal?(%Issue{state: "Cancelled"})
      assert Linear.terminal?(%Issue{state: "Duplicate"})
      assert Linear.terminal?(%Issue{state: "Closed"})
    end

    test "non-terminal by default" do
      refute Linear.terminal?(%Issue{state: "Todo"})
      refute Linear.terminal?(%Issue{state: "In Progress"})
      refute Linear.terminal?(%Issue{state: "Blocked"})
    end

    test "respects config terminal_states" do
      config = %{"tracker" => %{"terminal_states" => ["Archived"]}}
      assert Linear.terminal?(%Issue{state: "Archived"}, config)
      refute Linear.terminal?(%Issue{state: "Done"}, config)
    end

    test "accepts list of states directly" do
      assert Linear.terminal?(%Issue{state: "Deployed"}, ["Deployed", "Released"])
      refute Linear.terminal?(%Issue{state: "Todo"}, ["Deployed", "Released"])
    end
  end

  describe "blocked?/2" do
    test "default blocked states" do
      assert Linear.blocked?(%Issue{state: "Blocked"})
      assert Linear.blocked?(%Issue{state: "On Hold"})
      assert Linear.blocked?(%Issue{state: "Waiting"})
      assert Linear.blocked?(%Issue{state: "Paused"})
      assert Linear.blocked?(%Issue{state: "Blocked by"})
    end

    test "non-blocked by default" do
      refute Linear.blocked?(%Issue{state: "Todo"})
      refute Linear.blocked?(%Issue{state: "In Progress"})
      refute Linear.blocked?(%Issue{state: "Done"})
    end

    test "terminal is never blocked" do
      refute Linear.blocked?(%Issue{state: "Done"})
      refute Linear.blocked?(%Issue{state: "Canceled"})
      refute Linear.blocked?(%Issue{state: "Closed"})
    end

    test "respects config blocked_states" do
      config = %{"tracker" => %{"blocked_states" => ["Needs Triage", "Pending Approval"]}}
      assert Linear.blocked?(%Issue{state: "Needs Triage"}, config)
      refute Linear.blocked?(%Issue{state: "Blocked"}, config)
    end
  end

  describe "active?/2" do
    test "default active states" do
      assert Linear.active?(%Issue{state: "Todo"})
      assert Linear.active?(%Issue{state: "In Progress"})
      assert Linear.active?(%Issue{state: "Review"})
    end

    test "non-active by default" do
      refute Linear.active?(%Issue{state: "Done"})
      refute Linear.active?(%Issue{state: "Blocked"})
      refute Linear.active?(%Issue{state: "Closed"})
    end

    test "respects config active_states (explicit list overrides)" do
      config = %{"tracker" => %{"active_states" => ["Backlog", "Ready"]}}
      assert Linear.active?(%Issue{state: "Backlog"}, config)
      refute Linear.active?(%Issue{state: "Todo"}, config)
    end

    test "terminal never active" do
      config = %{"tracker" => %{"active_states" => ["Done"], "terminal_states" => ["Done"]}}
      refute Linear.active?(%Issue{state: "Done"}, config)
    end

    test "active when config has only blocked_states and state is not blocked" do
      config = %{"tracker" => %{"blocked_states" => ["Blocked"]}}
      assert Linear.active?(%Issue{state: "In Progress"}, config)
      refute Linear.active?(%Issue{state: "Blocked"}, config)
    end
  end

  # ─── Normalization ────────────────────────────────────────────────────

  describe "normalize_issue/1" do
    test "handles fully nested Linear GraphQL node" do
      raw = %{
        "id" => "abc-123",
        "identifier" => "ENG-42",
        "title" => "Implement runner",
        "description" => "We need a runner.",
        "url" => "https://linear.app/myteam/issue/ENG-42",
        "updatedAt" => "2026-01-01T00:00:00Z",
        "state" => %{"name" => "In Progress"},
        "team" => %{"key" => "ENG"},
        "assignee" => %{"id" => "user-1"},
        "labels" => %{"nodes" => [%{"name" => "automation"}, %{"name" => "high-priority"}]}
      }

      issue = Linear.normalize_issue(raw)

      assert issue.id == "abc-123"
      assert issue.identifier == "ENG-42"
      assert issue.title == "Implement runner"
      assert issue.description == "We need a runner."
      assert issue.url == "https://linear.app/myteam/issue/ENG-42"
      assert issue.updated_at == "2026-01-01T00:00:00Z"
      assert issue.state == "In Progress"
      assert issue.team_key == "ENG"
      assert issue.assignee_id == "user-1"
      assert issue.labels == ["automation", "high-priority"]
      assert issue.raw == raw
    end

    test "handles flat (non-nested) fields" do
      raw = %{
        "id" => "i1",
        "identifier" => "PROJ-7",
        "title" => "Flat issue",
        "state" => "Todo",
        "teamKey" => "PROJ",
        "assigneeId" => "usr42",
        "labels" => ["bug"]
      }

      issue = Linear.normalize_issue(raw)

      assert issue.id == "i1"
      assert issue.state == "Todo"
      assert issue.team_key == "PROJ"
      assert issue.assignee_id == "usr42"
      assert issue.labels == ["bug"]
    end

    test "handles atom-keyed maps" do
      raw = %{
        id: "i2",
        identifier: "OPS-1",
        title: "Atoms!",
        state: "Done",
        team_key: "OPS",
        assignee_id: "usr99",
        labels: ["ops"],
        updated_at: "2026-01-01T00:00:00Z"
      }

      issue = Linear.normalize_issue(raw)

      assert issue.id == "i2"
      assert issue.identifier == "OPS-1"
      assert issue.state == "Done"
      assert issue.team_key == "OPS"
      assert issue.assignee_id == "usr99"
      assert issue.labels == ["ops"]
    end

    test "defaults description to empty string" do
      issue = Linear.normalize_issue(%{"id" => "i1"})
      assert issue.description == ""
    end

    test "handles nil labels gracefully" do
      issue = Linear.normalize_issue(%{"id" => "i1", "labels" => nil})
      assert issue.labels == []
    end

    test "handles empty labels nodes" do
      issue = Linear.normalize_issue(%{"id" => "i1", "labels" => %{"nodes" => []}})
      assert issue.labels == []
    end
  end

  describe "normalize_issues/1" do
    test "normalizes a list of raw nodes" do
      nodes = [
        %{"id" => "i1", "identifier" => "A-1", "title" => "One", "state" => "Todo"},
        %{"id" => "i2", "identifier" => "A-2", "title" => "Two", "state" => "In Progress"}
      ]

      issues = Linear.normalize_issues(nodes)
      assert length(issues) == 2
      assert Enum.map(issues, & &1.identifier) == ["A-1", "A-2"]
    end
  end

  # ─── GraphQL query ────────────────────────────────────────────────────

  describe "query/0" do
    test "returns a non-empty GraphQL query" do
      q = Linear.query()
      assert is_binary(q)
      assert String.contains?(q, "AgentFabricIssues")
      assert String.contains?(q, "issues")
    end
  end

  # ─── extract_nodes/1 ──────────────────────────────────────────────────

  describe "extract_nodes/1" do
    test "extracts issue nodes from a valid response" do
      response = %{
        "data" => %{
          "issues" => %{
            "nodes" => [
              %{"id" => "i1", "title" => "One"},
              %{"id" => "i2", "title" => "Two"}
            ]
          }
        }
      }

      nodes = Linear.extract_nodes(response)
      assert length(nodes) == 2
      assert hd(nodes)["id"] == "i1"
    end

    test "returns empty list for empty response" do
      assert Linear.extract_nodes(%{}) == []
      assert Linear.extract_nodes(%{"data" => %{}}) == []
    end
  end

  # ─── candidate_issues/2 with fake HTTP ────────────────────────────────

  describe "candidate_issues/2" do
    test "fetches and normalizes issues through injected HTTP function" do
      fake_response = %{
        "data" => %{
          "issues" => %{
            "nodes" => [
              %{
                "id" => "i1",
                "identifier" => "ENG-10",
                "title" => "Fix login",
                "description" => "Users cannot log in on Safari.",
                "state" => %{"name" => "In Progress"},
                "url" => "https://linear.app/team/ENG-10",
                "updatedAt" => "2026-01-01T00:00:00Z",
                "team" => %{"key" => "ENG"},
                "assignee" => %{"id" => "usr-abc"},
                "labels" => %{"nodes" => [%{"name" => "bug"}, %{"name" => "p1"}]}
              }
            ]
          }
        }
      }

      fake_http = fn _req -> {:ok, fake_response} end
      {:ok, issues} = Linear.candidate_issues(%{}, fake_http)

      assert length(issues) == 1
      issue = hd(issues)
      assert issue.identifier == "ENG-10"
      assert issue.state == "In Progress"
      assert issue.team_key == "ENG"
      assert issue.labels == ["bug", "p1"]
    end

    test "returns empty list when no nodes in response" do
      fake_http = fn _req -> {:ok, %{"data" => %{"issues" => %{"nodes" => []}}}} end
      assert {:ok, []} = Linear.candidate_issues(%{}, fake_http)
    end

    test "returns empty list for malformed response" do
      fake_http = fn _req -> {:ok, %{"unexpected" => true}} end
      assert {:ok, []} = Linear.candidate_issues(%{}, fake_http)
    end

    test "propagates HTTP errors" do
      fake_http = fn _req -> {:error, :timeout} end
      assert {:error, :timeout} = Linear.candidate_issues(%{}, fake_http)
    end

    test "passes tracker config through to HTTP function" do
      config = %{
        "tracker" => %{
          "url" => "https://custom.linear.app/graphql",
          "token" => "custom-token",
          "team_key" => "TEAM"
        }
      }

      fake_http = fn req ->
        assert req.url == "https://custom.linear.app/graphql"
        assert req.token == "custom-token"
        {:ok, %{"data" => %{"issues" => %{"nodes" => []}}}}
      end

      {:ok, []} = Linear.candidate_issues(config, fake_http)
    end

    test "default http returns error when no token" do
      assert {:error, :missing_linear_token} =
               Linear.candidate_issues(%{}, fn %{token: nil} ->
                 {:error, :missing_linear_token}
               end)
    end
  end

  # ─── End-to-end: classification pipeline ─────────────────────────────

  describe "classification pipeline" do
    test "correctly classifies a mixed batch of issues" do
      raw_issues = [
        %{"id" => "1", "identifier" => "A-1", "title" => "Active task", "state" => "Todo"},
        %{"id" => "2", "identifier" => "A-2", "title" => "Blocked task", "state" => "Blocked"},
        %{"id" => "3", "identifier" => "A-3", "title" => "Done task", "state" => "Done"},
        %{"id" => "4", "identifier" => "A-4", "title" => "On hold", "state" => "On Hold"},
        %{"id" => "5", "identifier" => "A-5", "title" => "Canceled", "state" => "Canceled"}
      ]

      issues = Linear.normalize_issues(raw_issues)

      active = Enum.filter(issues, &Linear.active?/1)
      blocked = Enum.filter(issues, &Linear.blocked?/1)
      terminal = Enum.filter(issues, &Linear.terminal?/1)

      assert length(active) == 1
      assert hd(active).identifier == "A-1"

      assert length(blocked) == 2
      assert Enum.map(blocked, & &1.identifier) |> Enum.sort() == ["A-2", "A-4"]

      assert length(terminal) == 2
      assert Enum.map(terminal, & &1.identifier) |> Enum.sort() == ["A-3", "A-5"]
    end

    test "workflow config overrides all state classifications" do
      config = %{
        "tracker" => %{
          "active_states" => ["Backlog", "Ready for Dev"],
          "blocked_states" => ["Needs Info"],
          "terminal_states" => ["Released"]
        }
      }

      assert Linear.active?(%Issue{state: "Ready for Dev"}, config)
      refute Linear.active?(%Issue{state: "Todo"}, config)
      refute Linear.active?(%Issue{state: "Released"}, config)

      assert Linear.blocked?(%Issue{state: "Needs Info"}, config)
      refute Linear.blocked?(%Issue{state: "Blocked"}, config)

      assert Linear.terminal?(%Issue{state: "Released"}, config)
      refute Linear.terminal?(%Issue{state: "Done"}, config)
    end

    test "disjoint classification: no issue has two labels" do
      all_states = ["Todo", "In Progress", "Blocked", "Done", "Canceled", "On Hold", "Review"]
      issues = Enum.map(all_states, &%Issue{id: &1, title: &1, state: &1})

      for issue <- issues do
        labels =
          [Linear.active?(issue), Linear.blocked?(issue), Linear.terminal?(issue)]
          |> Enum.count(& &1)

        assert labels <= 1,
               "Issue state #{issue.state} has #{labels} classifications (expected 0 or 1)"
      end
    end
  end
end
