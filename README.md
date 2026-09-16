# Daily Board

A store team's shared screen: today's **sales goals** with progress bars, the
**daily** and **weekly task checklists**, and **announcements** from management.
Every item is signed off by an employee — pick your name, sign with a finger (or
type it), done — so the board always shows *who* did *what* and *when*. Managers
can post to the board just by **texting** its number.

Runs anywhere Node and Postgres run; built for a free Supabase database and a
free Vercel deployment.

## Run it locally

```
npm install
cp .env.example .env      # fill in DATABASE_URL
npm start                 # http://localhost:3000
npm test                  # the text-message grammar tests
```

The schema is created automatically on first boot. Sign in as a manager with the
default PIN **1234**, then under **Manager panel → Settings** set a board
password for the team and change the PIN.

## How it works

**The board** (`/`) is meant to live on a tablet or PC at the front desk, opened
once with the shared board password (it stays signed in for 30 days and
refreshes itself every minute).

- **Sales goals** — recurring goals (e.g. *Units sold 25*, *Revenue $1,200*)
  copy onto every new day. Employees tap **+ Log**, pick their name, sign, and
  the goal ticks up. Each entry is recorded with who/when/note.
- **Today's tasks** — daily tasks (reset every day) plus one-time tasks for that
  day. **This week** — weekly tasks (Mon–Sun), optionally due on a weekday.
  Signing off records the person, time, an optional note, a drawn signature
  (PNG) or typed name, and the device address. Undo is limited to the signer
  (with their PIN, if they have one) or a manager.
- **Announcements** — pin to the top, attach an image, auto-hide after a date;
  each employee can mark one as read so you can see who has seen it.
- **Prev / Next day** pages through history to see how a day was closed out.

**The manager panel** (manager PIN) manages recurring goals and per-day
overrides, tasks, announcements, the staff roster (optional per-person PIN so
nobody signs as someone else), a 30-day activity log with CSV export, text-in
setup, branding, and settings (timezone, passwords, text-in number).

**Branding** (Manager panel → Branding) makes the board look like the business:
name and tagline, a welcome message for the sign-in screen, a logo (upload an
image — it's shrunk and stored in the database, no file hosting needed — or
link to one), accent / top-bar / page-background colors, and a font. A live
preview follows every change; the browser-tab icon follows the logo or accent
color; text on the top bar and buttons flips to dark automatically on light
colors. *Reset to defaults* puts it all back.

## Post by text message

Managers whose mobile number is on the roster can text the board's number. The
first word decides where it lands:

| Text | Lands as |
|---|---|
| `ANNOUNCE Team meeting Friday at 3` (or no keyword) | announcement |
| `TASK Restock the front shelves` | one-time task on today's list |
| `DAILY Wipe down the counters` | recurring daily task |
| `WEEKLY Fri Deep-clean the back room` | recurring weekly task (due Friday) |
| `GOAL units sold 25` / `GOAL revenue $1200` | sets today's target |
| `HELP` | texts the list back |

A photo attached to a text is shown on the announcement. Texts from numbers
not on the roster are ignored — they're listed as *rejected* under Manager
panel → Text-in, so a forgotten number is easy to spot and add. The keyword has
to be the first word (*"Task force meeting at 3"* would become a task titled
*"force meeting at 3"*); texts with no keyword become announcements, or tasks if
you prefer (Settings).

### Setup (Twilio)

1. Buy a number at [twilio.com](https://www.twilio.com) (about $1/month plus a
   fraction of a cent per message).
2. Phone Numbers → your number → Messaging → *A message comes in* → Webhook,
   HTTP POST: `https://<your-site>/api/sms/inbound`
3. Set `TWILIO_AUTH_TOKEN` (Twilio Console → Account Info) in the environment
   so only requests Twilio signed are accepted.
4. Under Staff, give each manager the Manager role and their mobile number.

Any provider that can POST `from` + `body` (form or JSON) to that URL works
too — set `SMS_WEBHOOK_SECRET` and have it send the value as an
`X-Webhook-Secret` header.

## Deploy (Supabase + Vercel)

1. **Database:** create a Supabase project and copy the *Transaction pooler*
   connection URI (Connect → Transaction pooler), password filled in.
2. **App:** create a Vercel project from this repository (framework preset:
   *Other*). Environment variables: `DATABASE_URL`, and `TWILIO_AUTH_TOKEN` if
   you use text-in. Deploy.
3. Open the site, sign in with PIN `1234`, set the board password, change the
   PIN, add goals, tasks, and staff.

Tables get Row Level Security enabled with no policies, which makes them
invisible to Supabase's public REST API; the app itself connects directly as
the database owner.

## Files

- `server.js` — Express app: security headers, static hosting, sign-in tokens
  (board / manager), `/api/login`, `/api/config`
- `board.js` — the board API (goals, tasks, announcements, sign-offs), the
  manager panel API, and the inbound-SMS webhook + text grammar
- `db.js` — Postgres pool, schema, settings
- `public/` — `index.html` + `board.js` (the whole front end) + `styles.css`
- `board.test.js` — tests for the text grammar and helpers
- `api/index.js`, `vercel.json` — Vercel serverless entry
