set -e
D=/home/ubuntu/dazl-746ac1b7-prod/web; G=https://raw.githubusercontent.com/gagan114662/dazl; Q=$G/quest-proof/qc
rm -rf /tmp/dzq; mkdir -p /tmp/dzq/site/team; cd /tmp/dzq
curl -sf $Q/run1208.mts -o run.mts; curl -sf $Q/site1208/index.html -o site/index.html; curl -sf $Q/site1208/team/index.html -o site/team/index.html
ln -s $D/node_modules /tmp/dzq/node_modules; cp $D/package.json /tmp/dzq/
mk(){ mkdir -p $1/web; cp -r $D/lib $1/web/lib; ln -s $D/node_modules $1/web/node_modules; cp $D/package.json $1/web/; }
mk post; mk pre1208; for f in lib/people/email-pattern.ts lib/connectors/sitecrawl.ts; do curl -sf $G/4892262e8989bc9b16c4bba138a488554dd5d07e/web/$f -o pre1208/web/$f; done
echo SETUP_OK
