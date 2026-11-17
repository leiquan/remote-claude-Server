#!/bin/sh
# Swap current back to the previous release inside a temporary root. Does not call systemctl.
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
if [ ! -L "$ROOT/previous" ]; then
  echo "no previous version"
  exit 4
fi
prev=$(readlink "$ROOT/previous")
if [ -L "$ROOT/current" ]; then
  cur=$(readlink "$ROOT/current")
  ln -sfn "$cur" "$ROOT/previous.new"
  mv -Tf "$ROOT/previous.new" "$ROOT/previous"
fi
ln -sfn "$prev" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"
echo "rolled back to $prev"
exit 0
