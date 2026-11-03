#!/bin/bash
#
# Serve this checkout of TraceSift to a locally installed Mobile Dev plugin, so
# the plugin's panel exercises the code in this working tree rather than the
# published CLI and the installed app.
#
# Three things have to come from here rather than from a release: `tracesift
# record`, which no published CLI has yet; `record --platform rn`, which only
# 0.6.0 has; and gzip support in the analyze route, without which a recorded
# trace reaches no cards. All live in this tree, so this script points the
# plugin at the tree.
#
# It leaves two pointer files the plugin's own tooling/test-codex-local.sh
# reads, then stays in the foreground serving the app. Stop it with Ctrl-C.
#
#   scripts/test-codex-local.sh [--port 3100] [--home <path>] [--metro <url>]
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POINTER_FILE="${TMPDIR%/}/tracesift-codex-test-home"
CLI_POINTER_FILE="${TMPDIR%/}/tracesift-codex-test-cli"
# A stable home, so analyses and recordings survive a restart of this script.
HOME_DIR="${TMPDIR%/}/tracesift-codex-test-home.d"
PORT=""

METRO_URL=""

usage() { echo "Usage: $0 [--port <port>] [--home <path>] [--metro <url>]" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:-}"; shift ;;
    --home) HOME_DIR="${2:-}"; shift ;;
    --metro) METRO_URL="${2:-}"; shift ;;
    *) usage; exit 2 ;;
  esac
  shift
done

cd "$ROOT"

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    console.error(`Node.js 22.19.0 or newer is required; found ${process.version}.`);
    process.exit(1);
  }
'

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..." >&2
  npm ci
fi

# Never 3000 by default: that is where the ordinary `npm run dev` lives, and
# taking it would stop the browser window you already have open.
if [[ -z "$PORT" ]]; then
  PORT="$(node -e '
    const { createServer } = require("node:net");
    const server = createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => console.log(port)); });
  ')"
fi

mkdir -p "$HOME_DIR"
chmod 700 "$HOME_DIR"

# The plugin spawns this by path, so it has to be an executable that forwards
# to the CLI in this tree.
CLI_WRAPPER="$HOME_DIR/tracesift"
cat > "$CLI_WRAPPER" <<EOF
#!/bin/sh
exec $(printf '%q' "$(command -v node)") $(printf '%q' "$ROOT/packages/cli/src/cli.js") "\$@"
EOF
chmod 755 "$CLI_WRAPPER"

TOKEN="$(node -e 'console.log(require("node:crypto").randomUUID().replace(/-/g, ""))')"
INSTANCE="codex-local-$$"
BASE_URL="http://127.0.0.1:$PORT"

cleanup() {
  local status=$?
  echo
  echo "Stopping..."
  # A recording outlives this script: it runs in a detached recorder holding
  # Hermes' one sampler or Chrome's tracing lock, and leaving it running means
  # the next run cannot start one.
  TRACE_SIFT_HOME="$HOME_DIR" "$CLI_WRAPPER" record stop >/dev/null 2>&1 || true
  # A Chrome left open by `record launch` belongs to this home; quitting it
  # here means the next run does not meet a browser nobody can reach.
  TRACE_SIFT_HOME="$HOME_DIR" "$CLI_WRAPPER" record close >/dev/null 2>&1 || true
  rm -f "$POINTER_FILE" "$CLI_POINTER_FILE" "$HOME_DIR/service.json"
  if [[ -n "${SERVER_PID:-}" ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  exit $status
}
trap cleanup INT TERM EXIT

echo "Starting TraceSift from this checkout on $BASE_URL..."
TRACE_SIFT_HOME="$HOME_DIR" \
TRACE_SIFT_INTEGRATION_TOKEN="$TOKEN" \
TRACE_SIFT_INSTANCE="$INSTANCE" \
TRACESIFT_DEBUG=1 \
TRACE_SIFT_VERSION="0.0.0-codex-local" \
  npm run dev -- --port "$PORT" &
SERVER_PID=$!

# Wait for the integration API itself, not just the port: the app compiles on
# first request, and the plugin's health check is the same call.
DEADLINE=$(( $(date +%s) + 240 ))
until curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/integration/v1/health" >/dev/null 2>&1; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then echo "The dev server exited before it was ready." >&2; exit 1; fi
  if [[ $(date +%s) -gt $DEADLINE ]]; then echo "TraceSift did not become ready in four minutes." >&2; exit 1; fi
  sleep 1
done

# The descriptor `tracesift start` would have written. The plugin reuses a
# healthy service rather than spawning one, which is how the dev server stands
# in for an installed release.
node -e '
  const { writeFileSync } = require("node:fs");
  const [file, baseUrl, token, instance, pid] = process.argv.slice(1);
  writeFileSync(file, JSON.stringify({
    version: "0.0.0-codex-local", apiVersion: 1, pid: Number(pid), childPid: Number(pid),
    instance, baseUrl, token, startedAt: Date.now(),
  }), { mode: 0o600 });
' "$HOME_DIR/service.json" "$BASE_URL" "$TOKEN" "$INSTANCE" "$SERVER_PID"
chmod 600 "$HOME_DIR/service.json"

printf '%s' "$HOME_DIR" > "$POINTER_FILE"
printf '%s' "$CLI_WRAPPER" > "$CLI_POINTER_FILE"

# Say up front whether a React Native app is reachable, because that is the
# route under test and the answer is one command away. Metro and the app are
# the developer's to start, so this only reports what it found.
METRO_URL="${METRO_URL:-http://127.0.0.1:8081}"
RN_STATUS="$(
  TRACE_SIFT_HOME="$HOME_DIR" "$CLI_WRAPPER" record targets --platform rn --metro "$METRO_URL" --json 2>/dev/null |
    node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { input += chunk; });
      process.stdin.on("end", () => {
        let payload;
        try { payload = JSON.parse(input); } catch { payload = null; }
        if (!payload) { process.stdout.write("Metro did not answer. Start it with `npx expo start` or `npm start`."); return; }
        if (payload.error) { process.stdout.write(payload.error); return; }
        const targets = payload.targets ?? [];
        if (!targets.length) { process.stdout.write(`no app connected to ${payload.metro}. Open the app in a simulator or emulator.`); return; }
        process.stdout.write(targets.map(target => `${target.title}${target.recommended ? " (default)" : ""}`).join(", "));
      });
    ' || true
)"

cat <<EOF

TraceSift is serving this checkout.
  app:   $BASE_URL
  home:  $HOME_DIR
  cli:   $CLI_WRAPPER
  metro: $METRO_URL
         ${RN_STATUS:-could not be checked}

Leave this running. In another terminal, install the plugin and relaunch Codex:
  cd <codex-mobile-dev-plugin> && tooling/test-codex-local.sh

Then in Codex: Mobile Dev -> TraceSift -> JavaScript CPU -> Record a running app.
  React Native  one press: the app is already running, so Start profile records
                it. Ask the agent instead and it drives the same thing itself.
  Web app       two presses: Launch web app, reach the state worth profiling,
                then Start profile.

Ctrl-C here when you are done; it stops any recording still running and quits
any browser \`record launch\` left open.
EOF

wait "$SERVER_PID"
