#!/usr/bin/env bash
# Scan Ironflow code for anti-patterns. Output format: file:line:severity:rule:message
#
# Usage: audit-scan.sh [directory]
#   directory defaults to "src" (TypeScript) or "." (mixed/Go)
#
# Severity:
#   CRITICAL — data corruption / runtime failure
#   WARNING  — operational issues, debugging pain
#   INFO     — code quality
#
# Path skip rules (Ironflow rules don't apply inside these files):
#   **/app/**/page.tsx       — Next.js server/client demo pages, not function handlers
#   **/app/**/route.ts       — Next.js Route Handlers: HTTP endpoints that emit or
#                              mount serve(), never a durable handler body.
#                              Skipped only when the file calls no createFunction().
#   **/components/**/*.tsx   — React components (incl. shadcn ui/** boilerplate)
#   **/components/**/*-provider.tsx — React lifecycle wrappers
#   **/scripts/verify-*.ts   — assertion scripts run from the shell, directly in
#                              scripts/ only. Deliberately NOT all of scripts/
#                              and not nested subtrees: that directory is a
#                              naming convention, not a framework location, and
#                              a scripts/backfill.ts (or scripts/verify-x/y.ts)
#                              holding a real handler must stay covered.
#
# This is a heuristic grep scanner. False positives possible. Always review findings.
#
# Per-line exception:
#   // audit-ignore: <rule> — <why this line is correct as written>
# on the flagged line, or in the `//` or JSDoc (`/** ... */`) comment block
# directly above it. A single-line `/* ... */` is NOT recognised. Naming the
# rule is mandatory, so the pragma cannot silence a different finding that later
# lands on the same line. See suppress().
#
# Known limitations:
#   - missing-expectedversion uses paren counting; parens inside string
#     literals (e.g. `streams.append(id, { msg: ")" }, { expectedVersion })`)
#     will trip the counter and produce a false positive. Full JS tokenizing
#     is out of scope for a bash heuristic. False positives are recoverable,
#     false negatives (missed concurrency bugs) are not — scanner errs on the
#     side of flagging.

set -uo pipefail

DIR="${1:-}"
if [ -z "$DIR" ]; then
  if [ -d "src" ]; then
    DIR="src"
  else
    DIR="."
  fi
fi

if [ ! -d "$DIR" ]; then
  echo "Error: directory not found: $DIR" >&2
  exit 1
fi

# Collect TS and Go files (skip node_modules, vendor, build artifacts).
# .ironflow/ is engine runtime state (gitignored): a desktop agent workspace
# there holds third-party skill sources that are not the example's code.
# Use null-delimited output so paths with spaces are handled correctly.
TS_FILES_LIST=$(mktemp)
GO_FILES_LIST=$(mktemp)
trap 'rm -f "$TS_FILES_LIST" "$GO_FILES_LIST"' EXIT

