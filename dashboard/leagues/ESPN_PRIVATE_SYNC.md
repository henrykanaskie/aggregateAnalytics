# Private ESPN league sync: the FantasyPros method (parked)

Written 2026-09-23. **Status: parked, not built.** The focus is the backend
data handling and the prediction engine; this file exists so the research
does not have to be redone when (if) this comes back.

What ships today (`espn.py`) reads **public** ESPN leagues by id and takes no
credentials. This file is about **private** leagues, which is most of them.

## Why private leagues are different

ESPN has no official fantasy API and no partner program open to a small site.
A private league answers only to a request carrying the owner's ESPN login
cookies:

| cookie | what it is |
|---|---|
| `espn_s2` | the session token, long and URL-encoded |
| `SWID` | the account id, a GUID in braces: `{XXXXXXXX-...}` |

With both in the `Cookie` header, the same endpoint `espn.py` already calls
returns a private league:

    GET https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/<season>/segments/0/leagues/<id>
        ?view=mTeam&view=mRoster&view=mSettings
    Cookie: espn_s2=<...>; SWID={<...>}

So the parsing is done. The hard part is getting those two cookies and
keeping them safely.

## How FantasyPros does it

From FantasyPros' own help pages (sources at the bottom):

1. The user clicks **Sync ESPN** on FantasyPros and is sent to ESPN.com,
   where they are already logged in.
2. The **FantasyPros Chrome extension** runs on ESPN.com, lists the user's
   leagues, and captures their ESPN auth cookie.
3. FantasyPros **stores an encrypted copy of that cookie on its servers** and
   uses it to re-sync the league on a schedule, so rosters and settings stay
   current without the user coming back.
4. They have needed the extension since **July 2020**, "due to a change on
   ESPN's platform". Before that a plain web sync worked. ESPN changed
   something, and every site built on it had to rebuild.

Hobby tools (league bots, scripts) skip the extension: the user copies
`espn_s2` and `SWID` out of their browser's dev tools, or out of a helper
extension such as "ESPN Cookie Finder", and pastes them in.

## The rights question

They have no license. It works because:

- **The user authorises it.** It is their own league, read with their own
  login. That is a much stronger position than scraping someone else's data.
- **ESPN tolerates it.** These tools keep people active in ESPN leagues. That
  is tolerance, not permission, and it can end on any given day (see 2020).
- **Law, roughly** (not legal advice): *hiQ v. LinkedIn* held that scraping
  publicly visible data is likely not "unauthorized access" under the CFAA,
  but hiQ still lost on breach of the site's terms of use, then settled.
  Disney's terms restrict automated access without written permission. The
  realistic risk at small scale is ESPN blocking the site or sending a
  cease-and-desist letter, not a lawsuit.
- Large players may have business agreements with ESPN. Unknown, not assumed.

## What building it would take here

Two routes, from lightest to heaviest:

**A. One-off import with pasted cookies (no storage).**
- A form: league id + `espn_s2` + `SWID`. The server makes one request, returns
  the roster through the existing `espn.parse`, and forgets the cookies.
- Roughly half a day on top of `espn.py`.
- Cost: people must dig cookies out of dev tools, and each re-sync means doing
  that again. Their cookies still pass through the server in memory, over
  HTTPS, and must never be logged (check uvicorn's access log and any error
  reporting).

**B. The FantasyPros method (extension + stored cookies + scheduled re-sync).**
- A Chrome extension (Manifest V3, `cookies` permission for `espn.com`), which
  goes through Chrome Web Store review.
- Server-side storage of the cookies, encrypted at rest with a key kept
  outside the database. Those cookies are a login to the user's **whole ESPN
  account**, not just fantasy.
- Accounts on this site, so a stored cookie belongs to someone. Today the site
  has one shared password and keeps rosters in the browser.
- A scheduled job to re-sync, and handling for expired cookies.
- A privacy policy that says all of the above.
- Several weeks of work, plus a security responsibility this project is not
  set up for.

## When to revisit

Revisit only if **all** of these hold:

1. People are actually asking for private ESPN leagues, and the public-league
   import plus manual roster entry are not enough.
2. The site has user accounts and a way to store secrets properly.
3. If money is being charged: an hour with a lawyer about ESPN's terms, and a
   decision to accept the risk that ESPN breaks it without notice.

Until then, route A is the most that is worth building, and only if (1) holds.

## Sources

- FantasyPros, "How do I add my ESPN fantasy league to my account? Why do I
  need your browser extension to sync my league?":
  https://support.fantasypros.com/hc/en-us/articles/360051313453
- FantasyPros, League Sync help section:
  https://support.fantasypros.com/hc/en-us/sections/360003294494-League-Sync
- GameDayBot, "ESPN_S2 and SWID": https://www.gamedaybot.com/help/espn_s2-and-swid/
- ESPN Cookie Finder (Chrome Web Store):
  https://chromewebstore.google.com/detail/espn-cookie-finder/oapfffhnckhffnpiophbcmjnpomjkfcj
- finger-six/fantasy_bot issue #8, on Disney's terms and ESPN access routes:
  https://github.com/finger-six/fantasy_bot/issues/8
