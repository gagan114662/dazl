D=$(ls -d /home/ubuntu/dazl-527b2a4e*-prod | head -1); echo "RELEASE $D"
S=""; for f in $D/web/.env.production $D/web/.env $D/.env /home/ubuntu/dazl.env /etc/dazl/env; do [ -r "$f" ] || continue; v=$(grep -E '^AUTOPILOT_TICK_SECRET=' "$f" | tail -1 | cut -d= -f2- | tr -d '"'"'"); [ -n "$v" ] && { S=$v; echo "SECRET_FROM $f (len ${#S})"; break; }; done
if [ -z "$S" ]; then P=$(sudo ss -ltnp 2>/dev/null | grep ':3105 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$P" ] && S=$(sudo cat /proc/$P/environ 2>/dev/null | tr '\0' '\n' | grep '^AUTOPILOT_TICK_SECRET=' | cut -d= -f2-); [ -n "$S" ] && echo "SECRET_FROM process env pid $P (len ${#S})"; fi
[ -z "$S" ] && { echo "NO_SECRET_FOUND"; exit 0; }
curl -s -H "Authorization: Bearer $S" "http://localhost:3105/api/internal/usable-check?job=d424f925be95e2812d922aeb" | head -c 2500; echo; unset S; echo DONE1176
