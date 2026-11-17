#!/bin/sh
# Remove a first install that has no previous version. This is not a version rollback.
set -eu
ROOT=${1:?root}
case "$ROOT" in
  /*) ;;
  *) echo "root must be absolute"; exit 1 ;;
esac
case "$ROOT" in
  /|/etc|/etc/*|/usr|/usr/*|/lib|/lib/*|/opt|/opt/*|/run|/run/*|/bin|/bin/*)
    echo "refusing system path"
    exit 1
    ;;
esac
if [ ! -f "$ROOT/RELEASE_ROOT_OK" ]; then
  echo "missing RELEASE_ROOT_OK"
  exit 1
fi
if [ -e "$ROOT/previous" ]; then
  echo "previous exists; use rollback-release.sh"
  exit 2
fi
if [ ! -e "$ROOT/current" ]; then
  echo "nothing installed"
  exit 3
fi
rm -f "$ROOT/current"
echo "removed first install"
exit 0
