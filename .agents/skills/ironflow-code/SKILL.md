---
name: ironflow-code
version: 0.54.0
description: |
  Build Ironflow components — write functions, projections, workers, entity streams,
  webhooks, sagas, plus generate tests and audit existing code for anti-patterns.
  Triggers on: "write a function", "create a projection", "add a worker", "implement saga",
  "build a workflow", "write tests for", "add tests for", "test coverage for",
  "audit my code", "review my ironflow", "check anti-patterns".
  NOT for setup/scaffolding (use ironflow-start).
  NOT for runtime debugging (use ironflow-ops).
  NOT for SDK reference lookup (use ironflow-docs).
user-invocable: true
argument-hint: "[what to build, test, or audit] — e.g., 'a function that processes orders'"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Ironflow Code

Workflow for writing Ironflow components, generating tests, and auditing for anti-patterns.
This skill encodes the *process*. SDK syntax lives in `ironflow-docs`.

> **Path convention.** Scripts are named relative to this skill's own directory — your
> harness names that directory when it loads the skill, and a packaged skill serves them as
> readable resources rather than executable files. Reference files in ANOTHER skill are
> shown as `~/.agents/skills/<skill>/...` (global install); if that path does not resolve,
> activate that skill by name instead of guessing at a prefix.

## Reference Files

When you need SDK syntax, fetch these pages instead of guessing:

```
https://docs.ironflow.run/reference/js-sdk/node.md
https://docs.ironflow.run/reference/api/go-sdk.md
https://docs.ironflow.run/reference/api/python-sdk.md
https://docs.ironflow.run/explanation/patterns.md
https://docs.ironflow.run/explanation/ai-pitfalls.md
```

## Workflow Selection

Match the user's intent, then **read the chosen file before acting**:

| Intent | Mode | Read |
|---|---|---|
| "write/create/add/implement/build" | **Write Code** | [write-code.md](write-code.md) |
| "test/coverage/spec" | **Generate Tests** | [generate-tests.md](generate-tests.md) |
| "audit/review/check anti-patterns" | **Audit** | [audit.md](audit.md) |

Load only the relevant mode, not all three. These files are relative to this skill's
own directory; use readable skill resources when packaged. If ambiguous, ask once.
When switching modes, read the target file before continuing.

---

**Next:** After writing code, you may need:
- `/ironflow-start` — set up entry points (worker, serve handler)
- `/ironflow-ops` — debug runtime failures
- `/ironflow-docs` — look up specific SDK syntax
