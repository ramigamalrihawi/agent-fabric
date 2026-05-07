defmodule AgentFabricOrchestrator.Linear do
  @moduledoc """
  Linear issue adapter and normalizer.

  This module provides:

  - A **Client behaviour** so callers can inject mock or real HTTP backends.
  - A **normalized `Issue` struct** matching the Symphony-style issue fields:
    `id`, `identifier`, `title`, `description`, `state`, `url`,
    `assignee_id`, `team_key`, `labels`, `updated_at`, `raw`.
  - **State classifiers**: `active?/2`, `blocked?/2`, `terminal?/2`
    driven by workflow config or sensible defaults.
  - A minimal `:httpc` GraphQL fetch path for local development, with the
    HTTP call injectable in tests.
  - A **GraphQL query** builder and response parser.

  The module intentionally stops at the tracker boundary.  It never writes the
  Agent Fabric database directly; orchestrators pass normalized issue structs to
  the Agent Fabric client surface.
  """

  # ─── Behaviour ───────────────────────────────────────────────────────

  @doc """
  A behaviour for fetching Linear issues.

  Implement this to swap in mock clients, caching layers, or alternative HTTP
  stacks. The built-in `candidate_issues/2` path keeps the HTTP function
  injectable so this preview slice does not require a client dependency.
  """
  @type client_req :: %{
          required(:url) => String.t(),
          required(:token) => String.t() | nil,
          required(:query) => String.t(),
          required(:variables) => map()
        }

  @type client_result :: {:ok, list(Issue.t())} | {:error, term()}

  @callback list_issues(config :: map()) :: client_result()

  # ─── Struct ───────────────────────────────────────────────────────────

  defmodule Issue do
    @moduledoc """
    Normalized Linear issue shape used by the orchestrator.

    Fields match the Symphony-style issue reference used by
    `AgentFabricOrchestrator.Workflow` for prompt rendering.
    """
    defstruct [
      :id,
      :identifier,
      :title,
      :description,
      :state,
      :url,
      :assignee_id,
      :team_key,
      :updated_at,
      labels: [],
      raw: %{}
    ]

    @type t :: %__MODULE__{
            id: String.t() | nil,
            identifier: String.t() | nil,
            title: String.t() | nil,
            description: String.t() | nil,
            state: String.t() | nil,
            url: String.t() | nil,
            assignee_id: String.t() | nil,
            team_key: String.t() | nil,
            updated_at: String.t() | nil,
            labels: [String.t()],
            raw: map()
          }
  end

  # ─── Default State Sets ───────────────────────────────────────────────

  @terminal_states_default MapSet.new(["Done", "Canceled", "Cancelled", "Duplicate", "Closed"])
  @blocked_states_default MapSet.new(["Blocked", "On Hold", "Waiting", "Paused", "Blocked by"])

  # ─── State Classifiers ────────────────────────────────────────────────

  @doc """
  Return `true` when an issue is in an active (non-terminal, non-blocked) state.

  If both `active_states` and `blocked_states` are specified in config,
  `active_states` takes precedence.  When neither is specified the issue is
  assumed active unless terminal.
  """
  @spec active?(Issue.t(), map() | nil) :: boolean()
  def active?(%Issue{state: state} = issue, config \\ nil) do
    active_states = workflow_states(config, "active_states")

    cond do
      terminal?(issue, config) ->
        false

      active_states != [] ->
        state in active_states

      true ->
        not blocked?(issue, config)
    end
  end

  @doc """
  Return `true` when an issue is in a blocked state according to workflow config.
  """
  @spec blocked?(Issue.t(), map() | nil) :: boolean()
  def blocked?(%Issue{state: state} = issue, config \\ nil) do
    blocked_states = workflow_states(config, "blocked_states")

    cond do
      terminal?(issue, config) ->
        false

      blocked_states != [] ->
        state in blocked_states

      true ->
        state in @blocked_states_default
    end
  end

  @doc """
  Return `true` when an issue is terminal (done, cancelled, closed, etc.).
  """
  @spec terminal?(Issue.t(), map() | list(String.t()) | nil) :: boolean()
  def terminal?(issue, states_or_config \\ nil)

  def terminal?(%Issue{state: state}, states) when is_list(states) do
    state in MapSet.new(states)
  end

  def terminal?(%Issue{state: state}, config) when is_map(config) do
    terminal_states = workflow_states(config, "terminal_states")

    if terminal_states != [] do
      state in MapSet.new(terminal_states)
    else
      state in @terminal_states_default
    end
  end

  def terminal?(%Issue{state: state}, nil) do
    state in @terminal_states_default
  end

  @doc """
  Return a classification label for the issue state.

  ## Examples

      iex> state_label(%Issue{state: "Done"}, nil)
      :terminal
      iex> state_label(%Issue{state: "Blocked"}, nil)
      :blocked
      iex> state_label(%Issue{state: "In Progress"}, nil)
      :active
  """
  @spec state_label(Issue.t(), map() | nil) :: :active | :blocked | :terminal
  def state_label(%Issue{} = issue, config \\ nil) do
    cond do
      terminal?(issue, config) -> :terminal
      blocked?(issue, config) -> :blocked
      active?(issue, config) -> :active
    end
  end

  # ─── Normalization ────────────────────────────────────────────────────

  @doc """
  Normalize one Linear GraphQL issue node into a stable `%Issue{}` struct.

  Accepts both string-keyed maps (from JSON) and atom-keyed maps.

  ## Examples

      iex> node = %{"id" => "i1", "identifier" => "ENG-42", "title" => "Fix bug",
      ...>           "state" => %{"name" => "In Progress"},
      ...>           "team" => %{"key" => "ENG"},
      ...>           "assignee" => %{"id" => "usr1"},
      ...>           "labels" => %{"nodes" => [%{"name" => "automation"}]}}
      iex> %Issue{} = issue = normalize_issue(node)
      iex> issue.identifier
      "ENG-42"
  """
  @spec normalize_issue(map()) :: Issue.t()
  def normalize_issue(raw) when is_map(raw) do
    state = nested(raw, ["state", "name"]) || raw["state"] || raw[:state]
    team_key = nested(raw, ["team", "key"]) || raw["teamKey"] || raw[:team_key]
    assignee_id = nested(raw, ["assignee", "id"]) || raw["assigneeId"] || raw[:assignee_id]

    labels =
      raw
      |> nested(["labels", "nodes"])
      |> case do
        labels when is_list(labels) ->
          labels
          |> Enum.map(fn m ->
            Map.get(m, "name") || Map.get(m, :name)
          end)
          |> Enum.reject(&is_nil/1)

        _ ->
          raw["labels"] || raw[:labels] || []
      end

    %Issue{
      id: raw["id"] || raw[:id],
      identifier: raw["identifier"] || raw[:identifier],
      title: raw["title"] || raw[:title],
      description: raw["description"] || raw[:description] || "",
      state: state,
      url: raw["url"] || raw[:url],
      assignee_id: assignee_id,
      team_key: team_key,
      updated_at: raw["updatedAt"] || raw[:updated_at],
      labels: labels,
      raw: raw
    }
  end

  @doc """
  Normalize a list of raw GraphQL issue nodes.
  """
  @spec normalize_issues([map()]) :: [Issue.t()]
  def normalize_issues(nodes) when is_list(nodes) do
    Enum.map(nodes, &normalize_issue/1)
  end

  # ─── GraphQL Query ───────────────────────────────────────────────────

  @doc """
  Return the GraphQL query used to fetch candidate issues for orchestration.
  """
  def query do
    """
    query AgentFabricIssues($teamKey: String, $states: [String!]) {
      issues(
        filter: {
          team: { key: { eq: $teamKey } }
          state: { name: { in: $states } }
        }
      ) {
        nodes {
          id
          identifier
          title
          description
          url
          updatedAt
          state { name }
          team { key }
          assignee { id }
          labels { nodes { name } }
        }
      }
    }
    """
  end

  @doc """
  Return the GraphQL query used to fetch one cursor-aware issue page.
  """
  @spec paginated_query() :: String.t()
  def paginated_query do
    """
    query AgentFabricIssuesPaginated($teamKey: String, $states: [String!], $first: Int, $after: String) {
      issues(
        filter: {
          team: { key: { eq: $teamKey } }
          state: { name: { in: $states } }
        }
        first: $first
        after: $after
      ) {
        nodes {
          id
          identifier
          title
          description
          url
          updatedAt
          state { name }
          team { key }
          assignee { id }
          labels { nodes { name } }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
    """
  end

  # ─── Fetch Candidates (injectable HTTP) ──────────────────────────────

  @doc """
  Fetch candidate issues through Linear GraphQL.

  `http_fun` receives a request map with `:url`, `:token`, `:query`, and
  `:variables` keys and must return `{:ok, response_map}` or `{:error, reason}`.

  This keeps tests and offline development fakeable.
  """
  @spec candidate_issues(map(), function()) :: {:ok, list(Issue.t())} | {:error, term()}
  def candidate_issues(config, http_fun \\ &default_http/1) do
    case candidate_issues_with_page_info(config, http_fun) do
      {:ok, %{issues: issues}} -> {:ok, issues}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Fetch one candidate issue page using explicit pagination options.

  This wrapper keeps the old `candidate_issues_with_page_info/3` test injection
  shape while giving orchestrators a clean public entrypoint for persisted
  cursor polling.
  """
  @spec candidate_issues_page(map(), keyword() | map()) ::
          {:ok, %{issues: list(Issue.t()), page_info: map()}} | {:error, term()}
  def candidate_issues_page(config, opts \\ %{}) do
    candidate_issues_with_page_info(config, &default_http/1, opts)
  end

  @doc """
  Fetch candidate issues and return normalized issues plus cursor metadata.

  `opts` may include `:first` and `:after`. When omitted, page size and cursor
  come from tracker config or `LINEAR_PAGE_SIZE`/`LINEAR_AFTER_CURSOR`.
  """
  @spec candidate_issues_with_page_info(map(), function(), keyword() | map()) ::
          {:ok, %{issues: list(Issue.t()), page_info: map()}} | {:error, term()}
  def candidate_issues_with_page_info(config, http_fun \\ &default_http/1, opts \\ %{}) do
    tracker = config["tracker"] || %{}

    request = %{
      url: tracker["url"] || "https://api.linear.app/graphql",
      token: tracker["token"] || System.get_env("LINEAR_API_KEY"),
      query: paginated_query(),
      variables: %{
        teamKey: tracker["team_key"],
        states: tracker["active_states"] || [],
        first: page_size(tracker, opts),
        after: after_cursor(tracker, opts)
      }
    }

    with {:ok, response} <- http_fun.(request),
         :ok <- validate_response(response) do
      {:ok,
       %{
         issues: response |> extract_nodes() |> normalize_issues(),
         page_info: extract_page_info(response)
       }}
    end
  end

  @doc """
  Extract raw issue nodes from a GraphQL response map.
  """
  @spec extract_nodes(map()) :: [map()]
  def extract_nodes(response) do
    case nested(response, ["data", "issues", "nodes"]) do
      nodes when is_list(nodes) -> nodes
      _ -> []
    end
  end

  @doc """
  Extract Linear page metadata from a GraphQL response map.
  """
  @spec extract_page_info(map()) :: %{has_next_page: boolean(), end_cursor: String.t() | nil}
  def extract_page_info(response) do
    case nested(response, ["data", "issues", "pageInfo"]) do
      %{} = page_info ->
        %{
          has_next_page:
            Map.get(page_info, "hasNextPage") || Map.get(page_info, :hasNextPage) || false,
          end_cursor: Map.get(page_info, "endCursor") || Map.get(page_info, :endCursor)
        }

      _ ->
        %{has_next_page: false, end_cursor: nil}
    end
  end

  # ─── Default HTTP Client ──────────────────────────────────────────────

  defp default_http(%{token: nil}), do: {:error, :missing_linear_token}

  defp default_http(%{url: url, token: token, query: query, variables: variables}) do
    body = Jason.encode!(%{query: query, variables: variables})

    headers = [
      {~c"authorization", ~c"Bearer #{token}"},
      {~c"content-type", ~c"application/json"}
    ]

    request = {String.to_charlist(url), headers, ~c"application/json", body}

    case :httpc.request(:post, request, [], body_format: :binary) do
      {:ok, {{_, status, _}, _headers, response_body}} when status in 200..299 ->
        Jason.decode(response_body)

      {:ok, {{_, status, _}, _headers, response_body}} ->
        {:error, {:linear_http_error, status, response_body}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # ─── Private Helpers ──────────────────────────────────────────────────

  defp workflow_states(nil, _key), do: []

  defp workflow_states(config, key) when is_map(config) do
    config
    |> get_in(["tracker", key])
    |> case do
      states when is_list(states) -> states
      _ -> []
    end
  end

  defp validate_response(%{"errors" => errors}) when is_list(errors) and errors != [],
    do: {:error, {:graphql_errors, errors}}

  defp validate_response(%{errors: errors}) when is_list(errors) and errors != [],
    do: {:error, {:graphql_errors, errors}}

  defp validate_response(%{"data" => data}) when is_map(data), do: :ok
  defp validate_response(%{data: data}) when is_map(data), do: :ok
  defp validate_response(_), do: {:error, :malformed_linear_response}

  defp page_size(tracker, opts) do
    opts
    |> option(:first)
    |> normalize_positive_integer(nil)
    |> case do
      nil ->
        tracker
        |> Map.get("page_size")
        |> normalize_positive_integer(nil)

      value ->
        value
    end
    |> case do
      nil -> System.get_env("LINEAR_PAGE_SIZE") |> normalize_positive_integer(50)
      value -> value
    end
  end

  defp after_cursor(tracker, opts) do
    case option(opts, :after, :missing) do
      :missing ->
        normalize_cursor(tracker["after_cursor"] || System.get_env("LINEAR_AFTER_CURSOR"))

      value ->
        normalize_cursor(value)
    end
  end

  defp normalize_cursor(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_cursor(value), do: value

  defp option(opts, key) when is_map(opts),
    do: Map.get(opts, key) || Map.get(opts, to_string(key))

  defp option(opts, key) when is_list(opts), do: Keyword.get(opts, key)

  defp option(opts, key, default) when is_map(opts) do
    cond do
      Map.has_key?(opts, key) -> Map.get(opts, key)
      Map.has_key?(opts, to_string(key)) -> Map.get(opts, to_string(key))
      true -> default
    end
  end

  defp option(opts, key, default) when is_list(opts) do
    if Keyword.has_key?(opts, key), do: Keyword.get(opts, key), else: default
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

  defp nested(nil, _path), do: nil

  defp nested(value, []) do
    value
  end

  defp nested(map, [key | rest]) when is_map(map) do
    nested(map[key] || map[String.to_atom(key)], rest)
  end

  defp nested(_value, _path), do: nil
end
