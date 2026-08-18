#!/usr/bin/busybox sh

# This is deliberately a BusyBox script, not a Node provider.  Its only runtime
# dependency is the exact static BusyBox inode mounted by the test closure.
if [ "${1:-}" = "--version" ]; then
  # If a caller ever probes this provider without Bubblewrap, this host-visible
  # marker exposes the regression.  Inside the synthetic root it is ephemeral.
  /usr/bin/busybox touch /tmp/grok-outer-probe-host-marker
  /usr/bin/busybox printf '%s\n' 'fake-grok-outer 2.0'
  exit 0
fi

cwd=''
prompt=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cwd)
      cwd="${2:-}"
      shift 2
      ;;
    -p)
      prompt="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [ -z "$cwd" ]; then
  /usr/bin/busybox printf '%s\n' 'RESULT fatal=missing-cwd'
  exit 64
fi

attempt_write() {
  key="$1"
  destination="$2"
  if /usr/bin/busybox touch "$destination" 2>/dev/null; then
    /usr/bin/busybox printf 'RESULT %s=written\n' "$key"
  else
    /usr/bin/busybox printf 'RESULT %s=denied\n' "$key"
  fi
}

check_absent() {
  key="$1"
  destination="$2"
  if [ -e "$destination" ]; then
    /usr/bin/busybox printf 'RESULT %s=visible\n' "$key"
  else
    /usr/bin/busybox printf 'RESULT %s=absent\n' "$key"
  fi
}

/usr/bin/busybox printf 'RESULT prompt=%s\n' "$prompt"
/usr/bin/busybox printf '%s\n' 'ENV-BEGIN'
# Never echo a projected API credential. The fixture deliberately proves that
# even diagnostic output retains only the name and a redaction marker.
/usr/bin/busybox env | /usr/bin/busybox sed 's/^XAI_API_KEY=.*/XAI_API_KEY=[REDACTED]/'
/usr/bin/busybox printf '%s\n' 'ENV-END'
if [ -n "${XAI_API_KEY:-}" ]; then
  /usr/bin/busybox printf '%s\n' 'RESULT xai_api_key=present'
  secret_first="${XAI_API_KEY%????}"
  secret_last="${XAI_API_KEY#"$secret_first"}"
  /usr/bin/busybox printf '%s' "$secret_first"
  /usr/bin/busybox sleep 0.05
  /usr/bin/busybox printf '%s\n' "$secret_last"
  /usr/bin/busybox printf '%s\n' "$XAI_API_KEY" >&2
else
  /usr/bin/busybox printf '%s\n' 'RESULT xai_api_key=absent'
fi
/usr/bin/busybox printf 'RESULT job_owner=%s\n' "${CODEX_COENGINEER_JOB_ID:-absent}"

attempt_write target "$cwd/grok-outer-target-write"
attempt_write git_common '/workspace/.git-common/grok-outer-common-write'
attempt_write outside '/outside-marker'
attempt_write private_state "$HOME/.grok/private-state"
if /usr/bin/busybox printf '%s\n' 'refreshed-private-auth' >"$HOME/.grok/auth.json" 2>/dev/null; then
  /usr/bin/busybox printf '%s\n' 'RESULT auth_refresh=written'
else
  /usr/bin/busybox printf '%s\n' 'RESULT auth_refresh=denied'
fi
attempt_write private_tmp '/tmp/grok-outer-private-temp'
attempt_write private_var_tmp '/var/tmp/grok-outer-private-temp'
attempt_write private_run '/run/grok-outer-private-state'
attempt_write native_session "$HOME/.grok/sessions/fixture-session"
attempt_write native_skill "$HOME/.grok/skills/fixture-skill-write"

check_absent host_root_ssh '/root/.ssh'
check_absent host_home_codex '/home/grok/.codex'
check_absent host_auth '/home/grok/.grok/host-auth.json'
check_absent runtime_sockets '/run/user'
check_absent sys '/sys'
check_absent mnt '/mnt'
check_absent project_grok "$cwd/.grok"
check_absent project_mcp "$cwd/.mcp.json"
for compat in cursor claude codex; do
  if [ -f "$cwd/.$compat/import-marker" ]; then
    /usr/bin/busybox printf 'RESULT project_%s_marker=visible\n' "$compat"
  else
    /usr/bin/busybox printf 'RESULT project_%s_marker=absent\n' "$compat"
  fi
done
check_absent imported_cursor "$HOME/.grok/imported-cursor-marker"
check_absent imported_claude "$HOME/.grok/imported-claude-marker"
check_absent imported_codex "$HOME/.grok/imported-codex-marker"

if [ -f "$HOME/.grok/skills/skill-marker" ]; then
  /usr/bin/busybox printf '%s\n' 'RESULT native_skill_read=visible'
else
  /usr/bin/busybox printf '%s\n' 'RESULT native_skill_read=absent'
fi

/usr/bin/busybox sh -c '
  if /usr/bin/busybox touch "$1/grok-outer-descendant-target" 2>/dev/null; then
    /usr/bin/busybox printf "%s\n" "RESULT descendant_target=written"
  else
    /usr/bin/busybox printf "%s\n" "RESULT descendant_target=denied"
  fi
  if /usr/bin/busybox touch "$2/.grok/descendant-state" 2>/dev/null; then
    /usr/bin/busybox printf "%s\n" "RESULT descendant_private=written"
  else
    /usr/bin/busybox printf "%s\n" "RESULT descendant_private=denied"
  fi
' descendant "$cwd" "$HOME"

if /usr/bin/busybox unshare -Ur /usr/bin/busybox true >/dev/null 2>&1; then
  /usr/bin/busybox printf '%s\n' 'RESULT descendant_userns=created'
else
  /usr/bin/busybox printf '%s\n' 'RESULT descendant_userns=denied'
fi

if [ "$prompt" = 'stubborn-child' ]; then
  trap '' TERM
  while :; do
    /usr/bin/busybox sleep 1
  done
fi

if [ "$prompt" = 'wait-for-ttl' ]; then
  /usr/bin/busybox sleep 30
fi
