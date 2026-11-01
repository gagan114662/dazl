# Fresh listener preparation, not blue-green deployment

Status: isolated preparation primitives and synthetic tests only. There is no
production start CLI, accepted candidate receipt file, Caddy mutation, deployment
success claim or relaxation of the current safe_launch ancestry checks. Running
fresh_listener.py returns a nonzero preparation-only status even with --execute.
The existing release helper and release configuration are unchanged.

## Why separate preparation is needed

safe_launch.py is a same-port replacement helper. It requires a live exact
socket-owning PID and the reviewed Next -> sh -> npm -> PID1 ancestry. A
historical manually wrapped fallback cannot safely be relabeled compatible.
Starting a candidate on another port would let the immediate previous release
remain warm, but empty-port observation is not sufficient authority or safety.

Source review at main3e42ce0c:
- instrumentation.ts installs shutdown and error handlers, not a startup cron.
- internal/tick uses a shared lease, but this is not a candidate admission fence.
- /api/ready opens getAuthDb and can migrate SQLite and record alerts/errors.
  Readiness is NOT a read-only operation.
- safe_launch.launch does not explicitly bind loopback. A future candidate must.

Infra's November1 read-only report found Caddy2.11.7 with a systemd reload path,
admin API on127.0.0.1:2019, production upstream localhost:3100, staging3200, and
historical listener3101. Ports3102-3199 were free at that observation, not
reserved. Production listeners bound wildcard addresses. SQLite is shared;
36 migrations were reported additive, with no DB restore on prior rollbacks.
None of these historical facts authorize starting a production candidate.

## What the isolated code establishes

A caller-created process must lead its own new session/group, with exact PID,
/proc start ticks, UID, cwd and cgroup. A candidate-ready-only result requires
all observed listener owners on the port to belong to that group/session and
match UID/cwd/cgroup; listeners must bind exactly127.0.0.1 or ::1, with no wildcard endpoint. Every
LISTEN inode on the port must have at least one resolved process owner, not
merely one resolved inode while another is hidden or has disappeared.
The exact readiness commit is checked between two identity checks. The result
records wall-clock and monotonic nanosecond observation timestamps; monotonic
values are comparable only on the same host boot. This is not an expiry policy
or a trusted durable receipt: a future orchestrator still needs freshness/boot
binding, serialization and custody checks before phase2. Redirects
are refused. No provider or database is contacted by the tests.

Cleanup rechecks the same leader identity and signals only its group. It never
signals the current public listener or a port occupant just because the port
was empty earlier. A missing/reused/exited leader before cleanup refuses unknown
group signaling. A successful cleanup result proves only the leader stopped,
NOT that every descendant drained. No success receipt claims otherwise. Real
process tests keep an unrelated healthy listener alive while candidate cleanup
runs. Other tests cover occupied IPv4/IPv6, a stolen port, wildcard binding,
wrong commit, foreign socket owner, stale start ticks/cwd/group, exited leader,
cleanup timeout, no-execute CLI and redirect rejection.

This is not an ownership capability: an authorized caller could pass some other
same-user process leader. A real launcher must capture identity from the exact
Popen it just created, maintain custody and a durable recovery record, and must
not accept a user-supplied PID as proof of newly created ownership. Process
checks have TOCTOU windows and do not constrain a privileged operator.

## Blockers before any production preparation

1. Prove same-database schema forward/rollback compatibility for both builds,
   not a blanket assumption that migrations are additive. Existing backup and
   manifest gates remain mandatory.
2. Establish a candidate work-admission fence. The externally called tick lease
   does not stop scan/admission or prove no background writes. Candidate startup,
   readiness and shutdown effects must be audited. An env label is not proof.
3. Integrate exact-main CI, target/helper identity, private env/runtime/backup,
   resource headroom and artifact checks without weakening current controls.
4. Implement a bounded launch lifecycle and guaranteed follow-up for timeout,
   interruption, early death, leader exit with surviving descendants and failed
   cleanup. The primitives do not yet implement that orchestrator.
5. Independently review and run actual production-build synthetic tests with
   network fence and disposable databases. Current tests use small HTTP children,
   not Next, Caddy or real DBs.

## Separate future cutover phase

Only after candidate preparation is accepted: compare exact current Caddy
configuration/upstream against expected old state, verify both listeners,
validate a proposed config, switch atomically/reload, verify public exact
manifest/static/affected flows, and automatically restore the captured config
on bounded failure. Config drift during revert must fail safe, not overwrite
unrelated edits. Retain the immediate previous listener warm until verified.
This needs separate reviewed implementation, production authorization and real
outcome proof. Candidate-ready-only is not public cutover or completed blue-green.
