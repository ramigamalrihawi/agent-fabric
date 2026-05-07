defmodule AgentFabricOrchestrator.StateStore do
  @moduledoc """
  Small local crash-recovery store for the Elixir orchestrator.

  This store is intentionally not an Agent Fabric database replacement. It only
  persists local orchestration cursors and issue-to-queue mappings under
  `~/.agent-fabric/elixir/` or a configured `runner.state_dir`. Agent Fabric's
  daemon remains the durable source of truth for queue tasks, worker runs,
  lifecycle events, patches, approvals, memory, and cost.
  """

  alias AgentFabricOrchestrator.Workflow

  @version 1

  @doc "Return the default state directory."
  @spec default_dir() :: String.t()
  def default_dir do
    Application.get_env(:agent_fabric_orchestrator, :runner, [])
    |> Keyword.get(:state_dir)
    |> case do
      nil ->
        System.get_env("AGENT_FABRIC_ELIXIR_STATE_DIR") ||
          Path.join([System.user_home!(), ".agent-fabric", "elixir"])

      configured ->
        configured
    end
    |> Workflow.expand_path()
  end

  @doc "Resolve the state file path for a workflow."
  @spec path(Workflow.t() | String.t() | nil, keyword()) :: String.t()
  def path(workflow_or_path, opts \\ []) do
    state_dir =
      opts[:state_dir] ||
        workflow_state_dir(workflow_or_path) ||
        default_dir()

    name =
      workflow_or_path
      |> workflow_identity()
      |> hash_name()

    Path.join(Workflow.expand_path(state_dir), "#{name}.json")
  end

  @doc "Load a state map. Missing files return an empty versioned store."
  @spec load(Path.t()) :: {:ok, map()} | {:error, term()}
  def load(path) do
    case File.read(path) do
      {:ok, body} ->
        case Jason.decode(body) do
          {:ok, %{} = decoded} -> {:ok, normalize(decoded)}
          {:ok, other} -> {:error, {:invalid_state, other}}
          {:error, reason} -> {:error, reason}
        end

      {:error, :enoent} ->
        {:ok, empty()}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc "Save a state map atomically."
  @spec save(Path.t(), map()) :: :ok | {:error, term()}
  def save(path, state) do
    encoded =
      state
      |> normalize()
      |> Jason.encode_to_iodata!(pretty: true)

    dir = Path.dirname(path)
    tmp = Path.join(dir, ".#{Path.basename(path)}.#{System.unique_integer([:positive])}.tmp")

    with :ok <- File.mkdir_p(dir),
         :ok <- File.write(tmp, encoded),
         :ok <- File.rename(tmp, path) do
      :ok
    else
      {:error, _reason} = error ->
        _ = File.rm(tmp)
        error
    end
  end

  @doc "Return one issue mapping from a loaded state map."
  @spec get_issue(map(), String.t()) :: map() | nil
  def get_issue(state, identifier) do
    get_in(state, ["issues", identifier])
  end

  @doc "Put one issue mapping into a loaded state map."
  @spec put_issue(map(), String.t(), map()) :: map()
  def put_issue(state, identifier, issue_state) do
    issues = Map.get(state, "issues", %{}) || %{}

    state
    |> normalize()
    |> Map.put("issues", Map.put(issues, identifier, issue_state))
    |> Map.put("updated_at", DateTime.utc_now() |> DateTime.to_iso8601())
  end

  @doc "Return a fresh state document."
  @spec empty() :: map()
  def empty do
    %{
      "version" => @version,
      "queue_id" => nil,
      "poll_cursor" => nil,
      "issues" => %{},
      "recent_failures" => [],
      "updated_at" => nil
    }
  end

  defp normalize(state) when is_map(state) do
    empty()
    |> Map.merge(stringify_keys(state))
    |> Map.put("version", Map.get(stringify_keys(state), "version", @version))
    |> Map.update!("poll_cursor", &normalize_cursor/1)
  end

  defp normalize_cursor(nil), do: nil

  defp normalize_cursor(cursor) when is_binary(cursor) do
    %{
      "after" => nil,
      "previous_after" => nil,
      "last_end_cursor" => nil,
      "has_next_page" => false,
      "page_size" => nil,
      "last_page_count" => 0,
      "wrapped" => false,
      "updated_at" => nil,
      "legacy_value" => cursor
    }
  end

  defp normalize_cursor(%{} = cursor) do
    %{
      "after" => Map.get(cursor, "after"),
      "previous_after" => Map.get(cursor, "previous_after"),
      "last_end_cursor" => Map.get(cursor, "last_end_cursor"),
      "has_next_page" => Map.get(cursor, "has_next_page", false),
      "page_size" => Map.get(cursor, "page_size"),
      "last_page_count" => Map.get(cursor, "last_page_count", 0),
      "wrapped" => Map.get(cursor, "wrapped", false),
      "updated_at" => Map.get(cursor, "updated_at"),
      "legacy_value" => Map.get(cursor, "legacy_value")
    }
  end

  defp normalize_cursor(_other), do: nil

  defp workflow_state_dir(%Workflow{} = workflow), do: Workflow.state_dir(workflow)
  defp workflow_state_dir(_), do: nil

  defp workflow_identity(%Workflow{path: path, config: config}) do
    path || Workflow.project_path(config) || "agent-fabric-elixir"
  end

  defp workflow_identity(path) when is_binary(path), do: path
  defp workflow_identity(nil), do: "agent-fabric-elixir"

  defp hash_name(value) do
    hash = :crypto.hash(:sha256, to_string(value)) |> Base.encode16(case: :lower)
    "workflow-" <> binary_part(hash, 0, 16)
  end

  defp stringify_keys(%DateTime{} = value), do: DateTime.to_iso8601(value)
  defp stringify_keys(value) when is_boolean(value) or is_nil(value), do: value

  defp stringify_keys(value) when is_map(value) do
    Map.new(value, fn {key, item} -> {key_to_string(key), stringify_keys(item)} end)
  end

  defp stringify_keys(value) when is_list(value), do: Enum.map(value, &stringify_keys/1)
  defp stringify_keys(value) when is_atom(value), do: Atom.to_string(value)
  defp stringify_keys(value) when is_pid(value), do: inspect(value)
  defp stringify_keys(value), do: value

  defp key_to_string(key) when is_atom(key), do: Atom.to_string(key)
  defp key_to_string(key), do: key
end
