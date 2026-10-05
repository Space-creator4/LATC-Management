# Latitude ATC — website API

The service behind the parts of the website that need to know who someone is:
Discord sign in, application intake, the join queue, and the Radar.

The website itself is static. This runs separately, on Render, and never serves
any HTML.

## Why it exists at all

Three things cannot be done safely in the browser:

- **Knowing who is applying.** A JSON body can be written by hand, so a claim of
  "I am already a pilot" is worth nothing. The role is read from Discord here.
- **Deciding who is a controller.** Hiding the Radar page is a courtesy. The
  board is only returned to a member holding the controller role.
- **Holding the private invite.** An invite link in a public file is an invite
  link anyone can copy. It lives in this service's environment and is released
  per member after approval.

Everything else — the pages, the rules, the navigation — works with no service
at all.

## Running it locally

```sh
npm install
cp .env.example .env      # then fill it in
npm start                 # http://localhost:3000
```

`npm run dev` restarts on change. `npm test` runs the suite; it needs no
database and no Discord account, because the store and the Discord calls are
injected.

The website has to be served over HTTP too, not opened as a file, because the
pages read the question sets with `fetch`. Either use `START.bat` at the
repository root, or serve `Website` on port 8000:

```sh
npx serve Website -l 8000
```

## Deploying to Render

The website is **https://latcm.co.uk**, served as static files. This service is
only the API behind the interactive parts: sign in, applications, the join queue,
and the radar. Two different domains are involved, and mixing them up is the
most common way to get this wrong:

| What                | Value                                                        |
| ------------------- | ------------------------------------------------------------ |
| Website origin      | `https://latcm.co.uk` — goes in `ALLOWED_ORIGINS`             |
| Discord redirect    | `https://YOUR-SERVICE.onrender.com/auth/discord/callback`     |
| API the browser uses| `https://YOUR-SERVICE.onrender.com` — goes in `apiBaseUrl`    |

1. Create a Web Service pointing at this `backend` folder.
2. Render picks up `render.yaml`, which sets the non-secret defaults including
   `ALLOWED_ORIGINS`.
3. Add every secret from the header comment in `render.yaml` under
   **Environment**. The bot token, client secret, database URL, session secret,
   and private invite are all required.
4. Copy the service URL into `DISCORD_REDIRECT_URI`, using
   `https://YOUR-SERVICE.onrender.com/auth/discord/callback`. This points at
   the **API**, not at latcm.co.uk, because Discord calls it server to server.
5. Add that same URL to **Discord developer portal → your app → OAuth2 →
   Redirects**. It has to match exactly, trailing slash included.
6. Check `ALLOWED_ORIGINS` lists `https://latcm.co.uk` first. The first entry is
   where the browser lands after signing in, so it becomes
   `https://latcm.co.uk/account/?signed_in=1`.
7. Set `apiBaseUrl` in `Website/assets/js/config.js` to the **service** URL.

The cookies the session uses are `SameSite=Lax` with `Secure` in production,
which works because the site is HTTPS and the API is on a different subdomain.
If you ever serve the site over plain HTTP, set `SESSION_SECURE=false` or the
browser will drop the cookie and nobody will stay signed in.

`/health` is the health check path and needs no authentication.

The free plan sleeps after inactivity, so the first request after a quiet period
can take a few seconds. That is why the client shows a "checking your session"
state instead of assuming anyone is signed out.

### The database

`Store` creates its three tables with `CREATE TABLE IF NOT EXISTS` on boot, so
pointing it at the bot's existing Neon database is safe. It shares the database
but not the bot's code, and it never writes to the bot's tables.

Neon in `eu-west-2` and a Render region in the US will make every query cross an
ocean. Matching the region is worth doing if the service feels slow.

## Endpoints

| Method | Path                  | Who can call it        |
| ------ | --------------------- | ---------------------- |
| GET    | `/health`             | anyone                 |
| GET    | `/api/config`         | anyone                 |
| GET    | `/api/question-sets`  | anyone                 |
| GET    | `/auth/discord`       | anyone, starts OAuth   |
| GET    | `/auth/discord/callback` | Discord redirect    |
| GET    | `/auth/me`            | anyone, answers either |
| POST   | `/auth/logout`        | signed in              |
| POST   | `/api/applications`   | signed in, Pilot for ATC |
| POST   | `/api/queue/join`     | signed in              |
| GET    | `/api/queue/status`   | signed in              |
| POST   | `/api/queue/leave`    | signed in              |
| GET    | `/api/radar`          | signed in, controller role |
| GET    | `/api/radar/status`   | signed in, controller role |

Sessions are an opaque token in an httpOnly cookie, backed by a row in
`web_sessions`. The token is signed, but the row is what makes logout real:
throwing the cookie away does not stop the server honouring it. Rotating
`SESSION_SECRET` invalidates every session at once.

## The question sets

Questions live in `Website/assets/data/applications.<role>.json` — the same
files the browser fetches and the same files this service validates against, so
a question can never exist on one side only. Adding a question means editing
one JSON file.

Staff intake is closed. Its file has an empty question list on purpose: even if
the closed flag were overridden by mistake there would be nothing to submit.
Reopening it means writing the questions *and* setting
`APPLICATIONS_STAFF_OPEN=true`.

## What is not here

- **Live traffic on the Radar.** The sector layout is fixed and positions come
  from a static list until a real data source exists. `radar.js` draws whatever
  the API returns, so wiring one up later is a change to this service, not to
  the page.
- **The bot.** No shared code and no bridge. The two read the same database and
  the same Discord, and that is the whole relationship.
- **Email.** Applicants are identified by Discord, and Discord OAuth does not
  hand over an address by default. Staff reach people on Discord.
