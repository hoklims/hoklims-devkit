#!/bin/bash
# usage: witness.sh <id> <test-name-regex> [testfile]  (mutation must already be applied in WORK)
S=/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad
WORK=$S/w-G-native-reports; EVID=$S/evidence/G-native-reports
id=$1; rx=$2; f=${3:-test/app.test.js}
cd $WORK
git diff > $EVID/$id.patch
[ -s $EVID/$id.patch ] || { echo "NO MUTATION"; exit 9; }
cmd="rtk proxy bun test $f -t '$rx'"
{ echo "\$ $cmd"; echo "# mutation: $(git diff --stat | tail -1)"; rtk proxy bun test $f -t "$rx" 2>&1; echo "EXIT=$?"; } > $EVID/$id.red.log
red=$(grep '^EXIT=' $EVID/$id.red.log)
git checkout -- . ; st=$(git status --porcelain)
{ echo "\$ $cmd"; echo "# git status --porcelain: '${st}'"; rtk proxy bun test $f -t "$rx" 2>&1; echo "EXIT=$?"; } > $EVID/$id.green.log
green=$(grep '^EXIT=' $EVID/$id.green.log)
echo "$id red:$red green:$green"
grep -E "^\(fail\)|^ *[0-9]+ (pass|fail)" $EVID/$id.red.log
