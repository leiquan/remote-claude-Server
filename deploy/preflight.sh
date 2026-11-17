#!/bin/sh
# Read-only preflight. Does not install units, edit nginx, start services, or print secret values.
set -u
hard=0

echo "deploy_ready=false"
echo "preflight_changes=none"

if command -v node >/dev/null 2>&1; then
  node_v=$(node -v 2>/dev/null || true)
  major=${node_v#v}
  major=${major%%.*}
  case "$major" in
    ''|*[!0-9]*)
      echo "node_runtime=unparsed"
      hard=1
      ;;
    *)
      if [ "$major" -ge 22 ]; then
        echo "node_runtime=$node_v"
      else
        echo "node_runtime=too_old"
        hard=1
      fi
      ;;
  esac
else
  echo "node_runtime=missing"
  hard=1
fi

if command -v npm >/dev/null 2>&1; then
  echo "npm=present"
else
  echo "npm=missing"
  hard=1
fi

if [ -n "${BROWSER_EXECUTABLE:-}" ]; then
  if [ ! -x "$BROWSER_EXECUTABLE" ]; then
    echo "browser_executable=unusable"
    hard=1
  else
    if "$BROWSER_EXECUTABLE" --version >/dev/null 2>&1; then
      echo "browser_executable=usable"
    else
      version_status=$?
      echo "browser_executable=unusable"
      echo "browser_version_exit=$version_status"
      hard=1
    fi
  fi
else
  found=""
  for candidate in google-chrome google-chrome-stable chromium-browser chromium; do
    if command -v "$candidate" >/dev/null 2>&1; then
      found=$candidate
      break
    fi
  done
  if [ -n "$found" ]; then
    echo "browser_executable=discovered"
  else
    echo "browser_executable=missing"
  fi
fi

if [ -n "${DISPLAY:-}" ]; then
  echo "display=present"
else
  echo "display=unknown"
fi
echo "sandbox=unknown"
echo "permissions=unknown"
if [ -r /proc/meminfo ]; then
  mem=$(awk '/MemAvailable:/ { print $2; exit }' /proc/meminfo)
  if [ -n "$mem" ]; then
    echo "mem_available_kb=$mem"
  else
    echo "mem_available_kb=unknown"
  fi
else
  echo "mem_available_kb=unknown"
fi
if command -v nproc >/dev/null 2>&1; then
  echo "cpu_count=$(nproc)"
else
  echo "cpu_count=unknown"
fi
if [ -n "${GATEWAY_PORT:-}" ]; then
  case "$GATEWAY_PORT" in
    ''|*[!0-9]*) echo "gateway_port=unknown" ;;
    *) echo "gateway_port=$GATEWAY_PORT" ;;
  esac
else
  echo "gateway_port=unset"
fi
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-enabled remote-claude-gateway.service >/dev/null 2>&1; then
    echo "unit_remote_claude_gateway=enabled"
  else
    unit_status=$?
    echo "unit_remote_claude_gateway=not_enabled"
    echo "unit_query_exit=$unit_status"
  fi
else
  echo "unit_remote_claude_gateway=unknown"
fi
echo "tls=unknown"
if [ -n "${GATEWAY_ACCESS_TOKEN:-}" ]; then
  echo "GATEWAY_ACCESS_TOKEN=present"
else
  echo "GATEWAY_ACCESS_TOKEN=unset"
fi
echo "env names only: GATEWAY_BIND_HOST GATEWAY_BASE_PATH REMOTE_CLAUDE_ADAPTER BROWSER_HOST BROWSER_ALLOWLIST BROWSER_HEADLESS"
exit "$hard"
