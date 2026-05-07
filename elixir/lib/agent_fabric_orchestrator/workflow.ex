defmodule AgentFabricOrchestrator.Workflow do
  @moduledoc """
  Parser for a Symphony-style `WORKFLOW.md` contract.

  A workflow is Markdown with YAML front matter. YAML config describes the
  tracker, workspace, Codex/App Server runner, and Agent Fabric queue behavior.
  The Markdown body is the worker prompt template rendered for each issue.
  """

  defstruct [:path, :config, :prompt_template]

  @type t :: %__MODULE__{
          path: String.t() | nil,
          config: map(),
          prompt_template: String.t()
        }

  @required_sections ["tracker", "workspace", "codex", "agent_fabric"]
  @issue_fields ["identifier", "title", "description", "state", "url", "labels"]

  @doc """
  Read and parse a workflow file.
  """
  @spec load(Path.t()) :: {:ok, t()} | {:error, String.t()}
  def load(path) do
    with {:ok, body} <- File.read(path),
         {:ok, workflow} <- parse(body, path: path) do
      {:ok, workflow}
    else
      {:error, %File.Error{} = error} -> {:error, Exception.message(error)}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Parse workflow text.

  Workflows normally use YAML front matter followed by a Markdown prompt.
  A plain Markdown file is accepted as a prompt-only workflow so operator
  commands can produce useful validation errors instead of failing at parse time.
  """
  @spec parse(String.t(), keyword()) :: {:ok, t()} | {:error, String.t()}
  def parse(text, opts \\ []) do
    with {:ok, front_matter, markdown} <- split_front_matter(text),
         {:ok, config} <- decode_yaml(front_matter),
         {:ok, config} <- validate(config) do
      {:ok,
       %__MODULE__{path: opts[:path], config: config, prompt_template: String.trim(markdown)}}
    end
  end

  @doc """
  Render the Markdown prompt body for a normalized issue.
  """
  @spec render_prompt(t(), map() | struct()) :: String.t()
  def render_prompt(%__MODULE__{prompt_template: template}, issue) do
    data = normalize_issue(issue)

    Enum.reduce(@issue_fields, template, fn field, acc ->
      value =
        data
        |> Map.get(field)
        |> render_value()

      String.replace(acc, "{{ issue.#{field} }}", value)
    end)
  end

  @doc """
  Expand `~`, `$VAR`, and `${VAR}` path expressions.
  """
  @spec expand_path(String.t() | nil, map()) :: String.t() | nil
  def expand_path(path, env \\ System.get_env())

  def expand_path(nil, _env), do: nil

  def expand_path(path, env) do
    path
    |> expand_home()
    |> (&Regex.replace(~r/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/, &1, fn _, key ->
          Map.get(env, key, "")
        end)).()
    |> Path.expand()
  end

  @doc "Return the configured tracker kind, accepting `type` and legacy `kind`."
  @spec tracker_type(t() | map()) :: String.t() | nil
  def tracker_type(%__MODULE__{config: config}), do: tracker_type(config)

  def tracker_type(config),
    do: get_in(config, ["tracker", "type"]) || get_in(config, ["tracker", "kind"])

  @doc "Return the expanded project path from the workflow contract."
  @spec project_path(t() | map()) :: String.t() | nil
  def project_path(%__MODULE__{config: config}), do: project_path(config)

  def project_path(config),
    do: config |> get_in(["agent_fabric", "project_path"]) |> expand_path()

  @doc "Return the configured queue id when the workflow should reuse a queue."
  @spec queue_id(t() | map()) :: String.t() | nil
  def queue_id(%__MODULE__{config: config}), do: queue_id(config)
  def queue_id(config), do: get_in(config, ["agent_fabric", "queue_id"])

  @doc "Return a human-friendly queue title."
  @spec queue_title(t() | map()) :: String.t()
  def queue_title(%__MODULE__{config: config}), do: queue_title(config)

  def queue_title(config) do
    get_in(config, ["agent_fabric", "queue_title"]) ||
      get_in(config, ["agent_fabric", "title"]) ||
      "Elixir Orchestrator Queue"
  end

  @doc "Return true when the workflow explicitly allows queue execution starts."
  @spec auto_start_execution?(t() | map()) :: boolean()
  def auto_start_execution?(%__MODULE__{config: config}), do: auto_start_execution?(config)

  def auto_start_execution?(config) do
    get_in(config, ["agent_fabric", "auto_start_execution"]) in [true, "true", "1", 1, "yes"]
  end

  @doc "Return the configured runner section."
  @spec runner_config(t() | map()) :: map()
  def runner_config(%__MODULE__{config: config}), do: runner_config(config)
  def runner_config(config), do: Map.get(config, "runner", %{}) || %{}

  @doc "Return optional Agent Fabric queue task defaults used by the Elixir issue planner."
  @spec task_defaults(t() | map()) :: map()
  def task_defaults(%__MODULE__{config: config}), do: task_defaults(config)

  def task_defaults(config) do
    case get_in(config, ["agent_fabric", "task_defaults"]) do
      defaults when is_map(defaults) -> defaults
      _ -> %{}
    end
  end

  @doc "Return runner concurrency using the new runner contract or legacy agent config."
  @spec runner_concurrency(t() | map(), pos_integer()) :: pos_integer()
  def runner_concurrency(workflow_or_config, default \\ 4)

  def runner_concurrency(%__MODULE__{config: config}, default),
    do: runner_concurrency(config, default)

  def runner_concurrency(config, default) do
    value =
      get_in(config, ["runner", "concurrency"]) ||
        get_in(config, ["agent", "max_concurrent_agents"]) ||
        default

    normalize_positive_integer(value, default)
  end

  @doc "Return heartbeat cadence from workflow runner config."
  @spec heartbeat_ms(t() | map(), pos_integer()) :: pos_integer()
  def heartbeat_ms(workflow_or_config, default \\ 30_000)

  def heartbeat_ms(%__MODULE__{config: config}, default), do: heartbeat_ms(config, default)

  def heartbeat_ms(config, default) do
    config
    |> get_in(["runner", "heartbeat_ms"])
    |> normalize_positive_integer(default)
  end

  @doc "Return a configured or default runner state directory."
  @spec state_dir(t() | map(), map()) :: String.t()
  def state_dir(workflow_or_config, env \\ System.get_env())

  def state_dir(%__MODULE__{config: config}, env), do: state_dir(config, env)

  def state_dir(config, env) do
    configured = get_in(config, ["runner", "state_dir"])

    cond do
      is_binary(configured) and configured != "" ->
        expand_path(configured, env)

      env_state = Map.get(env, "AGENT_FABRIC_ELIXIR_STATE_DIR") ->
        expand_path(env_state, env)

      true ->
        Path.join([System.user_home!(), ".agent-fabric", "elixir"])
    end
  end

  @doc "Return the configured Linear tracker page size."
  @spec tracker_page_size(t() | map(), pos_integer()) :: pos_integer()
  def tracker_page_size(workflow_or_config, default \\ 50)

  def tracker_page_size(%__MODULE__{config: config}, default),
    do: tracker_page_size(config, default)

  def tracker_page_size(config, default) do
    config
    |> get_in(["tracker", "page_size"])
    |> normalize_positive_integer(default)
  end

  @doc "Return the configured Linear tracker cursor, if present."
  @spec tracker_after_cursor(t() | map()) :: String.t() | nil
  def tracker_after_cursor(%__MODULE__{config: config}), do: tracker_after_cursor(config)

  def tracker_after_cursor(config),
    do: normalize_optional_string(get_in(config, ["tracker", "after_cursor"]))

  @doc "Return the workspace mode. `directory` preserves legacy plain-directory behavior."
  @spec workspace_mode(t() | map()) :: String.t()
  def workspace_mode(%__MODULE__{config: config}), do: workspace_mode(config)

  def workspace_mode(config) do
    config
    |> get_in(["workspace", "mode"])
    |> normalize_optional_string()
    |> case do
      nil -> "directory"
      "local" -> "directory"
      "sandbox" -> "directory"
      mode -> mode
    end
  end

  @doc "Return the expanded source project used for git-worktree workspace mode."
  @spec workspace_source_project(t() | map(), map()) :: String.t() | nil
  def workspace_source_project(workflow_or_config, env \\ System.get_env())

  def workspace_source_project(%__MODULE__{config: config}, env),
    do: workspace_source_project(config, env)

  def workspace_source_project(config, env) do
    config
    |> get_in(["workspace", "source_project"])
    |> normalize_optional_string()
    |> expand_path(env)
  end

  @doc "Return the raw after-create hook from the workspace contract."
  @spec workspace_after_create(t() | map()) :: term()
  def workspace_after_create(%__MODULE__{config: config}), do: workspace_after_create(config)

  def workspace_after_create(config), do: get_in(config, ["workspace", "after_create"])

  defp split_front_matter(text) do
    case text do
      "---\n---\n" <> markdown ->
        {:ok, "", markdown}

      "---\n---" ->
        {:ok, "", ""}

      _ ->
        case Regex.run(~r/\A---\s*\n(.*?)\n---\s*\n?(.*)\z/s, text) do
          [_, yaml, markdown] -> {:ok, yaml, markdown}
          _ -> {:ok, "", String.trim(text)}
        end
    end
  end

  defp decode_yaml(""), do: {:ok, %{}}

  defp decode_yaml(yaml) do
    case YamlElixir.read_from_string(yaml) do
      {:ok, nil} -> {:ok, %{}}
      nil -> {:ok, %{}}
      {:ok, %{} = config} -> {:ok, config}
      %{} = config -> {:ok, config}
      {:error, reason} -> {:error, "invalid workflow YAML: #{inspect(reason)}"}
      other -> {:error, "workflow YAML must decode to a map, got: #{inspect(other)}"}
    end
  rescue
    error -> {:error, "invalid workflow YAML: #{Exception.message(error)}"}
  end

  defp validate(config) do
    if config == %{} do
      {:ok, config}
    else
      validate_required_config(config)
    end
  end

  defp validate_required_config(config) do
    missing =
      @required_sections
      |> Enum.reject(&Map.has_key?(config, &1))

    cond do
      missing != [] ->
        {:error, "workflow missing required sections: #{Enum.join(missing, ", ")}"}

      !tracker_type(config) ->
        {:error, "workflow tracker.type or tracker.kind is required"}

      !get_in(config, ["workspace", "root"]) ->
        {:error, "workflow workspace.root is required"}

      !get_in(config, ["codex", "command"]) ->
        {:error, "workflow codex.command is required"}

      !get_in(config, ["agent_fabric", "project_path"]) ->
        {:error, "workflow agent_fabric.project_path is required"}

      true ->
        {:ok, config}
    end
  end

  defp normalize_positive_integer(nil, default), do: default
  defp normalize_positive_integer(value, _default) when is_integer(value) and value > 0, do: value

  defp normalize_positive_integer(value, default) when is_binary(value) do
    case Integer.parse(value) do
      {parsed, ""} when parsed > 0 -> parsed
      _ -> default
    end
  end

  defp normalize_positive_integer(_value, default), do: default

  defp normalize_optional_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_optional_string(value), do: value

  defp normalize_issue(%_{} = issue), do: issue |> Map.from_struct() |> normalize_issue()

  defp normalize_issue(issue) when is_map(issue) do
    Map.new(issue, fn {key, value} -> {to_string(key), value} end)
  end

  defp render_value(nil), do: ""
  defp render_value(value) when is_list(value), do: Enum.map_join(value, ", ", &to_string/1)
  defp render_value(value), do: to_string(value)

  defp expand_home("~" <> rest), do: Path.join(System.user_home!(), rest)
  defp expand_home(path), do: path
end
