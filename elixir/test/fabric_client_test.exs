defmodule AgentFabricOrchestrator.FabricClientTest do
  use ExUnit.Case, async: true

  alias AgentFabricOrchestrator.FabricClient
  alias AgentFabricOrchestrator.FabricClient.Session

  @socket_path "/tmp/agent-fabric-test.sock"

  # --- Helpers ---

  defp build_register_payload do
    %{
      bridgeVersion: "1.0.0",
      agent: %{id: "elixir-test", displayName: "Elixir Test Agent"},
      host: %{name: "jcode-elixir", transport: "uds"},
      workspace: %{root: "/tmp/test-ws", source: "explicit"},
      capabilities: %{}
    }
  end

  defp fake_session do
    %Session{
      session_id: "sess_test",
      session_token: "tok_def",
      origin_peer_id: "peer_abc",
      expires_at: "2099-01-01T00:00:00Z",
      warnings: []
    }
  end

  # Build a fake transport that echoes the request for assertion
  defp transport_that_responds(response_map) do
    fn _json_line -> {:ok, response_map} end
  end

  # Build a fake transport that captures the request line for inspection
  defp transport_that_captures(receiver_pid) do
    fn json_line ->
      send(receiver_pid, {:transport_request, json_line})
      {:ok, %{"ok" => true, "result" => %{"echo" => json_line}}}
    end
  end

  # Create a simple process that can receive messages for assert_receive
  defp receiver_process do
    parent = self()

    spawn(fn ->
      receive do
        {:await, pid} -> send(pid, {:receiver_pid, self()})
      end

      relay(parent)
    end)
  end

  defp get_receiver(receiver) do
    send(receiver, {:await, self()})

    receive do
      {:receiver_pid, pid} -> pid
    after
      1000 -> raise "receiver not ready"
    end
  end

  defp relay(parent) do
    receive do
      msg ->
        send(parent, msg)
        relay(parent)
    end
  end

  # --- Default payload tests ---

  describe "defaults" do
    test "builds default bridge registration payload" do
      payload = FabricClient.default_register_payload()

      assert payload.bridgeVersion == "0.1.0"
      assert payload.agent.id == "elixir-orchestrator"
      assert payload.host.transport == "uds"
      assert payload.capabilities.outcomeReporting == "explicit"
    end

    test "uses explicit socket path defaults shape" do
      assert FabricClient.default_socket_path() =~ ".agent-fabric/agent.sock"
    end
  end

  # --- register/3 ---

  describe "register/3" do
    test "returns Session struct on success" do
      response = %{
        "ok" => true,
        "result" => %{
          "sessionId" => "sess_abc",
          "sessionToken" => "tok_xyz",
          "originPeerId" => "peer_123",
          "expiresAt" => "2099-01-01T00:00:00Z",
          "heartbeatEveryMs" => 30_000,
          "warnings" => ["test warning"]
        }
      }

      {:ok, session} =
        FabricClient.register(
          @socket_path,
          build_register_payload(),
          transport: transport_that_responds(response)
        )

      assert %Session{} = session
      assert session.session_id == "sess_abc"
      assert session.session_token == "tok_xyz"
      assert session.origin_peer_id == "peer_123"
      assert session.expires_at == "2099-01-01T00:00:00Z"
      assert session.warnings == ["test warning"]
    end

    test "sends register request with correct shape in transport" do
      receiver_pid = receiver_process() |> get_receiver()
      transport = transport_that_captures(receiver_pid)

      FabricClient.register(@socket_path, build_register_payload(), transport: transport)

      assert_receive {:transport_request, json_line}, 1000
      decoded = Jason.decode!(json_line)

      assert decoded["type"] == "register"
      assert is_binary(decoded["id"])
      assert String.starts_with?(decoded["id"], "elixir_")
      assert decoded["payload"]["agent"]["id"] == "elixir-test"
      assert decoded["payload"]["host"]["transport"] == "uds"
      assert decoded["payload"]["workspace"]["root"] == "/tmp/test-ws"
    end

    test "returns error on daemon error response" do
      response = %{
        "ok" => false,
        "error" => %{
          "code" => "DUPLICATE_AGENT",
          "message" => "already registered",
          "retryable" => false
        }
      }

      {:error, error} =
        FabricClient.register(
          @socket_path,
          build_register_payload(),
          transport: transport_that_responds(response)
        )

      assert error["code"] == "DUPLICATE_AGENT"
      assert error["message"] == "already registered"
      assert error["retryable"] == false
    end

    test "returns error when transport fails" do
      {:error, reason} =
        FabricClient.register(
          @socket_path,
          build_register_payload(),
          transport: fn _ -> {:error, :econnrefused} end
        )

      assert reason == :econnrefused
    end
  end

  # --- call/5 ---

  describe "call/5" do
    test "sends call request with tool, input, and context" do
      receiver_pid = receiver_process() |> get_receiver()
      transport = transport_that_captures(receiver_pid)

      session = fake_session()

      FabricClient.call(
        @socket_path,
        session,
        "fabric_status",
        %{},
        transport: transport,
        idempotency_key: "idem_001"
      )

      assert_receive {:transport_request, json_line}, 1000
      decoded = Jason.decode!(json_line)

      assert decoded["type"] == "call"
      assert decoded["tool"] == "fabric_status"
      assert decoded["input"] == %{}
      assert decoded["context"]["sessionId"] == "sess_test"
      assert decoded["context"]["idempotencyKey"] == "idem_001"
    end

    test "includes session token in call context" do
      receiver_pid = receiver_process() |> get_receiver()
      transport = transport_that_captures(receiver_pid)

      session = %Session{
        session_id: "sess_x",
        session_token: "tok_secret",
        origin_peer_id: "peer_x",
        expires_at: "2099-01-01T00:00:00Z"
      }

      FabricClient.call(@socket_path, session, "some_tool", %{}, transport: transport)

      assert_receive {:transport_request, json_line}, 1000
      decoded = Jason.decode!(json_line)
      assert decoded["context"]["sessionToken"] == "tok_secret"
    end

    test "merges extra context fields" do
      receiver_pid = receiver_process() |> get_receiver()
      transport = transport_that_captures(receiver_pid)

      FabricClient.call(
        @socket_path,
        fake_session(),
        "tool",
        %{key: "val"},
        transport: transport,
        context: %{traceId: "trace_123", branch: "main"}
      )

      assert_receive {:transport_request, json_line}, 1000
      decoded = Jason.decode!(json_line)

      assert decoded["context"]["traceId"] == "trace_123"
      assert decoded["context"]["branch"] == "main"
      assert decoded["input"]["key"] == "val"
    end

    test "returns result on success" do
      response = %{"ok" => true, "result" => %{"status" => "ok", "uptime" => 42}}

      {:ok, result} =
        FabricClient.call(
          @socket_path,
          fake_session(),
          "fabric_status",
          %{},
          transport: transport_that_responds(response)
        )

      assert result["status"] == "ok"
      assert result["uptime"] == 42
    end

    test "returns error on tool failure" do
      response = %{
        "ok" => false,
        "error" => %{"code" => "TOOL_ERROR", "message" => "bad input", "retryable" => false}
      }

      {:error, error} =
        FabricClient.call(
          @socket_path,
          fake_session(),
          "bad_tool",
          %{},
          transport: transport_that_responds(response)
        )

      assert error["code"] == "TOOL_ERROR"
    end
  end

  # --- close_session/3 ---

  describe "close_session/3" do
    test "calls fabric_session_close tool" do
      receiver_pid = receiver_process() |> get_receiver()
      transport = transport_that_captures(receiver_pid)

      FabricClient.close_session(@socket_path, fake_session(), transport: transport)

      assert_receive {:transport_request, json_line}, 1000
      decoded = Jason.decode!(json_line)

      assert decoded["type"] == "call"
      assert decoded["tool"] == "fabric_session_close"
    end

    test "returns close result" do
      response = %{"ok" => true, "result" => %{"sessionId" => "sess_test", "status" => "ended"}}

      {:ok, result} =
        FabricClient.close_session(
          @socket_path,
          fake_session(),
          transport: transport_that_responds(response)
        )

      assert result["status"] == "ended"
    end
  end

  # --- request/3 transport abstraction ---

  describe "request/3 transport" do
    test "uses real UDS when transport is nil (default)" do
      # When no transport is given and socket path doesn't exist, we get a connect error.
      # This proves the real UDS path is attempted.
      {:error, reason} =
        FabricClient.request("/tmp/nonexistent-path-12345.sock", %{
          id: "x",
          type: "register",
          payload: %{}
        })

      assert reason in [:econnrefused, :enoent, :nxdomain]
    end

    test "uses injected transport when provided" do
      response = %{"ok" => true, "result" => %{"called" => "via_transport"}}

      {:ok, result} =
        FabricClient.request(@socket_path, %{id: "x", type: "call", tool: "t"},
          transport: transport_that_responds(response)
        )

      assert result["called"] == "via_transport"
    end

    test "transport receives newline-terminated JSON" do
      receiver_pid = receiver_process() |> get_receiver()
      transport = transport_that_captures(receiver_pid)

      FabricClient.request(@socket_path, %{id: "abc", type: "register", payload: %{}},
        transport: transport
      )

      assert_receive {:transport_request, json_line}, 1000
      assert is_binary(json_line)
      assert String.ends_with?(json_line, "\n")
      decoded = String.trim_trailing(json_line, "\n") |> Jason.decode!()
      assert decoded["id"] == "abc"
    end

    test "bubbles transport error" do
      {:error, :custom_error} =
        FabricClient.request(
          @socket_path,
          %{id: "x"},
          transport: fn _ -> {:error, :custom_error} end
        )

      assert :custom_error == :custom_error
    end
  end

  # --- decode_response_struct/1 ---

  describe "decode_response_struct/1" do
    test "extracts result on ok response" do
      assert {:ok, %{"a" => 1}} =
               FabricClient.decode_response_struct(%{"ok" => true, "result" => %{"a" => 1}})
    end

    test "extracts error on failure response" do
      assert {:error, %{"code" => "ERR"}} =
               FabricClient.decode_response_struct(%{
                 "ok" => false,
                 "error" => %{"code" => "ERR"}
               })
    end

    test "returns unexpected for malformed response" do
      assert {:error, {:unexpected_response, %{"garbage" => true}}} =
               FabricClient.decode_response_struct(%{"garbage" => true})
    end
  end
end
