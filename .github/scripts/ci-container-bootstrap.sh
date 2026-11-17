#!/usr/bin/env bash
# Privileged setup only. Original test/build commands run through ci-bash as UID1001.
set -euo pipefail
[ "$(id -u)" -eq 0 ]
# Minimal Ubuntu images have no initialized machine-id. Give each disposable
# job its own OS identity; never mount/copy the runner host's identity.
initialize_ci_machine_id() {
  python3 - "$1" <<'CI_MACHINE_ID'
from pathlib import Path
import sys
import uuid
Path(sys.argv[1]).write_text(uuid.uuid4().hex + '\n')
CI_MACHINE_ID
}
initialize_ci_machine_id /etc/machine-id
useradd --create-home --uid 1001 --shell /bin/bash ci
printf '%s\n' 'ci ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/dazl-ci
chmod 0440 /etc/sudoers.d/dazl-ci
mkdir -p /tmp/ci-npm-cache
chown ci:ci /tmp/ci-npm-cache
chmod 1777 "$RUNNER_TEMP"
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
printf 'CI test/build effective UID: '
sudo -u ci id -u
# Docker exec and PAM/sudo may reset the mask. Establish it in the final
# non-root process, not merely in the listener or container entrypoint.
exec sudo -E -H -u ci env "PATH=$PATH" /bin/bash --noprofile --norc -c \
  'umask 0022; exec /bin/bash --noprofile --norc -e -o pipefail "$@"' ci-bash "$@"
CI_SHELL
chmod 0755 /usr/local/bin/ci-bash
