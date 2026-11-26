#!/usr/bin/env bash
# PC lane only (docs/CI-PC.md): privileged setup inside the disposable job container on the isolated dazl-ci runner.
# The original test/build commands then run through ci-bash as the non-root uid 1001, so permission-sensitive tests
# keep executing instead of passing vacuously as root. Never used on GitHub-hosted runners.
set -euo pipefail
[ "$(id -u)" -eq 0 ]
# Minimal Ubuntu images have no initialized machine-id. Give each disposable
# job its own OS identity; never mount/copy the runner host's identity.
python3 -c 'import uuid, sys; open(sys.argv[1], "w").write(uuid.uuid4().hex + "\n")' /etc/machine-id
useradd --create-home --uid 1001 --shell /bin/bash ci
printf '%s\n' 'ci ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/dazl-ci
chmod 0440 /etc/sudoers.d/dazl-ci
mkdir -p /tmp/ci-npm-cache
chown ci:ci /tmp/ci-npm-cache
chmod 1777 "$RUNNER_TEMP"
# One npm cache for setup-node's cache step (root) and the commands (ci).
echo "NPM_CONFIG_CACHE=/tmp/ci-npm-cache" >> "$GITHUB_ENV"
cat > /usr/local/bin/ci-bash <<'CI_SHELL'
#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -eq 0 ]
[ -d "$GITHUB_WORKSPACE" ] && [ ! -L "$GITHUB_WORKSPACE" ]
# JavaScript actions retain the standard root container context; hand their outputs
# to the unprivileged command user without relaxing source-file modes.
chown -R ci:ci -- "$GITHUB_WORKSPACE" /tmp/ci-npm-cache
for name in GITHUB_ENV GITHUB_OUTPUT GITHUB_PATH GITHUB_STEP_SUMMARY GITHUB_STATE; do
  file="${!name:-}"
  if [ -n "$file" ] && [ -f "$file" ]; then chown ci:ci -- "$file"; fi
done
# Docker exec and PAM/sudo may reset the mask. Establish it in the final
# non-root process, not merely in the listener or container entrypoint.
exec sudo -E -H -u ci env "PATH=$PATH" /bin/bash --noprofile --norc -c \
  'umask 0022; exec /bin/bash --noprofile --norc -e -o pipefail "$@"' ci-bash "$@"
CI_SHELL
chmod 0755 /usr/local/bin/ci-bash
printf 'CI test/build effective UID: '
sudo -u ci id -u
