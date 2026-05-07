defmodule AgentFabricOrchestrator.RunnerRegistry do
  @moduledoc """
  Unique-per-identifier registry for runner processes.

  Ensures at most one runner is active per Linear issue identifier.
  Uses ETS for lightweight registration, avoiding OTP naming conflicts.
  """

  @table_name :af_runner_registry

  @doc """
  Ensure the ETS table exists. Safe to call multiple times.
  """
  def ensure_table do
    if :ets.whereis(@table_name) == :undefined do
      :ets.new(@table_name, [:set, :public, :named_table])
    end

    :ok
  end

  @doc "Register a runner pid for an issue identifier."
  def register(issue_identifier, pid) do
    ensure_table()
    :ets.insert(@table_name, {issue_identifier, pid})
  end

  @doc "Look up a runner pid by issue identifier."
  def lookup(issue_identifier) do
    ensure_table()

    case :ets.lookup(@table_name, issue_identifier) do
      [{^issue_identifier, pid}] -> pid
      [] -> nil
    end
  end

  @doc "Remove a runner registration."
  def unregister(issue_identifier) do
    ensure_table()
    :ets.delete(@table_name, issue_identifier)
  end

  @doc "Return all registered issue identifiers."
  def list do
    ensure_table()
    :ets.select(@table_name, [{{:"$1", :_}, [], [:"$1"]}])
  end
end
