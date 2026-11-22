D=$(ls -d /home/ubuntu/dazl-87505c47*-prod | head -1)/web; echo "RELEASE $D"
P=$(sudo ss -ltnp 2>/dev/null | grep ':3105 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
K=$(sudo cat /proc/$P/environ | tr '\0' '\n' | grep -E '^ANTHROPIC_API_KEY=' | cut -d= -f2-); echo "KEY_LEN ${#K}"
curl -sf https://raw.githubusercontent.com/gagan114662/dazl/quest-proof/qc/run1395.mts -o /tmp/r1395.mts
(cd $D && QK=$K timeout 120 node --experimental-strip-types --no-warnings /tmp/r1395.mts $D 2>&1 | tail -60); unset K; rm -f /tmp/r1395.mts; echo DONE1395
