defmodule AgentFabricOrchestrator.Dashboard do
  @moduledoc """
  Minimal HTTP observability surface for the Elixir orchestrator.

  Serves JSON endpoints that expose orchestrator **runtime state** (GenServer
  process-local) and proxy **durable state** via the Agent Fabric daemon.

  This is a placeholder implementation using a small raw `:gen_tcp` HTTP parser.
  The target is a **Phoenix LiveView dashboard** (see README roadmap); this
  minimal surface provides an immediate observability slice without adding
  Phoenix dependencies.

  ## Runtime vs Durable State

  | State Kind | Source | Endpoints |
  |---|---|---|
  | Runtime | `AgentFabricOrchestrator.Orchestrator` GenServer | `/api/status`, `/api/lanes` |
  | Durable | Agent Fabric daemon (TypeScript, SQLite) | `/api/queue-health/:queue_id` |
  | Combined | Both sources merged per-request | `/api/progress` |

  ## Routes

      GET /health                  — liveness check
      GET /api/status              — orchestrator runtime status
      GET /api/lanes               — active tracked issues
      GET /api/progress            — combined runtime + fabric summary
      GET /api/workflow            — workflow summary
      GET /api/runners             — runner pool state
      GET /api/issues              — issue-to-queue mapping
      GET /api/failures            — recent runner/poll failures
      GET /api/workspaces          — local workspace cleanup preview
      GET /api/sync-health         — sync health: cursor, failures, terminal cleanup
      GET /api/queue-health/:id    — proxy to daemon queue health API

  ## Legacy API (kept for Phoenix LiveView mount)

      snapshot/2 — build a json-ready snapshot from raw state maps
      json/1     — encode snapshot to JSON
  """

  use GenServer

  require Logger

  @default_port 4574

  # --- Legacy Snapshot API (kept for Phoenix LiveView mount) ---

  @doc """
  Build a dashboard snapshot from orchestrator runtime state and Agent Fabric progress.
  """
  @spec snapshot(map(), map()) :: map()
  def snapshot(orchestrator_state, fabric_progress) do
    %{
      source: "agent_fabric_elixir_orchestrator",
      generated_at: DateTime.utc_now() |> DateTime.to_iso8601(),
      runtime: %{
        active_issue_count: orchestrator_state |> Map.get(:active, %{}) |> map_size(),
        last_error: Map.get(orchestrator_state, :last_error)
      },
      fabric: %{
        queue_id:
          get_in(fabric_progress, ["queue", "queueId"]) ||
            get_in(fabric_progress, [:queue, :queueId]),
        status:
          get_in(fabric_progress, ["summary", "status"]) ||
            get_in(fabric_progress, [:summary, :status]),
        active_workers:
          get_in(fabric_progress, ["summary", "counts", "activeWorkers"]) ||
            get_in(fabric_progress, [:summary, :counts, :activeWorkers])
      }
    }
  end

  @doc """
  Encode a snapshot for a simple HTTP endpoint.
  """
  @spec json(map()) :: {:ok, String.t()} | {:error, term()}
  def json(snapshot), do: Jason.encode(snapshot)

  # --- GenServer Client API ---

  def start_link(opts) do
    genserver_opts =
      if Process.whereis(__MODULE__) do
        []
      else
        [name: __MODULE__]
      end

    GenServer.start_link(__MODULE__, opts, genserver_opts)
  end

  @doc """
  Returns the port the dashboard HTTP server is listening on.
  """
  def port do
    GenServer.call(__MODULE__, :port)
  end

  # --- GenServer Callbacks ---

  @impl true
  def init(_opts) do
    port = Application.get_env(:agent_fabric_orchestrator, :dashboard_port, @default_port)

    case :gen_tcp.listen(port, [
           :binary,
           packet: :raw,
           reuseaddr: true,
           active: false,
           backlog: 32
         ]) do
      {:ok, lsock} ->
        Logger.info("AgentFabric Dashboard HTTP server listening on port #{port}")

        Task.start(fn -> accept_loop(lsock) end)

        {:ok, %{port: port, lsock: lsock}}

      {:error, reason} ->
        Logger.warning("Dashboard failed to listen on port #{port}: #{inspect(reason)}")
        {:ok, %{port: port, lsock: nil, listen_error: reason}}
    end
  end

  @impl true
  def handle_call(:port, _from, state) do
    {:reply, state.port, state}
  end

  @impl true
  def terminate(_reason, state) do
    if state.lsock, do: :gen_tcp.close(state.lsock)
    :ok
  end

  # --- Acceptor Loop ---

  defp accept_loop(lsock) do
    case :gen_tcp.accept(lsock, 5_000) do
      {:ok, sock} ->
        Task.start(fn -> handle_connection(sock) end)
        accept_loop(lsock)

      {:error, :timeout} ->
        accept_loop(lsock)

      {:error, reason} when reason in [:closed, :einval, :enotconn, :badarg] ->
        :ok

      {:error, reason} ->
        Logger.warning("Dashboard accept error: #{inspect(reason)}")
        accept_loop(lsock)
    end
  end

  # --- HTTP Request Handling ---

  defp handle_connection(sock) do
    case :gen_tcp.recv(sock, 0, 10_000) do
      {:ok, request} ->
        {method, path} = parse_request_line(request)
        dispatch(sock, method, path)

      _error ->
        :gen_tcp.close(sock)
    end
  rescue
    _ -> :gen_tcp.close(sock)
  end

  defp parse_request_line(request) do
    request
    |> String.split("\r\n", parts: 2)
    |> List.first()
    |> String.split(" ", parts: 3)
    |> case do
      [method, path, _version] -> {method, path}
      _ -> {"GET", "/"}
    end
  end

  # --- Routing ---

  defp dispatch(sock, method, path) do
    {status, content_type, payload} = route(method, path)
    respond(sock, status, content_type, payload)
  end

  defp route(method, path)

  # GET /health
  defp route("GET", "/health") do
    {200, "application/json", health_json()}
  end

  # GET /api/status - runtime state from Orchestrator GenServer
  defp route("GET", "/api/status") do
    json =
      case orchestrator_state() do
        {:ok, state} ->
          Jason.encode!(%{
            source: "runtime",
            data: runtime_summary(state)
          })

        :not_running ->
          Jason.encode!(%{
            source: "runtime",
            data: not_running_payload()
          })
      end

    {200, "application/json", json}
  end

  # GET /api/lanes - active tracked issues
  defp route("GET", "/api/lanes") do
    json =
      case orchestrator_state() do
        {:ok, state} ->
          lanes =
            state
            |> state_issues()
            |> Enum.map(fn {identifier, detail} ->
              %{
                identifier: identifier,
                issue_title:
                  get_in(detail, [:issue, :title]) || get_in(detail, [:issue, "title"]),
                queue_task_id: detail[:queue_task_id] || detail["queue_task_id"],
                fabric_task_id: detail[:fabric_task_id] || detail["fabric_task_id"],
                worker_run_id: detail[:worker_run_id] || detail["worker_run_id"],
                workspace: detail[:workspace_path] || detail["workspace_path"],
                status: detail[:status] || detail["status"]
              }
            end)

          Jason.encode!(%{
            source: "runtime",
            lanes: lanes,
            orchestrator_alive: true,
            orchestator_alive: true
          })

        :not_running ->
          Jason.encode!(%{
            source: "runtime",
            lanes: [],
            orchestrator_alive: false,
            orchestator_alive: false
          })
      end

    {200, "application/json", json}
  end

  # GET /api/progress - combined runtime + fabric summary
  defp route("GET", "/api/progress") do
    orchestrator_data =
      case orchestrator_state() do
        {:ok, state} ->
          runtime_summary(state)

        :not_running ->
          not_running_payload()
      end

    fabric_data = fetch_fabric_progress()

    json =
      Jason.encode!(%{
        runtime: %{
          source: "Elixir Orchestrator (runtime)",
          data: orchestrator_data
        },
        durable: %{
          source: "Agent Fabric daemon (durable SQLite)",
          data: fabric_data
        }
      })

    {200, "application/json", json}
  end

  # GET /api/workflow - workflow summary and queue id
  defp route("GET", "/api/workflow") do
    payload =
      case orchestrator_state() do
        {:ok, state} ->
          workflow = Map.get(state, :workflow)

          %{
            orchestrator_alive: true,
            orchestator_alive: true,
            source: "runtime",
            workflow_path: workflow && workflow.path,
            project_path: workflow && AgentFabricOrchestrator.Workflow.project_path(workflow),
            queue_id: Map.get(state, :queue_id),
            concurrency: Map.get(state, :concurrency),
            state_store_path: Map.get(state, :state_store_path),
            runner: AgentFabricOrchestrator.Workflow.runner_config(workflow || %{})
          }

        :not_running ->
          %{source: "runtime", data: not_running_payload()}
      end

    {200, "application/json", Jason.encode!(payload)}
  end

  # GET /api/runners - runner pool state
  defp route("GET", "/api/runners") do
    payload =
      case orchestrator_state() do
        {:ok, state} ->
          %{
            orchestrator_alive: true,
            orchestator_alive: true,
            source: "runtime",
            runner_pool: runner_pool_from_state(state)
          }

        :not_running ->
          %{
            source: "runtime",
            runner_pool: %{},
            orchestator_alive: false,
            orchestrator_alive: false
          }
      end

    {200, "application/json", Jason.encode!(payload)}
  end

  # GET /api/issues - issue mapping and last poll result
  defp route("GET", "/api/issues") do
    payload =
      case orchestrator_state() do
        {:ok, state} ->
          %{
            orchestrator_alive: true,
            orchestator_alive: true,
            source: "runtime",
            queue_id: Map.get(state, :queue_id),
            issues: state_issues(state),
            last_poll_result: Map.get(state, :last_poll_result),
            poll_cursor: Map.get(state, :poll_cursor),
            last_poll_cursor: Map.get(state, :poll_cursor)
          }

        :not_running ->
          %{source: "runtime", issues: %{}, orchestator_alive: false, orchestrator_alive: false}
      end

    {200, "application/json", Jason.encode!(payload)}
  end

  # GET /api/failures - recent failures
  defp route("GET", "/api/failures") do
    payload =
      case orchestrator_state() do
        {:ok, state} ->
          %{
            source: "runtime",
            recent_failures: Map.get(state, :recent_failures, []),
            orchestrator_alive: true,
            orchestator_alive: true
          }

        :not_running ->
          %{
            source: "runtime",
            recent_failures: [],
            orchestator_alive: false,
            orchestrator_alive: false
          }
      end

    {200, "application/json", Jason.encode!(payload)}
  end

  # GET /api/workspaces - local workspace lifecycle preview
  defp route("GET", "/api/workspaces") do
    payload =
      case orchestrator_state() do
        {:ok, state} ->
          workflow = Map.get(state, :workflow)
          root = workflow_workspace_root(workflow)

          preview =
            if root do
              AgentFabricOrchestrator.Workspace.cleanup_preview(root, [],
                active_paths: active_workspace_paths(state)
              )
            else
              %{dry_run: true, error: "workflow workspace.root is unavailable"}
            end

          %{
            source: "runtime",
            orchestrator_alive: true,
            orchestator_alive: true,
            queue_id: Map.get(state, :queue_id),
            workspace_cleanup: preview
          }

        :not_running ->
          %{
            source: "runtime",
            orchestrator_alive: false,
            orchestator_alive: false,
            workspace_cleanup: %{dry_run: true, candidates: [], protected: []}
          }
      end

    {200, "application/json", Jason.encode!(payload)}
  end

  # GET /api/sync-health - sync health: cursor, issues, terminal cleanup guidance
  defp route("GET", "/api/sync-health") do
    json =
      case orchestrator_state() do
        {:ok, state} ->
          Jason.encode!(%{
            source: "runtime",
            orchestrator_alive: true,
            orchestator_alive: true,
            data: AgentFabricOrchestrator.Orchestrator.sync_health(state)
          })

        :not_running ->
          Jason.encode!(%{
            source: "runtime",
            orchestrator_alive: false,
            orchestator_alive: false,
            data: %{
              cursor: nil,
              failures: %{consecutive: 0, recent_count: 0},
              issues: %{total: 0, queued: 0, running: 0, terminal: 0, failed: 0, pending: 0},
              terminal_cleanup: [],
              state_store_path: nil,
              queue_id: nil,
              generated_at: DateTime.utc_now() |> DateTime.to_iso8601()
            }
          })
      end

    {200, "application/json", json}
  end

  # GET /api/queue-health/:queue_id - durable state from Agent Fabric daemon
  defp route("GET", path) do
    case path do
      <<"/api/queue-health/", queue_id::binary>> ->
        daemon_health = fetch_queue_health(queue_id)

        json =
          Jason.encode!(%{
            source: "durable",
            source_api: "Agent Fabric daemon",
            queue_id: queue_id,
            data: daemon_health
          })

        {200, "application/json", json}

      _ ->
        {404, "application/json", Jason.encode!(%{error: "not_found", path: path})}
    end
  end

  # Other methods on known paths
  defp route(_method, path)
       when path in [
              "/health",
              "/api/status",
              "/api/lanes",
              "/api/progress",
              "/api/workflow",
              "/api/runners",
              "/api/issues",
              "/api/failures",
              "/api/workspaces",
              "/api/sync-health"
            ] do
    {405, "application/json", Jason.encode!(%{error: "method_not_allowed"})}
  end

  defp route(_method, path) do
    case path do
      <<"/api/queue-health/", _::binary>> ->
        {405, "application/json", Jason.encode!(%{error: "method_not_allowed"})}

      _ ->
        {404, "application/json", Jason.encode!(%{error: "not_found", path: path})}
    end
  end

  # --- Response Helpers ---

  defp respond(sock, status, content_type, body) do
    reason = reason_phrase(status)
    date = http_date()

    response =
      "HTTP/1.1 #{status} #{reason}\r\n" <>
        "Content-Type: #{content_type}\r\n" <>
        "Content-Length: #{byte_size(body)}\r\n" <>
        "Date: #{date}\r\n" <>
        "Server: AgentFabric-Dashboard/0.1.0\r\n" <>
        "Connection: close\r\n" <>
        "\r\n" <>
        body

    :gen_tcp.send(sock, response)
    :gen_tcp.close(sock)
  end

  # --- JSON Payloads ---

  defp health_json do
    Jason.encode!(%{
      status: "ok",
      application: "agent_fabric_orchestrator",
      version: "0.1.0"
    })
  end

  # --- Orchestrator State (Runtime) ---

  defp runtime_summary(state) do
    issues = state_issues(state)

    %{
      active_issue_count: map_size(issues),
      active_runners: Map.get(state, :active_runners, 0),
      concurrency: Map.get(state, :concurrency),
      queue_id: Map.get(state, :queue_id),
      last_error: Map.get(state, :last_error),
      last_poll_result: Map.get(state, :last_poll_result),
      poll_cursor: Map.get(state, :poll_cursor),
      last_poll_cursor: Map.get(state, :poll_cursor),
      orchestrator_alive: true,
      orchestator_alive: true
    }
  end

  defp not_running_payload do
    %{
      active_issue_count: 0,
      active_runners: 0,
      last_error: nil,
      orchestrator_alive: false,
      orchestator_alive: false,
      note: "Orchestrator not autostarted (set AGENT_FABRIC_ELIXIR_AUTOSTART=1)"
    }
  end

  defp state_issues(state) do
    cond do
      is_map(Map.get(state, :issues)) ->
        state.issues
        |> Enum.map(fn {id, rec} ->
          {id,
           %{
             issue: issue_to_map(rec.issue),
             fabric_task_id: rec.fabric_task_id,
             queue_task_id: rec.queue_task_id,
             queue_id: rec.queue_id,
             worker_run_id: rec.worker_run_id,
             workspace_path: rec.workspace_path,
             status: rec.status,
             last_error: rec.last_error
           }}
        end)
        |> Map.new()

      is_map(Map.get(state, :active)) ->
        Map.get(state, :active, %{})

      true ->
        %{}
    end
  end

  defp runner_pool_from_state(state) do
    %{
      active: Map.get(state, :active_runners, 0),
      concurrency: Map.get(state, :concurrency),
      runners:
        state_issues(state)
        |> Enum.filter(fn {_id, rec} -> rec[:worker_run_id] || rec["worker_run_id"] end)
        |> Map.new(fn {id, rec} ->
          {id,
           %{
             worker_run_id: rec[:worker_run_id] || rec["worker_run_id"],
             queue_task_id: rec[:queue_task_id] || rec["queue_task_id"],
             fabric_task_id: rec[:fabric_task_id] || rec["fabric_task_id"],
             workspace_path: rec[:workspace_path] || rec["workspace_path"],
             status: rec[:status] || rec["status"]
           }}
        end)
    }
  end

  defp workflow_workspace_root(nil), do: nil

  defp workflow_workspace_root(%{config: config}) do
    config
    |> get_in(["workspace", "root"])
    |> case do
      nil -> nil
      root -> AgentFabricOrchestrator.Workflow.expand_path(root)
    end
  end

  defp active_workspace_paths(state) do
    state
    |> state_issues()
    |> Enum.map(fn {_id, rec} -> rec[:workspace_path] || rec["workspace_path"] end)
    |> Enum.reject(&(&1 in [nil, ""]))
  end

  defp issue_to_map(%_{} = issue), do: Map.from_struct(issue)
  defp issue_to_map(issue), do: issue

  defp orchestrator_state do
    orchestrator_name =
      case Process.whereis(AgentFabricOrchestrator.Orchestrator) do
        nil ->
          # Try the old naming convention
          Process.whereis(:"Elixir.AgentFabricOrchestrator.Orchestrator")

        pid ->
          pid
      end

    if orchestrator_name do
      {:ok, :sys.get_state(orchestrator_name)}
    else
      :not_running
    end
  end

  # --- Daemon HTTP Proxy (Durable State) ---

  defp fetch_queue_health(queue_id) do
    daemon_endpoint =
      Application.get_env(:agent_fabric_orchestrator, :daemon_endpoint, "http://127.0.0.1:4573")

    url = String.to_charlist("#{daemon_endpoint}/api/queues/#{queue_id}/health")

    case http_get(url) do
      {:ok, body} ->
        case Jason.decode(body) do
          {:ok, parsed} -> parsed
          _ -> %{raw: body}
        end

      {:error, reason} ->
        %{error: "daemon_unavailable", reason: inspect(reason)}
    end
  end

  defp fetch_fabric_progress do
    daemon_endpoint =
      Application.get_env(:agent_fabric_orchestrator, :daemon_endpoint, "http://127.0.0.1:4573")

    url = String.to_charlist("#{daemon_endpoint}/api/status")

    case http_get(url) do
      {:ok, body} ->
        case Jason.decode(body) do
          {:ok, parsed} -> parsed
          _ -> %{raw: body}
        end

      {:error, reason} ->
        %{error: "daemon_unavailable", reason: inspect(reason)}
    end
  end

  defp http_get(url) do
    case :httpc.request(:get, {url, []}, [{:timeout, 5_000}], body_format: :binary) do
      {:ok, {{_http_ver, 200, _reason}, _headers, body}} ->
        {:ok, body}

      {:ok, {{_http_ver, code, reason}, _headers, body}} ->
        {:error, {code, reason, body}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # --- Utilities ---

  defp reason_phrase(200), do: "OK"
  defp reason_phrase(404), do: "Not Found"
  defp reason_phrase(405), do: "Method Not Allowed"
  defp reason_phrase(500), do: "Internal Server Error"
  defp reason_phrase(_), do: "OK"

  defp http_date do
    {{y, m, d}, {h, min, s}} = :calendar.universal_time()
    days = ~w(Mon Tue Wed Thu Fri Sat Sun)
    months = ~w(Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec)
    day_of_week = :calendar.day_of_the_week(y, m, d) |> then(&Enum.at(days, &1 - 1))

    "#{day_of_week}, #{pad2(d)} #{Enum.at(months, m - 1)} #{y} #{pad2(h)}:#{pad2(min)}:#{pad2(s)} GMT"
  end

  defp pad2(n) when n < 10, do: "0#{n}"
  defp pad2(n), do: "#{n}"
end
