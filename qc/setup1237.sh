set -e
D=$(ls -d /home/ubuntu/dazl-5e5d7e4d*-prod | head -1)/web; echo "RELEASE $D"; G=https://raw.githubusercontent.com/gagan114662/dazl; Q=$G/quest-proof/qc
rm -rf /tmp/dzq; mkdir -p /tmp/dzq/site/news /tmp/dzq/site/customers; cd /tmp/dzq
curl -sf $Q/run1237.mts -o run.mts; for p in index.html news/index.html customers/index.html; do curl -sf $Q/site1237/$p -o site/$p; done
ln -s $D/node_modules node_modules; cp $D/package.json .
mk(){ mkdir -p $1/web; cp -r $D/lib $1/web/lib; ln -s $D/node_modules $1/web/node_modules; cp $D/package.json $1/web/; }
mk post; mk pre1237; curl -sf $G/8c0fbab0dfc0cd981d75abcd4bb85bd9236b6d1b/web/lib/scan/counterparty.ts -o pre1237/web/lib/scan/counterparty.ts
echo SETUP_OK
