---
name: ironflow-docs
version: 0.49.0
description: |
  Ironflow reference documentation — SDK syntax, CLI commands, MCP tools, and patterns.
  Use when looking up specific API signatures, CLI flags, MCP tool names, or canonical
  code patterns. Triggers on "how do I emit", "ironflow CLI command", "MCP tool reference",
  "SDK reference", "what's the syntax for", "show me the docs for".
  Other Ironflow skills delegate here when they need reference content.
  NOT for writing application workflows (use ironflow-code).
  NOT for debugging runtime issues (use ironflow-ops).
user-invocable: true
argument-hint: "[topic] — e.g., 'step.run syntax' or 'CLI emit command'"
allowed-tools: Read, Grep, WebFetch
---

# Ironflow Reference

The Ironflow docs site is the only source of reference facts. This skill tells you which
page to fetch. Each URL returns one page as Markdown. Reference lookups need network access.

## How to look something up

1. Find the topic in the table below and fetch its URL. Use `WebFetch`; in Ironflow
   Desktop's built-in agent, use `docs_fetch`; it takes the full URL or the path after the host.
2. If no topic matches, fetch `https://docs.ironflow.run/llms.txt`. It lists every page
   with a one-line description. Pick the page and fetch its `.md` URL.
3. Fetch only the pages you need. Do not fetch `llms-full.txt` unless the user asks for
   the whole site.

## Topics

| Topic | URL | When |
|-------|-----|------|
| CLI commands | https://docs.ironflow.run/reference/cli.md | `ironflow` commands and flags; links to one page per command |
| MCP tools | https://docs.ironflow.run/reference/mcp-tools.md | Tool names, modes, the flags that enable them |
| TypeScript SDK (Node) | https://docs.ironflow.run/reference/js-sdk/node.md | TS functions, projections, workers, KV, config, files |
| TypeScript SDK (shared types) | https://docs.ironflow.run/reference/js-sdk/core.md | Types and helpers shared by the Node and browser packages |
| Go SDK | https://docs.ironflow.run/reference/api/go-sdk.md | Go functions, projections, workers, files |
| Python SDK | https://docs.ironflow.run/reference/api/python-sdk.md | Python pull workers, push handlers, durable steps, files |
| Design patterns | https://docs.ironflow.run/explanation/patterns.md | Push vs pull, CQRS, aggregates, sagas, concurrency, snapshots |
| Pitfalls | https://docs.ironflow.run/explanation/ai-pitfalls.md | Things that break at runtime, with wrong/right code |
| Design diagrams | `diagrams.md` (this skill) | Drawing a design proposal for the user |

## Cross-skill use

Other Ironflow skills link to the URLs above directly. Never copy reference content into a
skill: link to the docs page.
