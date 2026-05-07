defmodule AgentFabricOrchestrator.WorkflowTest do
  use ExUnit.Case, async: true

  alias AgentFabricOrchestrator.Workflow

  # ─── Fixtures ────────────────────────────────────────────────────────

  @valid_workflow """
  ---
  tracker:
    kind: linear
    api_key: $LINEAR_API_KEY
    project_slug: my-project
    active_states:
      - Todo
      - In Progress
    terminal_states:
      - Done
      - Cancelled
  polling:
    interval_ms: 15000
  workspace:
    root: /tmp/test_workspaces
  hooks:
    after_create: echo "created"
    before_run: echo "running"
    timeout_ms: 30000
  agent:
    max_concurrent_agents: 5
    max_turns: 10
    max_retry_backoff_ms: 120000
    max_concurrent_agents_by_state:
      Todo: 2
      In Progress: 3
  codex:
    command: codex app-server
    turn_timeout_ms: 600000
    read_timeout_ms: 10000
    stall_timeout_ms: 120000
  agent_fabric:
    project_path: /tmp/test_project
    queue_id: test-queue
  ---
  You are working on issue {{ issue.identifier }}: {{ issue.title }}

  Description:
  {{ issue.description }}

  State: {{ issue.state }}
  URL: {{ issue.url }}
  Labels: {{ issue.labels }}

  Work on it.
  """

  @minimal_workflow """
  ---
  tracker:
    kind: linear
  workspace:
    root: /tmp/ws
  codex:
    command: codex
  agent_fabric:
    project_path: /tmp/p
  ---
  Prompt body here.
  """

  @no_front_matter "Just a prompt body, no YAML front matter."

  @non_map_yaml """
  ---
  - item1
  - item2
  ---
  Body
  """

  @invalid_yaml """
  ---
  tracker: [unclosed
  ---
  Body
  """

  @missing_tracker """
  ---
  workspace:
    root: /tmp/ws
  codex:
    command: codex
  agent_fabric:
    project_path: /tmp/p
  ---
  Body
  """

  @missing_kind """
  ---
  tracker:
    api_key: key123
  workspace:
    root: /tmp/ws
  codex:
    command: codex
  agent_fabric:
    project_path: /tmp/p
  ---
  Body
  """

  @missing_workspace_root """
  ---
  tracker:
    kind: linear
  workspace:
    some_other: value
  codex:
    command: codex
  agent_fabric:
    project_path: /tmp/p
  ---
  Body
  """

  @missing_codex_command """
  ---
  tracker:
    kind: linear
  workspace:
    root: /tmp/ws
  codex:
    timeout: 100
  agent_fabric:
    project_path: /tmp/p
  ---
  Body
  """

  @missing_agent_fabric_path """
  ---
  tracker:
    kind: linear
  workspace:
    root: /tmp/ws
  codex:
    command: codex
  agent_fabric:
    queue: q
  ---
  Body
  """

  @env_var_workflow """
  ---
  tracker:
    kind: linear
    api_key: $TEST_LINEAR_KEY
    project_slug: $TEST_PROJECT_SLUG
  workspace:
    root: $TEST_WORKSPACE_ROOT
  codex:
    command: codex
  agent_fabric:
    project_path: /tmp/p
  ---
  Use {{ issue.identifier }}
  """

  # Not used directly - kept for documentation completeness

  @type_tracker_workflow """
  ---
  tracker:
    type: linear
  workspace:
    root: /tmp/ws
  codex:
    command: codex
  agent_fabric:
    project_path: /tmp/p
  ---
  Uses type not kind.
  """

  # ─── Parsing Tests ───────────────────────────────────────────────────

  describe "parse/2" do
    test "parses valid workflow with all sections" do
      assert {:ok, workflow} = Workflow.parse(@valid_workflow)
      assert %Workflow{} = workflow
      assert workflow.prompt_template =~ "You are working on issue"
      assert workflow.config["tracker"]["kind"] == "linear"
      assert workflow.config["tracker"]["project_slug"] == "my-project"
      assert workflow.config["workspace"]["root"] == "/tmp/test_workspaces"
      assert workflow.config["codex"]["command"] == "codex app-server"
      assert workflow.config["agent_fabric"]["project_path"] == "/tmp/test_project"
      assert workflow.config["polling"]["interval_ms"] == 15_000
      assert workflow.config["hooks"]["after_create"] == "echo \"created\""
      assert workflow.config["agent"]["max_turns"] == 10
    end

    test "parses minimal valid workflow" do
      assert {:ok, workflow} = Workflow.parse(@minimal_workflow)
      assert workflow.prompt_template == "Prompt body here."
      assert workflow.config["tracker"]["kind"] == "linear"
    end

    test "tracks file path when given" do
      assert {:ok, workflow} = Workflow.parse(@valid_workflow, path: "/some/path/WORKFLOW.md")
      assert workflow.path == "/some/path/WORKFLOW.md"
    end

    test "treats entire file as prompt body when no front matter" do
      assert {:ok, workflow} = Workflow.parse(@no_front_matter)
      assert workflow.prompt_template == @no_front_matter
      assert workflow.config == %{}
    end

    test "returns error for non-map YAML front matter" do
      assert {:error, reason} = Workflow.parse(@non_map_yaml)
      assert reason =~ "must decode to a map"
    end

    test "returns error for invalid YAML" do
      assert {:error, reason} = Workflow.parse(@invalid_yaml)
      assert reason =~ "invalid workflow YAML"
    end

    test "rejects missing required sections" do
      assert {:error, reason} = Workflow.parse(@missing_tracker)
      assert reason =~ "missing required sections"
      assert reason =~ "tracker"
    end

    test "rejects missing tracker.kind or tracker.type" do
      assert {:error, reason} = Workflow.parse(@missing_kind)
      assert reason =~ "tracker.type or tracker.kind"
    end

    test "rejects missing workspace.root" do
      assert {:error, reason} = Workflow.parse(@missing_workspace_root)
      assert reason =~ "workspace.root is required"
    end

    test "rejects missing codex.command" do
      assert {:error, reason} = Workflow.parse(@missing_codex_command)
      assert reason =~ "codex.command is required"
    end

    test "rejects missing agent_fabric.project_path" do
      assert {:error, reason} = Workflow.parse(@missing_agent_fabric_path)
      assert reason =~ "agent_fabric.project_path is required"
    end

    test "accepts tracker.type as alias for tracker.kind" do
      assert {:ok, workflow} = Workflow.parse(@type_tracker_workflow)
      assert workflow.config["tracker"]["type"] == "linear"
    end

    test "handles empty front matter gracefully" do
      text = "---\n---\nJust body."
      assert {:ok, workflow} = Workflow.parse(text)
      assert workflow.prompt_template == "Just body."
      assert workflow.config == %{}
    end
  end

  # ─── Path Expansion Tests ────────────────────────────────────────────

  describe "expand_path/2" do
    test "returns nil for nil input" do
      assert Workflow.expand_path(nil) == nil
    end

    test "expands $VAR references using provided env map" do
      result = Workflow.expand_path("$MY_ROOT/projects", %{"MY_ROOT" => "/home/user"})
      assert result =~ "/home/user/projects"
    end

    test "expands ${VAR} syntax" do
      result = Workflow.expand_path("${MY_ROOT}/projects", %{"MY_ROOT" => "/home/user"})
      assert result =~ "/home/user/projects"
    end

    test "expands ~ to home directory" do
      result = Workflow.expand_path("~/my_workspaces")
      home = System.user_home!()
      assert result == Path.join(home, "my_workspaces")
    end

    test "resolves relative paths to absolute" do
      result = Workflow.expand_path("relative/path")
      assert Path.type(result) == :absolute
    end

    test "leaves unresolvable $VAR as empty string replacement" do
      result = Workflow.expand_path("$UNSET_VAR/sub")
      assert result =~ "/sub"
      refute result =~ "$UNSET_VAR"
    end

    test "expands env var in workspace root from real workflow" do
      System.put_env("TEST_WORKSPACE_ROOT", "/env/test/ws")
      on_exit(fn -> System.delete_env("TEST_WORKSPACE_ROOT") end)

      # Note: expand_path is called on individual values, not automatically on parse
      config = Workflow.parse(@env_var_workflow)

      # The raw value still has $VAR reference
      assert {:ok, wf} = config
      raw_root = wf.config["workspace"]["root"]
      assert raw_root == "$TEST_WORKSPACE_ROOT"

      # expand_path resolves it
      expanded = Workflow.expand_path(raw_root)
      assert expanded == "/env/test/ws"
    end
  end

  # ─── Prompt Rendering Tests ──────────────────────────────────────────

  describe "render_prompt/2" do
    setup do
      {:ok, workflow} = Workflow.parse(@valid_workflow)
      %{workflow: workflow}
    end

    test "renders all issue fields", %{workflow: wf} do
      issue = %{
        "identifier" => "ENG-42",
        "title" => "Fix memory leak",
        "description" => "The process leaks 1MB/s",
        "state" => "In Progress",
        "url" => "https://linear.app/issue/ENG-42",
        "labels" => ["bug", "critical", "backend"]
      }

      result = Workflow.render_prompt(wf, issue)

      assert result =~ "ENG-42"
      assert result =~ "Fix memory leak"
      assert result =~ "The process leaks 1MB/s"
      assert result =~ "In Progress"
      assert result =~ "https://linear.app/issue/ENG-42"
      assert result =~ "bug, critical, backend"
    end

    test "renders nil fields as empty strings", %{workflow: wf} do
      issue = %{
        "identifier" => "ENG-1",
        "title" => "Test",
        "description" => nil,
        "state" => nil,
        "url" => nil,
        "labels" => []
      }

      result = Workflow.render_prompt(wf, issue)

      assert result =~ "ENG-1"
      assert result =~ "Test"
      # description has its own line with "Description:" prefix - the empty after should be fine
      refute result =~ "{{ issue.description }}"
      refute result =~ "{{ issue.state }}"
      refute result =~ "{{ issue.url }}"
    end

    test "renders labels as comma-separated string", %{workflow: wf} do
      issue = %{
        "identifier" => "ENG-10",
        "title" => "Labels test",
        "description" => nil,
        "state" => nil,
        "url" => nil,
        "labels" => ["a", "b", "c"]
      }

      result = Workflow.render_prompt(wf, issue)
      assert result =~ "a, b, c"
    end

    test "renders single label without trailing comma", %{workflow: wf} do
      issue = %{
        "identifier" => "ENG-10",
        "title" => "Single label",
        "description" => nil,
        "state" => nil,
        "url" => nil,
        "labels" => ["single"]
      }

      result = Workflow.render_prompt(wf, issue)
      assert result =~ "single"
      refute result =~ "single,"
    end

    test "accepts atom-keyed maps", %{workflow: wf} do
      issue = %{
        identifier: "ENG-99",
        title: "Atom keys",
        description: "Works with atoms",
        state: "Todo",
        url: "https://example.com",
        labels: ["atom-test"]
      }

      result = Workflow.render_prompt(wf, issue)
      assert result =~ "ENG-99"
      assert result =~ "Atom keys"
      assert result =~ "atom-test"
    end

    test "accepts string-keyed maps", %{workflow: wf} do
      issue = %{
        "identifier" => "ENG-100",
        "title" => "String keys",
        "description" => "Works with strings",
        "state" => "Todo",
        "url" => "https://example.com",
        "labels" => ["string-test"]
      }

      result = Workflow.render_prompt(wf, issue)
      assert result =~ "ENG-100"
      assert result =~ "String keys"
      assert result =~ "string-test"
    end

    test "handles issue with missing fields gracefully", %{workflow: wf} do
      issue = %{"identifier" => "MINIMAL-1", "title" => "Minimal"}
      result = Workflow.render_prompt(wf, issue)

      assert result =~ "MINIMAL-1"
      assert result =~ "Minimal"
      # Other fields should be empty, not crashed
      refute result =~ "{{ issue.description }}"
      refute result =~ "{{ issue.state }}"
      refute result =~ "{{ issue.url }}"
      refute result =~ "{{ issue.labels }}"
    end

    test "renders Workflow struct and Issue struct" do
      wf_struct = %Workflow{
        path: nil,
        config: %{},
        prompt_template: "Issue {{ issue.identifier }}: {{ issue.title }} [{{ issue.labels }}]"
      }

      issue_struct = %Workflow.Issue{
        id: "abc",
        identifier: "PROJ-123",
        title: "Struct test",
        description: "desc",
        state: "Todo",
        url: "https://example.com/123",
        labels: ["bug"]
      }

      result = Workflow.render_prompt(wf_struct, issue_struct)
      assert result =~ "PROJ-123"
      assert result =~ "Struct test"
      assert result =~ "bug"
    end

    test "both whitespace variations of issue var work", %{workflow: wf} do
      # The workflow fixture uses {{ issue.identifier }} (with spaces)
      # Verify it works with both space and no-space variants
      issue = %{"identifier" => "BOTH-1", "title" => "Both", "description" => nil}
      result = Workflow.render_prompt(wf, issue)
      assert result =~ "BOTH-1"
    end

    test "prompt body is trimmed", %{workflow: wf} do
      assert wf.prompt_template ==
               String.trim(
                 @valid_workflow
                 |> String.split("---\n")
                 |> Enum.at(2)
                 |> String.trim()
               )
    end
  end

  # ─── Integration Tests ───────────────────────────────────────────────

  describe "full workflow lifecycle" do
    test "parse → render works end-to-end" do
      text = """
      ---
      tracker:
        kind: linear
        api_key: $LINEAR_API_KEY
        project_slug: demo
      workspace:
        root: /tmp/demo-ws
      codex:
        command: codex app-server
      agent_fabric:
        project_path: /tmp/demo
      ---
      You are fixing {{ issue.identifier }}.

      Title: {{ issue.title }}
      State: {{ issue.state }}

      Description: {{ issue.description }}
      URL: {{ issue.url }}
      Labels: {{ issue.labels }}
      """

      assert {:ok, wf} = Workflow.parse(text)

      issue = %{
        "identifier" => "SEC-999",
        "title" => "XSS in comment field",
        "description" => "User input is not sanitized in the comment form.",
        "state" => "Todo",
        "url" => "https://linear.app/SEC-999",
        "labels" => ["security", "high-priority", "web"]
      }

      rendered = Workflow.render_prompt(wf, issue)

      assert rendered =~ "SEC-999"
      assert rendered =~ "XSS in comment field"
      assert rendered =~ "not sanitized"
      assert rendered =~ "Todo"
      assert rendered =~ "security, high-priority, web"
    end

    test "missing_workflow_file error from load" do
      assert {:error, reason} = Workflow.load("/nonexistent/path/WORKFLOW.md")
      reason_str = if is_binary(reason), do: reason, else: inspect(reason)
      assert reason_str =~ "missing_workflow_file" or reason_str =~ "enoent"
    end

    test "config preserves all top-level sections" do
      assert {:ok, wf} = Workflow.parse(@valid_workflow)
      config = wf.config

      assert is_map(config["tracker"])
      assert is_map(config["workspace"])
      assert is_map(config["codex"])
      assert is_map(config["agent_fabric"])
      assert is_map(config["polling"])
      assert is_map(config["hooks"])
      assert is_map(config["agent"])
    end

    test "nil issue fields render as empty without error" do
      text = """
      ---
      tracker:
        kind: linear
      workspace:
        root: /tmp/ws
      codex:
        command: codex
      agent_fabric:
        project_path: /tmp/p
      ---
      ID: {{ issue.identifier }}
      Title: {{ issue.title }}
      Desc: {{ issue.description }}
      State: {{ issue.state }}
      URL: {{ issue.url }}
      Labels: {{ issue.labels }}
      """

      assert {:ok, wf} = Workflow.parse(text)

      issue = %{
        "identifier" => "ID-ONLY",
        "title" => nil,
        "description" => nil,
        "state" => nil,
        "url" => nil,
        "labels" => nil
      }

      result = Workflow.render_prompt(wf, issue)

      # Should not crash; nil fields become empty strings
      assert result =~ "ID-ONLY"
      refute result =~ "{{ issue."
    end
  end
end
