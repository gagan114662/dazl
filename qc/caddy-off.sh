sudo cp -a /home/ubuntu/Caddyfile.bak-dazltest /etc/caddy/Caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1 && sudo systemctl reload caddy
sudo rm -rf /srv/dazl-test /tmp/dzq /home/ubuntu/Caddyfile.bak-dazltest
sleep 2; echo "page now: $(curl -s -o /dev/null -w '%{http_code}' https://dazl.ai/dazl-test/team/)"; sudo grep -c dazl-test /etc/caddy/Caddyfile; ls /srv/dazl-test /tmp/dzq 2>&1 | head -2; curl -s https://dazl.ai/api/health | head -c 60; echo
