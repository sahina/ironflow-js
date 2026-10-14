---
name: ironflow-docs
version: 0.44.0
description: |
  Ironflow reference documentation — SDK syntax, CLI commands, MCP tools, and patterns.
  Use when looking up specific API signatures, CLI flags, MCP tool names, or canonical
  code patterns. Triggers on "how do I emit", "ironflow CLI command", "MCP tool reference",
  "SDK reference", "what's the syntax for", "show me the docs for".
  Other Ironflow skills delegate here when they need reference content — read the relevant
  topic file directly via Read instead of invoking this skill, when possible.
  NOT for writing application workflows (use ironflow-code).
  NOT for debugging runtime issues (use ironflow-ops).
user-invocable: true
argument-hint: "[topic] — e.g., 'step.run syntax' or 'CLI emit command'"
allowed-tools: Read, Grep, WebFetch
---

# Ironflow Reference

Knowledge bundle for Ironflow SDK, CLI, MCP, and patterns. Each topic carries a minimal
inline example for the common case + a URL to the full hosted docs for depth.

> **Path convention.** Scripts are named relative to this skill's own directory — your
> harness names that directory when it loads the skill, and a packaged skill serves them as
> readable resources rather than executable files. Reference files in ANOTHER skill are
> shown as `~/.agents/skills/<skill>/...` (global install); if that path does not resolve,
> activate that skill by name instead of guessing at a prefix.

## Topic Index

| Topic | File | When to load |
|-------|------|--------------|
| TypeScript SDK | `sdk-typescript.md` | Writing TS functions, projections, workers, KV, config, files |
| Go SDK | `sdk-go.md` | Writing Go functions, projections, workers, files |
| Python SDK | `sdk-python.md` | Writing Python pull workers, push handlers, durable steps and files |
| CLI commands | `cli.md` | `ironflow` binary commands and flags |
| MCP tools | `mcp.md` | MCP tool names, parameters, read-only vs write modes |
| Patterns | `patterns.md` | Canonical code patterns (sagas, webhooks, upcasters) |
| Design diagrams | `diagrams.md` | Visual design proposals for component relationships, execution ordering, or lifecycles |
| Anti-patterns | `anti-patterns.md` | Things to avoid — what breaks at runtime |

## How to Use This Skill

1. Identify which topic the user (or invoking skill) needs.
2. Read the topic file: `Read <topic>.md`
3. The topic gives you the inline happy-path example.
4. For depth, edge cases, or full API coverage, follow the URL at the bottom of the topic
   file via `WebFetch` to fetch the hosted docs.

## Cross-Skill Reference Pattern

Other Ironflow skills reference these topics by their full path under this skill's directory —
`ironflow-code` and `ironflow-ops` both carry the form in their Reference Files block. A topic
file is a resource of THIS skill's directory, not of the calling skill's, so a caller cannot
reach it with a relative path.

If the path does not resolve, activate `ironflow-docs` by name rather than guessing a prefix.

Do not duplicate reference content in workflow skills. Always defer to docs.
