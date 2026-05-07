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
    * `[command, arg, ...]` — an argv command run without a shell
    * `command` — a string shell command run in the workspace directory and
      reported as shell-backed metadata

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
    mode = normalize_mode(opts[:mode])

    with {:ok, created?, source_project} <- prepare_workspace(mode, root, workspace, opts),
         {:ok, hook} <- maybe_run_after_create(workspace, created?, opts[:after_create]) do
      {:ok,
       %{
         path: workspace,
         created?: created?,
         hook: hook,
         mode: mode,
         source_project: source_project
       }}
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

  defp normalize_mode(nil), do: "directory"
  defp normalize_mode(""), do: "directory"
  defp normalize_mode(:directory), do: "directory"
  defp normalize_mode(:local), do: "directory"
  defp normalize_mode(:sandbox), do: "directory"
  defp normalize_mode(:git_worktree), do: "git_worktree"
  defp normalize_mode("local"), do: "directory"
  defp normalize_mode("sandbox"), do: "directory"
  defp normalize_mode("directory"), do: "directory"
  defp normalize_mode("git_worktree"), do: "git_worktree"
  defp normalize_mode(other), do: to_string(other)

  defp prepare_workspace("directory", _root, workspace, _opts) do
    existed? = File.dir?(workspace)

    with :ok <- File.mkdir_p(workspace) do
      {:ok, !existed?, nil}
    end
  end

  defp prepare_workspace("git_worktree", root, workspace, opts) do
    source_project = expand_source_project(opts[:source_project], root)

    cond do
      source_project in [nil, ""] ->
        {:error, :git_worktree_source_project_required}

      not git_repo?(source_project) ->
        {:error, {:git_worktree_source_not_git_repo, source_project}}

      File.dir?(workspace) ->
        if git_worktree?(workspace) do
          {:ok, false, source_project}
        else
          {:error, {:workspace_exists_not_git_worktree, workspace}}
        end

      true ->
        with :ok <- File.mkdir_p(Path.dirname(workspace)),
             :ok <- add_git_worktree(source_project, workspace) do
          {:ok, true, source_project}
        end
    end
  end

  defp prepare_workspace(mode, _root, _workspace, _opts) do
    {:error, {:unsupported_workspace_mode, mode}}
  end

  defp expand_source_project(nil, _root), do: nil
  defp expand_source_project("", _root), do: nil

  defp expand_source_project(source, root) when is_binary(source) do
    source
    |> Path.expand(Path.expand(root))
  end

  defp git_repo?(path) do
    case System.cmd("git", ["-C", path, "rev-parse", "--is-inside-work-tree"],
           stderr_to_stdout: true
         ) do
      {"true\n", 0} -> true
      {output, 0} -> String.trim(output) == "true"
      _ -> false
    end
  end

  defp git_worktree?(path) do
    File.exists?(Path.join(path, ".git")) and git_repo?(path)
  end

  defp add_git_worktree(source_project, workspace) do
    case System.cmd(
           "git",
           ["-C", source_project, "worktree", "add", "--detach", workspace, "HEAD"],
           stderr_to_stdout: true
         ) do
      {_output, 0} -> :ok
      {output, status} -> {:error, {:git_worktree_add_failed, status, output}}
    end
  end

  defp maybe_run_after_create(_path, false, _hook), do: {:ok, nil}

  # nil hook — nothing to do
  defp maybe_run_after_create(_path, true, nil), do: {:ok, nil}

  # Single 1-arity function hook
  defp maybe_run_after_create(path, true, fun) when is_function(fun, 1) do
    run_single_hook(fun, path)
  end

  # List of 1-arity function hooks — execute each in order, stop on first failure
  defp maybe_run_after_create(path, true, [hook | _] = hooks) when is_function(hook, 1) do
    Enum.reduce_while(hooks, {:ok, nil}, fn hook, {:ok, _acc} ->
      case run_single_hook(hook, path) do
        {:ok, result} -> {:cont, {:ok, result}}
        {:error, _reason} = error -> {:halt, error}
      end
    end)
  end

  # argv command hook — executes without shell interpolation.
  defp maybe_run_after_create(path, true, [command | args] = argv)
       when is_binary(command) and is_list(args) do
    maybe_run_argv_hook(path, command, args, argv)
  end

  defp maybe_run_after_create(path, true, %{"command" => command, "args" => args} = hook) do
    maybe_run_argv_hook(path, command, args, hook)
  end

  defp maybe_run_after_create(path, true, %{command: command, args: args} = hook) do
    maybe_run_argv_hook(path, command, args, hook)
  end

  # String command hook
  defp maybe_run_after_create(path, true, command) when is_binary(command) do
    {output, status} = System.cmd("sh", ["-lc", command], cd: path, stderr_to_stdout: true)

    if status == 0 do
      {:ok, %{command: command, shell: true, output: output, exit_status: status}}
    else
      {:error, {:after_create_failed, status, output}}
    end
  rescue
    error -> {:error, {:after_create_exec_failed, Exception.message(error)}}
  end

  defp maybe_run_after_create(_path, true, unknown),
    do: {:error, {:unsupported_after_create_hook, unknown}}

  defp maybe_run_argv_hook(path, command, args, original)
       when is_binary(command) and command != "" and is_list(args) do
    if Enum.all?(args, &is_binary/1) do
      run_argv_hook(path, [command | args])
    else
      {:error, {:unsupported_after_create_hook, original}}
    end
  end

  defp maybe_run_argv_hook(_path, _command, _args, original),
    do: {:error, {:unsupported_after_create_hook, original}}

  defp run_argv_hook(path, [command | args] = argv) do
    {output, status} = System.cmd(command, args, cd: path, stderr_to_stdout: true)

    if status == 0 do
      {:ok, %{argv: argv, shell: false, output: output, exit_status: status}}
    else
      {:error, {:after_create_failed, status, output}}
    end
  rescue
    error -> {:error, {:after_create_exec_failed, Exception.message(error)}}
  end

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
