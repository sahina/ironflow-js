# Audit

### Step 1: Run the scanner

```bash
scripts/audit-scan.sh <directory>
```

Relative to this skill's own directory, which your harness names when it loads the skill.
Output is `file:line:severity:rule:message` format. The script greps for known
anti-patterns: 18 TypeScript rules and 4 Go rules (`missing-recording`, `hardcoded-url`,
`PROJ-DET-002`, `PROJ-DET-003`) — Go code gets no coverage for side-effects, yielding
steps, `expectedVersion`, idempotency, webhooks or upcasters; review those by hand.

If the script cannot be executed — a packaged skill is served as readable resources, not
as files on disk — read `scripts/audit-scan.sh` as a skill resource and apply its patterns with the
search tools instead. Keep the rule names it uses so the report matches scanner output;
classify each hit against `https://docs.ironflow.run/explanation/ai-pitfalls.md` by topic (the sections are numbered, not keyed by rule ID).

### Step 2: For each finding, classify

Fetch `https://docs.ironflow.run/explanation/ai-pitfalls.md` and read the relevant section for the
detailed why and fix.

The scanner is a grep heuristic and says so — `missing-expectedversion` counts parens,
`side-effect-outside-step` cannot see that a helper module is only ever called from
inside `step.run()`. When a finding is genuinely wrong, annotate the line rather than
contorting the code around the scanner:

```ts
// audit-ignore: side-effect-outside-step — this is the HTTP client itself, not a
// handler body; its callers wrap it in step.run().
await fetch(url);
```

The pragma goes on the flagged line, or in the `//` or JSDoc block directly above it
(a single-line `/* ... */` is not recognised). Naming the rule is mandatory, so it
cannot silence a different finding that later lands on the same line. For a multi-line
call, put it above the line the scanner actually reports — that is the line the call
*starts* on.

Fix real findings; reserve the pragma for false positives, and always write the why.

### Step 3: Generate report

```markdown
## Ironflow Audit Report

**Scope:** src/functions/, src/projections/
**Files scanned:** N
**Findings:** X critical, Y warnings, Z info

### Critical Issues

1. **Side effects outside steps** — src/functions/process-order.ts:15
   `db.users.find()` outside `step.run()` — re-executes on every retry
   Fix: wrap in `step.run("fetch-user", ...)`

### Warnings

2. **Missing recording flag** — src/functions/process-order.ts:3
   No `recording: true` — time-travel debugging unavailable

### Info

3. **Hardcoded URL** — src/infrastructure/client.ts:5
   `http://localhost:9123` hardcoded — use `process.env.IRONFLOW_SERVER_URL`
```

### Step 4: Offer fixes

> "Want me to fix these? I can:
> - Apply all fixes in one pass
> - Apply only critical fixes
> - Walk through each one with explanation"

Then read [write-code.md](write-code.md) before switching to Write Code mode for the chosen scope.

---

## Common Mistakes Quick Lookup

For the full anti-pattern reference: fetch `https://docs.ironflow.run/explanation/ai-pitfalls.md`.

**Mechanical — top 5 by impact:**
1. Side effects outside `step.run()` — duplicate operations on retry
2. Non-unique step IDs in loops — only first iteration runs
3. Impure managed projections — break rebuild
   - 3a. Non-deterministic managed reducer (`Date.now()`, `Math.random()`, `time.Now()`, `os.Getenv`) — rebuild diverges from live
   - 3b. Mutating state arg then returning it — aliasing hazard; return a fresh object
4. Polling `getProjection()` from browser — use `subscribeToProjection`
5. Yielding step in a `try/catch` or a `.catch()` chain — the catch eats the
   `YieldSignal`, so the run "completes" without ever waiting (and a null check
   never fires either)

**CQRS-semantic — top 5 by impact:**
1. CRUD-named events (`UserUpdated`) — intent erased, consumers write defensive diffs
2. Querying entity streams for display data — couples UI to write model
3. Anemic aggregates — invariants leak into reactors, get enforced too late
4. Fat events carrying full entity state — projections can't cleanly re-derive
5. Command vocabulary on event names (`OrderPlace` instead of `OrderPlaced`) — breaks
   "event = fact" invariant

The audit scanner (`audit-scan.sh`) flags mechanical issues by regex. CQRS-semantic
issues require **reading** the code — during Mode 3 audit, after the scanner runs,
look for these five by hand: grep for event-name constants and check tense; grep for
`streams.read` or `streams.getInfo` in rendering/API code; check whether business rule
violations throw from deciders or from reactors.

