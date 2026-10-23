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
