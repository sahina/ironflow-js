---
name: ironflow-fit
version: 0.48.0
description: |
  Analyze a codebase or workspace and produce a visual HTML report on whether and where
  Ironflow fits — event-driven readiness, ranked opportunities with file:line evidence,
  and an honest adoption path for the detected stack. Works on Java/Spring, C#/.NET,
  Python, Rust, Node/TypeScript and Go, one project or many.
  Triggers on: "where can we use ironflow", "does ironflow fit", "ironflow fit",
  "fit my app", "analyze my codebase", "ironflow readiness", "should we use ironflow",
  "should I use ironflow", "assess my projects", "is ironflow right for us".
  NOT for setting up or installing Ironflow (use ironflow-start).
  NOT for writing application code (use ironflow-code).
  NOT for runtime debugging or deployment (use ironflow-ops).
  NOT for SDK reference lookup (use ironflow-docs).
user-invocable: true
argument-hint: "[directory] — defaults to the current directory"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Ironflow Fit

Produces one self-contained HTML report answering "should we use Ironflow, and
where?" for a codebase the reader owns.

> **Path convention.** Scripts are named relative to this skill's own directory — your
> harness names that directory when it loads the skill, and a packaged skill serves them as
> readable resources rather than executable files. Reference files in ANOTHER skill are
> shown as `~/.agents/skills/<skill>/...` (global install); if that path does not resolve,
> activate that skill by name instead of guessing at a prefix.

## Who this is for

Engineers who have not adopted event-driven architecture and are not sure the
idea applies to them. They are skeptical, and they are right to be. **The report
must be able to say no.** A report that always finds a fit is a sales instrument,
and this audience detects one in about thirty seconds.

## Reference files

```
detect-java.md        signal interpretation per stack
detect-dotnet.md
detect-python.md
detect-rust.md
detect-node.md
detect-go.md
readiness.md          the 7-item checklist + scoring
adoption-paths.md     SDK tiers, honestly; snippet rule
report-template.html  the output shell
```

Snippets come from the docs pages listed in the `ironflow-docs` skill — fetch the topic URL. **Never
invent Ironflow API surface.** A wrong snippet in a vendor report is worse than no
snippet.

For anything about non-Go/TS adoption, the published docs are the source and the
report should **link rather than restate**:

```
https://docs.ironflow.run/how-to-guides/integration/other-languages/
                       client generation, registration, push mode, known gaps
https://docs.ironflow.run/reference/api/push-protocol/
                       the full push wire contract
https://docs.ironflow.run/reference/sdk-comparison/
                       the tier model
```

## Run it

This skill runs **autonomously**. Do not interview the user first — in a workshop,
twenty people cannot each hold a conversation, and a report derived from code
alone is more credible. The interview is inverted to the end of the report.

### Step 1 — Scan

```bash
scripts/scan.sh <directory>
```

Relative to this skill's own directory, which your harness names when it loads the skill.
If the script cannot be executed — a packaged skill is served as readable resources, not
as files on disk — read `scripts/scan.sh` as a skill resource and apply its patterns with the
search tools instead. Emit the same signal IDs either way — `detect-<stack>.md` interprets those IDs, so a
hand-run scan that invents its own labels cannot be read by the next step.

Default the directory to `.` when no argument was given. Output is TSV: project
roots, signal hits with `file:line`, infrastructure config, readiness probes, and
scale. The script owns every regex — do not write your own greps unless you are
chasing a specific file the scan already pointed at.

### Step 2 — Read the interpretation

For each stack the scan found, read the matching `detect-<stack>.md`. It maps
signal IDs to meaning, to what breaks today, to the Ironflow equivalent, and to a
weight. **Honor the combination rules** in each file — several signals are
deliberate over-reporters that only mean something in intersection.

Open the actual files behind the strongest hits. The scan gives you a line; the
report needs to be right about what that line does.

### Step 3 — Score readiness

Follow `readiness.md`. Seven rows, red/amber/green, each from cited evidence.
Never score green on absence of evidence.

### Step 4 — Decide the verdict

Four paths. Pick by the rules, not by feel.

| Verdict | Trigger condition | `VERDICT_CLASS` |
|---|---|---|
| **Strong fit** | At least one candidate with 2 or more **independent** cited signals — see the definition below | *(empty)* |
| **Possible** | Only single-signal candidates | *(empty)* |
| **Not a fit** | No async work, no retry code, no scheduled work, no cross-service writes | `no` |
| **Already doing EDA** | Any `*.broker-consumer` signal hit | `eda` |

### What "independent" means

This is where the verdict is won or lost, so it is defined rather than left to
judgement.

Two signals are independent only if they describe **different concerns**, not the
same concern seen twice. Signals are **not** independent when:

- They sit on the same code path. A `@shared_task` and the `.delay()` that calls
  it are one feature, not two. Same for a Hangfire `RecurringJob` and the method
  it schedules.
- One is the definition and the other the use site of the same thing.
- They are all *supporting* weight. Two supporting signals never make a strong
  fit; a strong fit needs at least one signal the detect file weights **strong**.

The concrete trap: a Django app with one Celery task that sends a welcome email
fires `python.scheduled`, `python.fire-and-forget`, and `python.status-column` —
three signal IDs, one feature, and the honest verdict is **possible**. One
background task does not justify a platform. `tests/fixtures/django-marginal`
exists to catch exactly this, and if you return "strong fit" on it, the
calibration is broken.

Ask before promoting a candidate: *if this team fixed only this, would they still
want a durable execution engine?* If no, it is possible, not strong.

### Hard rules

1. **A candidate with no `file:line` citation is dropped, not softened.**
2. **The "Where Ironflow does not help" section is mandatory** and populated from
   real findings. If you cannot fill it, you have not looked hard enough.
