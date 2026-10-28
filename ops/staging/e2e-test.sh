#!/usr/bin/env bash
# End-to-end test of ops/staging/deploy.sh as root on a throwaway machine (docs/STAGING.md). NOT run in CI: it creates
# a system user and runs real npm/next builds. Everything lives under one temporary directory; the "service" is
# next start launched as the service user with the env file's values passed by root (as systemd's EnvironmentFile and
# User= would). Run from the repo root:  sudo bash ops/staging/e2e-test.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 2; }
SRC=$(git rev-parse --show-toplevel)
T=$(mktemp -d /tmp/dazl-staging-e2e.XXXX); chmod 755 "$T"
U=dazl-staging-e2e
id "$U" >/dev/null 2>&1 || useradd --system --home-dir "$T/home" --create-home --shell /usr/sbin/nologin "$U"
PORT=${E2E_PORT:-3299}
pass() { echo "PASS $*"; }
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' # root's own git calls on the service-owned test repo
die() { echo "FAIL $*"; exit 1; }

# a repo whose main is the commit under test
git clone -q --bare "$SRC" "$T/origin.git"; git -C "$T/origin.git" update-ref refs/heads/main "$(git -C "$SRC" rev-parse HEAD)"
chown -R "$U" "$T/origin.git"
# production's database (must never be touched) and the staging env file: root-only directory, root-owned, mode 600
mkdir -p "$T/prod" && echo production > "$T/prod/app.db"
install -d -m 700 "$T/etc"; install -d -o "$U" -m 750 "$T/staging-data"
cat > "$T/etc/env" <<ENV
DAZL_ENV=staging
PUBLIC_BASE_URL=https://staging.example.test
DB_PATH=$T/staging-data/app.db
DAZL_MASTER_KEY=$(openssl rand -base64 32)
STRIPE_SECRET_KEY=sk_test_e2e
STRIPE_PRICE_PRO=price_e2e
STRIPE_WEBHOOK_SECRET=whsec_e2e
STAGING_DEMO_PASSWORD=$(openssl rand -hex 12)
ENV
chmod 600 "$T/etc/env"
runuser -u "$U" -- cat "$T/etc/env" >/dev/null 2>&1 && die "the service user can read the env file"
pass "env file is root-only (600) and unreadable by $U"

