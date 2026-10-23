# Same-port release recovery helper (local review candidate)

Not run on the host. No restart is authorized by this file.

Preflight requires explicit new/rollback web stage paths, full commit markers,
private env-file path, exact listener PID, port, and readable /proc listener
ownership. Checks .build-commit, .next/BUILD_ID, package.json, current listener
cwd/socket ownership and exact localhost health commit. No systemd assumption.

Default does not signal/start. --execute is a separate authorized action:
SIGTERM only exact old listener; wait for port release; start npm in new stage;
wait for exact new health SHA; otherwise stop new isolated process group, wait
for port release, start old stage and verify old SHA. No kill-by-name or SIGKILL.
Old-stop timeout does not start a competing listener. Unhealthy rollback reports
manual recovery required. Same-port cutover necessarily has a short outage.

Env format: blank/comment lines, optional export, KEY=literal or quoted literal.
No expansion ($ or backticks), duplicate keys, multiline or unquoted spaces.
Unsupported syntax fails with a fixed error code, never the raw line or value.
Inline comments are intentionally unsupported; # in values remains literal.
Real-file compatibility is UNVERIFIED and must not be assumed from synthetic tests.
Read permission mode must be private and env symlinks are refused. No secret in
arguments; values passed only in child environment. Parent environment is not
copied except operational PATH default and HOME. Application output goes to
/dev/null, so no launch log can accidentally duplicate env; this sacrifices
application diagnostics. No secret/class/value is printed or counted.

Remaining host checks before execution: stage marker presence/correctness,
listener PID/socket/cwd, node/npm executable availability under PATH, mode600
file metadata and parser preflight status only, localhost health SHA, backup
and rollback prerequisites. Do not read launchers, env text, or process environ.
Public health must also be checked after authorized switch. No public success
is inferred from localhost alone. App schema/backup compatibility is outside
this helper: coordinate a separately verified DB backup before execution.

Tests: python3 -m unittest discover -s ops -p 'test_safe_launch.py'. Synthetic
parser inputs, subprocess non-output of sentinel secret on errors, argv/output
handling, dry-run no signal, exact listener refusal, success/rollback ordering,
old-listener timeout. Mocked lifecycle tests are not real host proof.

## Revision safety gates

Requires nonempty DB_PATH, DAZL_MASTER_KEY, PUBLIC_BASE_URL; DB_PATH must name an
existing nonempty absolute database. Caller must supply exact verified backup
path, backup-db identity matching DB_PATH and backup-verified attestation; helper
also independently checks read-only SQLite backup integrity. Backup recency and
correspondence to live DB still need separately grounded main coordination.
Requires env regular-file ownership by executing uid, private mode and no symlink
in file/parent path. Rejects backslashes rather than silently unescaping values.
Rejects env PATH/NODE_OPTIONS/NODE_PATH/LD preload/library and npm shell/prefix
overrides; resolves and pins root-owned non-group/world-writable npm/node before
stop. No shell lookup of npm after stop. Health redirects disabled. Reusable-port
probe handles TIME_WAIT. /proc PPid/cgroup metadata refuses supervised/unrecognised
process trees; direct-orphan PPid1 only. This intentionally will NOT support the
previously observed npm/sh/next chain without a separately reviewed reconciliation.
Never bypass that refusal by guessing a parent PID or stopping a supervisor.
Remaining PID recheck has a small TOCTOU window; no pidfd implementation claimed.

## Observed-ancestry revision

The earlier PPid1-only guard is superseded. Metadata-only inspection established
listener next-server -> sh -> npm start -> PID1, all same stage cwd and scope,
not .service/container. check_process now accepts only that bounded chain with
same executing uid/cwd/cgroup, refuses other supervisor/container/service facts,
and repeats just before SIGTERM. No parent signal, arbitrary ancestor traversal
or new supervisor installation. Real process facts can change; execution must
revalidate, not reuse historical PIDs blindly.
