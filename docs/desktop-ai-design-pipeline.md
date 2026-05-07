# Desktop AI Design Pipeline

This document defines the AI-native design and implementation workflow for the
next Agent Fabric desktop app.

The goal is not to let one AI UI generator own the product. The goal is to use
frontier AI design tools to generate options, then use Agent Fabric's own
review-gated operating model to converge on a durable, testable, professional
interface.

## Target Outcome

Build the Agent Fabric desktop app as a high-density agent operations cockpit:

- persistent sessions and queues that survive restarts
- live worker lanes with checkpoints, costs, files, tests, and artifacts
- graph views for dependencies, claims, context, and evidence
- review benches for patch-ready output
- clear human approval gates for cost, policy, tool context, memory, and patches
- a design system that coding agents can follow without visual drift

The desktop app should make Agent Fabric's durable substrate visible. It should
not become a coding-agent runtime.

## Non-Negotiable Boundary

Agent Fabric owns:

- queues, task DAGs, worker runs, checkpoints, and artifacts
- live plus durable collaboration
- memory review and provenance
- model routing, context inspection, costs, and approvals
- patch review gates
- daemon and desktop API contracts

The desktop frontend owns:

- navigation and operator workflows
- state visualization
- inspection and review surfaces
- safe mutation affordances
- visual design, density, accessibility, and keyboard ergonomics

AI design tools own:

- divergent concepts
- screen prototypes
- component alternatives
- critique and comparison

They do not own canonical state, product boundary, or final implementation
judgment.

## Source Inputs

Use these inputs before generating or implementing UI:

1. Current desktop code:
   - `src/desktop/public/index.html`
   - `src/desktop/public/app.js`
   - `src/desktop/public/app.css`
   - `src/runtime/desktop-server.ts`
   - `test/desktop-server.test.ts`
2. Product architecture:
   - `README.md`
   - `ARCHITECTURE.md`
   - `PLAN.md`
   - `api/project-queue-tools.md`
   - `api/worker-tools.md`
   - `api/fabric-tools.md`
   - `decisions/0019-senior-mode-codex-claude-integration.md`
   - `decisions/0021-worker-runtime-boundary.md`
3. Taste and market signals:
   - `bird` bookmark extraction for recent X bookmarks
   - screenshots or videos from relevant bookmarks
   - official docs for Claude Design, Figma MCP, v0, Stitch, Playwright, and the selected frontend stack

Do not treat social posts as factual proof. Treat them as taste, workflow, and
market-signal inputs.

## Tool Roles

### Claude Design

Role: visual director and concept generator.

Use it to produce polished design directions and to critique whether the UI
feels like a serious agent cockpit. It is especially useful for:

- visual hierarchy
- product framing
- density and contrast
- operator workflow storytelling
- alternative screen compositions
- "does this feel professional?" critique

Claude Design output is not the final implementation source. It is a design
option set.

### Google Stitch

Role: divergent UI generator and `DESIGN.md` influence.

Use it to generate alternative screens from the same brief, especially when the
team needs fast exploration of:

- command-center layout
- graph/map layout
- review bench layout
- mobile or narrow-window behavior
- design-system documentation patterns

Use Stitch output to inform the local design constitution, not to replace it.

### Figma

Role: canonical design source.

Figma should hold the accepted component library, screen layouts, tokens,
interaction annotations, and responsive variants. If Figma MCP is available,
use it to let coding agents inspect exact component context.

Figma is the stable handoff layer between design exploration and implementation.

### v0

Role: production-shaped React experiment generator.

Use v0 to generate practical React/shadcn/Tailwind implementations for narrow
component or screen variants:

- lane card variants
- action inbox layouts
- approval drawers
- review bench panels
- dense tables
- responsive command surfaces

Do not accept v0 output blindly. Normalize it into the local component system.

### Magic Patterns, Lovable, Bolt, Replit Agent

Role: challengers.

Use these tools for short bake-offs, not as the source of truth. They are useful
for asking, "What would another frontier app builder do with this screen?"

They should not directly mutate the production repo unless their output has
passed senior review and is adapted to local conventions.

### Codex

Role: senior implementation harness.

Use Codex for:

- reading the existing codebase
- creating the React shell
- integrating the desktop API
- writing focused tests
- running Playwright and accessibility checks
- coordinating Agent Fabric worker lanes

Codex should keep the work scoped and review all generated code before it lands.

### Claude Code

Role: alternate senior harness and design/code reviewer.

Use Claude Code for:

- second-opinion UX critique
- refactor reviews
- accessibility and edge-case review
- design-system consistency review

