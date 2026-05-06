# Local Private Config And Agent Memory

Agent Fabric works best with one active development checkout. Do not maintain a
second private source copy unless you are intentionally testing migration or
sync logic.

## Gitignored Local Material

Keep private operating material inside this checkout when it helps agents work,
but keep it out of public Git:

| Path | Role |
|---|---|
| `agent-fabric.local.env` | Local environment defaults and harness preferences. |
| `decisions/` | Local architecture intent, roadmap notes, and agent memory. |
| `.agent-fabric-local/` | Private local generated state. |
| `artifacts/` | Generated artifacts and reports. |
| `~/.agent-fabric` | Runtime SQLite, sockets, generated views, and logs. |

Agents should read local `decisions/` when present. Public docs, package files,
and tests must not require those records to exist in a fresh GitHub clone.

## Local Configuration

Keep personal defaults in `agent-fabric.local.env`:

```bash
export AGENT_FABRIC_HOME="$HOME/.agent-fabric"
export AGENT_FABRIC_WORKSPACE_ROOT="/path/to/agent-fabric"
export AGENT_FABRIC_PROJECT_MODEL_COMMAND="agent-fabric-deepseek-worker model-command --model deepseek-v4-pro --reasoning-effort max"
export AGENT_FABRIC_SENIOR_MODE="permissive"
export AGENT_FABRIC_SENIOR_DEFAULT_WORKER="jcode-deepseek"
export JCODE_BIN="$HOME/.local/bin/jcode"
# Optional legacy/private dispatcher override only:
# export AGENT_FABRIC_JCODE_DEEPSEEK_DISPATCHER="/path/to/dispatch-deepseek-with-collab.sh"
```

Do not put real tokens, provider keys, billing settings, or private task packets
in tracked files. Commit public examples as `*.example` files only.

## Public Promotion Checklist

Before promoting a local note into public docs:

1. Confirm it helps outside users understand or operate Agent Fabric.
2. Remove private paths unless they are clearly marked as examples.
3. Remove provider tokens, account names, bearer tokens, billing IDs, and local
   machine details.
4. Convert personal product names into generic adapter names when the concept is
   not specific to the public project.
5. Move only the public-safe substance into tracked docs.
6. Run `npm run build && npm test` before committing.
