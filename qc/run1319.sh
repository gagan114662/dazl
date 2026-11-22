D=$(ls -d /home/ubuntu/dazl-87505c47*-prod | head -1)/web; echo "RELEASE $D"; G=https://raw.githubusercontent.com/gagan114662/dazl
rm -rf /tmp/dzq; mkdir -p /tmp/dzq; cd /tmp/dzq
mk(){ mkdir -p $1/web; (cd $D && tar --exclude=./node_modules --exclude=./.next -cf - .) | (cd $1/web && tar -xf -); ln -s $D/node_modules $1/web/node_modules; }
pull(){ v=$1; s=$2; shift 2; for f in "$@"; do curl -sf $G/$s/web/$f -o $v/web/$f || { rm -f $v/web/$f; echo "$v: no $f at ${s:0:8}"; }; done; }
mk post; mk pre1536; mk pre1474
pull pre1536 327a1e0301e8c5aa1d235231f7332002261b6a45 app/api/scan/route.ts lib/scan/estimate-request.ts lib/scan/price-estimate.ts test/helpers/estimate-route-runtime.mts test/helpers/scan-route-runtime.mts
pull pre1474 21869d17a4f5dc30809f115c9d7cc1a19218ba22 app/api/auth/callback/google/route.ts app/api/auth/google/route.ts app/api/scan/route.ts app/app/leads/estimate-confirm.tsx app/app/leads/leads-client.tsx app/app/settings/account-panel.tsx app/app/trial-refusal-notice.tsx lib/auth-google-response.ts lib/google-link.ts lib/scan/price-estimate.ts lib/scan/status-read-service.ts lib/scan/status-reads.ts test/helpers/google-auth-route-runtime.mts test/helpers/google-link-taken-1319-runtime.mts test/helpers/trial-cost-cap-1319-runtime.mts
run(){ v=$1; shift; echo "===== $v"; (cd /tmp/dzq/$v/web && for t in "$@"; do r=$(SITECRAWL_ENABLED=0 NEWS_SEARCH_ENABLED=0 timeout 240 node --experimental-strip-types --no-warnings --import ./test/helpers/net-fence.ts --test $t 2>&1); echo "$t: $(echo "$r" | grep -E '^(# |ℹ )(tests|pass|fail|skipped)' | tr '\n' ' ')"; echo "$r" | grep -E "^not ok|✖|Error" | head -4 | cut -c1-150; done); }
run post test/cost-copy-1319.test.ts test/trial-cost-cap-1319.test.ts test/google-link-taken-1319.test.ts
run pre1536 test/cost-copy-1319.test.ts
run pre1474 test/trial-cost-cap-1319.test.ts test/google-link-taken-1319.test.ts
cd ~; rm -rf /tmp/dzq; echo "CLEANED $(ls /tmp/dzq 2>&1 | head -1)"
