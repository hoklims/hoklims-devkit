import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
n = s.count(old)
if n != 1: sys.exit(f"expected exactly 1 occurrence, found {n}: {old!r}")
open(path, "w").write(s.replace(old, new))
