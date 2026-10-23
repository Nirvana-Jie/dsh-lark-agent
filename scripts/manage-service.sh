#!/usr/bin/env bash
# Manage a per-login-session macOS launchd service. Nothing is installed in
# ~/Library/LaunchAgents; bootstrap state lasts until logout or reboot.
set -euo pipefail

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
runtime_dir="$repo_dir/.runtime"
config_file="$runtime_dir/team.config.json"
service_hash="$(printf '%s' "$repo_dir" | /usr/bin/shasum -a 256 | /usr/bin/cut -c 1-12)"
service_label="com.local.dsh-larkbot.$service_hash"
service_domain="gui/$(/usr/bin/id -u)"
service_target="$service_domain/$service_label"
plist_file="$runtime_dir/launchd/$service_label.plist"
stdout_file="$runtime_dir/logs/service.stdout.log"
stderr_file="$runtime_dir/logs/service.stderr.log"

if [[ "$(/usr/bin/uname -s)" != Darwin ]]; then
  printf 'This service wrapper requires macOS launchd.\n' >&2
  exit 1
fi

loaded() { /bin/launchctl print "$service_target" >/dev/null 2>&1; }
service_pid() {
  /bin/launchctl print "$service_target" 2>/dev/null |
    /usr/bin/awk '/^[[:space:]]*pid = [0-9]+$/ {print $3; exit}' || true
}

prepare() {
  if [[ ! -f "$config_file" ]]; then
    printf 'Missing team configuration: %s\n' "$config_file" >&2
    return 1
  fi
  local node_command dsh_command lark_command
  node_command="$(command -v node)"
  dsh_command="$(command -v dsh)"
  lark_command="$(command -v lark-cli)"
  if [[ ! -x "$node_command" || ! -f "$dsh_command" || ! -x "$lark_command" ]]; then
    printf 'node, dsh and lark-cli must already be installed.\n' >&2
    return 1
  fi
  mkdir -p "$runtime_dir/launchd" "$runtime_dir/logs"
  chmod 700 "$runtime_dir" "$runtime_dir/launchd" "$runtime_dir/logs"
  touch "$stdout_file" "$stderr_file"
  chmod 600 "$stdout_file" "$stderr_file"
  # process.execPath resolves fnm's ephemeral shell path to the installed Node.
  # Only filesystem paths are passed here; no model or app secrets enter argv.
  "$node_command" --input-type=module - "$repo_dir" "$service_label" "$plist_file" "$dsh_command" "$lark_command" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [repo, label, target, dshCommand, larkCommand] = process.argv.slice(2);
const node = fs.realpathSync(process.execPath);
const dsh = fs.realpathSync(dshCommand);
const runtime = path.join(repo, '.runtime');
const searchPath = [...new Set([path.dirname(node), path.dirname(larkCommand), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const string = value => `<string>${escape(value)}</string>`;
const env = {
  PATH: searchPath,
  DSH_HOME: path.join(runtime, 'dsh'),
  DSH_LARK_CONFIG: path.join(runtime, 'team.config.json'),
  DSH_TELEMETRY_DISABLED: '1',
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
};
const document = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${[node, dsh, '--profile', 'feishu-team'].map(string).join('')}</array>
<key>WorkingDirectory</key>${string(repo)}
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${escape(key)}</key>${string(value)}`).join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>ExitTimeOut</key><integer>60</integer>
<key>Umask</key><integer>63</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key>${string(path.join(runtime, 'logs/service.stdout.log'))}
<key>StandardErrorPath</key>${string(path.join(runtime, 'logs/service.stderr.log'))}
</dict></plist>
`;
fs.writeFileSync(target, document, {mode: 0o600});
fs.chmodSync(target, 0o600);
NODE
  /usr/bin/plutil -lint "$plist_file"
  printf 'Prepared %s\n' "$plist_file"
}

assert_unlocked() {
  # This wrapper never deletes an instance lock. The service itself recovers one
  # only after verifying that its owner exited and no event consumer remains.
  local state_dir lock_pid
  state_dir="$(node --input-type=module - "$config_file" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const configPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
process.stdout.write(path.resolve(path.dirname(configPath), config.stateDir ?? '.state'));
NODE
)"
  [[ -e "$state_dir/instance.lock" ]] || return 0
  lock_pid="$(/bin/cat "$state_dir/instance.lock/pid" 2>/dev/null || true)"
  if [[ "$lock_pid" =~ ^[0-9]+$ ]] && /bin/kill -0 "$lock_pid" 2>/dev/null; then
    printf 'Instance lock is held by running PID %s: %s\n' "$lock_pid" "$state_dir/instance.lock" >&2
    printf 'Stop that instance first. Do not remove a live lock.\n' >&2
    return 1
  fi
  printf 'Found a lock from an exited process; the service will verify and recover it on start.\n'
}

start_service() {
  local current_pid
  current_pid="$(service_pid)"
  if [[ -n "$current_pid" ]]; then
    printf 'Already running: %s (PID %s)\n' "$service_target" "$current_pid"
    return
  fi
  prepare
  assert_unlocked
  if loaded; then
    /bin/launchctl bootout "$service_target"
  fi
  /bin/launchctl bootstrap "$service_domain" "$plist_file"
  printf 'Started %s. Run "%s status" and inspect the ready marker in %s\n' "$service_target" "$0" "$stdout_file"
}

stop_service() {
  if ! loaded; then
    printf 'Not loaded: %s\n' "$service_target"
    return
  fi
  local previous_pid current_pid remaining
  previous_pid="$(service_pid)"
  if [[ -n "$previous_pid" ]]; then
    # KeepAlive is disabled: a crash never enters a restart loop; the next start
    # recovers the exited process's lock. Never kickstart -k to reload.
    /bin/launchctl kill SIGTERM "$service_target"
    remaining=45
    while /bin/kill -0 "$previous_pid" 2>/dev/null; do
      if (( remaining == 0 )); then
        printf 'PID %s has not exited after SIGTERM. Service remains loaded; lock is untouched.\n' "$previous_pid" >&2
        return 1
      fi
      sleep 1
      remaining=$((remaining - 1))
    done
    current_pid="$(service_pid)"
    if [[ -n "$current_pid" ]]; then
      printf 'Service started another process (PID %s) during shutdown; inspect its logs before retrying.\n' "$current_pid" >&2
      return 1
    fi
  fi
  /bin/launchctl bootout "$service_target"
  printf 'Stopped and unloaded %s\n' "$service_target"
}

status_service() {
  printf 'Service: %s\nPlist: %s\nStdout: %s\nStderr: %s\n' "$service_target" "$plist_file" "$stdout_file" "$stderr_file"
  if loaded; then
    /bin/launchctl print "$service_target" |
      /usr/bin/awk '/^\t(state|pid|last exit code) =/ {sub(/^\t/, ""); print}'
  else
    printf 'state = not loaded\n'
  fi
}

case "${1:-status}" in
  prepare) prepare ;;
  start) start_service ;;
  stop) stop_service ;;
  restart) stop_service; start_service ;;
  status) status_service ;;
  *) printf 'Usage: %s {prepare|start|stop|restart|status}\n' "$0" >&2; exit 2 ;;
esac
