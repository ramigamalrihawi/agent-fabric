defmodule AgentFabricOrchestrator.IssueTaskPlanner do
  @moduledoc """
  Converts normalized tracker issues into Agent Fabric queue tasks.

  This is the Elixir-side task shaping seam. The TypeScript daemon remains the
  durable source of truth, while Elixir owns the Symphony-style translation from
  project work into queue-visible worker packets with useful metadata,
  acceptance criteria, and context hints.
  """

  alias AgentFabricOrchestrator.{Linear, Workflow}

  @priorities ~w(urgent high normal low)
  @risks ~w(high medium low)

  @doc """
  Build an Agent Fabric `project_queue_add_tasks` task map for one issue.
  """
  @spec build_task(Workflow.t() | map(), Linear.Issue.t(), String.t()) :: map()
  def build_task(%Workflow{config: config}, %Linear.Issue{} = issue, prompt) do
    build_task(config, issue, prompt)
  end

  def build_task(config, %Linear.Issue{} = issue, prompt) when is_map(config) do
    defaults = Workflow.task_defaults(config)
    labels = issue.labels || []
    parsed = parse_description(issue.description)

    expected_files =
      unique_strings(
        list_default(defaults, "expected_files") ++
          label_values(labels, ["file", "expected_file", "expected-files"]) ++
          parsed.expected_files
      )

    context_refs =
      unique_strings(
        list_default(defaults, "required_context_refs") ++
          list_default(defaults, "context_refs") ++
          label_values(labels, ["context", "context_ref", "context-ref"]) ++
          parsed.context_refs
      )

    acceptance =
      unique_strings(
        list_default(defaults, "acceptance_criteria") ++
          parsed.acceptance_criteria ++
          quality_acceptance(prompt)
      )

    %{
      clientKey: issue.identifier,
      title: issue_title(issue),
      goal: issue.description || issue.title || issue.identifier,
      phase: string_default(defaults, "phase", "linear"),
      workstream: workstream(defaults, labels, issue),
      category: category(defaults, labels),
      status: "queued",
      priority: priority(defaults, labels),
      parallelSafe: parallel_safe?(defaults, labels),
      risk: risk(defaults, labels),
      expectedFiles: expected_files,
      acceptanceCriteria: acceptance,
      requiredTools: list_default(defaults, "required_tools"),
      requiredMcpServers: list_default(defaults, "required_mcp_servers"),
      requiredMemories: list_default(defaults, "required_memories"),
      requiredContextRefs: context_refs,
      dependsOn: []
    }
  end

  @doc """
  Extract worker-facing hints from issue Markdown.

  Supported headings are intentionally small and predictable:
  `Expected files`, `Context refs`, and `Acceptance criteria`.
  """
  @spec parse_description(String.t() | nil) :: %{
          expected_files: [String.t()],
          context_refs: [String.t()],
          acceptance_criteria: [String.t()]
        }
  def parse_description(nil), do: %{expected_files: [], context_refs: [], acceptance_criteria: []}

  def parse_description(description) when is_binary(description) do
    description
    |> String.split(~r/\R/)
    |> Enum.reduce(
      {nil, %{expected_files: [], context_refs: [], acceptance_criteria: []}},
      fn line, {section, acc} ->
        trimmed = String.trim(line)

        case section_heading(trimmed) do
          nil ->
            case {section, bullet_value(trimmed)} do
              {nil, _} ->
                {section, acc}

              {_, nil} ->
                {section, acc}

              {:expected_files, value} ->
                {section, update_in(acc.expected_files, &[value | &1])}

              {:context_refs, value} ->
                {section, update_in(acc.context_refs, &[value | &1])}

              {:acceptance_criteria, value} ->
                {section, update_in(acc.acceptance_criteria, &[value | &1])}
            end

          next_section ->
            {next_section, acc}
        end
      end
    )
    |> elem(1)
    |> Map.new(fn {key, values} -> {key, values |> Enum.reverse() |> unique_strings()} end)
  end

  defp issue_title(%Linear.Issue{identifier: identifier, title: title}) do
    cond do
      is_binary(identifier) and identifier != "" and is_binary(title) and title != "" ->
        "#{identifier}: #{title}"

      is_binary(title) and title != "" ->
        title

      true ->
        identifier || "Linear issue"
    end
  end

  defp priority(defaults, labels) do
    label_priority =
      cond do
        label_present?(labels, ["p0", "urgent", "priority-urgent", "priority:urgent"]) ->
          "urgent"

        label_present?(labels, ["p1", "high", "priority-high", "priority:high"]) ->
          "high"

        label_present?(labels, ["p3", "low", "priority-low", "priority:low"]) ->
          "low"

        true ->
          label_value(labels, ["priority", "prio"])
      end

    normalize_choice(
      label_priority || string_default(defaults, "priority", "normal"),
      @priorities,
      "normal"
    )
  end

  defp risk(defaults, labels) do
    label_risk =
      cond do
        label_present?(labels, ["high-risk", "risk-high", "risk:high"]) -> "high"
        label_present?(labels, ["low-risk", "risk-low", "risk:low"]) -> "low"
        true -> label_value(labels, ["risk"])
      end

    normalize_choice(label_risk || string_default(defaults, "risk", "medium"), @risks, "medium")
  end

  defp category(defaults, labels) do
    label_value(labels, ["category", "type", "kind"]) ||
      string_default(defaults, "category", "implementation")
  end

  defp workstream(defaults, labels, issue) do
    label_value(labels, ["workstream", "area", "component", "domain"]) ||
      string_default(defaults, "workstream", issue.team_key || "linear")
  end

  defp parallel_safe?(defaults, labels) do
    cond do
      label_present?(labels, ["serial", "exclusive", "no-parallel", "parallel:false"]) ->
        false

      label_present?(labels, ["parallel", "parallel:true", "parallel-safe"]) ->
        true

      Map.has_key?(defaults, "parallel_safe") ->
        defaults["parallel_safe"] in [true, "true", "1", 1, "yes"]

      true ->
        true
    end
  end

  defp quality_acceptance(prompt) do
    [
      prompt,
      "Provide proof of work: changed files, verification commands, risks, and follow-ups.",
      "Do not bypass Agent Fabric patch review or queue-visible lifecycle evidence."
    ]
  end

  defp parse_label(label) do
    label = String.trim(to_string(label))
    downcased = String.downcase(label)

    case Regex.run(~r/^([a-z0-9_.-]+)\s*[:=\/]\s*(.+)$/i, label) do
      [_, key, value] -> {String.downcase(key), clean_value(value)}
      _ -> {downcased, nil}
    end
  end

  defp label_value(labels, keys) do
    keys = MapSet.new(Enum.map(keys, &String.downcase/1))

    Enum.find_value(labels, fn label ->
      case parse_label(label) do
        {key, value} when not is_nil(value) ->
          if MapSet.member?(keys, key), do: value

        _ ->
          nil
      end
    end)
  end

  defp label_values(labels, keys) do
    labels
    |> Enum.map(fn label ->
      case parse_label(label) do
        {key, value} when not is_nil(value) ->
          if key in Enum.map(keys, &String.downcase/1), do: value, else: nil

        _ ->
          nil
      end
    end)
    |> Enum.reject(&is_nil/1)
    |> unique_strings()
  end

  defp label_present?(labels, wanted) do
    wanted = MapSet.new(Enum.map(wanted, &String.downcase/1))

    Enum.any?(labels, fn label ->
      {key, value} = parse_label(label)

      MapSet.member?(wanted, key) or
        (value && MapSet.member?(wanted, "#{key}:#{String.downcase(value)}"))
    end)
  end

  defp section_heading(line) do
    line =
      line
      |> String.downcase()
      |> String.trim_leading("#")
      |> String.trim()
      |> String.trim_trailing(":")

    cond do
      line in ["expected files", "files", "changed files"] ->
        :expected_files

      line in ["context refs", "context references", "required context refs", "context"] ->
        :context_refs

      line in ["acceptance criteria", "acceptance", "done when", "definition of done"] ->
        :acceptance_criteria

      true ->
        nil
    end
  end

  defp bullet_value(""), do: nil

  defp bullet_value(line) do
    case Regex.run(~r/^\s*(?:[-*]|\d+\.)\s+(.+)$/, line) do
      [_, value] -> clean_value(value)
      _ -> nil
    end
  end

  defp string_default(defaults, key, fallback) do
    case Map.get(defaults, key) do
      value when is_binary(value) and value != "" -> value
      _ -> fallback
    end
  end

  defp list_default(defaults, key) when is_map(defaults) do
    case Map.get(defaults, key) do
      values when is_list(values) -> unique_strings(values)
      value when is_binary(value) and value != "" -> [String.trim(value)]
      _ -> []
    end
  end

  defp normalize_choice(value, allowed, fallback) do
    normalized =
      value
      |> to_string()
      |> String.downcase()
      |> String.replace("_", "-")

    if normalized in allowed, do: normalized, else: fallback
  end

  defp clean_value(value) do
    value
    |> to_string()
    |> String.trim()
    |> String.trim_leading("`")
    |> String.trim_trailing("`")
    |> String.trim()
  end

  defp unique_strings(values) do
    values
    |> Enum.map(&clean_value/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
  end
end
