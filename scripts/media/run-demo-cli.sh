#!/bin/bash
source /tmp/watch-demo/env.sh
rm -f /tmp/watch-demo/watch.db /tmp/watch-demo/watch.db-* /tmp/watch-demo/opencode.db /tmp/watch-demo/opencode.db-*
CWD=/tmp/watch-demo/projects/example-api
clear
type_cmd() { printf '\033[1;32m$\033[0m '; for ((i=0;i<${#1};i++)); do printf '%s' "${1:$i:1}"; sleep 0.035; done; printf '\n'; }
run() { type_cmd "$1"; sleep 0.4; shift; "$@" 2>&1; echo; sleep "${PAUSE:-2.2}"; }
printf '\033[2m# Watch · 值更 — Claude Code → OpenCode 会话接力（隔离环境 · 合成会话）\033[0m\n\n'; sleep 1.5
run "watch status --cwd ./example-api" npm run --silent watch -- status --cwd "$CWD"
run "watch sessions --cwd ./example-api" npm run --silent watch -- sessions --cwd "$CWD"
run "watch switch opencode --cwd ./example-api" npm run --silent watch -- switch opencode --cwd "$CWD"
PAUSE=3.5 run "watch status --cwd ./example-api" npm run --silent watch -- status --cwd "$CWD"
sleep 1