Claude Code native helper agents do not count as Agent Fabric workers unless
they register queue-visible worker runs.

### DeepSeek Worker Lanes

Role: cheap breadth.

Use `deepseek-direct` or `jcode-deepseek` workers for:

- screen-by-screen UX critique
- task decomposition
- API contract review
- accessibility review
- visual-regression test planning
- implementation alternatives
- risk and edge-case review

Mutating workers must use `git_worktree` paths and return patch artifacts for
senior review.

### Playwright And Axe

Role: objective UI gates.

Every implemented screen must have:

- desktop screenshot
- narrow-window screenshot
- empty state
- loading state
- error state
- high-density data state
- accessibility scan

Visual approval should require screenshots, not just code review.

## Pipeline

### Phase 0: Capture Current State

Artifacts:

- current app screenshots
- current tab inventory
- current desktop API route inventory
- current feature flags from `/api/readiness`
- known pain points

Commands:

```bash
npm run build
npm test
npm run dev:desktop -- --port 4573
```

Capture at least these current states:

- no queue selected
- demo queue
- ready tasks
- active worker lanes
- pending approvals
- patch-ready task
- stale worker recovery

### Phase 1: Build The Taste Board

Use `bird` to extract recent bookmarks:

```bash
bird --plain bookmarks --all --max-pages 12 --json
```

Filter for terms such as:

```text
ui, ux, design, figma, claude, codex, opencode, agent, agents, hermes,
browser, memory, skill, mcp, session, worktree, desktop, workflow,
research vault, semantic graph, queue, parallel, review, orchestrator
```

Summarize findings as product signals, not factual claims.

The current bookmark-derived signals are:

- persistent session restoration across Claude Code, Codex, and OpenCode
- left-rail project/session management
- file tree plus git/worktree context
- central senior command/run surface
- right inspector for rendered docs, task packets, patches, or evidence
- NotebookLM-style graph and mind-map navigation
- Hermes-style skills, memory, browser harnesses, and research vaults
- human approval only at meaningful risk, cost, or patch gates

### Phase 2: Generate Design Directions

Run the same brief through at least three generators:

- Claude Design
- Stitch
- v0

Optional challengers:

- Magic Patterns
- Figma Make
- Lovable
- Bolt
- Replit Agent

Each generator must produce the same screens:

1. Command
2. Lanes
3. Map
4. Review
5. Vault

Each generator must also produce:

- desktop layout
- narrow-window layout
- primary components
- empty/error/loading states
- interaction notes
- design tokens or style guidance

### Phase 3: Senior Synthesis

Use Codex or Claude Code to compare generated outputs against this rubric:

- Can the operator understand current state in five seconds?
- Are pending decisions obvious?
- Can the UI handle 10, 20, and 50 worker lanes?
- Can the user find the next safe action?
- Does patch review feel safer than the current app?
- Does context/cost inspection become easier?
- Does memory show provenance clearly?
- Does the layout preserve Agent Fabric's substrate boundary?
- Is it dense without becoming visually noisy?
- Does it avoid decorative hero/marketing patterns?

The output of this phase is a single accepted design direction, not a merged
collage.

### Phase 4: Create The Design Constitution

Create `docs/desktop-design-system.md` or a future `DESIGN.md` with:

- product personality
- screen map
- component inventory
- layout rules
- density rules
- spacing scale
- color tokens
- status tokens
- typography rules
- interaction rules
- accessibility requirements
- screenshot acceptance rules
- forbidden patterns

This file is required context for every implementation worker.

### Phase 5: Implement A Parallel React Shell

Add a new frontend under:

```text
src/desktop/app
```

Keep the current static shell under `src/desktop/public` until the new app
passes core parity gates.

Recommended stack:

- React
- TypeScript
- Vite
- TanStack Router
- TanStack Query or a small local API layer
- Tailwind CSS v4
- shadcn/ui
- Radix primitives
- Lucide icons
- React Flow
- TanStack Table
- Monaco Editor
- Playwright
- axe accessibility checks

Do not introduce server-side rendering. This is a local desktop command center,
not a public web application.

### Phase 6: First Vertical Slice

Implement only:

- app shell
- queue/project left rail
- Command workspace
- Action Inbox
- Lanes workspace
- worker lane cards
- right inspector for selected task/lane
- real `/api/bootstrap` integration
- fake-data fixtures for visual states
- screenshot and accessibility tests

Do not implement Map, Review, or Vault until this slice is excellent.

### Phase 7: Expand By Product Differentiator

Implement in this order:

1. Map workspace
2. Review bench
3. Vault workspace
4. Plan Studio flows if they remain separate
5. native packaging

