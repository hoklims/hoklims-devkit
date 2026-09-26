#!/bin/bash
# usage: run.sh <id> <red|green|gap> <testfile> <regex>
WORK=/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/w-C-preflight-versions
EVID=/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/evidence/C-preflight-versions
id=$1; kind=$2; file=$3; re=$4
cd $WORK
log=$EVID/$id.$kind.log
[ "$kind" != green ] && git diff > $EVID/$id.patch
{ echo "\$ cd $WORK && rtk proxy bun test $file -t '$re'"; echo "HEAD=$(git rev-parse HEAD)"; echo "--- diff stat:"; git diff --stat; echo "---"; } > $log
rtk proxy bun test $file -t "$re" >> $log 2>&1
code=$?
echo "EXIT CODE: $code" >> $log
echo "$id $kind exit=$code"
grep -E '^\(fail\)|^\(pass\)| pass$| fail$|Ran ' $log | tail -25
