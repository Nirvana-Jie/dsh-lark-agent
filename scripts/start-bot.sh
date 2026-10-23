#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export DSH_HOME="${DSH_HOME:-"$repo_dir/.runtime/dsh"}"
export DSH_LARK_CONFIG="${DSH_LARK_CONFIG:-"$repo_dir/.runtime/team.config.json"}"
export DSH_TELEMETRY_DISABLED="${DSH_TELEMETRY_DISABLED:-1}"

if [[ ! -f "$DSH_LARK_CONFIG" ]]; then
  printf 'Team configuration is missing: %s\n' "$DSH_LARK_CONFIG" >&2
  exit 1
fi

exec dsh --profile feishu-team "$@"
