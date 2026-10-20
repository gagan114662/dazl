import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "0 8 * * *",
  markdown: `
You are running the daily morning signal scan for dazl.

Steps:
1. For each active business in the database, call find_signals with their businessDescription and geography for at least 5 signal types (reddit_intent, news_mention, funding_round, hn_mention, youtube_intent).
2. Score each signal: funding_round=90, new_hire=80, competitor_review=75, reddit_intent=65, news_mention=55, youtube_intent=45, hn_mention=60.
3. For signals scoring >= 60, call lookup_contact to find an email address.
4. For leads with a found email, call send_email with a personalised Day 1 outreach referencing the exact signal and source URL.
5. Log every action to the database.
6. Report a summary: X signals found, Y qualified (score>=60), Z emails sent, N contacts not found.

Always cite the source URL for every lead. Never send to an email you fabricated.
  `.trim(),
});
