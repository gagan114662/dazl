import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "0 */6 * * *",
  markdown: `
You are running the follow-up sequence checker for dazl. Run every 6 hours.

Steps:
1. Query the sequences table for pending sequences where:
   - status = 'pending' AND sent_at IS NULL
   - The lead's original found_at is >= the sequence day threshold:
     - day=3: found_at >= 3 days ago
     - day=7: found_at >= 7 days ago
     - day=14: found_at >= 14 days ago
2. Check whether the lead has replied (outreach.replied_at IS NOT NULL) — if so, mark the sequence cancelled and skip.
3. For due sequences with no reply, call send_email with appropriate follow-up copy:
   - Day 3: Add a relevant insight or case study. Subject: "Re: [original subject] — one quick thing"
   - Day 7: Softer check-in. Subject: "Re: [original subject] — is the timing off?"
   - Day 14: Final touch. Subject: "Re: [original subject] — closing the loop"
4. Mark each sent sequence with sent_at = now().
5. Report: X sequences checked, Y sent, Z cancelled (replied), N skipped (not due yet).

Stop all sequences immediately when a reply is detected. Never send after opt-out.
  `.trim(),
});
