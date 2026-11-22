set -e
D=/home/ubuntu/dazl-746ac1b7-prod/web; G=https://raw.githubusercontent.com/gagan114662/dazl; Q=$G/quest-proof/qc
rm -rf /tmp/dzq; mkdir -p /tmp/dzq; cd /tmp/dzq
curl -sf $Q/run.mts -o run.mts
mkdir -p site/team site/team2 site/careers; for p in index.html team/index.html team2/index.html careers/index.html; do curl -sf $Q/site/$p -o site/$p; done
mk(){ mkdir -p $1/web; cp -r $D/lib $1/web/lib; ln -s $D/node_modules $1/web/node_modules; cp $D/package.json $1/web/ 2>/dev/null || true; }
ln -s $D/node_modules /tmp/dzq/node_modules; cp $D/package.json /tmp/dzq/ ; mk post
mk pre1207; curl -sf $G/ee0f5564f986147973d7f362f60cc7d1937bbc13/web/lib/people/email-pattern.ts -o pre1207/web/lib/people/email-pattern.ts
mk pre1208; for f in lib/people/email-pattern.ts lib/connectors/sitecrawl.ts; do curl -sf $G/4892262e8989bc9b16c4bba138a488554dd5d07e/web/$f -o pre1208/web/$f; done
mk pre1139; curl -sf $G/5f5a652482d13e04564c080840c0aff15aecb910/web/lib/scan/scoreboard.ts -o pre1139/web/lib/scan/scoreboard.ts
sudo cp -a /etc/caddy/Caddyfile /home/ubuntu/Caddyfile.bak-dazltest
echo SETUP_OK
