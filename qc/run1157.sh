D=$(ls -d /home/ubuntu/dazl-527b2a4e*-prod | head -1)/web; echo "RELEASE $D"; G=https://raw.githubusercontent.com/gagan114662/dazl; PRE=5e5d7e4d332ad7c52f53abf23126ed7270b6bb77
rm -rf /tmp/dzq; mkdir -p /tmp/dzq; cd /tmp/dzq
mk(){ mkdir -p $1/web; (cd $D && tar --exclude=./node_modules --exclude=./.next -cf - .) | (cd $1/web && tar -xf -); ln -s $D/node_modules $1/web/node_modules; }
mk post; mk pre
for f in app/app/leads/leads-client.tsx lib/llm/claude-web-search.ts lib/scan/progress.ts lib/scan/provider-issue-text.ts lib/scan/scan-outcome.ts lib/scan/status-read-service.ts lib/scan/status-reads.ts ; do curl -sf $G/$PRE/web/$f -o pre/web/$f || echo "pre has no $f"; done
T="test/claude-search-stall-1157.test.ts test/running-step-progress-1157.test.ts test/accounting-definite-1157.test.ts test/one-source-fails-1157.test.ts"
for v in post pre; do echo "===== $v"; (cd /tmp/dzq/$v/web && for t in $T; do r=$(SITECRAWL_ENABLED=0 NEWS_SEARCH_ENABLED=0 timeout 240 node --experimental-strip-types --no-warnings --import ./test/helpers/net-fence.ts --test $t 2>&1); echo "$t: $(echo "$r" | grep -E '^(# |ℹ )(pass|fail)' | tr '\n' ' ')"; echo "$r" | grep -E "^not ok|^# (tests|pass|fail)|^ℹ (tests|pass|fail)|✖|Error" | head -8 | cut -c1-160; [ -z "$(echo "$r" | grep -E "pass|fail")" ] && echo "$r" | tail -12 | cut -c1-200; done); done
cd ~; rm -rf /tmp/dzq; echo "CLEANED $(ls /tmp/dzq 2>&1 | head -1)"
