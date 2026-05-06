#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: dispatch-deepseek-with-collab.example.sh <task-packet>

Runs one Agent Fabric task packet through Jcode's DeepSeek provider and prints
the structured worker-result JSON path on stdout.

Required:
  <task-packet>      JSON or Markdown task packet from agent-fabric-project
  JCODE_BIN          Optional path to Jcode; defaults to "jcode"

Optional:
  AGENT_FABRIC_AGENT_ID             Stable worker identity
  AGENT_FABRIC_OUTPUT_DIR           Output directory for logs/results
  AGENT_FABRIC_COLLAB_ASK_LISTENER  Executable helper to answer collab asks
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage
  exit 64
fi

task_packet=$1
if [[ ! -f "$task_packet" ]]; then
  echo "Task packet not found: $task_packet" >&2
  exit 66
fi

JCODE_BIN=${JCODE_BIN:-jcode}
AGENT_FABRIC_AGENT_ID=${AGENT_FABRIC_AGENT_ID:-"jcode-deepseek-worker-$(date +%s)-$$"}
export AGENT_FABRIC_AGENT_ID

output_dir=${AGENT_FABRIC_OUTPUT_DIR:-"${TMPDIR:-/tmp}/agent-fabric-jcode-deepseek/${AGENT_FABRIC_AGENT_ID}"}
mkdir -p "$output_dir"

prompt_file="$output_dir/prompt.md"
ndjson_log="$output_dir/jcode.ndjson"
stderr_log="$output_dir/jcode.stderr.log"
result_file=${AGENT_FABRIC_RESULT_FILE:-"$output_dir/worker-result.json"}

cat > "$prompt_file" <<PROMPT
You are a Jcode DeepSeek worker running under Agent Fabric.

Follow the task packet exactly. Work only in the current workspace. Do not run
git operations unless the task packet explicitly allows them. Return concise
evidence: files inspected or changed, commands run, tests/checks run, blockers,
and the next recommended queue action.

Task packet:

$(cat "$task_packet")
PROMPT

listener_pid=""
if [[ -n "${AGENT_FABRIC_COLLAB_ASK_LISTENER:-}" ]]; then
  if [[ ! -x "$AGENT_FABRIC_COLLAB_ASK_LISTENER" ]]; then
    echo "AGENT_FABRIC_COLLAB_ASK_LISTENER is not executable: $AGENT_FABRIC_COLLAB_ASK_LISTENER" >&2
    exit 126
  fi
  "$AGENT_FABRIC_COLLAB_ASK_LISTENER" "$task_packet" &
  listener_pid=$!
fi

cleanup() {
  if [[ -n "$listener_pid" ]]; then
    kill "$listener_pid" 2>/dev/null || true
    wait "$listener_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

set +e
"$JCODE_BIN" run --provider deepseek --ndjson --no-update --quiet < "$prompt_file" > "$ndjson_log" 2> "$stderr_log"
exit_code=$?
set -e

node - "$result_file" "$exit_code" "$task_packet" "$ndjson_log" "$stderr_log" <<'NODE'
const fs = require("node:fs");
const [resultFile, rawExitCode, taskPacket, ndjsonLog, stderrLog] = process.argv.slice(2);
const exitCode = Number(rawExitCode);
const readTail = (file, max = 12000) => {
  try {
    const body = fs.readFileSync(file, "utf8");
    return body.length > max ? body.slice(body.length - max) : body;
  } catch {
    return "";
  }
};
const stdoutTail = readTail(ndjsonLog);
const stderrTail = readTail(stderrLog);
const status = exitCode === 0 ? "completed" : "failed";
const blockers = exitCode === 0 ? [] : [`Jcode exited ${exitCode}`];
const artifact = {
  schema: "agent-fabric.deepseek-worker-result.v1",
  result: {
    status,
    summary: exitCode === 0 ? "Jcode DeepSeek worker completed." : `Jcode DeepSeek worker failed with exit code ${exitCode}.`,
    changedFilesSuggested: [],
    testsSuggested: [],
    blockers,
    taskPacket,
    stdoutTail,
    stderrTail
  }
};
fs.writeFileSync(resultFile, `${JSON.stringify(artifact, null, 2)}\n`);
NODE

echo "$result_file"
exit "$exit_code"
