set -e
sudo mkdir -p /srv/dazl-test && sudo cp -r /tmp/dzq/site/. /srv/dazl-test/ && sudo chmod -R a+rX /srv/dazl-test
sudo cp -a /etc/caddy/Caddyfile /home/ubuntu/Caddyfile.bak-dazltest
sudo sed -i '1a\\thandle_path /dazl-test/* {\n\t\troot * /srv/dazl-test\n\t\theader X-Robots-Tag "noindex, nofollow"\n\t\tfile_server\n\t}' /etc/caddy/Caddyfile
sudo head -9 /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1
sudo systemctl reload caddy
sleep 2; for p in / /team/ /team2/ /careers/; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' https://dazl.ai/dazl-test$p)"; done
curl -sI https://dazl.ai/dazl-test/ | grep -i robots; curl -s https://dazl.ai/api/health | head -c 60; echo
