#!/bin/bash
# usage: witness.sh <id> <kind: red|gap> <test file> [-t regex]   (mutation must already be applied in WORK)
W=/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/w-HI-release-hostcmd
E=/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/evidence/HI-release-hostcmd
id=$1; kind=$2; shift 2
cd $W
git diff > $E/$id.patch
{ echo "\$ rtk proxy bun test $*"; rtk proxy bun test "$@" 2>&1; echo "EXIT=$?"; } > $E/$id.$kind.log
git checkout -- . ; [ -z "$(git status --porcelain)" ] || echo "DIRTY!"
{ echo "\$ rtk proxy bun test $*"; rtk proxy bun test "$@" 2>&1; echo "EXIT=$?"; } > $E/$id.green.log
echo "== $id $kind"; grep -E "^\(fail\)|EXIT=| pass$| fail$" $E/$id.$kind.log; echo "-- green"; grep -E "EXIT=" $E/$id.green.log
