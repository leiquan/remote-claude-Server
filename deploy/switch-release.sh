#!/bin/sh
# Point a temporary release root at one version. Refuses system paths. Does not call systemctl.
set -eu
ROOT=${1:?root}
VERSION=${2:?version}
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
if [ ! -d "$ROOT/releases/$VERSION" ]; then
  echo "missing release"
  exit 1
fi
if [ -L "$ROOT/current" ]; then
  target=$(readlink "$ROOT/current")
  ln -sfn "$target" "$ROOT/previous.new"
  mv -Tf "$ROOT/previous.new" "$ROOT/previous"
fi
ln -sfn "releases/$VERSION" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"
echo "switched $VERSION"
exit 0
