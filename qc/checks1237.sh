cd /tmp/dzq; for v in post pre1237; do echo "===== $v"; node --experimental-strip-types --no-warnings run.mts /tmp/dzq/$v/web 2>&1 | tail -20; done; cd ~
