# apply.py <mutation-id>...  : apply named mutations from mutmap.py's list M (no test run)
import sys, re
src = open(__file__.replace("apply.py","mutmap.py")).read()
ns = {}
exec(src.split("only = sys.argv")[0], ns)
W = ns["W"]; M = {m[0]: m for m in ns["M"]}
for mid in sys.argv[1:]:
    _, f, old, new = M[mid]; p = f"{W}/{f}"; s = open(p).read()
    assert s.count(old) >= 1, mid
    open(p, "w").write(s.replace(old, new)); print("applied", mid)
