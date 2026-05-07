defmodule Mix.Tasks.Af.Workflow.Check do
  @moduledoc """
  Validate an Agent Fabric Elixir workflow.

      mix af.workflow.check --workflow WORKFLOW.example.md
  """

  use Mix.Task

  alias AgentFabricOrchestrator.{FabricClient, Workflow}

  @shortdoc "Validate Agent Fabric Elixir workflow configuration"

  @impl true
  def run(argv) do
    Mix.Task.run("app.config")

    {opts, _args, invalid} =
      OptionParser.parse(argv,
        strict: [workflow: :string, socket: :string, json: :boolean],
        aliases: [w: :workflow]
      )

    reject_invalid!(invalid)

    report = check(opts)
    emit(report, opts[:json])

    if report.errors != [] do
      Mix.raise("workflow check failed with #{length(report.errors)} error(s)")
    end
  end

  @doc false
  def check(opts) do
    workflow_path =
      opts[:workflow] || env_or_config("AGENT_FABRIC_WORKFLOW", :workflow_path, "WORKFLOW.md")

    socket_path =
      opts[:socket] ||
        env_or_config("AGENT_FABRIC_SOCKET", :socket_path, FabricClient.default_socket_path())

    base = %{
      workflow_path: workflow_path,
      socket_path: socket_path,
      errors: [],
      warnings: [],
      checks: %{}
    }

    base
    |> check_workflow_file()
    |> check_workflow_config()
    |> check_socket()
    |> Map.update!(:errors, &Enum.reverse/1)
    |> Map.update!(:warnings, &Enum.reverse/1)
  end

  defp check_workflow_file(report) do
    if File.exists?(report.workflow_path) do
      case Workflow.load(report.workflow_path) do
        {:ok, workflow} ->
          report
          |> put_in([:checks, :workflow_loaded], true)
          |> Map.put(:workflow, workflow)

        {:error, reason} ->
          add_error(report, "workflow parse failed: #{reason}")
      end
    else
      add_error(report, "workflow file does not exist: #{report.workflow_path}")
    end
  end

  defp check_workflow_config(%{workflow: %Workflow{} = workflow} = report) do
    config = workflow.config

    report
    |> validate_required_config(config)
    |> validate_project_path(workflow)
    |> validate_workspace_root(config)
    |> validate_codex_command(config)
    |> validate_linear_config(config)
  end

  defp check_workflow_config(report), do: report

  defp validate_required_config(report, config) do
    if config == %{} do
      add_error(
        report,
        "workflow has no YAML config; add tracker/workspace/codex/agent_fabric sections"
      )
    else
      report
    end
  end

  defp validate_project_path(report, workflow) do
    project_path = Workflow.project_path(workflow)

    cond do
      is_nil(project_path) ->
        add_error(report, "agent_fabric.project_path is missing")

      File.dir?(project_path) ->
        put_in(report, [:checks, :project_path], project_path)

      true ->
        add_error(report, "agent_fabric.project_path does not exist: #{project_path}")
    end
  end

  defp validate_workspace_root(report, config) do
    root = config |> get_in(["workspace", "root"]) |> Workflow.expand_path()

    cond do
      is_nil(root) ->
        add_error(report, "workspace.root is missing")

      File.dir?(root) ->
        put_in(report, [:checks, :workspace_root], root)

      true ->
        add_warning(report, "workspace.root does not exist yet: #{root}")
    end
  end

  defp validate_codex_command(report, config) do
    command = get_in(config, ["codex", "command"])
    executable = command |> to_string() |> String.split(" ", parts: 2) |> List.first()

    cond do
      command in [nil, ""] ->
        add_error(report, "codex.command is missing")

      executable_available?(executable) ->
        put_in(report, [:checks, :codex_command], command)

      true ->
        add_error(report, "codex.command executable is not available on PATH: #{executable}")
    end
  end

  defp validate_linear_config(report, config) do
    if Workflow.tracker_type(config) == "linear" do
      tracker = Map.get(config, "tracker", %{})

      token =
        env_expand(tracker["token"] || tracker["api_key"]) || System.get_env("LINEAR_API_KEY")

      report =
        if token in [nil, ""] do
          add_warning(
            report,
            "Linear token is not configured; set tracker.token, tracker.api_key, or LINEAR_API_KEY before live polling"
          )
        else
          put_in(report, [:checks, :linear_token], "present")
        end

      if tracker["team_key"] || tracker["project_slug"] do
        put_in(report, [:checks, :linear_scope], tracker["team_key"] || tracker["project_slug"])
      else
        add_warning(
          report,
          "Linear scope is broad; set tracker.team_key or tracker.project_slug for practical polling"
        )
      end
    else
      report
    end
  end

  defp check_socket(report) do
    case :gen_tcp.connect(
           {:local, String.to_charlist(report.socket_path)},
           0,
           [:binary, active: false],
           1_000
         ) do
      {:ok, socket} ->
        :gen_tcp.close(socket)
        put_in(report, [:checks, :socket_reachable], true)

      {:error, reason} ->
        add_error(
          report,
          "Agent Fabric socket is not reachable at #{report.socket_path}: #{inspect(reason)}. If the daemon was recently rebuilt or relinked, run `agent-fabric-project senior-doctor --project <path>` or `agent-fabric-project doctor local-config --project <path>` to verify source parity and restart/relink from the active checkout."
        )
    end
  end

  defp emit(report, true) do
    payload =
      report
      |> Map.delete(:workflow)
      |> Jason.encode!(pretty: true)

    Mix.shell().info(payload)
  end

  defp emit(report, _json) do
    Mix.shell().info("Workflow: #{report.workflow_path}")
    Mix.shell().info("Socket: #{report.socket_path}")

    Enum.each(report.warnings, fn warning -> Mix.shell().info("warning: #{warning}") end)
    Enum.each(report.errors, fn error -> Mix.shell().error("error: #{error}") end)

    if report.errors == [] do
      Mix.shell().info("ok")
    end
  end

  defp add_error(report, error), do: Map.update!(report, :errors, &[error | &1])
  defp add_warning(report, warning), do: Map.update!(report, :warnings, &[warning | &1])

  defp executable_available?(nil), do: false
  defp executable_available?(""), do: false
  defp executable_available?(path = "/" <> _), do: File.exists?(path) and File.regular?(path)
  defp executable_available?(command), do: System.find_executable(command) != nil

  defp env_or_config(env, key, default) do
    System.get_env(env) || Application.get_env(:agent_fabric_orchestrator, key, default)
  end

  defp env_expand(nil), do: nil

  defp env_expand("$" <> var) do
    var
    |> String.trim_leading("{")
    |> String.trim_trailing("}")
    |> System.get_env()
  end

  defp env_expand(value), do: value

  defp reject_invalid!([]), do: :ok

  defp reject_invalid!(invalid) do
    flags =
      invalid
      |> Enum.map(fn {flag, _value} -> to_string(flag) end)
      |> Enum.join(", ")

    Mix.raise("unknown option(s): #{flags}")
  end
end
