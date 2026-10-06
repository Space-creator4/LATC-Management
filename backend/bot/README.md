# LATC Management Bot

A single file Discord bot (`main.py`) that runs a light automod plus a
**code-only Roblox verification** flow.

Applications are **not** handled here. Pilots, ATC, and staff apply on the website
(`../Website/applications/`), which posts to its own API. The bot no longer has an
application panel, modals, a review queue, or application roles.

The bot never asks for a Roblox password, cookie, `.ROBLOSECURITY`, or a Roblox
account of any kind. It reads public Roblox endpoints and nothing else:

| Endpoint | Purpose |
| --- | --- |
| `POST https://users.roblox.com/v1/usernames/users` | turn a username into a user id |
| `GET https://apis.roblox.com/user-search-api/v1/usernames/search` | fallback, only if the batch lookup misses |
| `GET https://users.roblox.com/v1/users/{id}` | read the public `description` field |

There is no OAuth client, no callback server, no game, gamepass, group, or rank check,
and no access, refresh, or session token anywhere in the code or configuration. The
search fallback is only ever used for a name, and a result is accepted solely on an
exact username match, so a fuzzy neighbour can never be verified in its place.

## Roblox verification

Verification is a proof of account ownership that the member can perform entirely
from the public Roblox site:

1. The member runs `/verify` (optionally `/verify username:builderman`).
2. The bot replies with a one time code like `VERIFY-7K4P9Q`, valid for
   `VERIFY_CODE_EXPIRY_MINUTES` minutes.
3. The member pastes the code into their Roblox **About** text at
   <https://www.roblox.com/my/account#!/about> and saves.
4. The member presses the **Verify** button on the bot's reply.
5. The bot re-reads the public bio, confirms the code, stores the link, burns the
   code, and grants the verification role.

Details that matter:

- **Only the About text counts.** The Roblox display name is never searched, and a
  code has to appear as its own token, so `NOTVERIFY-AB12CDX` does not verify.
- **Codes are stable.** Running `/verify` again reuses the same code instead of
  invalidating the one being typed. A new code is minted only after expiry, a
  successful use, or a lockout.
- **Codes are single use.** Consumption is a conditional `UPDATE`, so a double
  click links once and the second attempt reports the code as expired.
- **Guessing is rate limited.** `VERIFY_MAX_ATTEMPTS` wrong tries locks the code and
  `VERIFY_COOLDOWN_SECONDS` spaces out attempts, per server and per member.
- **One owner per Roblox account.** A Roblox account already linked to another
  member is refused with `taken`. Set `VERIFY_ALLOW_TRANSFER=true`, or
  `/verify-admin config transfer:allow`, to let a new member take it over; the old
  holder then loses the role.
- **One link per member.** A member who wants a different Roblox account must
  `/unlink` first. Verification never silently overwrites an existing link.
- **Roblox outages are not member errors.** A `429` or `5xx` is reported as a
  temporary failure and the code stays usable.

To unverify, use `/unlink`. Staff can do it for someone with
`/verify-admin unlink`, or wipe a server with `/roblox-config unlink-all`.

## Commands

Member commands:

| Command | Description |
| --- | --- |
| `/verify [username:...]` | Start or resume verification, get a code |
| `/verification` | Show your current Roblox link and code |
| `/unlink` | Remove your Roblox link, and the role |
| `/warnings` (button) | Check your automod warnings |

Staff commands:

| Command | Description |
| --- | --- |
| `/verify-admin check user:...` | Look up a member's link and any pending code |
| `/verify-admin unlink user:...` | Remove a member's verification |
| `/verify-admin config ...` | Set role, expiry, attempts, cooldown, transfer, role removal |
| `/verify-admin codes` | List live codes and their attempt counts |
| `/roblox` | Show the verification setup and per server counts |
| `/roblox-config requirement` | Turn the Roblox verification requirement off or on |
| `/roblox-config min-age` | Minimum Roblox account age in days |
| `/roblox-config lookup roblox_username:...` | Read a public bio, no state change |
| `/roblox-config unlink-all` | Remove every link in the server |
| `/automod`, `/warnings`, `/sync` | Existing staff tools |

Staff can inspect a Roblox profile with `/verify-admin check` or
`/roblox-config lookup`, but neither creates nor confirms a link. Only the member
pressing **Verify** on their own bio can do that.

## Setup

1. Create an application at <https://discord.com/developers/applications> and copy
   the bot token. Invite it with the `applications.commands` scope and, if you want
   it to grant roles, the `Manage Roles` permission plus role hierarchy above the
   verification role.
2. Install the dependencies:

   ```powershell
   py -3.12 -m venv .venv
   .venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```

