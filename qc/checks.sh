cd /tmp/dzq; for v in post pre1207 pre1208 pre1139; do echo "===== $v"; node --experimental-strip-types --no-warnings run.mts /tmp/dzq/$v/web 2>&1 | tail -60; done
