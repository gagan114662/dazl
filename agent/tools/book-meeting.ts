import { defineTool } from "eve/tools";
import { z } from "zod";

interface GCalEvent { start: { dateTime: string }; end: { dateTime: string } }
interface FreeBusyResp { calendars?: Record<string, { busy?: GCalEvent[] }> }

function addMinutes(iso: string, mins: number): string {
  return new Date(new Date(iso).getTime() + mins * 60000).toISOString();
}

function nextWorkdaySlots(busyPeriods: GCalEvent[], daysAhead = 7, slotMins = 30): string[] {
  const slots: string[] = [];
  const now = new Date();
  for (let d = 1; d <= daysAhead; d++) {
    const day = new Date(now);
    day.setDate(now.getDate() + d);
    if (day.getDay() === 0 || day.getDay() === 6) continue; // skip weekends
    for (const hour of [9, 10, 11, 14, 15, 16]) {
      day.setHours(hour, 0, 0, 0);
      const slotStart = day.toISOString();
      const slotEnd   = addMinutes(slotStart, slotMins);
      const clash = busyPeriods.some(
        (b) => new Date(b.start.dateTime) < new Date(slotEnd) && new Date(b.end.dateTime) > new Date(slotStart)
      );
      if (!clash) slots.push(slotStart);
    }
  }
  return slots.slice(0, 5);
}

async function getFreeBusy(accessToken: string, calendarId = "primary"): Promise<GCalEvent[]> {
  const now = new Date().toISOString();
  const end = addMinutes(now, 7 * 24 * 60);
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: now, timeMax: end, items: [{ id: calendarId }] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Calendar API ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
  const d = await res.json() as FreeBusyResp;
  return d?.calendars?.[calendarId]?.busy ?? [];
}

async function createEvent(accessToken: string, summary: string, start: string, attendeeEmail: string): Promise<string> {
  const end = addMinutes(start, 30);
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary,
      start: { dateTime: start },
      end: { dateTime: end },
      attendees: [{ email: attendeeEmail }],
      conferenceData: { createRequest: { requestId: Math.random().toString(36).slice(2) } },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Create event ${res.status}`);
  const d = await res.json() as { htmlLink?: string };
  return d?.htmlLink ?? "https://calendar.google.com";
}

export default defineTool({
  description:
    "Find available meeting slots and optionally create a Google Calendar event. Uses GOOGLE_ACCESS_TOKEN env var. Returns available ISO datetime slots and a booking URL for the dazl.ai frontend. No Cal.com or Calendly needed.",
  inputSchema: z.object({
    business_id: z.string().min(1).describe("dazl business ID"),
    lead_id: z.string().min(1).describe("Lead ID for the booking URL"),
    prospect_email: z.string().email().optional().describe("If provided, immediately creates the event and invites this email"),
    slot: z.string().datetime().optional().describe("ISO datetime for the meeting if prospect already chose a slot"),
    meeting_title: z.string().optional().describe("Calendar event title"),
  }),
  async execute({ business_id, lead_id, prospect_email, slot, meeting_title }) {
    const token = process.env["GOOGLE_ACCESS_TOKEN"];
    if (!token) {
      const bookingUrl = `https://dazl.ai/book/${business_id}/${lead_id}`;
      return { booking_url: bookingUrl, available_slots: null, provider: "dazl_page",
        note: "Set GOOGLE_ACCESS_TOKEN to enable live freebusy lookup. Returning static booking page URL." };
    }

    try {
      const busy = await getFreeBusy(token);
      const available = nextWorkdaySlots(busy);

      if (slot && prospect_email) {
        const title = meeting_title ?? "Discovery call — dazl";
        const eventUrl = await createEvent(token, title, slot, prospect_email);
        return { booking_url: eventUrl, available_slots: available, provider: "google_calendar", event_created: true };
      }

      const bookingUrl = `https://dazl.ai/book/${business_id}/${lead_id}`;
      return { booking_url: bookingUrl, available_slots: available, provider: "google_calendar", event_created: false };
    } catch (e) {
      return { booking_url: `https://dazl.ai/book/${business_id}/${lead_id}`, available_slots: null,
        provider: "dazl_page", error: e instanceof Error ? e.message : String(e) };
    }
  },
});
