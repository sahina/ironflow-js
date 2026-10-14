#!/usr/bin/env bash
# Detect project type and Ironflow install state.
#
# Output (key=value pairs, one per line):
#   framework=<nextjs|hono|express|remix|node|go|flask|fastapi|django|python|unknown>
#   language=<ts|go|python|mixed|none>
#   languages=<comma-separated ts,go,python|none>
#   ironflow_installed=<true|false|unknown>           # SDK present in this project
#   ironflow_cli=<version|none>               # engine binary on PATH
#   package_manager=<pnpm|yarn|npm|bun|uv|pip|unknown|none>
#
# Usage: detect-project.sh [ts|go|python]

set -uo pipefail

FRAMEWORK="unknown"
LANGUAGE="none"
IRONFLOW_INSTALLED="false"
IRONFLOW_CLI="none"
PACKAGE_MANAGER="none"

# Engine binary. The SDK is useless without one, so setup asks about installing
# it — skip that question when it is already here.
if command -v ironflow >/dev/null 2>&1; then
  IRONFLOW_CLI=$(ironflow version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  [ -z "$IRONFLOW_CLI" ] && IRONFLOW_CLI="unknown"
fi

# Detection is manifest-based; unrecognized files still need agent inspection.
LANGUAGES=""
[ ! -f package.json ] || LANGUAGES="ts"
[ ! -f go.mod ] || LANGUAGES="${LANGUAGES:+$LANGUAGES,}go"
if [ -f pyproject.toml ] || [ -f requirements.txt ]; then
  LANGUAGES="${LANGUAGES:+$LANGUAGES,}python"
fi
LANGUAGES=${LANGUAGES:-none}
if [ "$#" -gt 1 ]; then
  echo "Usage: detect-project.sh [ts|go|python]" >&2; exit 1
fi
if [ "$#" -eq 1 ]; then
  case "$1" in ts|go|python) ;; *) echo "Select ts, go, or python." >&2; exit 1 ;; esac
  case ",$LANGUAGES," in
    *,"$1",*) LANGUAGE=$1 ;;
    *) echo "No $1 manifest found here; choose a detected language or another directory." >&2; exit 1 ;;
  esac
else
  case "$LANGUAGES" in
    *,*) LANGUAGE=mixed; IRONFLOW_INSTALLED=unknown; PACKAGE_MANAGER=unknown ;;
    *) LANGUAGE=$LANGUAGES ;;
  esac
fi

# Detect TS framework + package manager + ironflow
if [ "$LANGUAGE" = ts ]; then
  PKG=$(cat package.json 2>/dev/null)

  # Here-strings, not pipes: see python_has below for the pipefail/SIGPIPE reason.
  if grep -q '"next"' <<<"$PKG"; then
    FRAMEWORK="nextjs"
  elif grep -q '"@remix-run/' <<<"$PKG"; then
    FRAMEWORK="remix"
  elif grep -q '"hono"' <<<"$PKG"; then
    FRAMEWORK="hono"
  elif grep -q '"express"' <<<"$PKG"; then
    FRAMEWORK="express"
  else
    FRAMEWORK="node"
  fi

  if grep -q '"@ironflow/node"\|"@ironflow/browser"\|"@ironflow/core"\|"@ironflow/langgraph"' <<<"$PKG"; then
    IRONFLOW_INSTALLED="true"
  fi

  # Package manager detection
  if [ -f "pnpm-lock.yaml" ]; then
    PACKAGE_MANAGER="pnpm"
  elif [ -f "bun.lockb" ] || [ -f "bun.lock" ]; then
    PACKAGE_MANAGER="bun"
  elif [ -f "yarn.lock" ]; then
    PACKAGE_MANAGER="yarn"
  elif [ -f "package-lock.json" ]; then
    PACKAGE_MANAGER="npm"
  else
    # Read packageManager field
    PM=$(echo "$PKG" | grep -E '"packageManager":' | head -1 | sed 's/.*"packageManager":[[:space:]]*"\([a-z]*\).*/\1/')
    if [ -n "$PM" ]; then
      PACKAGE_MANAGER="$PM"
    fi
  fi
fi

# Detect Go ironflow install. The public module is `github.com/sahina/ironflow-go`;
# its SDK package is `/ironflow` (published in v0.22.6, #979).
# Pre-v0.22.6 the SDK was not published to a public module, so external
# users could only resolve the engine-internal `sahina/ironflow/sdk/go/ironflow`
# path via a private-repo checkout — out of scope for the agent skill's
# detection heuristic.
if [ "$LANGUAGE" = go ]; then
  # A here-string, not a pipe: see python_has below for the pipefail/SIGPIPE reason.
  if grep -Eq '(^|[[:space:]])github\.com/sahina/ironflow-go(/ironflow)?[[:space:]]+v' <<<"$(sed 's|//.*$||' go.mod)"; then
    IRONFLOW_INSTALLED="true"
  fi
  if [ "$FRAMEWORK" = "unknown" ]; then
    FRAMEWORK="go"
  fi
fi

# ponytail: dependency-name heuristic, not a TOML parser; inspect complex/dynamic
# manifests with the agent instead of adding a runtime dependency to detection.
if [ "$LANGUAGE" = python ]; then
  PY_DEPS=""
  # One level of `-r base.txt` includes; deeper chains are left to agent inspection.
  manifests="requirements.txt pyproject.toml"
  if [ -f requirements.txt ]; then
    manifests="$manifests $(sed -nE 's/^[[:space:]]*(-r|--requirement)[[:space:]=]+([^[:space:]#]+).*/\2/p' requirements.txt)"
  fi
  for manifest in $manifests; do
    if [ -f "$manifest" ]; then
      # A pyproject `name = "flask"` names the project, not a dependency.
      PY_DEPS="$PY_DEPS
$(sed -e 's/#.*$//' -e '/^[[:space:]]*name[[:space:]]*=/d' "$manifest")"
    fi
  done
  python_has() {
    # A here-string, not a pipe: under pipefail, grep -q exiting on an early match can
    # SIGPIPE the writer on a large manifest and turn a found dependency into "absent".
    # A dependency starts a requirements line or a quoted TOML string; prose such as a
    # description that mentions a package does not.
    grep -Eiq "(^[[:space:]]*|[\"'])$1([\"'[:space:]<>=!~;@]|\\[|$)" <<<"$PY_DEPS"
  }
  FRAMEWORK=python
  for candidate in flask fastapi django; do
    if python_has "$candidate"; then FRAMEWORK=$candidate; break; fi
  done
  if python_has 'ironflow[-_.]py'; then IRONFLOW_INSTALLED=true; fi
  if [ -f uv.lock ]; then PACKAGE_MANAGER=uv
  elif [ -f requirements.txt ]; then PACKAGE_MANAGER=pip
  else PACKAGE_MANAGER=unknown
  fi
fi

echo "framework=$FRAMEWORK"
echo "language=$LANGUAGE"
echo "ironflow_installed=$IRONFLOW_INSTALLED"
echo "ironflow_cli=$IRONFLOW_CLI"
echo "package_manager=$PACKAGE_MANAGER"
echo "languages=$LANGUAGES"
