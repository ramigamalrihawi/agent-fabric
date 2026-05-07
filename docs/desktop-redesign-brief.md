# Desktop Redesign Brief

This brief describes the product direction for redesigning the Agent Fabric
desktop app from the ground up.

It is intended for Claude Design, Figma, Stitch, v0, Codex, Claude Code, and
Agent Fabric worker lanes. It should be read together with
`docs/desktop-ai-design-pipeline.md`.

## Product Position

Agent Fabric Desktop is a local agent operations cockpit for senior engineers.

It is not:

- a chatbot
- a generic admin dashboard
- a hosted swarm platform
- a coding-agent runtime
- a marketing site

It is the visual control plane for:

- queue-backed autonomous work
- parallel worker lanes
- durable checkpoints and resume state
- tool/context/model approvals
- memory review
- context and cost inspection
- review-gated patches
- senior-mode supervision

## Current State

The current desktop app is a local browser command center served by the daemon.
It is useful and already has the right data primitives, but the interaction
model is too tab-heavy for a professional cockpit.

Current implementation:

- `src/desktop/public/index.html`
- `src/desktop/public/app.js`
- `src/desktop/public/app.css`
- `src/runtime/desktop-server.ts`
- `test/desktop-server.test.ts`

Current top-level tabs:

- Dashboard
- Pipeline
- Tasks
- Matrix
- Approvals
- Memory
- Context
- Model Brain
- Theater
- Activity

Current strengths:

- local-only desktop server
- API token for mutations
- readiness contract for wrappers
- bootstrap route for first render
- queue dashboard snapshot
- action inbox projection
- approval inbox
- worker lane data
- task detail and task packets
- memory review
- context package inspection
- model routing and approval surfaces
- patch review actions

Current weaknesses:

- too many top-level tabs
- long forms dominate the visual hierarchy
- worker lanes are not the central product object
- graph/dependency state is not visually native
- review workflow is not prominent enough
- context, cost, and policy are split across surfaces
- the UI feels like a utility console rather than a professional desktop app

## Bookmark-Derived Signals

Recent `bird` bookmark research suggests the desired product direction is a
durable agent cockpit.

Signals:

- session restoration across Claude Code, Codex, and OpenCode is valuable
- a left rail for project/session navigation feels natural
- file tree and git/worktree context should be visible near agent work
- a central senior command surface should own the active operation
- a right inspector should show rendered docs, task packets, patches, logs, or evidence
- worker lanes should feel persistent, resumable, and inspectable
- graph and mind-map navigation help users understand complex generated work
- skills should be first-class commands, not hidden prompt text
- memory should be structured as evidence with provenance
- context cost and token waste should be visible before model calls
- browser workers need explicit state, target, permissions, and takeover points
- human approval should happen only at meaningful risk, cost, or patch gates

These are taste and workflow signals, not requirements to clone another tool.

## Design Thesis

Make Agent Fabric Desktop feel like:

```text
Codex worktree cards
+ Warp-style command surface
+ cmux-style resumable sessions
+ NotebookLM-style graph navigation
+ GitHub-style patch review
+ Sentry-style action triage
+ Agent Fabric durable state
```

The unique product object is the **worker lane**: a queue-visible, resumable,
reviewable unit of agent work with checkpoints, artifacts, cost, risk, and
patch state.

## Primary Users

### Senior Operator

Runs Codex or Claude Code as the supervising harness. Needs to fan out work,
inspect evidence, approve risk, accept patches, and keep final judgment.

Needs:

- next safe action
- active lane overview
- stale/failing work recovery
- patch review
- cost and context visibility
- durable handoff briefs

### Worker Adapter Author

Builds or debugs worker integrations such as DeepSeek direct, Jcode DeepSeek,
OpenHands, Aider, or custom CLIs.

Needs:

- worker lifecycle visibility
- event/checkpoint diagnostics
- task packet inspection
- workspace mode and path visibility
- artifact and patch validation

### Local Power User

Runs many tools locally and wants a desktop control plane that survives
restarts.

Needs:

- session continuity
- project and queue rail
- keyboard-first workflows
- local-only trust model
- no hidden hosted dependency

## Information Architecture