# the stand-in for systemctl restart: root reads the env file, the app runs as the service user
cat > "$T/restart.sh" <<RS
#!/usr/bin/env bash
# like systemctl restart: stop everything the service runs, and wait until the port is free
pkill -u $U || true
for i in \$(seq 1 40); do (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null || break; sleep 0.5; done
( set -a; . $T/etc/env; set +a; cd $T/root/current/web && DAZL_COMMIT_SHA=\$(cat .build-commit) exec setsid runuser -u $U -- npx next start -p $PORT -H 127.0.0.1 ) > $T/app.log 2>&1 < /dev/null &
RS
chmod +x "$T/restart.sh"
export STAGING_ROOT="$T/root" STAGING_ENV_FILE="$T/etc/env" STAGING_PORT=$PORT STAGING_USER=$U STAGING_REPO_URL="file://$T/origin.git" STAGING_RESTART="$T/restart.sh" PROD_DB_PATH="$T/prod/app.db"
mkdir -p "$T/root"; chown "$U" "$T/root"
D="bash $SRC/ops/staging/deploy.sh"
sha() { git -C "$T/origin.git" rev-parse main; }
commit() { # a new main commit on top of the current one, changing one file (made as the repo's owner)
  local w=$T/work; rm -rf "$w"; install -d -o "$U" "$w"
  runuser -u "$U" -- bash -c "git clone -q -b main '$T/origin.git' '$w' && cd '$w' && $1 && git -c user.email=e2e@example.test -c user.name=e2e commit -qam '$2' && git push -q origin HEAD:main"; }

# 1. floor: skipped (not failed), alerted, nothing created
echo 'echo "$1" >> '"$T"'/alerts.log' > "$T/alert.sh"
out=$(MIN_FREE_BYTES=999999999999999 STAGING_ALERT_CMD="bash $T/alert.sh" $D 2>&1) || die "a low-disk skip exited non-zero: $out"
echo "$out" | grep -q "ALERT low_disk: skipped" || die "no low-disk alert: $out"
grep -q '"reason":"low_disk"' "$T/alerts.log" || die "the alert command did not receive the alert"
[ -z "$(ls -A "$T/root/releases")" ] || die "a release was created under the floor"
pass "under the disk floor: skipped with exit 0, alert sent ($(head -c 160 "$T/alerts.log")), no release created"

# 2. first deploy as the service user
$D
s1=$(sha)
curl -fsS "http://127.0.0.1:$PORT/api/health" | grep -q "\"commit\":\"$s1\"" || die "health does not report $s1"
[ "$(stat -c %U "$T/root/releases/$s1/web/.next")" = "$U" ] || die "build output not owned by $U"
[ "$(stat -c '%U %a' "$T/etc/env")" = "root 600" ] || die "env file permissions changed"
curl -fsS "http://127.0.0.1:$PORT/" | grep -q "Staging - test data" || die "no staging banner"
runuser -u "$U" -- node -e "const D=require('$T/root/current/web/node_modules/better-sqlite3');const d=new D('$T/staging-data/app.db');if(!d.prepare(\"select 1 from users where email='demo@staging.dazl.test'\").get())process.exit(1)" || die "demo account not seeded"
[ "$(cat "$T/prod/app.db")" = production ] || die "production database touched"
pass "first deploy: live $s1 as $U, banner served, demo seeded, env file still root 600, production db untouched"

# 3. same commit again: nothing to do
out=$($D 2>&1); [ -z "$out" ] || die "re-run printed: $out"
[ "$(ls "$T/root/releases" | wc -l)" = 1 ] || die "a no-op run created a release"
pass "re-run on the same commit: no-op (lock free, nothing printed)"

# 4. a new commit with the same lockfile: node_modules hard-linked from the live release
commit "echo >> README.md" "e2e second release"; s2=$(sha)
$D
curl -fsS "http://127.0.0.1:$PORT/api/health" | grep -q "\"commit\":\"$s2\"" || die "health does not report $s2"
f=web/node_modules/next/package.json
[ "$(stat -c %i "$T/root/releases/$s1/$f")" = "$(stat -c %i "$T/root/releases/$s2/$f")" ] || die "node_modules not hard-linked"
pass "second release: live $s2, node_modules hard-linked (shared inodes), previous release kept for rollback"

# 5. a commit that does not build: removed, the live release keeps serving
commit "echo 'export default function P() { return <div> }' > web/app/terms/page.tsx" "e2e broken build"; s3=$(sha)
if $D > "$T/d5.log" 2>&1; then die "a broken build deployed"; fi; tail -1 "$T/d5.log"
[ ! -e "$T/root/releases/$s3" ] || die "the failed release was left behind"
curl -fsS "http://127.0.0.1:$PORT/api/health" | grep -q "\"commit\":\"$s2\"" || die "live release changed after a failed build"
pass "broken commit: build failed, its release removed, $s2 still live"

# 6. free space reaches the floor during the build: stopped, release removed
commit "git -c user.email=e2e@example.test -c user.name=e2e revert --no-edit HEAD >/dev/null && echo >> README.md" "e2e fixed"; s4=$(sha)
avail=$(df -B1 --output=avail "$T/root" | tail -1 | tr -d ' '); est=$(du -sb --exclude=node_modules "$T/root/current/web" | cut -f1)
# a floor the pre-check just clears, which the build's own writes then cross
if out=$(DISK_RESERVE_BYTES=0 MIN_FREE_BYTES=$(( avail - est - 5000000 )) $D 2>&1); then die "deployed although the build crossed the floor"; fi
echo "$out" | grep -q "fell below the floor plus reserve" || die "no mid-build floor stop: $(echo "$out" | tail -3)"
[ ! -e "$T/root/releases/$s4" ] || die "release left behind after the floor stop"
curl -fsS "http://127.0.0.1:$PORT/api/health" | grep -q "\"commit\":\"$s2\"" || die "live release changed after the floor stop"
pass "floor reached during the build: build stopped, release removed, $s2 still live"

pkill -u "$U" || true
echo "ALL PASS ($T)"
