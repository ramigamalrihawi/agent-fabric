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
  """
  @spec parse(String.t(), keyword()) :: {:ok, t()} | {:error, String.t()}
  def parse(text, opts \\ []) do
    with {:ok, front_matter, markdown} <- split_front_matter(text),
         {:ok, config} <- decode_yaml(front_matter),
         {:ok, config} <- validate(config) do
      {:ok, %__MODULE__{path: opts[:path], config: config, prompt_template: String.trim(markdown)}}
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
  @spec expand_path(String.t(), map()) :: String.t()
  def expand_path(path, env \\ System.get_env()) do
    path
    |> expand_home()
    |> (&Regex.replace(~r/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/, &1, fn _, key ->
          Map.get(env, key, "")
        end)).()
    |> Path.expand()
  end

  defp split_front_matter(text) do
    case Regex.run(~r/\A---\s*\n(.*?)\n---\s*\n?(.*)\z/s, text) do
      [_, yaml, markdown] -> {:ok, yaml, markdown}
      _ -> {:error, "workflow must start with YAML front matter delimited by ---"}
    end
  end

  defp decode_yaml(yaml) do
    case YamlElixir.read_from_string(yaml) do
      {:ok, %{} = config} -> {:ok, config}
      %{} = config -> {:ok, config}
      {:error, reason} -> {:error, "invalid workflow YAML: #{inspect(reason)}"}
      other -> {:error, "workflow YAML must decode to a map, got: #{inspect(other)}"}
    end
  rescue
    error -> {:error, "invalid workflow YAML: #{Exception.message(error)}"}
  end

  defp validate(config) do
    missing =
      @required_sections
      |> Enum.reject(&Map.has_key?(config, &1))

    cond do
      missing != [] ->
        {:error, "workflow missing required sections: #{Enum.join(missing, ", ")}"}

      !get_in(config, ["tracker", "type"]) ->
        {:error, "workflow tracker.type is required"}

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
