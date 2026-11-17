#!/usr/bin/env python3
"""dazl #413 live check: reply/opt-out reading for first-touch-only outreach (staging, $0).

Runs ON the staging box against its SQLite DB after the setup in README.md. Everything comes from env, nothing is
hard-coded and no secret is printed. Prints PASS/FAIL per acceptance criterion and exits 0 only if all pass.

Every check is bound to THIS run: the exact outreach message IDs created in setup (probe, control, held) and the
run start time CHECK_SINCE (epoch seconds, the same unit dazl stores). Evidence from another row, another tenant
or from before CHECK_SINCE never counts. A missing table/column, a missing bound row or stale evidence is a FAIL,
never a skip.

  --self-test   builds throwaway DBs: one working (must PASS) and several broken ones, including the two
                false-PASS paths found in review (F1, F2). Every broken one must FAIL.
"""
import os, sqlite3, sys, tempfile

REQUIRED = {
    "outreach_messages": ["id", "tenant_id", "to_email", "status", "sent_at", "created_at", "reply_checked_at"],
    "inbound_messages": ["tenant_id", "from_email", "classification", "received_at", "outreach_message_id"],
    "suppressions": ["tenant_id", "email", "created_at"],
    "scheduler_progress": ["tenant_id", "kind", "last_attempt_at", "last_outcome"],
}


def schema_gaps(db):
    gaps = []
    for t, need in REQUIRED.items():
        have = {r[1] for r in db.execute(f"PRAGMA table_info({t})")}
        if not have:
            gaps.append(f"table {t} missing")
            continue
        gaps += [f"{t}.{c} missing" for c in need if c not in have]
    return gaps


def msg(db, mid):
    r = db.execute("SELECT id, tenant_id, lower(to_email), status, sent_at, created_at, reply_checked_at "
                   "FROM outreach_messages WHERE id=?", (mid,)).fetchone()
    if not r:
        return None
    return dict(zip(("id", "tenant", "email", "status", "sent_at", "created_at", "reply_checked_at"), r))


def run(db_path, tenant, syncerr_tenant, probe_id, control_id, held_id, since, optout=None, control=None):
    db = sqlite3.connect(db_path)
    res = []

    def ac(name, ok, detail):
        res.append(bool(ok))
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")

    gaps = schema_gaps(db)
    ac("SCHEMA required tables/columns present", not gaps, "ok" if not gaps else "; ".join(gaps))
    if gaps:
        print("RESULT: FAIL")
        return False

    probe, ctrl, held = msg(db, probe_id), msg(db, control_id), msg(db, held_id)

    # Bound probe: this run's first touch to the opt-out address, on the tenant under test.
    probe_ok = (probe is not None and probe["tenant"] == tenant and probe["status"] == "sent"
                and (probe["sent_at"] or 0) >= since and (optout is None or probe["email"] == optout.lower()))
    ac("BIND probe first touch is this run's sent message", probe_ok,
       f"probe={probe and {k: probe[k] for k in ('tenant', 'status', 'sent_at')}} since={since}")
    o = probe["email"] if probe else None

    # AC-1: the opt-out reply to THIS probe was ingested during this run.
    n1 = db.execute("SELECT COUNT(*) FROM inbound_messages WHERE tenant_id=? AND outreach_message_id=? "
                    "AND lower(from_email)=? AND classification='opt_out' AND received_at>=?",
                    (tenant, probe_id, o, since)).fetchone()[0] if probe_ok else 0
    ac("AC-1 opt-out reply to the probe ingested on tick (no sequence)", n1 >= 1,
       f"{n1} opt_out row(s) linked to probe {probe_id} since start")

    # AC-2: suppression for that address created during this run.
    n2 = db.execute("SELECT COUNT(*) FROM suppressions WHERE tenant_id=? AND lower(email)=? AND created_at>=?",
                    (tenant, o, since)).fetchone()[0] if probe_ok else 0
    ac("AC-2 opted-out address is suppressed (this run)", n2 >= 1, f"{n2} suppression row(s) created since start")

    # AC-3: nothing else sent to it after the probe, and a second send attempt this run was refused.
    if probe_ok:
        later = db.execute("SELECT COUNT(*) FROM outreach_messages WHERE tenant_id=? AND lower(to_email)=? AND id<>? "
                           "AND status IN ('sending','sent','uncertain')", (tenant, o, probe_id)).fetchone()[0]
        refused = db.execute("SELECT COUNT(*) FROM outreach_messages WHERE tenant_id=? AND lower(to_email)=? AND id<>? "
                             "AND status='skipped' AND created_at>=?", (tenant, o, probe_id, since)).fetchone()[0]
    else:
        later, refused = None, 0
    ac("AC-3 no further email to the opted-out recipient", probe_ok and later == 0 and refused >= 1,
       f"other sends={later}, refused second sends this run={refused}")

    # AC-4: the EXACT held message stays unsent, and reply_sync for its tenant recorded a genuine "failure"
    # (not "hold", which classifySync uses for reading_not_enabled) during this run.
    held_ok = (held is not None and held["tenant"] == syncerr_tenant and held["status"] == "approved"
               and held["sent_at"] is None and (held["created_at"] or 0) >= since)
    prog = db.execute("SELECT last_outcome, last_attempt_at FROM scheduler_progress WHERE tenant_id=? AND kind='reply_sync'",
                      (syncerr_tenant,)).fetchone()
    prog_ok = prog is not None and prog[0] == "failure" and (prog[1] or 0) >= since
    ac("AC-4 partial sync error marks freshness unknown and the held send stays unsent", held_ok and prog_ok,
       f"held {held_id}={held and {k: held[k] for k in ('tenant', 'status', 'sent_at')}}, "
       f"reply_sync={prog} since={since}")

    # NEG control: this run's control message was really read by the tick, and produced no inbound/suppression.
    ctrl_ok = (ctrl is not None and ctrl["tenant"] == tenant and ctrl["status"] == "sent"
               and (ctrl["sent_at"] or 0) >= since and (ctrl["reply_checked_at"] or 0) >= since
               and (control is None or ctrl["email"] == control.lower()))
    c = ctrl["email"] if ctrl else None
    crow = db.execute("SELECT COUNT(*) FROM inbound_messages WHERE tenant_id=? AND lower(from_email)=?",
                      (tenant, c)).fetchone()[0] if ctrl else None
    csup = db.execute("SELECT COUNT(*) FROM suppressions WHERE tenant_id=? AND lower(email)=?",
                      (tenant, c)).fetchone()[0] if ctrl else None
    ac("NEG control read this run, NOT ingested or suppressed", ctrl_ok and crow == 0 and csup == 0,
       f"control={ctrl and {k: ctrl[k] for k in ('tenant', 'status', 'sent_at', 'reply_checked_at')}}, "
       f"inbound={crow}, suppressed={csup}")

    print("RESULT:", "PASS" if all(res) else "FAIL")
    return all(res)


