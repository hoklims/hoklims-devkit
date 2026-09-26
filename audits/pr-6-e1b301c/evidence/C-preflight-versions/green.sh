#!/bin/bash
WORK=/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/w-C-preflight-versions
EVID=/tmp/claude-1000/-home-laegel--claude-session/e90c724e-4ef0-48ad-8599-172e694fc5f1/scratchpad/evidence/C-preflight-versions
cd $WORK && git checkout -- . && [ -z "$(git status --porcelain)" ] || { echo DIRTY; git status --porcelain; exit 9; }
$EVID/run.sh "$@"
