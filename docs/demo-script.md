# 2-Minute Demo Script

This is the shortest useful walkthrough for showing Agent Fabric to another developer.

## Setup

```bash
npm install
npm run build
npm test
```

Start the daemon:

```bash
AGENT_FABRIC_COST_INGEST_TOKEN="$(openssl rand -base64 32)" npm run dev:daemon
```

In another terminal, start the command center:

```bash
npm run dev:desktop -- --port 4573
```

Open `http://127.0.0.1:4573/`.

## Talk Track

1. **Problem**

   "When I use multiple coding agents, the hard part is not another prompt. It is durable coordination: who owns which task, what was tried, what passed review, what cost money, and what can be trusted later."

2. **Queue**

   Show a project queue with tasks grouped by status, risk, dependencies, and readiness. Point out that workers do not just run free-form; they get task packets and explicit grants.

3. **Worker Lanes**

   Open a task drawer and show worker events/checkpoints. Explain that a worker can be Claude Code, Codex, OpenHands, Aider, DeepSeek direct, or a custom CLI as long as it reports lifecycle evidence.

4. **Senior Mode**

   "The pattern I care about is a premium senior harness supervising cheaper high-context workers. The senior model spends tokens on judgment; workers spend cheaper tokens on breadth: planning variants, implementation slices, risk review, test review, and docs review."

5. **Patch Gate**

   Show `review-patches`. The point: worker output is not blindly applied. Proposed patches become queue artifacts, then the supervising harness or user decides.

6. **Collab + Memory + Cost**

   Mention that live fan-out is opportunistic, but SQLite inbox is canonical. Memory starts pending review. Cost preflight is explicit and coverage-honest.

## Close

"Agent Fabric is not a new coding agent. It is the local substrate underneath several of them: queues, collaboration, memory, costs, checkpoints, and review gates."