find "$DIR" -type f \( -name "*.ts" -o -name "*.tsx" \) \
  -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/build/*" \
  -not -path "*/.ironflow/*" \
  -print0 2>/dev/null \
  | while IFS= read -r -d '' p; do
      # Skip files that are not function handlers — the rules below (chiefly
      # side-effect-outside-step) presume a durable handler body, and there is
      # no step.run() to wrap anything in outside one. Match path segments:
      #   */app/.../page.tsx        — Next.js pages at any depth under app/
      #   */app/.../route.ts        — Next.js Route Handlers. These emit events
      #                               or mount serve(); the handler bodies they
      #                               dispatch to live in worker.ts / lib/. A
      #                               proxy route's `await fetch` is the whole
      #                               point of the file, not a durability bug.
      #                               Skipped ONLY when the route registers no
      #                               function of its own — an inline
      #                               createFunction() there is a real handler
      #                               and stays covered.
      #   */components/...          — React component tree
      #   */scripts/verify-*.ts     — shell-run assertion scripts, and only a
      #                               verify-*.ts sitting DIRECTLY in scripts/.
      #                               Scoped this tightly on purpose: scripts/
      #                               is a naming habit, not a framework
      #                               contract, so a scripts/backfill.ts (or a
      #                               scripts/verify-foo/handler.ts) that really
      #                               does define a handler stays covered.
      #
      # Note both narrow cases below: bash `case` globs let `*` span `/`, so
      # `*/scripts/verify-*.ts` on its own would swallow a whole subtree.
      case "$p" in
        */app/*/page.tsx|*/app/page.tsx) continue ;;
        */app/*/route.ts|*/app/route.ts)
          grep -q "createFunction[[:space:]]*(" "$p" 2>/dev/null || continue
          ;;
        */components/*) continue ;;
        */scripts/verify-*.ts)
          # Strip through the last "/scripts/": a remaining "/" means the file
          # is nested below scripts/, not a verify script sitting in it.
          case "${p##*/scripts/}" in
            */*) ;;
            *) continue ;;
          esac
          ;;
      esac
      printf '%s\0' "$p"
    done > "$TS_FILES_LIST" || true
find "$DIR" -type f -name "*.go" \
  -not -path "*/vendor/*" -not -path "*/.ironflow/*" \
  -print0 2>/dev/null > "$GO_FILES_LIST" || true

emit() {
  # emit file:line:severity:rule:message
  echo "$1:$2:$3:$4:$5"
}

suppress() {
  # Filter findings on stdin, dropping any whose flagged line — or the
  # contiguous comment block directly above it — carries
  #   audit-ignore: <rule> — <why this line is correct as written>
  #
  # Applied to whole-scan output rather than inside emit(), because several
  # rules (streams.append, projection determinism, upcasters) print from awk
  # and never reach emit(). One filter, every rule.
  #
  # Naming the rule is mandatory, so a pragma cannot silence a different finding
  # that later lands on the same line. The walk stops at the first non-comment
  # line, so a pragma cannot reach across code it does not touch.
  local file line sev rule msg start
  while IFS=: read -r file line sev rule msg; do
    # A path containing ":" shifts every field, so `line` is not trustworthy
    # input. Never let it reach $(( )) unchecked: bash arithmetic performs
    # command substitution, so a file named `a:x[$(rm -rf ~)0]:y.ts` would
    # EXECUTE that command here. Fail open on suppression — emit the finding
    # unchanged — because a finding we cannot place is one we must not drop.
    case $line in
      '' | *[!0-9]*)
        printf '%s:%s:%s:%s:%s\n' "$file" "$line" "$sev" "$rule" "$msg"
        continue
        ;;
    esac
    start=$(( line - 1 ))
    [ "$start" -lt 1 ] && start=1
    # `//` and `/* *` only. NOT `#` — in TypeScript that leads a private class
    # field (`#url = ...`), and treating one as a comment lets a pragma reach
    # across it to suppress a finding its justification never covered.
    while [ "$start" -gt 1 ] &&
      sed -n "${start}p" "$file" 2>/dev/null | grep -qE '^[[:space:]]*(//|\*)'; do
      start=$(( start - 1 ))
    done
    # The loop stops ON the first non-comment line. Step past it, or a trailing
    # `// audit-ignore` on a line of code would reach findings below it.
    sed -n "${start}p" "$file" 2>/dev/null | grep -qE '^[[:space:]]*(//|\*)' ||
      start=$(( start + 1 ))
    [ "$start" -gt "$line" ] && start=$line
    # Anchor the trailing edge: without it a pragma naming a longer rule that
    # merely starts with this one (a future `missing-recording-go`) would
    # silence its prefix (`missing-recording`).
    if sed -n "${start},${line}p" "$file" 2>/dev/null |
      grep -qE "audit-ignore:[[:space:]]*${rule}([^A-Za-z0-9_-]|\$)"; then
      continue
    fi
    printf '%s:%s:%s:%s:%s\n' "$file" "$line" "$sev" "$rule" "$msg"
  done
}

scan_ts() {
  local file="$1"

  # CRITICAL: side effects outside step.run (heuristic — await fetch/db/axios/prisma
  # not inside a .run() callback). Deliberately unanchored: the common real-world
  # shape is `const user = await db.users.find(...)`, not a bare `await` statement,
  # and an `^\s*` anchor misses every assigned await.
  #
  # Membership is decided by PAREN DEPTH from the `.run(` call, not by a fixed
  # lookback window. The old 3-line lookback reported every I/O line past the third
  # in a longer step body — the exact false positive that trains people to ignore
  # the scanner. `.run(` rather than `step.run(` so the scoped clients that
  # step.parallel/step.map hand to a branch (`s.run(...)`) count too.
  #
  # Parens are counted on the line with STRING LITERALS REMOVED. Counting them raw
  # is how a paren-depth rule fails unsafe: one `logger.info("done (partial")` inside
  # a step body leaves depth permanently above 0, `inrun` sticks for the rest of the
  # file, and every later finding is silently suppressed. The same hazard is called
  # out at the top of this file for streams.append, where it only cost a false
  # positive; here it would cost every real one.
  awk '
    function strip_strings(s,   out, i, c, q) {
      out = ""; q = ""
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (q != "") {
          if (c == "\\") { i++; continue }
          if (c == q) q = ""
          continue
        }
        if (c == "\"" || c == "'"'"'" || c == "`") { q = c; continue }
        out = out c
      }
      return out
    }
    function count_char(s, ch,   n, i) {
      n = 0
      for (i = 1; i <= length(s); i++) if (substr(s, i, 1) == ch) n++
      return n
    }
    $0 ~ /^[[:space:]]*(\/\/|\*)/ { next }
    {
      line = $0
      code = strip_strings($0)
      if (!inrun && match(code, /[A-Za-z0-9_$]\.run[[:space:]]*\(/)) {
        rest = substr(code, RSTART + RLENGTH - 1)
        inrun = 1
        depth = count_char(rest, "(") - count_char(rest, ")")
        if (depth <= 0) inrun = 0
        next
      }
      if (inrun) {
        depth += count_char(code, "(") - count_char(code, ")")
        if (depth <= 0) inrun = 0
        next
      }
      if (line ~ /await[[:space:]]+(fetch|axios|db\.|prisma\.|knex\.)/)
        print FILENAME":"NR":CRITICAL:side-effect-outside-step:I/O appears outside step.run()"
    }
  ' "$file" 2>/dev/null

  # CRITICAL: step.run() with a constant ID inside a loop. Duplicate step IDs are
  # memoized, so every iteration after the first returns the first one's cached
  # output. A correct ID varies per item — a template literal or an index — so
  # only plain double-quoted strings (no ${...}) are flagged.
  awk '
    $0 ~ /^[[:space:]]*(\/\/|\*)/ { next }
    {
      if (!inloop && ($0 ~ /(^|[^A-Za-z0-9_])(for|while)[[:space:]]*\(/ || $0 ~ /\.(forEach|map)\(/)) {
        inloop=1; depth=0; opened=0
      }
      if (inloop) {
        if ($0 ~ /\.run\([[:space:]]*"[^"]*"/)
          print FILENAME":"NR":CRITICAL:duplicate-step-id-in-loop:step.run() with a constant ID inside a loop — every iteration returns the first result; use step.map or an indexed ID"
        o = gsub(/\{/, "{"); c = gsub(/\}/, "}")
        depth += o - c
        if (o > 0) opened=1
        if (depth <= 0) inloop=0
      }
    }
  ' "$file" 2>/dev/null

  # CRITICAL: a yielding step whose rejection is swallowed. sleep, sleepUntil,
  # waitForEvent, invoke and invokeAsync suspend the run by THROWING an internal
  # YieldSignal that the SDK catches at the handler boundary
  # (sdk/js/node/src/serve.ts:396). Any user-level catch eats it: the run never
  # suspends, it returns as if finished, and the wait silently never happens. A
  # waitForEvent timeout is not catchable anyway — the scheduler fails the run out
  # from under the handler (internal/engine/scheduler.go:427,450). step.run is
  # exempt: it invokes the callback inline, so its errors are ordinary catchable
  # errors.
  #
  # Two swallow shapes are matched:
  #   1. inside a try block — including a one-line `try { await step.sleep(...) } catch {}`,
  #      whose brace closes on the try line itself;
  #   2. a `.catch(` chained onto the call — on the call line, on the line that
  #      closes its arguments, or on the line right after that close (the usual
  #      formatting for a long call, and what the fixture exercises).
  # Parens and braces are counted with string literals stripped, so a `(` or `{`
  # inside a message cannot make the scanner stick.
  awk '
    function strip_strings(s,   out, i, c, q) {
      out = ""; q = ""
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (q != "") {
          if (c == "\\") { i++; continue }
          if (c == q) q = ""
          continue
        }
        if (c == "\"" || c == "'"'"'" || c == "`") { q = c; continue }
        out = out c
      }
      return out
    }
    function count_char(s, ch,   n, i) {
      n = 0
      for (i = 1; i <= length(s); i++) if (substr(s, i, 1) == ch) n++
      return n
    }
    function report(ln, why) {
      print FILENAME":"ln":CRITICAL:yielding-step-in-try:yielding step with its rejection swallowed ("why") — the catch eats the YieldSignal and the run completes instead of suspending"
    }
    $0 ~ /^[[:space:]]*(\/\/|\*)/ { next }
    {
      code = strip_strings($0)

      # --- shape 2: .catch() chained onto a yielding call, possibly multi-line.
      if (incall) {
        calldepth += count_char(code, "(") - count_char(code, ")")
        if (calldepth <= 0) {
          if (code ~ /\.catch[[:space:]]*\(/) report(callline, ".catch chain")
          else pendingcatch = callline          # a leading .catch( may open the next line
          incall = 0
        }
      } else if (pendingcatch) {
        if (code ~ /^[[:space:]]*\.catch[[:space:]]*\(/) report(pendingcatch, ".catch chain")
        pendingcatch = 0
      }

      # --- locate a yielding call on this line. Two spellings: `step.sleep(` on one
      # line, and the chained form where `step` ends a line and `.sleep(` opens the
      # next (which is exactly how a long call with a trailing .catch() gets
      # formatted). prevstep carries the receiver across the line break.
      isyield = 0
      if (match(code, /step\.(waitForEvent|sleepUntil|sleep|invokeAsync|invoke)[[:space:]]*[<(]/)) isyield = 1
      else if (prevstep && match(code, /^[[:space:]]*\.(waitForEvent|sleepUntil|sleep|invokeAsync|invoke)[[:space:]]*[<(]/)) isyield = 1
      yieldstart = isyield ? RSTART : 0
      yieldlen   = isyield ? RLENGTH : 0

      # --- shape 1: inside a try block.
      if (intry) {
        if (isyield) report(NR, "inside try")
        depth += count_char(code, "{") - count_char(code, "}")
        if (depth <= 0) intry = 0
      } else if (code ~ /(^|[^A-Za-z0-9_])try[[:space:]]*\{/) {
        # Check the try line itself before the brace count can close it: a
        # one-liner `try { await step.sleep(...) } catch {}` opens and closes here.
        if (isyield) report(NR, "inside try")
        intry = 1
        depth = count_char(code, "{") - count_char(code, "}")
        if (depth <= 0) intry = 0
      }

      # Start tracking a yielding call for the .catch scan. Skipped when it was
      # already reported inside a try — one finding per call, not two.
      if (isyield && !intry && !incall) {
        rest = substr(code, yieldstart + yieldlen - 1)
        callline = NR
        calldepth = count_char(rest, "(") - count_char(rest, ")")
        if (calldepth <= 0) {
          if (code ~ /\.catch[[:space:]]*\(/) report(callline, ".catch chain")
          else pendingcatch = callline
        } else incall = 1
      }

      # Does this line end with the `step` receiver, leaving `.method(` for the next?
      # Blank lines do not clear it — a blank (or comment) between `step` and
      # `.waitForEvent(` is just formatting, and clearing here would drop the finding.
      if (code ~ /[^[:space:]]/)
        prevstep = (code ~ /(^|[^A-Za-z0-9_$])step[[:space:]]*$/)
    }
  ' "$file" 2>/dev/null

  # CRITICAL: managed-projection rules — impure-projection, PROJ-DET-001, PROJ-MUT-001.
  #
  # A projection is EXTERNAL (and so exempt from all three) when mode:"external"
  # is set OR when initialState is absent — the SDK auto-detects mode from
  # initialState (sdk/js/node/src/projection.ts). Both facts can sit anywhere in
  # the config object and object keys have no required order, so buffer the whole
  # createProjection(...) block and classify it at the closing brace.
  awk '
    function report(   i, ln, t, mutated, mut_line) {
      mutated = 0
      for (i = 1; i <= n; i++) {
        ln = L[i]; t = T[i]
        if (t ~ /await/)
          print FILENAME":"ln":CRITICAL:impure-projection:await in managed projection handler"
        if (t ~ /Date\.now\(\)/)                 print FILENAME":"ln":CRITICAL:PROJ-DET-001:non-deterministic Date.now() in managed projection — derive from event.timestamp"
        else if (t ~ /new Date\([[:space:]]*\)/) print FILENAME":"ln":CRITICAL:PROJ-DET-001:non-deterministic new Date() in managed projection — derive from event.timestamp"
        else if (t ~ /Math\.random\(\)/)         print FILENAME":"ln":CRITICAL:PROJ-DET-001:non-deterministic Math.random() in managed projection"
        else if (t ~ /crypto\.randomUUID\(\)/)   print FILENAME":"ln":CRITICAL:PROJ-DET-001:non-deterministic crypto.randomUUID() in managed projection — derive ID from event.data"
        else if (t ~ /performance\.now\(\)/)     print FILENAME":"ln":CRITICAL:PROJ-DET-001:non-deterministic performance.now() in managed projection"
        else if (t ~ /process\.env\./)           print FILENAME":"ln":CRITICAL:PROJ-DET-001:env read (process.env) in managed projection"
        if (t ~ /^[[:space:]]*state\.[A-Za-z_][A-Za-z0-9_]*[[:space:]]*(=|\+=|-=|\*=)/) { mutated = 1; mut_line = ln }
        if (t ~ /^[[:space:]]*return[[:space:]]+state[[:space:]]*;?[[:space:]]*$/ && mutated) {
          print FILENAME":"mut_line":CRITICAL:PROJ-MUT-001:managed handler mutates state arg then returns it — return a fresh object (e.g. { ...state, field: ... })"
          mutated = 0
        }
      }
    }
    !in_proj && /createProjection/ { in_proj=1; brace=0; n=0; ext=0; managed=0; in_handler=0 }
    in_proj {
      brace += gsub(/\{/, "{")
      brace -= gsub(/\}/, "}")
      if ($0 ~ /mode:[[:space:]]*"external"/) ext=1
      if ($0 ~ /initialState/)                managed=1
      if ($0 ~ /handler:/)                    in_handler=1
      # Do not buffer // or JSDoc lines — a comment explaining why the handler
      # avoids new Date() must not read as a call to it.
      if (in_handler && $0 !~ /^[[:space:]]*(\/\/|\*)/) { n++; L[n]=NR; T[n]=$0 }
      if (brace <= 0) {
        if (!ext && managed) report()
        in_proj=0; in_handler=0; n=0
      }
    }
  ' "$file" 2>/dev/null

  # WARNING: missing recording flag. Match actual call sites only:
  #   createFunction( or ironflow.createFunction(
  # The required "(" after the identifier already excludes imports and
  # typeof references (Parameters<typeof ironflow.createFunction>[1] has
  # ">" after createFunction, not "("). Also strip comment lines so
  # doc-style mentions don't match.
  #
  # Scoped to the config object by brace depth rather than a 15-line window: a
  # config with a schema or a long triggers array pushes `recording` past line 15
  # and the window rule reported a false positive on correct code.
  awk '
    $0 ~ /^[[:space:]]*(\/\/|\*)/ { next }
    {
      if (!incfg && $0 ~ /createFunction[[:space:]]*\(/) {
        incfg=1; start=NR; rec=0; depth=0; seen=0
      }
      if (incfg) {
        o = gsub(/\{/, "{"); c = gsub(/\}/, "}")
        if (o > 0) seen=1
        depth += o - c
        if ($0 ~ /recording:[[:space:]]*true/) rec=1
        if (seen && depth <= 0) {
          if (!rec) print FILENAME":"start":WARNING:missing-recording:Function without recording: true — no time-travel debugging"
          incfg=0
        }
      }
    }
    END { if (incfg && !rec) print FILENAME":"start":WARNING:missing-recording:Function without recording: true — no time-travel debugging" }
  ' "$file" 2>/dev/null

  # WARNING: validation throws regular Error (look for "Invalid" or "must be" in throw new Error)
  grep -nE 'throw new Error\(.*(Invalid|must be|required|missing)' "$file" 2>/dev/null | \
    while IFS=: read -r line _; do
      emit "$file" "$line" "WARNING" "missing-nonretryable" "Validation error should use NonRetryableError"
    done

  # WARNING: stripe/payment without idempotencyKey
  grep -nE "stripe\.charges\.create|stripe\.paymentIntents\.create" "$file" 2>/dev/null | \
    while IFS=: read -r line _; do
      end=$((line + 5))
      if ! sed -n "${line},${end}p" "$file" | grep -q "idempotencyKey"; then
        emit "$file" "$line" "WARNING" "missing-idempotency" "External API call without idempotencyKey"
      fi
    done

  # WARNING: waitForEvent match without data. prefix
  awk '
    /step\.waitForEvent/{wfe=1}
    wfe && /match:[[:space:]]*"/ && !/match:[[:space:]]*"data\./{
      print FILENAME":"NR":WARNING:wrong-match-prefix:waitForEvent match field missing \"data.\" prefix"
      wfe=0
    }
    wfe && /\}/ {wfe=0}
  ' "$file" 2>/dev/null

  # WARNING: streams.append without expectedVersion.
  # Anchor on paren depth: the call starts with "(" after streams.append, and
  # ends when depth returns to 0. Scan everything inside the call args; if
  # expectedVersion appears anywhere, pass. Keeps multi-line event objects
  # working without a hardcoded line window.
  awk '
    # Count parens of a given kind ( "(" or ")" ) in s.
    function count_char(s, ch,   n, i) {
      n = 0
      for (i = 1; i <= length(s); i++) if (substr(s, i, 1) == ch) n++
      return n
    }
    {
      # Skip // and JSDoc * lines — always, not just at top-level. Keeps
      # comment text out of both the call-start match and paren counting.
      if ($0 ~ /^[[:space:]]*(\/\/|\*)/) next
      if (!in_call && match($0, /streams\.append[[:space:]]*\(/)) {
        # Skip the identifier portion; only count parens from the opening.
        rest = substr($0, RSTART + RLENGTH - 1)
        in_call = 1; start = NR; ev = 0; depth = 0
        depth += count_char(rest, "(")
        depth -= count_char(rest, ")")
        if (rest ~ /expectedVersion/) ev = 1
        if (depth <= 0) {
          if (!ev) print FILENAME":"start":WARNING:missing-expectedversion:streams.append without expectedVersion"
          in_call = 0
        }
        next
      }
      if (in_call) {
        depth += count_char($0, "(")
        depth -= count_char($0, ")")
        if ($0 ~ /expectedVersion/) ev = 1
        if (depth <= 0) {
          if (!ev) print FILENAME":"start":WARNING:missing-expectedversion:streams.append without expectedVersion"
          in_call = 0
        }
      }
    }
  ' "$file" 2>/dev/null

  # WARNING: upcaster body that never spreads. An upcaster returns the WHOLE
  # migrated event, so an object literal that only names the changed fields
  # silently drops every other field on the way to the new version. Covers both
  # `upcast:` (defineEvent) and `registry.register(...)`. A body with any `...`
  # anywhere is treated as safe.
  #
  # Depth counts parens AND braces together: a block body (`=> {`) closes its
  # parens on the opening line, so paren-only tracking ends the callback before
  # its body is ever read. Template-literal `${...}` braces balance out.
  awk '
    $0 ~ /^[[:space:]]*(\/\/|\*)/ { next }
    {
      if (!inup && ($0 ~ /upcast:/ || $0 ~ /\.register\(/)) {
        inup=1; ustart=NR; depth=0; spread=0; opened=0
      }
      if (inup) {
        if ($0 ~ /\.\.\./) spread=1
        o = gsub(/[({]/, "&"); c = gsub(/[)}]/, "&")
        depth += o - c
        if (o > 0) opened=1
        if (opened && depth <= 0) {
          if (!spread)
            print FILENAME":"ustart":WARNING:upcaster-drops-fields:upcaster returns an object literal with no ...spread — every unnamed field is dropped at this version boundary"
          inup=0
        } else if (!opened) {
          # No callback on this line (e.g. `upcast: migrateV2,`) — nothing to analyze.
          inup=0
        }
      }
    }
  ' "$file" 2>/dev/null

  # INFO: hardcoded localhost URL
  grep -nE 'serverUrl:\s*"http://localhost:9123"' "$file" 2>/dev/null | \
    while IFS=: read -r line _; do
      emit "$file" "$line" "INFO" "hardcoded-url" "serverUrl hardcoded — use process.env.IRONFLOW_SERVER_URL"
    done

  # INFO: event.data as any
  grep -nE 'event\.data\s+as\s+any' "$file" 2>/dev/null | \
    while IFS=: read -r line _; do
      emit "$file" "$line" "INFO" "missing-types" "event.data cast as any — define interface"
    done

  # INFO: bucket.get() or bucket.getJSON() outside a try block. Tracks real try-block extent by brace
  # depth rather than looking back a fixed number of lines — a try body longer
  # than the window used to read as unguarded.
  awk '
    $0 ~ /^[[:space:]]*(\/\/|\*)/ { next }
    {
      if (!intry && $0 ~ /(^|[^A-Za-z0-9_])try[[:space:]]*\{/) { intry=1; depth=0 }
      if (intry) {
        depth += gsub(/\{/, "{")
        depth -= gsub(/\}/, "}")
      }
      if ($0 ~ /bucket\.get(JSON)?\(/ && !intry)
        print FILENAME":"NR":INFO:kv-missing-try:bucket.get()/getJSON() without try/catch — throws on missing key"
      if (intry && depth <= 0) intry=0
    }
  ' "$file" 2>/dev/null

  # INFO: raw string event names (event: "...")
  grep -nE 'event:\s*"[a-z]+\.[a-z.]+"' "$file" 2>/dev/null | \
    grep -v "Events\." | \
    while IFS=: read -r line _; do
      emit "$file" "$line" "INFO" "raw-event-name" "Event name as raw string — use typed constant"
    done

  # INFO: webhook verify body that never checks a signature. Buffers the whole
  # verify block and looks for any signing primitive; the old one-line pattern
  # only caught `verify: async (req) => JSON.parse(...)` and missed every
  # multi-line body, which is the shape real webhooks are written in.
  #
  # Stays INFO because `verify` is a REQUIRED field on WebhookConfig, so an
  # outright omission is a type error, not a runtime hole — this rule only
  # flags a body that parses without authenticating.
  awk '
    $0 ~ /^[[:space:]]*(\/\/|\*)/ { next }
    /createWebhook/ { cw=1 }
    cw && /verify:/ { inv=1; vstart=NR; vdepth=0; signed=0; opened=0 }
    inv {
      # Match signing *calls*, not the words. A bare /[Ss]ignature/ is satisfied
      # by prose — a `throw new Error("signature verification not configured")`
      # inside the verify body — which silently exempts unverified webhooks.
      if ($0 ~ /crypto\.|createHmac\(|createHash\(|timingSafeEqual\(|constructEvent\(|\.digest\(|verifyHeader\(/) signed=1
      o = gsub(/\{/, "{"); c = gsub(/\}/, "}")
      vdepth += o - c
      if (o > 0) opened=1
      if (opened && vdepth <= 0) {
        if (!signed)
          print FILENAME":"vstart":INFO:webhook-no-verify:Webhook verify body never checks a signature"
        inv=0; cw=0
      } else if (!opened && $0 ~ /,[[:space:]]*$/) {
        # single-expression body, e.g. `verify: async (req) => JSON.parse(...)`
        if (!signed)
          print FILENAME":"vstart":INFO:webhook-no-verify:Webhook verify body never checks a signature"
        inv=0; cw=0
      }
    }
  ' "$file" 2>/dev/null

  # INFO: config/bucket watch without .stop() in same file.
  # `client.config()` is a METHOD, so the real call site is `config().watch(` —
  # matching only `config.watch(` meant this rule never fired on real code.
  # A destructured `const config = client.config()` then `config.watch(` is also
  # valid, so both spellings are accepted.
  #
  # Comment lines are stripped from BOTH sides: a `// TODO: call .stop()` note
  # otherwise reads as the cleanup itself and silently exempts the leak.
  watch_src=$(grep -vE '^[[:space:]]*(//|\*)' "$file" 2>/dev/null)
  if printf '%s\n' "$watch_src" | grep -qE "(config(\(\))?|bucket)\.watch\("; then
    if ! printf '%s\n' "$watch_src" | grep -q "\.stop()"; then
      line=$(grep -nE "(config(\(\))?|bucket)\.watch\(" "$file" \
        | grep -vE '^[0-9]+:[[:space:]]*(//|\*)' | head -1 | cut -d: -f1)
      emit "$file" "$line" "INFO" "watch-no-cleanup" "watch() without .stop() — memory leak"
    fi
  fi
}

scan_go() {
  local file="$1"

  # WARNING: missing Recording: true. Brace-scoped to the config struct for the
  # same reason as the TS rule — a 15-line window false-positives on long configs.
  awk '
    $0 ~ /^[[:space:]]*\/\// { next }
    {
      if (!incfg && $0 ~ /ironflow\.CreateFunction/) { incfg=1; start=NR; rec=0; depth=0; seen=0 }
      if (incfg) {
        o = gsub(/\{/, "{"); c = gsub(/\}/, "}")
        if (o > 0) seen=1
        depth += o - c
        if ($0 ~ /Recording:[[:space:]]*true/) rec=1
        if (seen && depth <= 0) {
          if (!rec) print FILENAME":"start":WARNING:missing-recording:Function without Recording: true"
          incfg=0
        }
      }
    }
    END { if (incfg && !rec) print FILENAME":"start":WARNING:missing-recording:Function without Recording: true" }
  ' "$file" 2>/dev/null

  # INFO: hardcoded URL
  grep -nE 'ServerURL:\s*"http://localhost:9123"' "$file" 2>/dev/null | \
    while IFS=: read -r line _; do
      emit "$file" "$line" "INFO" "hardcoded-url" "ServerURL hardcoded — use os.Getenv"
    done

  # CRITICAL: PROJ-DET-002 (non-determinism) and PROJ-DET-003 (side effects)
  # inside a managed projection handler (Go).
  #
  # A projection is EXTERNAL (and so exempt) when Mode names external — idiomatic
  # Go writes the typed constant `ironflow.ProjectionModeExternal`, not the bare
  # string — OR when InitialState is absent, since CreateProjection auto-detects
  # mode from it (sdk/go/ironflow/projection.go). Struct fields have no required
  # order, so buffer the whole CreateProjection(...) block and classify at close.
  awk '
    function report(   i, ln, t) {
      for (i = 1; i <= n; i++) {
        ln = L[i]; t = T[i]
        if (t ~ /time\.Now\(\)/)                            print FILENAME":"ln":CRITICAL:PROJ-DET-002:non-deterministic time.Now() in managed projection — derive from event.Timestamp"
        else if (t ~ /time\.Since\(/)                       print FILENAME":"ln":CRITICAL:PROJ-DET-002:non-deterministic time.Since() in managed projection"
        else if (t ~ /rand\.(Int|Float|Intn|Int31|Int63)/)  print FILENAME":"ln":CRITICAL:PROJ-DET-002:non-deterministic rand.* in managed projection"
        else if (t ~ /uuid\.New(String)?\(\)/)              print FILENAME":"ln":CRITICAL:PROJ-DET-002:non-deterministic uuid.New() in managed projection — derive ID from event.Data"
        else if (t ~ /os\.Getenv\(/)                        print FILENAME":"ln":CRITICAL:PROJ-DET-002:env read (os.Getenv) in managed projection"
        if (t ~ /http\.(Get|Post|Do|Head)/ || t ~ /\.(Query|Exec)(Context)?\(/)
          print FILENAME":"ln":CRITICAL:PROJ-DET-003:side effect (network or DB call) in managed projection — use Mode: ironflow.ProjectionModeExternal"
      }
    }
    !in_proj && /ironflow\.CreateProjection/ { in_proj=1; brace=0; n=0; ext=0; managed=0; in_handler=0 }
    in_proj {
      brace += gsub(/\{/, "{")
      brace -= gsub(/\}/, "}")
      if ($0 ~ /Mode:.*[Ee]xternal/)      ext=1
      if ($0 ~ /InitialState/)            managed=1
      if ($0 ~ /Handler:[[:space:]]*func/) in_handler=1
      # Do not buffer comment lines — see the TS scanner for the rationale.
      if (in_handler && $0 !~ /^[[:space:]]*\/\//) { n++; L[n]=NR; T[n]=$0 }
      if (brace <= 0) {
        if (!ext && managed) report()
        in_proj=0; in_handler=0; n=0
      }
    }
  ' "$file" 2>/dev/null
}

# Counters
CRIT=0
WARN=0
INFO=0
TOTAL_FILES=0

count_severity() {
  # Count lines matching :SEVERITY: in input. Always returns single integer.
  local sev="$1"
  local input="$2"
  local n
  n=$(printf '%s\n' "$input" | grep -c ":${sev}:" 2>/dev/null) || n=0
  # grep -c can output empty or multi-line on edge cases; coerce to int
  printf '%d' "${n:-0}" 2>/dev/null || printf '0'
}

while IFS= read -r -d '' file; do
  TOTAL_FILES=$((TOTAL_FILES + 1))
  results=$(scan_ts "$file" | suppress)
  if [ -n "$results" ]; then
    echo "$results"
    CRIT=$((CRIT + $(count_severity CRITICAL "$results")))
    WARN=$((WARN + $(count_severity WARNING "$results")))
    INFO=$((INFO + $(count_severity INFO "$results")))
  fi
done < "$TS_FILES_LIST"

while IFS= read -r -d '' file; do
  TOTAL_FILES=$((TOTAL_FILES + 1))
  results=$(scan_go "$file" | suppress)
  if [ -n "$results" ]; then
    echo "$results"
    CRIT=$((CRIT + $(count_severity CRITICAL "$results")))
    WARN=$((WARN + $(count_severity WARNING "$results")))
    INFO=$((INFO + $(count_severity INFO "$results")))
  fi
done < "$GO_FILES_LIST"

echo "---"
echo "Scanned $TOTAL_FILES files. Findings: $CRIT critical, $WARN warnings, $INFO info."
