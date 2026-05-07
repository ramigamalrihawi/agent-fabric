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
            data: %{
              active_issue_count: state |> Map.get(:active, %{}) |> map_size(),
              last_error: state.last_error,
              orchestrator_alive: true
            }
          })

        :not_running ->
          Jason.encode!(%{
            source: "runtime",
            data: %{
              orchestator_alive: false,
              note: "Orchestrator not autostarted (set AGENT_FABRIC_ELIXIR_AUTOSTART=1)"
            }
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
            |> Map.get(:active, %{})
            |> Enum.map(fn {identifier, detail} ->
              %{
                identifier: identifier,
                issue_title: get_in(detail, [:issue, :title]),
                workspace: detail[:workspace]
              }
            end)

          Jason.encode!(%{source: "runtime", lanes: lanes})

        :not_running ->
          Jason.encode!(%{source: "runtime", lanes: [], orchestator_alive: false})
      end

    {200, "application/json", json}
  end

  # GET /api/progress - combined runtime + fabric summary
  defp route("GET", "/api/progress") do
    orchestrator_data =
      case orchestrator_state() do
        {:ok, state} ->
          %{
            active_issue_count: state |> Map.get(:active, %{}) |> map_size(),
            last_error: state.last_error,
            orchestator_alive: true
          }

        :not_running ->
          %{active_issue_count: 0, last_error: nil, orchestator_alive: false}
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
       when path in ["/health", "/api/status", "/api/lanes", "/api/progress"] do
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
