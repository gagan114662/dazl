#!/usr/bin/env python3
"""dazl #413 live check: reply/opt-out reading for first-touch-only outreach (staging, $0).

Runs ON the staging box against its SQLite DB after the setup in README.md. Everything comes from env, nothing is
hard-coded and no secret is printed. Prints PASS/FAIL per acceptance criterion and exits 0 only if all pass.

  --self-test   builds two throwaway DBs (a working one and a BROKEN one) and proves the checks PASS the first and
                FAIL the second, so a broken feature can't pass.
"""
import os, sqlite3, sys, tempfile, time

def cols(db, t):
    return [r[1] for r in db.execute(f"PRAGMA table_info({t})")]

def has(db, t):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone() is not None

def email_col(db, t):
    for c in ("email", "address", "to_email", "email_norm"):
        if c in cols(db, t):
            return c
    return None

def run(db_path, tenant, optout, control, syncerr_tenant, since):
    db = sqlite3.connect(db_path)
    res = []
    def ac(name, ok, detail):
        res.append(ok); print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
    o, c = optout.lower(), control.lower()

    rows = db.execute("SELECT classification, received_at FROM inbound_messages WHERE tenant_id=? AND lower(from_email)=?", (tenant, o)).fetchall()
    ac("AC-1 opt-out reply ingested on tick (no sequence)", any(r[0] == "opt_out" for r in rows),
       f"{len(rows)} inbound row(s) from the opt-out address, classes={sorted({r[0] for r in rows})}")

    sup = False; detail = "suppressions table missing"
    if has(db, "suppressions"):
        ec = email_col(db, "suppressions")
        if ec:
            tc = "tenant_id" in cols(db, "suppressions")
            q = f"SELECT COUNT(*) FROM suppressions WHERE lower({ec})=?" + (" AND tenant_id=?" if tc else "")
            n = db.execute(q, (o, tenant) if tc else (o,)).fetchone()[0]
            sup, detail = n > 0, f"{n} suppression row(s) for the opt-out address"
        else:
            detail = "no email column found in suppressions"
    ac("AC-2 opted-out address is suppressed", sup, detail)

    first_opt = min([r[1] for r in rows if r[0] == "opt_out"] or [None]) if rows else None
    later = db.execute("SELECT COUNT(*) FROM outreach_messages WHERE tenant_id=? AND lower(to_email)=? AND status='sent' AND sent_at > ?",
                       (tenant, o, first_opt or 10**12)).fetchone()[0]
    skipped = db.execute("SELECT COUNT(*) FROM outreach_messages WHERE tenant_id=? AND lower(to_email)=? AND status='skipped'", (tenant, o)).fetchone()[0]
    ac("AC-3 no further email to the opted-out recipient", first_opt is not None and later == 0 and skipped >= 1,
       f"sent after opt-out={later}, refused (skipped) second sends={skipped} (setup step 5 must have tried one)")

    prog = db.execute("SELECT last_outcome, last_success_at FROM scheduler_progress WHERE tenant_id=? AND kind='reply_sync'", (syncerr_tenant,)).fetchone() if has(db, "scheduler_progress") else None
    held = db.execute("SELECT COUNT(*) FROM outreach_messages WHERE tenant_id=? AND status IN ('approved','held') AND sent_at IS NULL", (syncerr_tenant,)).fetchone()[0]
    stale = prog is not None and prog[0] not in ("success", "ok")
    ac("AC-4 partial sync error marks freshness unknown (no send on stale safety)", stale and held >= 1,
       f"reply_sync outcome={prog[0] if prog else None}, unsent approved message(s) still held={held}")

    crow = db.execute("SELECT COUNT(*) FROM inbound_messages WHERE tenant_id=? AND lower(from_email)=?", (tenant, c)).fetchone()[0]
    csup = 0
    if has(db, "suppressions") and email_col(db, "suppressions"):
        csup = db.execute(f"SELECT COUNT(*) FROM suppressions WHERE lower({email_col(db,'suppressions')})=?", (c,)).fetchone()[0]
    ran = db.execute("SELECT COUNT(*) FROM outreach_messages WHERE tenant_id=? AND reply_checked_at >= ?", (tenant, since)).fetchone()[0] if "reply_checked_at" in cols(db, "outreach_messages") else 1
    ac("NEG control: no-reply address is NOT ingested or suppressed, and the tick actually read threads", crow == 0 and csup == 0 and ran > 0,
       f"control inbound={crow}, control suppressed={csup}, threads read since start={ran}")
    print("RESULT:", "PASS" if all(res) else "FAIL")
    return all(res)

def self_test():
    def mk(broken):
        p = tempfile.mktemp(suffix=".db"); d = sqlite3.connect(p)
        d.executescript("""CREATE TABLE inbound_messages(gmail_id,tenant_id,thread_id,lead_id,from_email,excerpt,classification,received_at,outreach_message_id);
        CREATE TABLE suppressions(tenant_id,email,reason);
        CREATE TABLE outreach_messages(id,tenant_id,to_email,status,sent_at,reply_checked_at);
        CREATE TABLE scheduler_progress(tenant_id,kind,last_success_at,last_outcome);""")
        d.execute("INSERT INTO outreach_messages VALUES('m1','t','a+fake-optout@x.test','sent',100,500)")
        d.execute("INSERT INTO outreach_messages VALUES('m3','q','b+fake-syncerror@x.test','approved',NULL,NULL)")
        if not broken:
            d.execute("INSERT INTO inbound_messages VALUES('g','t','m1',NULL,'a+fake-optout@x.test','Please unsubscribe me.','opt_out',200,'m1')")
            d.execute("INSERT INTO suppressions VALUES('t','a+fake-optout@x.test','opt_out')")
            d.execute("INSERT INTO outreach_messages VALUES('m2','t','a+fake-optout@x.test','skipped',NULL,NULL)")
            d.execute("INSERT INTO scheduler_progress VALUES('q','reply_sync',NULL,'failure')")
        else:  # broken: reply never read, second email went out, sync error treated as fresh
            d.execute("INSERT INTO outreach_messages VALUES('m2','t','a+fake-optout@x.test','sent',300,NULL)")
            d.execute("INSERT INTO scheduler_progress VALUES('q','reply_sync',400,'success')")
        d.commit(); return p
    ok = run(mk(False), "t", "a+fake-optout@x.test", "c+none@x.test", "q", 0)
    print("---- broken DB (must FAIL) ----")
    bad = run(mk(True), "t", "a+fake-optout@x.test", "c+none@x.test", "q", 0)
    print("SELF-TEST:", "PASS" if ok and not bad else "FAIL"); return ok and not bad

if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(0 if self_test() else 1)
    need = ["DAZL_DB", "CHECK_TENANT_ID", "CHECK_OPTOUT_EMAIL", "CHECK_CONTROL_EMAIL", "CHECK_SINCE"]
    miss = [k for k in need if not os.environ.get(k)]
    if miss:
        print("missing env:", ", ".join(miss)); sys.exit(2)
    e = os.environ
    sys.exit(0 if run(e["DAZL_DB"], e["CHECK_TENANT_ID"], e["CHECK_OPTOUT_EMAIL"], e["CHECK_CONTROL_EMAIL"],
                      e.get("CHECK_SYNCERR_TENANT_ID", e["CHECK_TENANT_ID"]), int(e["CHECK_SINCE"])) else 1)