3. Copy `.env.example` to `.env` and fill in the IDs. Turn on Developer Mode in
   Discord (`Settings > Advanced`) so you can copy channel, role, and user IDs.
4. Run the bot once and register the commands:

   ```
   /sync
   ```

   `GUILD_ID` makes registration instant for that one server. Remove it to publish
   commands globally, which Discord can take up to an hour to propagate.

There is no panel to post any more. Point members at the website's application
pages instead:
`../Website/applications/pilot/`, `../Website/applications/atc/`, and
`../Website/applications/staff/`.

### Configuration

Everything is environment driven and every value has a default, so an empty `.env`
still starts. `verify_settings` holds per server overrides; a `NULL` column means
"not set here", so an environment value of `0` is honoured and a staff `0` is
distinguishable from "never configured".

| Variable | Default | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | required | Bot token |
| `CLIENT_ID` | unset | Application id, used in logs |
| `GUILD_ID` | unset | Instant command sync for one server |
| `VERIFICATION_ROLE_ID` | unset | Role granted on success |
| `VERIFY_CODE_EXPIRY_MINUTES` | `10` | Code lifetime |
| `VERIFY_MAX_ATTEMPTS` | `5` | Wrong tries before lockout |
| `VERIFY_COOLDOWN_SECONDS` | `30` | `0` disables the wait |
| `VERIFY_ALLOW_TRANSFER` | `false` | Whether a link can move between members |
| `VERIFY_REMOVE_ROLE_ON_UNLINK` | `true` | Whether `/unlink` drops the role |
| `ROBLOX_LOOKUP_MIN_INTERVAL` | `0.6` | Raise it if Roblox replies `429` |
| `DATABASE_URL` | unset | Optional Postgres/Neon connection string; when set, it overrides `DB_PATH` |
| `DB_PATH` | `data/latc.db` | SQLite file used when `DATABASE_URL` is unset |

## Data and migrations

State lives in one SQLite file (`data/latc.db` by default), and it can also run on
Neon or any other Postgres-compatible database via `DATABASE_URL`. When the URL is
set, the app switches to Postgres automatically; otherwise it keeps using the local
SQLite file. Schema changes run automatically on start inside a lock, so the bot
upgrades its own database:

- `verify_sessions` is rebuilt to allow `NULL`, which is what makes a real `0`
  override possible.
- `roblox_bio_codes` and `roblox_links`, the old code and Roblox sign in tables,
  are dropped along with the retired `roblox_bio_rule` column and the unused
  `email_verified` column, which only the sign in flow ever populated.
- Retired `roblox_requirement` values (`any`, `oauth`, `manual`, `lookup`) become
  `profile`, since verification is now always a bio code.
- Duplicate Roblox links collapse to the newest row and a unique index stops one
  Roblox account serving two members.
- The `applications` table and the `automod_config.panel_message_id` column are no
  longer created or written. Any existing rows are left in place untouched and simply
  ignored, so no application history is lost. Drop them by hand when you no longer
  need them.

### Links from a retired method

Rows created by the old Roblox sign in, staff override, or username only flows are
**kept for history but no longer count as verified**, because none of them proved a
code was ever in the member's bio. They are labelled `retired ... link` wherever they
are displayed, and `/verification` tells the member to `/unlink` and re-verify,
because `/verify` will not overwrite an existing link. A link with `method =
profile` keeps its `bio_ok` state, so members who verified the old way round are
unaffected.

Back up `data/latc.db` before a first run against a live database.

## Deployment

`.github/workflows/bot.yml` runs the bot on a **self-hosted** runner, because a
hosted runner is killed after a few hours and a Discord gateway connection needs to
stay up. Register the runner in `Settings > Actions > Runners` with the label
`self-hosted`, add `DISCORD_TOKEN` and the ID values as repository secrets, and push
to `main`. Every `VERIFY_*` secret is optional.

The workflow stops a few minutes before its next scheduled run so the replacement
process can take over without two bots logging in at once.

## Testing

`tests/` holds a small `unittest` suite for the parts that are easy to break:
Postgres placeholder rewriting, the documented `.env` contract, and a guard that
the removed application system has not crept back into the schema, `Config`, or
`Database`.

```powershell
py -m unittest discover -s tests
py -m py_compile main.py
```

The flows worth covering are code format and stability, lockout and expiry, the
display-name-is-not-a-bio case, one-owner-per-Roblox-account, the double click that
must link exactly once, the migrations above, and slash command serialization. Real
Roblox calls can answer `429`; space them out or raise
`ROBLOX_LOOKUP_MIN_INTERVAL`.

A full end to end check needs a Roblox profile whose bio you can edit: put a live
code in the About text, then press **Verify** in the same server.