3. **If nothing scores above *possible*, the report opens with that verdict and
   stops after the not-a-fit section.** Skip opportunities, skip snippets. Say
   what would have to change for the answer to be different.
4. **Already doing EDA changes the pitch, not the volume.** They have the pattern
   and are missing durability, replay, and a queryable run history. Do not tell a
   team with `@KafkaListener` that they should consider events.

### Step 5 — Adoption path

Read `adoption-paths.md` and write the section for the detected primary stack. It
goes **before** the opportunities. State all three tiers including the parts that
are not good news. For Tier-2 stacks, link `other-languages.md` and
`push-protocol.md` rather than reproducing them, and include the warning against
building a pull worker on the generated client — phrased as **unsupported, not
undocumented**, since the rules are published.

### Step 6 — Rank and write opportunities

Cap at **5**. Rank by evidence of pain — retry blocks, status columns,
reconciliation crons, timeout config — not by architectural elegance. Everything
else goes in the compact "Also noticed" table.

Each opportunity card carries: what they have (with `file:line`), what breaks
today, the Ironflow equivalent, and effort (low/medium/high).

The **top two candidates get a two-sided snippet** per the snippet rule in
`adoption-paths.md`. Below that, add one only where code says something prose
cannot — a card whose recommendation is "delete this" does not need a snippet,
and padding every card with code makes the report longer without making it
clearer — their language on their
side, TypeScript on the orchestration side, framed as *"your services stay
<language>; this is the orchestration file that sequences them."* For Node and Go
readers this collapses to one snippet.

### Step 7 — Draw the diagram

One inline SVG, drawn from **their own service names** taken from the scan's
`infra` section. This is the element that does the real teaching for a reader who
does not know event-driven architecture — a generic illustration wastes it.

Two stacked panels: the synchronous chain you found, with the failure point
marked, above the same named services decoupled through Ironflow.

Rules, per the repository's diagram convention:

- Structural strokes and text use `currentColor` so the diagram follows the theme.
- Accent colors are literal hex: `#D97757` for the Ironflow path, `#B4503C` for
  the failure marker.
- **No blank lines anywhere inside the `<svg>` element.**
- `viewBox` plus `width="100%"`, and a real `role="img"` + `aria-label`.

Skeleton to adapt:

```html
<svg viewBox="0 0 800 300" width="100%" role="img" aria-label="..."><text x="12" y="18" font-size="11" fill="currentColor" opacity="0.7">TODAY — synchronous</text><rect x="12" y="30" width="150" height="46" rx="6" fill="none" stroke="currentColor"/><text x="87" y="58" text-anchor="middle" font-size="13" fill="currentColor">orders</text><line x1="162" y1="53" x2="228" y2="53" stroke="currentColor" stroke-width="1.5"/><text x="195" y="45" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">HTTP</text><rect x="230" y="30" width="150" height="46" rx="6" fill="none" stroke="#B4503C"/><text x="305" y="58" text-anchor="middle" font-size="13" fill="currentColor">inventory</text><text x="305" y="92" text-anchor="middle" font-size="10" fill="#B4503C">fails here, order stranded</text></svg>
```

If the scan found no cross-service edges, draw the in-process call chain from the
strongest candidate instead. Same two panels.

### Step 8 — Render

Read `report-template.html`, fill every `{{PLACEHOLDER}}`, and write to:

```
ironflow-fit-<repo>-YYYY-MM-DD.html
```

in the current directory. Self-contained: no CDN, no external fonts, no build
step. Target 6–10 printed pages.

**On the not-a-fit path, delete these sections from the output entirely** rather
than filling them with apologies: *Your adoption path*, *Your architecture today*,
*Where Ironflow helps most*, *Also noticed*, *Before you start*. What remains —
verdict, what was scanned, readiness, where it does not help, three questions —
is the whole report, and it should read as a complete document rather than a
truncated one. Keep the readiness table: it is the most useful thing a team that
does not need Ironflow will get from this.

Verify before you hand it over: no `{{` remains anywhere in the file, and no
`<link>`, `<script>` or `<img>` points at anything external.

### Step 9 — Report back

Print the file path. Then print the same three questions the report ends with,
and offer a second pass. Do not summarize the whole report into chat — the file
is the deliverable.

## Edge cases

- **Ironflow is already installed** (`@ironflow/node`, `@ironflow/browser`,
  `ironflow-go`, `ironflow-py`, an `ironflow` binary, or an `ironflow.yaml`). Say so up front and
  ask whether they want a usage review (`ironflow-code` audits anti-patterns) or a
  fit analysis of the parts *not* yet using it. Do not write a report that pitches
  something they already run.
- **No codebase** — nothing to scan. Do not produce a report. Ask what they are
  building and answer conversationally.
- **Unrecognized stack** (Ruby, PHP, Kotlin, Scala, anything else). Say so, run the
  readiness checklist, which is language-neutral, and ask the three questions. Do
  not guess at signals you cannot detect.
- **A repo that is mostly configuration or documentation** with little source. Say
  the scan found too little to judge rather than scoring seven readiness rows from
  nothing.

## What this skill does not do

- No AST parsing. Grep and config reads only.
- No code execution, no builds, no dependency installs, no network calls.
- No edits to the analyzed repository. The report is the only file written.
- Ruby, PHP, Kotlin, and Scala are not detected. If the stack is unrecognized,
  say so, run the readiness checklist (which is language-neutral), and ask the
  three questions instead of guessing.

## Next

- Setting it up for real → `ironflow-start`
- Writing the first function → `ironflow-code`
- Syntax while reading the snippets → `ironflow-docs`
