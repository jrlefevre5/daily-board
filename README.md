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
  **Import last year:** under Manager panel → Goals, upload or paste last
  year's daily numbers (a POS/spreadsheet export — one date and amount per
  line; headers and totals are skipped), choose *same calendar date* or *same
  weekday* this year, and a % uplift (default +5%). Every covered day then gets
  its own target automatically and the card shows the LY number it came from.
- **Today's tasks** — daily tasks (reset every day) plus one-time tasks for that
  day. **This week** — weekly tasks (Mon–Sun), optionally due on a weekday.
  Signing off records the person, time, an optional note, a drawn signature
  (PNG) or typed name, and the device address. Undo is limited to the signer
  (with their PIN, if they have one) or a manager.
  **Who does it:** *Anyone* (one sign-off by whoever did it), *Specific people*
  (each named person signs separately — one name makes it an individual task),
  or *Everyone* (the whole active roster signs separately). Per-person tasks
  show a chip per person that turns green as each signs; the task is done when
  all have. When outbound texting is configured (`TWILIO_ACCOUNT_SID` +
  `TWILIO_FROM` alongside the auth token), creating a per-person task texts
  each person on it.
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
| `TASK ALL Read the new return policy` | everyone signs separately |
| `TASK @Sam Call the vendor back` | assigned to Sam (first name or full name from Staff) |
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

Replies ("Posted ✓") can be switched off under Settings — then the number is
inbound-only, which needs no A2P/toll-free registration in Twilio; the Text-in
tab still logs every text and what became of it.

Any provider that can POST `from` + `body` (form or JSON) to that URL works
too — set `SMS_WEBHOOK_SECRET` and have it send the value as an
`X-Webhook-Secret` header.

## Deploy (about five minutes, free tiers)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjrlefevre5%2Fdaily-board&project-name=daily-board&repository-name=daily-board&env=DATABASE_URL&envDescription=Postgres%20connection%20string%20(Neon%2C%20Supabase%2C%20or%20any%20Postgres)&envLink=https%3A%2F%2Fgithub.com%2Fjrlefevre5%2Fdaily-board%23database)

**The short way (Vercel + Neon, one place):**

1. Sign in at [vercel.com](https://vercel.com) with GitHub → **Add New → Project**
   → import `daily-board` → framework preset **Other** → Deploy (the first build
   fails without a database — expected, keep going).
2. In the project: **Storage → Create Database → Neon (Postgres)** → Create and
   connect. Neon adds `DATABASE_URL` to the project for you.
3. **Deployments → Redeploy.** Open the site.
4. **Manager** → PIN `1234` → **Settings**: set a board password, change the
   PIN → **Branding**: name, logo, colors → **Staff**, **Goals**, **Tasks**.

<a id="database"></a>**Using Supabase instead:** create a project, copy the
*Transaction pooler* URI (Connect → Transaction pooler, password filled in) and
set it as `DATABASE_URL` under the Vercel project's Settings → Environment
Variables, then redeploy. Any Postgres 13+ works the same way.

Add `TWILIO_AUTH_TOKEN` as a second environment variable when you set up
text-in. Tables create themselves on the first request; on Supabase they get
Row Level Security enabled with no policies, which hides them from its public
REST API (the app connects directly as the database owner).

## Files

- `server.js` — Express app: security headers, static hosting, sign-in tokens
  (board / manager), `/api/login`, `/api/config`
- `board.js` — the board API (goals, tasks, announcements, sign-offs), the
  manager panel API, and the inbound-SMS webhook + text grammar
- `db.js` — Postgres pool, schema, settings
- `public/` — `index.html` + `board.js` (the whole front end) + `styles.css`
- `board.test.js` — tests for the text grammar and helpers
- `api/index.js`, `vercel.json` — Vercel serverless entry