Replace the ten-tab structure with five workspaces.

### 1. Command

Default workspace.

Purpose:

- answer "what needs attention now?"
- show queue health
- show next safe action
- expose active lanes
- surface approvals, stale workers, patch-ready work, failed tasks, and memory review

Primary components:

- ProjectQueueRail
- ActionInbox
- QueueHealthStrip
- NextActionPanel
- ActiveLanesPreview
- ApprovalSummary
- CostRiskSummary
- RecoverySummary

Data sources:

- `/api/bootstrap`
- `project_queue_dashboard`
- `project_queue_approval_inbox`
- `project_queue_agent_lanes`
- `memory_list`
- `desktopActionInbox` projection

### 2. Lanes

Live worker cockpit.

Purpose:

- make worker runs first-class
- show all queue-visible `@af/<name>` workers
- inspect checkpoints, events, files, tests, artifacts, and patch readiness
- message workers or request revisions

Primary components:

- LaneBoard
- LaneCard
- LaneInspector
- CheckpointTimeline
- ArtifactList
- WorkerMessageBox
- StaleWorkerRecoveryAction

Data sources:

- `project_queue_agent_lanes`
- `fabric_open_agent`
- `fabric_message_agent`
- `fabric_wait_agents`
- `project_queue_task_detail`
- `project_queue_timeline`

### 3. Map

Queue DAG and evidence graph.

Purpose:

- show how work decomposes
- show dependencies and blockers
- show path claims and parallel groups
- connect tasks to workers, context packages, memories, and artifacts

Primary components:

- QueueGraph
- DependencyInspector
- ParallelGroupLegend
- PathClaimOverlay
- EvidenceGraph
- ReadinessDrawer

Data sources:

- `project_queue_review_matrix`
- `project_queue_dashboard`
- `project_queue_task_detail`
- `project_queue_task_packet`
- context and memory refs from task metadata

### 4. Review

Patch and evidence bench.

Purpose:

- make patch acceptance safe
- compare worker output against evidence
- inspect tests, risks, reviewer findings, and patch artifacts
- accept, retry, reject, or request revision with senior metadata

Primary components:

- PatchQueue
- PatchDiffViewer
- TestEvidencePanel
- ReviewerFindingsPanel
- SeniorReviewForm
- RetryDecisionPanel
- ApplyPatchConfirmation

Data sources:

- `project_queue_review_matrix`
- `project_queue_task_detail`
- `fabric_accept_patch`
- `project_queue_retry_task`
- patch artifacts linked from worker output

### 5. Vault

Memory, context, policy, skills, and cost.

Purpose:

- show trusted and pending memories
- inspect context packages
- review model routing and approvals
- manage tool/context policy
- expose skill and MCP configuration as operator-facing capabilities

Primary components:

- MemoryReviewQueue
- MemoryProvenancePanel
- ContextPackageInspector
- ModelRoutePanel
- CostApprovalQueue
- ToolPolicyPanel
- SkillCatalog

Data sources:

- `memory_list`
- `memory_review`
- `fabric_inspect_context_package`
- `model_brain_route`
- `llm_approve`
- `tool_context_policy_status`
- `tool_context_policy_set`
- `tool_context_decide`

## Current Tab Mapping

| Current Tab | New Workspace | Notes |
|---|---|---|
| Dashboard | Command | Keep summary and action inbox, remove generic dashboard framing. |
| Pipeline | Command / Map | Pipeline gates become next actions and graph state. |
| Tasks | Command / Map / Review | Task lists become graph nodes, tables, and review queue. |
| Matrix | Map | Readiness and dependency matrix becomes visual graph plus dense table fallback. |
| Approvals | Command / Vault | Urgent approvals surface in Command; full policy history lives in Vault. |
| Memory | Vault | Add provenance and causal context. |
| Context | Vault | Context package inspection becomes a major cost/safety surface. |
| Model Brain | Vault | Model routing is part of cost/policy. |
| Theater | Lanes | Theater becomes the primary lane cockpit. |
| Activity | Lanes / Review / Vault | Activity appears in inspectors where it matters. |

## Screen Requirements

### Command Workspace

Must answer within five seconds:

- is the daemon healthy?
- which queue is selected?
- what is blocked?
- what needs a human decision?
- what workers are active?
- what is the next safe action?
- is cost or context risk rising?

Required states:

- no queues
- queue selected, no active work
- ready tasks but start gate closed
- active workers
- approvals pending
- patch-ready work
- stale workers
- failed tasks

### Lanes Workspace

Each LaneCard must show:

- `@af/<name>` handle
- worker type
- model profile
- workspace mode
- task title
- status
- latest checkpoint summary
- progress signal
- files touched
- tests run
- failing tests
- patch state
- review state
- cost/risk indicator
- last heartbeat or stale state

Actions:

- open task
- open packet
- message worker
- request revision
- open patch
- retry/recover

### Map Workspace

Graph nodes:

- queue
- task
- worker run
- context package
- memory
- path claim
- artifact
- patch
- decision

Graph edge types:

- depends on
- assigned to
- produced
- reviewed by
- blocked by
- used context
- used memory
- claims path
- accepted/rejected

The graph must support a dense table fallback for accessibility and large
queues.

### Review Workspace

Patch review must show:

- task goal
- acceptance criteria
- changed files
- proposed patch
- test evidence
- worker checkpoint
- reviewer findings
- risk notes
- senior review metadata
- accept/retry/reject controls

Patch acceptance must require explicit review metadata.

### Vault Workspace

Memory must show:

- source
- status
- namespace
- confidence or review state
- related task/session
- where it was injected
- outcomes
- approve/archive/reject actions

Context inspection must show:

- token estimate
- file count
- tool schema count
- memory count
- sensitive flags
- repeated/stale context
- suggested actions
- estimated waste

## Layout Rules

Use a three-pane desktop shell:

```text
left rail       center workbench             right inspector
projects       command / lanes / map         selected task/lane/patch
queues         review / vault                evidence/context/logs
sessions
saved views
```

Rules:

- left rail is persistent
- right inspector is collapsible
- center workbench owns the main task
- command palette is global
- bottom status strip shows daemon, model/cost, queue, branch/worktree, and policy state
- no hero screens
- no marketing copy
- no decorative orb/blob backgrounds
- no nested cards
- cards only for repeated items, modals, and framed tools

## Visual Style

Direction:

- professional
- dense
- calm
- local-first
- operational
- dark-mode friendly
- readable under sustained use

Avoid:

- one-note purple/blue palettes
- oversized hero type
- glossy SaaS cards
- heavy gradients
- decorative illustrations
- large empty marketing panels

Use:

- restrained neutral surfaces
- status colors only for state
- strong spacing discipline
- 8px radius max
- stable dimensions for lane cards and task rows
- accessible focus states
- Lucide icons for actions
- compact, scannable labels

## Component Inventory

Core shell:

- AppShell
- ProjectQueueRail
- WorkspaceTabs
- CommandPalette
- StatusStrip
- RightInspector
- SplitPane

Command:

- ActionInbox
- ActionItem
- QueueHealthStrip
- NextActionPanel
- ApprovalSummary
- ActiveLanesPreview
- RecoverySummary

Lanes:

- LaneBoard
- LaneCard
- LaneInspector
- CheckpointTimeline
- WorkerEventList
- ArtifactList
- WorkerMessageBox

Map:

- QueueGraph
- GraphNode
- GraphEdgeLegend
- DependencyInspector
- GraphTableFallback

Review:

- PatchQueue
- PatchDiffViewer
- TestEvidencePanel
- ReviewerFindingsPanel
- SeniorReviewForm
- ReviewDecisionBar

Vault:

- MemoryReviewQueue
- MemoryProvenancePanel
- ContextPackageInspector
- ModelRoutePanel
- ToolPolicyPanel
- SkillCatalog

Shared:

- StatusPill
- RiskBadge
- CostBadge
- EmptyState
- ErrorState
- LoadingSkeleton
- CopyButton
- IconButton
- Drawer
- Dialog
- Tooltip

## Data And API Contract

Prefer existing desktop routes first:

