# Proposed read-only staging retention planner (#1444)

Not installed. No apply mode, no filesystem enumeration/deletion by this
planner, and no production directory or deployment access. It converts an
authorized, redacted operator inventory into a proposal. Every input flag is an
operator attestation, not independently verified by this offline program; do
not give it an invented inventory or assume checked-in defaults are installed.

From the candidate repository root, run:

    python3 -I ops/staging/retention-plan.py < /approved/path/staging-inventory.json

The operator must independently verify exact installed staging units and
capture a bounded inventory **under the existing staging deploy lock**, fresh
within 15 minutes. Required inputs are demonstrated in the runnable test fixture:
installed and root ownership receipts for the two exact directories (confirm that the operator’s `~/dazl-data` expands to the canonical `/home/ubuntu/dazl-data` or hold the proposal),
literal regular `.complete` marker and matching full commit/build identity,
the actual public/local staging health, app and worker served release identity,
agreement with root-owned state and current symlink, pending recovery prev/new,
verified previous release and compatible recovery manifest, no recent subtree
activity, complete mount inventory (including bind mounts), trusted canonical
path plus device/inode exclusions for live databases and sidecars, and reviewed
open/restore references. Mark `single_regular_file` only for a canonical direct
regular snapshot with link count 1 and positively verified ownership. Mark
snapshot provenance only with integrity evidence, successful restore into a disposal workspace, and an approved manifest
binding exact basename, environment, release, and UTC capture time. No filename
pattern infers that evidence. Omit actual production paths, environment,
credentials and non-staging records; preserve unknown staging names with absent
proof. A receipt that cannot establish completeness yields HOLD.

Current repo sources: `ops/staging/deploy.sh` 103bb3c6 (release root,
root-owned state, lock, current link and pending recovery); `docs/STAGING.md`
9a9ee769 (keep live and two complete rollbacks); `ops/staging/pull-prebuilt.sh`
c37443c5 (separate pre-migrate backup root and existing retention).
This proposal does not touch the managed backup directory or timer. Seven means
seven newest manifest-proven *present* staging snapshots in the legacy archive,
keeping ties and all uncertain, pinned or referenced rows. Unclassified October
snapshots cannot be candidates. Production entries are never eligible. Staging
releases retain the live and one verified previous rollback, plus any other
worker-referenced, pending, pinned, recent or uncertain tree.
If installed roots, lock, or environment differ, halt rather than override.
Read-only collection and any later retention setting change are distinct from
the reviewed production deployment workflow.

Post the exact dated proposal and retained reasons in #1444 and the room,
then wait for explicit approval of the actual list. Candidate is not permission.
Any later operator action would require fresh proof and revalidation against
the same locks, roots, and identities; no such action is implemented here.
