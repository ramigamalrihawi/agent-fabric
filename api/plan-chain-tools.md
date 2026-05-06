# API — Plan-chain MCP tools

These tools implement the durable control plane for ADR-0014's A -> B -> C -> A-critique workflow. They do **not** call models themselves. A model-calling orchestrator or an agent drives model calls, then records each revision/critique here so the daemon owns state, audit, idempotency, human questions, and accepted-plan memory writes.

All mutating tools require the bridge/session idempotency key described by the
bridge/session protocol. The original ADR note may exist in the local ignored
`decisions/` directory, but public API docs must be usable without it.

## `plan_chain_start`

Start a chain in state `drafting_a`.

**Input:**
```ts
{
  task: string;
  models?: { a?: string; b?: string; c?: string };  // defaults: plan.strong / improve.cheap / improve.cheap
  maxRounds?: number;                               // default 3
  budgetUsd?: number;                               // default 5
  outputFormat?: "markdown" | "adr";                // default markdown
  showLineageToA?: boolean;                         // default false
}
```

**Output:**
```ts
{ chainId: string; round: 1; status: "drafting_a" }
```

## `plan_chain_record_revision`

Record one model-generated plan revision. The daemon enforces the current state:

- `a_draft` only while `drafting_a`
- `b_improve` only while `drafting_b`
- `c_improve` only while `drafting_c`

**Input:**
```ts
{
  chainId: string;
  step: "a_draft" | "b_improve" | "c_improve";
  body: string;
  model?: string;
  round?: number;                       // must match the chain's current round
  changeLog?: unknown;
  confidence?: number;
  leastConfidentAbout?: unknown;
  costUsd?: number;
  traceId?: string;
  questionsForUser?: {
    severity: "blocking" | "preference";
    body: string;
  }[];
  questionRecipient?: string;            // default "*"; used for blocking collab asks
}
```

**Output:**
```ts
{
  revisionId: string;
  chainId: string;
  round: number;
  step: "a_draft" | "b_improve" | "c_improve";
  state: "drafting_b" | "drafting_c" | "critiquing_a" | "awaiting_user";
  haltReason?: "budget" | "converged";
  questionsRaised: number;
}
```

Blocking questions pause the chain at `awaiting_user` and create a linked `collab_ask`/`tasks` row. Preference questions are recorded but do not pause unless another hard halt applies.

## `plan_chain_record_critique`

Record A's closing critique. The daemon accepts this only while the chain is `critiquing_a`, then moves to `awaiting_user` for the human accept/abandon/another-round decision.

**Input:**
```ts
{
  chainId: string;
  body: string;
  structured: {
    chainImprovedMyOriginal?: "yes" | "no" | "mixed";
    chain_improved_my_original?: "yes" | "no" | "mixed";
    lostFromV1?: string[];
    lost_from_v1?: string[];
    valuablyAdded?: string[];
    valuably_added?: string[];
    wouldSignOff?: boolean;
    would_sign_off?: boolean;
    wouldSignOffReason?: string;
    would_sign_off_reason?: string;
    confidence?: number;
  };
  reviewingRevisionId?: string;          // defaults to latest revision in the round
  model?: string;                        // defaults to models.a
  round?: number;                        // must match current round
  costUsd?: number;
  traceId?: string;
}
```

**Output:**
```ts
{
  critiqueId: string;
  chainId: string;
  round: number;
  state: "awaiting_user";
  haltReason?: "a_signoff" | "budget";
}
```

## `plan_chain_answer_question`

Answer a blocking or preference question. If this resolves all blocking questions for an `awaiting_user` chain, the daemon resumes to the next state implied by the latest revision.

**Input:**
```ts
{ questionId: string; answer: string }
```

**Output:**
```ts
{
  questionId: string;
  chainId: string;
  state: string;
  unansweredBlockingQuestions: number;
}
```

If the question created a linked collab ask, the ask becomes `answered` and its task becomes `completed`.

## `plan_chain_decide`

Human decision gate after critique or hard halt.

**Input:**
```ts
{
  chainId: string;
  decision: "accept" | "abandon" | "another_round";
  writeMemory?: boolean;                 // default true on accept
}
```

**Output on accept:**
```ts
{
  chainId: string;
  finalPlanRef?: string;                 // memory id
  costSummary: { totalSpentUsd: number; budgetUsd: number; remainingUsd: number };
  memoryWritten?: { id: string; status: "pending_review" };
}
```

Accepting writes the latest plan body as a `procedural` memory with `source = "user-confirmed-plan"` and `status = "pending_review"`. `another_round` starts at `drafting_b` and is refused when `maxRounds` has been reached or the chain has a hard halt (`a_signoff`, `budget`, or `converged`).

## `plan_chain_status`

Return chain state, revisions, critiques, questions, spend, halt reason, and final memory id.

**Input:**
```ts
{ chainId: string }
```

## `plan_chain_explain`

Return the causal trace for the chain: status plus outbox events and audit rows for the chain, revisions, critiques, and questions.

**Input:**
```ts
{ chainId: string }
```
