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


## Protected database directory boundary

Original user handover protects dazl-data. No deployment takeover overrides it.
Source DB readonly snapshot and restore rehearsal require a separate original
user permission. Backup/rehearsal outputs must be outside the source directory
and descendants; backup_preflight enforces this before creating files. No
production DB restore, directory hygiene edits, rotation or8795 action follows
from snapshot permission. Historical backup mode644 remains unchanged.


## Literal unquoted value compatibility

Reviewed fixedcategory-only check established unquoted_multiword as existingenv
rejection. Parser accepts quote-free values literally including spaces, matching
known legacy Python split semantics. $/backticks/backslash/NUL remain refused;
quoted values still strict single-token parsing. No shell, source, interpolation,
secret output or env rewriting. Existing env content itself was never displayed.

## Required outer preflights must stop the launch

The October30,2026 release used a shell sequence where an extra required SQL check failed but a later launch command still ran. The internal launch checks passed and later health/no-work checks were good, but neither makes that outer check a preflight success.

For every future cutover, invoke `ops/checked_launch.py` as the single outer command. Pass each required check as a `--preflight` JSON argv array, followed by the one `--launch` argv array for `safe_launch.py --execute`. Include disk, live identity/config, pending-work, backup, release-gate and internal dry-run checks. Do not execute a launch in a following shell line. A missing command, nonzero exit or timeout stops the sequence before launch. Child output is suppressed to avoid credential logging; inspect nonsecret preflight reports separately when needed. Never put secrets in argv.

`python3 -m unittest ops/test_checked_launch.py` independently runs the CLI with a deliberately failing command, nonexistent command and timeout, and proves neither a later preflight nor a sentinel launch is reached. A positive control proves successful preflights launch once. This wrapper does not create deployment permission and does not replace any required check.

## Exact-main CI is part of the entrypoint

`checked_launch.py` requires `--repository gagan114662/dazl --commit <full SHA>`. The repository is public, so
the default path is tokenless: the entrypoint makes read-only unauthenticated GitHub requests and no credential is
needed, requested or stored. `--ci-token-file <protected file>` remains supported for private mirrors.
It reads GitHub directly inside the same process before any preflight and again before launch. Current main must
match the full launch commit. Each required name (browser, migrations, test-sqlite, test-postgres, fail-closed, static-quality) must
have at least one GitHub Actions result for that SHA, grouped per check suite (push and pull_request tracks are
independent suites; a rerun replaces its attempt inside one suite). Any run not completed refuses the launch, and
every suite's newest completed run must be a success: an independent track's failure refuses the launch no matter
how green another track is, while a rerun success supersedes only the failed attempt inside its own suite. Missing,
wrong-SHA, non-Actions, missing or malformed suite identity, truncated or unreadable evidence refuses the launch.
There is no bypass flag or cached green report.
The launch argv must call the sibling safe_launch.py with the same single --commit and --execute.
The token file contains the credential, never an argv credential or logged value. Do not leave a credential on a host
for a release check. Use an already-authorized protected file or a securely passed ephemeral file descriptor for
the entrypoint; never echo its contents or put them in logs. The checker makes read-only requests only.

The shell is not a gate. Even `checked_launch.py ...; true` cannot run its launch or preflight when CI is refused.
The test suite exercises this with an attempted sentinel mutation and a caller deliberately ignoring failure.
2026-10-30 incident: a shell assertion refused pending exact-main PG, but a separate following checked-launch still
ran. Live health/static and all88 DB tables were preserved, and that PG suite later passed. Never record this as
all CI green at cutover. The fix moves evidence validation inside the mutation entrypoint.

## Anonymous stdin credential transport and strict launch binding

For a private mirror, or a remote host where a token is required, use `--ci-token-stdin` instead of `--ci-token-file`. Stream the already-authorized credential
through encrypted SSH stdin to this single command. The entrypoint reads at most16KiB into an owned private
anonymous Linux memory file, uses it for its own read-only GitHub checks, and closes it in a finally block.
No credential pathname persists on disk, the descriptor is close-on-exec and is not passed to preflights or
launch children. No credential is included in argv, reports, application environment or output. Do not use
shell tracing or echo the stream. Empty, oversized, whitespace-bearing or unavailable credentials refuse
before preflight. Disk-file mode requires owned private regular non-symlink files, including parent paths.

The launch interpreter must resolve to the entrypoint's Python executable. Only exact safe_launch option
names in separate-token form are accepted, each at most once; alternate interpreters, unknown flags,
abbreviated flags, equals-form flags and duplicate options are refused. safe_launch itself disables argparse
abbreviations. These are accidental-sequencing controls, not a sandbox against an actor who can edit code
or issue a separate host command. No pending CI check can be made safe by ignoring this command's exit.

GitHub evidence requests use a no-redirect opener. Any redirect refuses the release instead of forwarding
a bearer credential to another origin. A two-origin HTTP regression exercises the production transport and
proves the destination receives no request. Timeouts must be finite and positive, both via CLI and run().

## Guarded launcher and target checkout identity

The supported forward-release procedure runs the target checkout's own
`python3 ops/checked_launch.py`, with the target's sibling `safe_launch.py` and
explicit `--stage <target>/web`. This guarded version verifies before preflights
and again before its final CI read:

- target is a real, non-symlink `web` directory in an exact Git checkout;
- checkout root and HEAD match the checked full commit, with no tracked edits;
- `web/.build-commit` is a regular non-symlink file matching that commit;
- actual outer/inner helper paths are the target's `ops/` files, regular and not
  group/world-writable, and their bytes equal the target commit's Git blobs.

The artifact contract already overlays `.next` plus `.build-commit` on a clean
exact checkout (release-gate.yml runtime-assembly smoke). No source-archive or
missing-Git fallback exists. Untracked build output and bytecode caches are not
blanket-rejected; they are not helper identity sources. The explicitly invoked
helper paths are always checked. BUILD_ID is not used as commit identity. These
checks do not prove all build bytes: the artifact, manifest and runtime identity
checks remain required. Automatic inner rollback behavior is unchanged.

This prevents accidental stale/mutated helper use or wrong-target invocation
through **this guarded launcher**. It is not a privilege boundary. Immutable old
outer+inner scripts without the guard can still launch a new target if an
operator invokes them directly. Interactive sudo remains able to start/stop
processes or change files. No systemd service, protected OS wrapper, sudoers
restriction or network bootstrap has been installed by this change. Do not
claim universal production enforcement from repository code alone.

There is still a check-to-use interval during the final CI request and process
launch. An operator able to modify files concurrently can race it; repeated
checks are accidental-sequencing controls, not a filesystem lock or sandbox.
Use the reviewed target checkout's own helper, retain operational custody of
that checkout until cutover, and do not bypass refused checks. A failed local
identity read refuses before any subsequent preflight or launch; no secret
configuration is read or logged by this guard.
