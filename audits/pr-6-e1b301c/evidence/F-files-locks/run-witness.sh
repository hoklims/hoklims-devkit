#!/usr/bin/env bash
# usage: run-witness.sh <id> <testfile> <name-regex>   (mutation must already be applied in WORK)
set -u
W=/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/w-F-files-locks
E=/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/evidence/F-files-locks
id=$1; file=$2; name=$3
cd "$W"
git diff > "$E/$id.patch"
[ -s "$E/$id.patch" ] || { echo "NO MUTATION APPLIED"; exit 9; }
cmd="rtk proxy bun test $file -t '$name'"
{ echo "\$ $cmd"; eval "$cmd" 2>&1; echo "EXIT=$?"; } > "$E/$id.red.log"
red=$(grep -o 'EXIT=[0-9]*' "$E/$id.red.log")
git checkout -- . ; [ -z "$(git status --porcelain)" ] || { echo "TREE NOT CLEAN"; exit 8; }
{ echo "\$ $cmd"; eval "$cmd" 2>&1; echo "EXIT=$?"; } > "$E/$id.green.log"
green=$(grep -o 'EXIT=[0-9]*' "$E/$id.green.log")
echo "$id red:$red green:$green"
grep -E '^\(fail\)|^\(pass\)|error:|Expected|Received' "$E/$id.red.log" | head -12
