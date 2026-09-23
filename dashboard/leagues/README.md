# League imports

My team (Fantasy page) can import a roster instead of having it typed in.
Each import reads the other site on the person's behalf, matches its players
to ours, and hands the result back to the browser. Nothing about anyone's
league is stored on the server.

| Platform | What the person gives | How it is read | Setup |
|---|---|---|---|
| Sleeper | their username | Sleeper's public read-only API, no key | none |
| ESPN | a league id or link | ESPN's unofficial league endpoint; public leagues only | none |
| Yahoo | "Sign in with Yahoo" | Yahoo's official Fantasy API over OAuth 2.0 | an app + two env vars, below |

## Yahoo setup (once)

1. Sign in at <https://developer.yahoo.com/apps/> and **Create an App**.
   - Application type: *Web Application*
   - Redirect URI: `https://<your-site>/api/leagues/yahoo/callback`
     (for this Render service, `https://aggregateanalytics.onrender.com/...`
     or whatever the service's URL is). Yahoo requires https.
   - API permissions: **Fantasy Sports → Read**.
2. Copy the Client ID and Client Secret into the Render service's
   environment as `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET`.
3. Only if the callback URL the site builds does not match the registered one
   exactly (a custom domain, say), also set `YAHOO_REDIRECT_URI` to the
   registered value.

Until the two variables are set, the Yahoo button is shown disabled with a
note, and `/api/leagues/yahoo/start` answers 503.

## Terms, before charging money

- **Sleeper**: free and public; its docs ask for under 1000 calls a minute
  and the player list at most once a day (cached on disk here). Read their
  terms for commercial use.
- **ESPN**: no official API; Disney's terms restrict automated access without
  written permission. Public leagues only, no cookies, so no credentials are
  handled, but this is the one to review first.
- **Yahoo**: official, but its developer terms still apply to commercial use.

## Matching players

`common.match_player` tries, in order: the NFL's gsis id (Sleeper carries it),
ESPN's id (in nflverse's player table), then name + position + team, with
punctuation and Jr./III dropped. Players who still match nobody come back in
`unmatched` and the page lists them by name.
