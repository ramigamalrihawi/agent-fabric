defmodule AgentFabricOrchestrator.Workspace do
  @moduledoc """
  Deterministic per-issue workspace management.

  Workspace paths are derived from a stable issue identifier so that the same
  issue always maps to the same filesystem path. The key derivation uses
  sanitization and length capping to produce filesystem-safe directory names.

  ## Configuration

      config :agent_fabric_orchestrator,
        workspace_root: "/tmp/af_workspaces"

  Defaults to `~/agent_fabric_workspaces` when not explicitly configured.
  """

  alias AgentFabricOrchestrator.Linear.Issue

  @max_key_length 96

  @doc """
  Build a stable, filesystem-safe workspace key.

  Accepts an `Issue` struct, a plain map, or a string identifier.
  The key is deterministic: the same input always produces the same output.

  ## Examples

      iex> Workspace.key("pqtask_abc123")
      "pqtask_abc123-issue"

      iex> Workspace.key(%{identifier: "ENG-77", title: "Add workspace"})
      "eng-77-add-workspace"

  """
  @spec key(Issue.t() | map() | String.t()) :: String.t()
  def key(%Issue{identifier: identifier, title: title}),
    do: key(%{identifier: identifier, title: title})

  def key(issue) when is_map(issue) do
    identifier =
      Map.get(issue, :identifier) || Map.get(issue, "identifier") || Map.get(issue, :id) ||
        Map.get(issue, "id")

    title = Map.get(issue, :title) || Map.get(issue, "title") || "issue"

    [identifier, title]
    |> Enum.reject(&is_nil/1)
    |> Enum.join("-")
    |> sanitize_and_cap()
  end

  def key(issue_id) when is_binary(issue_id) do
    sanitize_and_cap(issue_id)
  end

  @doc """
  Resolve the workspace path for an issue given a root directory.
  """
  @spec path(Path.t(), Issue.t() | map() | String.t()) :: Path.t()
  def path(root, issue), do: Path.join(Path.expand(root), key(issue))

  @doc """
  Create or reuse a workspace directory and conditionally run hooks.

  `after_create` is only executed when the workspace is newly created.
  Passing an `after_create` hook is a keyword option with one of:

    * `nil` (default) — no hook
    * `fun/1` — a 1-arity function receiving the workspace path
    * `[fun/1, ...]` — a list of hooks, each receiving the workspace path
    * `command` — a string shell command run in the workspace directory

  ## Hook failure behavior

  When a function hook raises or a shell command exits non-zero, the error
  is returned immediately and no further hooks run. The workspace directory
  is left in place (it was already created).

  ## Returns

    * `{:ok, %{path: ..., created?: true, hook: ...}}` — newly created
    * `{:ok, %{path: ..., created?: false, hook: nil}}` — reused
    * `{:error, reason}` — creation or hook failure

  ## Examples

      iex> root = Path.join(System.tmp_dir!(), "af-test-#{System.unique_integer([:positive])}")
      iex> issue = %{identifier: "ENG-88", title: "Test hooks"}
      iex> {:ok, result} = Workspace.ensure_workspace(root, issue, after_create: fn _ -> {:ok, %{ran: true}} end)
      iex> result.created?
      true

  """
  @spec ensure_workspace(Path.t(), Issue.t() | map() | String.t(), keyword()) ::
          {:ok, map()} | {:error, term()}
  def ensure_workspace(root, issue, opts \\ []) do
    workspace = path(root, issue)
    existed? = File.dir?(workspace)

    with :ok <- File.mkdir_p(workspace),
         {:ok, hook} <- maybe_run_after_create(workspace, !existed?, opts[:after_create]) do
      {:ok, %{path: workspace, created?: !existed?, hook: hook}}
    end
  end

  @doc """
  Check whether a workspace directory exists for the given issue.
  """
  @spec exists?(Path.t(), Issue.t() | map() | String.t()) :: boolean()
  def exists?(root, issue) do
    root |> path(issue) |> File.dir?()
  end

  # ── Private Helpers ─────────────────────────────────────────────────

  defp sanitize_and_cap(raw) do
    raw
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9._-]+/, "-")
    |> String.trim("-")
    |> String.replace(~r/-+/, "-")
    |> String.slice(0, @max_key_length)
  end

  defp maybe_run_after_create(_path, false, _hook), do: {:ok, nil}

  # nil hook — nothing to do
  defp maybe_run_after_create(_path, true, nil), do: {:ok, nil}

  # Single 1-arity function hook
  defp maybe_run_after_create(path, true, fun) when is_function(fun, 1) do
    run_single_hook(fun, path)
  end

  # List of 1-arity function hooks — execute each in order, stop on first failure
  defp maybe_run_after_create(path, true, hooks) when is_list(hooks) do
    Enum.reduce_while(hooks, {:ok, nil}, fn hook, {:ok, _acc} ->
      case run_single_hook(hook, path) do
        {:ok, result} -> {:cont, {:ok, result}}
        {:error, _reason} = error -> {:halt, error}
      end
    end)
  end

  # String command hook
  defp maybe_run_after_create(path, true, command) when is_binary(command) do
    {output, status} = System.cmd("sh", ["-lc", command], cd: path, stderr_to_stdout: true)

    if status == 0 do
      {:ok, %{command: command, output: output, exit_status: status}}
    else
      {:error, {:after_create_failed, status, output}}
    end
  end

  # Fallback: unknown hook type is a no-op
  defp maybe_run_after_create(_path, true, _unknown), do: {:ok, nil}

  defp run_single_hook(fun, path) when is_function(fun, 1) do
    try do
      case fun.(path) do
        {:ok, result} -> {:ok, result}
        {:error, reason} -> {:error, reason}
        other -> {:ok, other}
      end
    rescue
      e -> {:error, {:hook_raised, Exception.message(e)}}
    catch
      kind, value -> {:error, {:hook_threw, kind, value}}
    end
  end
end