The order is intentional: graph navigation and review safety are more
product-defining than another form-based planning surface.

## Prompt Templates

### Claude Design Brief

```text
Design a professional desktop app for Agent Fabric, a local-first control plane
for supervising many coding-agent worker lanes.

The app is not a chatbot and not a SaaS marketing dashboard. It is an agent
operations cockpit for a senior engineer supervising queue-backed workers.

Use this layout direction:
- left rail for projects, queues, sessions, and saved views
- center command workbench for current queue state and next safe actions
- right inspector for selected worker, task, patch, context package, or memory
- optional graph/map workspace for queue DAGs and evidence provenance

Primary screens:
1. Command: action inbox, queue health, next safe action, active lanes
2. Lanes: live worker cards with checkpoints, files, tests, costs, artifacts
3. Map: task DAG, dependencies, path claims, memory/context refs, artifacts
4. Review: patch bench with diff, evidence, test logs, accept/retry/reject
5. Vault: memory, context packages, policies, skills, model/cost routing

Visual requirements:
- professional, dense, calm, utilitarian
- no hero page
- no decorative gradient blobs
- no nested cards
- status color only where it carries state
- 8px radius or less
- readable on laptop widths
- keyboard-driven command palette
- visible loading, empty, error, and blocked states

Produce three distinct visual directions with component notes and responsive
behavior.
```

### v0 Component Prompt

```text
Build a React + TypeScript + Tailwind component for Agent Fabric.

Component: WorkerLaneCard

Purpose:
Show one queue-visible worker lane in a desktop agent operations cockpit.

Data:
- handle, worker type, model profile, workspace mode, workspace path
- status, progress, latest checkpoint, latest event
- files touched, commands run, tests run, failing tests
- cost estimate, risk level, patch readiness, review state
- actions: open, message, request revision, open patch, retry

Style:
- dense professional tool UI
- no marketing styling
- 8px radius max
- clear status hierarchy
- fixed card dimensions that do not jump as data changes
- accessible labels and keyboard focus states

Return only the component and minimal supporting types. Do not invent backend
calls.
```

### Implementation Worker Prompt

```text
Implement the assigned Agent Fabric desktop UI slice.

Read:
- docs/desktop-ai-design-pipeline.md
- docs/desktop-redesign-brief.md
- docs/desktop-design-system.md if present
- src/runtime/desktop-server.ts
- test/desktop-server.test.ts

Scope:
Only edit the files assigned to you. Do not modify daemon semantics. Do not
replace Agent Fabric state with client-local state. Use existing desktop API
routes and add only narrow read routes if absolutely necessary.

Validation:
- npm run build
- npm test
- Playwright screenshot tests for assigned states

Output:
- changed files
- screenshots generated
- tests run
- gaps or blockers
```

### Visual Reviewer Prompt

```text
Review this Agent Fabric desktop screenshot as a senior product designer and
systems engineer.

Judge:
- five-second operator comprehension
- next-safe-action visibility
- lane density and scannability
- approval/risk clarity
- graph or review affordance clarity
- accessibility risks
- visual noise
- fidelity to the design constitution

Return:
- blocking issues
- high-value improvements
- what to keep
- screenshot-specific acceptance decision
```

## Quality Gates

An implementation slice is not done until:

- TypeScript builds
- existing tests pass
- new API code has tests
- Playwright screenshots exist for main states
- accessibility scan passes or documented exceptions exist
- no text overlaps at desktop or narrow widths
- loading, empty, error, and dense data states are designed
- the senior harness reviews generated code
- any worker patch is accepted only through a review gate

## Anti-Goals

Do not:

- make a landing page
- make the UI decorative before it is operationally clear
- hide approvals inside deep tabs
- treat worker lanes as transient chat messages
- let AI-generated code bypass local patterns
- replace Agent Fabric's durable state with browser-only state
- apply worker patches without senior review
- optimize for a public SaaS dashboard aesthetic
- build native packaging before the web shell is excellent

## First Milestone

Milestone name: `desktop-react-command-lanes`

Deliver:

- React app shell under `src/desktop/app`
- queue/project left rail
- Command workspace with real Action Inbox
- Lanes workspace with real worker cards
- right inspector
- fake fixtures for visual states
- `/api/bootstrap` integration
- Playwright screenshots

Exit criteria:

- the current static command center can remain available
- the new shell can be served locally
- a user can select a queue, see pending actions, inspect live lanes, and open a task/lane detail
- screenshots prove the UI works in empty, active, blocked, approval-heavy, and patch-ready states