SINCE = 1000
SCHEMA = """CREATE TABLE inbound_messages(gmail_id,tenant_id,thread_id,lead_id,from_email,excerpt,classification,received_at,outreach_message_id);
CREATE TABLE suppressions(tenant_id,email,reason,created_at);
CREATE TABLE outreach_messages(id,tenant_id,to_email,status,sent_at,created_at,reply_checked_at);
CREATE TABLE scheduler_progress(tenant_id,kind,last_attempt_at,last_success_at,last_outcome);"""


def fixture(case):
    """case: good | broken | f1_held_sent | f2_no_column | f2_no_control | f2_stale | f3_hold"""
    p = tempfile.mktemp(suffix=".db")
    d = sqlite3.connect(p)
    schema = SCHEMA
    if case == "f2_no_column":
        schema = schema.replace(",reply_checked_at)", ")")
    d.executescript(schema)
    t0 = 100 if case == "f2_stale" else SINCE + 10   # stale: every row predates CHECK_SINCE
    rc = "" if case == "f2_no_column" else ",?"
    def om(*v):
        v = v if case != "f2_no_column" else v[:-1]
        d.execute(f"INSERT INTO outreach_messages VALUES(?,?,?,?,?,?{rc})", v)
    om("m1", "t", "a+fake-optout@x.test", "sent", t0, t0, t0 + 50)
    if case != "f2_no_control":
        om("mc", "t", "c+none@x.test", "sent", t0, t0, t0 + 50)
    if case == "broken":
        om("m2", "t", "a+fake-optout@x.test", "sent", t0 + 30, t0 + 30, None)
        om("m3", "q", "b+fake-syncerror@x.test", "approved", None, t0, None)
        d.execute("INSERT INTO scheduler_progress VALUES('q','reply_sync',?,?,'success')", (t0 + 40, t0 + 40))
    else:
        d.execute("INSERT INTO inbound_messages VALUES('g','t','th1',NULL,'a+fake-optout@x.test','Please unsubscribe me.','opt_out',?,'m1')", (t0 + 20,))
        d.execute("INSERT INTO suppressions VALUES('t','a+fake-optout@x.test','unsubscribe',?)", (t0 + 21,))
        om("m2", "t", "a+fake-optout@x.test", "skipped", None, t0 + 30, None)
        d.execute("INSERT INTO scheduler_progress VALUES('q','reply_sync',?,NULL,?)",
                  (t0 + 40, "hold" if case == "f3_hold" else "failure"))
        if case == "f1_held_sent":
            # F1: the bound held message m3 actually went out; an UNRELATED approved row sits on the same tenant.
            om("m3", "q", "b+fake-syncerror@x.test", "sent", t0 + 45, t0, None)
            om("m9", "q", "z+unrelated@x.test", "approved", None, t0, None)
        else:
            om("m3", "q", "b+fake-syncerror@x.test", "approved", None, t0, None)
    d.commit()
    return p


def self_test():
    cases = [("good", True), ("broken", False), ("f1_held_sent", False),
             ("f2_no_column", False), ("f2_no_control", False), ("f2_stale", False),
             ("f3_hold", False)]
    ok = True
    for case, want in cases:
        print(f"---- {case} (must {'PASS' if want else 'FAIL'}) ----")
        got = run(fixture(case), "t", "q", "m1", "mc", "m3", SINCE, "a+fake-optout@x.test", "c+none@x.test")
        ok &= (got == want)
    print("SELF-TEST:", "PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(0 if self_test() else 1)
    need = ["DAZL_DB", "CHECK_TENANT_ID", "CHECK_PROBE_MESSAGE_ID", "CHECK_CONTROL_MESSAGE_ID",
            "CHECK_HELD_MESSAGE_ID", "CHECK_SINCE"]
    miss = [k for k in need if not os.environ.get(k)]
    if miss:
        print("missing env:", ", ".join(miss))
        sys.exit(2)
    e = os.environ
    sys.exit(0 if run(e["DAZL_DB"], e["CHECK_TENANT_ID"], e.get("CHECK_SYNCERR_TENANT_ID") or e["CHECK_TENANT_ID"],
                      e["CHECK_PROBE_MESSAGE_ID"], e["CHECK_CONTROL_MESSAGE_ID"], e["CHECK_HELD_MESSAGE_ID"],
                      int(e["CHECK_SINCE"]), e.get("CHECK_OPTOUT_EMAIL"), e.get("CHECK_CONTROL_EMAIL")) else 1)
