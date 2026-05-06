# Copy-Ready Feedback Post

## Short Version

I am looking for architecture feedback on Agent Fabric:

https://github.com/ramigamalrihawi/agent-fabric

It is a local-first coordination layer for coding agents. The idea is to let a senior harness like GPT-5.5 in Codex or Claude Opus in Claude Code supervise cheaper high-context worker lanes through durable queues, checkpoints, review gates, collab, memory review, and cost telemetry.

The project is not trying to be another coding agent. It is the substrate underneath several of them: task packets, worker lifecycle, live plus async collaboration, memory, cost preflight, and patch review.

I would especially value feedback on whether the supervisor-to-worker-to-reviewer loop matches how teams actually use coding agents.

## Longer Version

I am building Agent Fabric, a local-first daemon and CLI toolkit for coordinating multiple coding agents without turning the workflow into an untracked swarm.

The core pattern is "senior mode": keep a premium model or harness responsible for judgment, then fan out cheaper high-context workers for breadth. For example, a GPT-5.5/Codex or Claude Code session can split work, grant tools/context, launch DeepSeek-style planner or reviewer lanes, inspect their evidence, and apply only reviewed patches.

Agent Fabric keeps the boring but important parts durable:

- project queues and task DAGs
- task packets for workers
- worker heartbeats, checkpoints, and resume packets
- live collaboration plus durable inbox fallback
- memory review before reuse
- cost preflight and approval tokens
- review-gated patch application

The repo is early but working locally, with tests around the daemon, project queues, live collab fan-out, worker lifecycle, memory review, cost preflight, and patch review.

Feedback wanted:

- Is this the right boundary between an agent runtime and a coordination substrate?
- What would make the quickstart convincing?
- Which safety gates are essential versus too much friction?
- What worker/harness integration would you want first?

## Who To Ask First

Agent Fabric should start with developers who already run more than one coding agent or want to. Good early-user pools:

- Codex users who are moving from single-agent edits toward supervising multiple local or cloud coding lanes. OpenAI now presents Codex as a family across CLI, IDE, cloud, and desktop, with coordinated teams of agents as a core workflow.
- Claude Code users who rely on project rules, terminal execution, and long-lived sessions but need durable handoffs, queue state, and review gates across more than one lane.
- OpenHands users who like autonomous sandboxed execution but need a local control plane for task DAGs, checkpoints, and patch review across other runtimes too.
- Aider/OpenCode/jcode-style terminal users who prefer bring-your-own-model workflows and want worker outputs to become durable artifacts instead of disappearing into separate terminals.
- Solo maintainers and small teams doing bug hunts, dependency upgrades, migrations, test expansion, security review, or docs cleanup where parallel review helps but blind patch application is too risky.

Launch hooks:

- "Not another coding agent: the local queue, memory, cost, and review layer underneath the agents you already use."
- "Run parallel coding lanes without losing who owns what, what changed, what passed review, or what it cost."
- "Senior model coordinates; cheaper workers explore; Agent Fabric keeps the evidence."

Useful distribution channels:

- GitHub Discussions/Issues for Codex, OpenHands, Aider, OpenCode, Goose, and adjacent coding-agent projects.
- Hacker News Show HN with a 2-minute terminal/dashboard demo.
- Reddit communities for Claude Code, Codex, local LLM tooling, and agentic coding.
- Short screencasts showing a queue becoming live lanes, then reviewed patches.

Reference signals:

- OpenAI describes Codex across CLI, IDE, cloud, and desktop surfaces, and positions the app around supervising coordinated agent work: https://openai.com/index/introducing-the-codex-app/
- OpenHands is an active open-source coding-agent project with cloud and enterprise variants: https://github.com/OpenHands/OpenHands
- Aider remains a focused terminal pair-programming tool for developers who want local workflows: https://github.com/aider-ai/aider