- `GET /api/readiness`
- `GET /api/bootstrap`
- `GET /api/queues`
- `GET /api/queues/:queueId/snapshot`
- `GET /api/queues/:queueId/timeline`
- `GET /api/queues/:queueId/lanes`
- `GET /api/queues/:queueId/tasks/:queueTaskId`
- `GET /api/queues/:queueId/tasks/:queueTaskId/packet`
- `GET /api/context/:requestId`
- `GET /api/memory/pending`
- `POST /api/call`

Use `POST /api/call` only for allowlisted tools exposed by the desktop server.

Do not add broad generic backend escape hatches. If a new route is needed, make
it narrow, read-optimized, tested, and backed by existing daemon tools.

## Keyboard And Interaction

Required:

- global command palette
- queue switcher
- open selected lane/task
- open next pending action
- approve/reject with confirmation
- copy task packet URL
- copy worker handoff brief
- collapse/expand inspector
- focus search/filter

Important shortcuts should be discoverable in menus or tooltips, but the app
should not rely on visible instructional prose to explain itself.

## Accessibility

Requirements:

- all icon buttons have accessible labels
- all status colors have text labels
- keyboard navigation works across rail, workbench, and inspector
- graph has table fallback
- patch review is usable without color-only diff semantics
- text does not overlap at desktop or narrow widths
- focus indicators are visible
- dialogs trap focus
- live updates do not steal focus

## Implementation Plan

### Slice 1: Command And Lanes

Files likely to add:

- `src/desktop/app/package.json` or root-level app config, depending on final build integration
- `src/desktop/app/src/main.tsx`
- `src/desktop/app/src/App.tsx`
- `src/desktop/app/src/api/desktopApi.ts`
- `src/desktop/app/src/components/AppShell.tsx`
- `src/desktop/app/src/components/ProjectQueueRail.tsx`
- `src/desktop/app/src/workspaces/CommandWorkspace.tsx`
- `src/desktop/app/src/workspaces/LanesWorkspace.tsx`
- `src/desktop/app/src/components/LaneCard.tsx`
- `src/desktop/app/src/components/RightInspector.tsx`
- `src/desktop/app/src/fixtures/*.ts`
- `src/desktop/app/tests/*.spec.ts`

Server changes should be minimal in Slice 1. Prefer existing `/api/bootstrap`.

Validation:

```bash
npm run build
npm test
```

New validation after frontend test tooling exists:

```bash
npx playwright test
```

### Slice 2: Map

Add React Flow and graph projection helpers.

Focus:

- task DAG
- readiness blockers
- path claims
- workers and artifacts
- table fallback

### Slice 3: Review

Add patch review bench.

Focus:

- patch queue
- diff/evidence/test view
- senior metadata
- accept/retry/reject gates

### Slice 4: Vault

Add memory, context, cost, policy, and skills.

Focus:

- provenance
- context waste
- tool/context grants
- model approval state
- skill catalog

### Slice 5: Native Wrapper

Evaluate packaging only after the web app is strong.

Preferred order:

1. keep local browser app for development
2. add Electron wrapper if native desktop delivery is needed quickly
3. evaluate Tauri only after frontend and daemon boundaries stabilize

## Acceptance Criteria

The redesign is on track when:

- the default screen is Command, not a generic dashboard
- worker lanes are central and inspectable
- the operator can identify pending decisions quickly
- patch review is safer and clearer than the current app
- queue dependencies are visible as a graph
- memory and context have provenance
- cost and context risk are visible before approval
- the app survives dense data without layout collapse
- every major screen has screenshot coverage
- the old static app can remain as fallback until parity

## Open Questions

- Should the first React app be served from the existing desktop server or a
  Vite dev server proxied to it during development?
- Should `DESIGN.md` live at repo root for broad agent visibility or under
  `docs/desktop-design-system.md` to keep it scoped?
- Should screenshots from Bird-derived references be archived in a private
  overlay rather than the public repo?
- Which native wrapper, if any, is needed for the first public demo?
- Should browser-worker state become a first-class lane subtype in the desktop
  API?

## Immediate Next Step

Create the design constitution:

```text
docs/desktop-design-system.md
```

Then scaffold the first implementation slice:

```text
src/desktop/app
```

Do not delete the existing static app until the React shell reaches Command and
Lanes parity.
