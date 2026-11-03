# 🐴 Umamusume Daily — Discord bot

A Discord bot that posts a **SFW Umamusume: Pretty Derby picture every day** at a time you choose. It pulls art from several image boards and falls back to another one if a site is down:

| Source | Needs an account? | Notes |
| --- | --- | --- |
| [Danbooru](https://danbooru.donmai.us) | No (optional API key) | Best metadata: characters, artist, pixiv link |
| [Safebooru](https://safebooru.org) | No | SFW-only site |
| [Konachan.net](https://konachan.net) | No | SFW-only mirror of Konachan |
| [Gelbooru](https://gelbooru.com) | **Yes**, free API key | Only used when credentials are set |
| [Zerochan](https://www.zerochan.net) | Username only | Only used when `ZEROCHAN_USERNAME` is set |

Features:

- **Strict SFW filtering.** Only posts rated *general* are allowed by default. A built-in tag blacklist also blocks swimsuits, underwear, cleavage, gore and similar, and you can add your own tags.
- **No repeats.** Posted pictures are remembered in `data/state.json`, and the same file found on two different sites counts as one picture.
- **Artist credit.** Every post links back to the booru page and the original artwork (pixiv, X, …).
- **Uploads the image file**, so hotlink-protected sites still show up. If the file is too big, the bot links it instead.
- **Doesn't miss a day.** If the bot was offline at post time, it posts when it starts. If every source fails, it retries later.
- **Slash commands:** `/uma` posts a random picture on demand, and `/uma_status` shows the schedule (admins only).

There are two ways to run it:

- **[Easy way, no computer needed](#easy-way-no-computer-needed-github-actions)**: GitHub runs it for free once an hour and it posts through a Discord webhook. You can set it all up from a phone.
  - Add **[`/uma` without a computer](#slash-command-without-a-computer-cloudflare-workers)** on top: a free Cloudflare Worker answers the command.
- **[Full bot](#1-create-the-discord-bot)**: an always-on bot with `/uma` and `/uma_status`. It needs a computer or server that stays on.

## Easy way, no computer needed (GitHub Actions)

The workflow in [`.github/workflows/daily-post.yml`](.github/workflows/daily-post.yml) runs every hour on GitHub's servers. It posts once per day, as soon as `POST_TIME` has passed. Every step below works in the Discord app and a phone browser.

1. **Create a webhook in the Discord app:** open your server → tap the server name → **Settings** → **Integrations** → **Webhooks** → **New Webhook**. Pick the channel, give it a name and picture (e.g. "Umamusume Daily"), then tap **Copy Webhook URL**.
2. **Give the URL to GitHub:** in your browser, open the repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Name it `WEBHOOK` (or `DISCORD_WEBHOOK_URL`), with no spaces, and paste the URL as the value. (On a phone you may need to switch the browser to "desktop site" to see **Settings**.)
3. **Test it:** open the **Actions** tab → **Daily Umamusume picture** → **Run workflow**, then pick one of these:
   - `post now` posts today's picture right away.
   - `check sources` tests the image sites. Open the run's log to see the results.
4. **Optional:** change settings by adding repository **variables** (same page, **Variables** tab), e.g. `POST_TIME` = `09:00` and `TIMEZONE` = `Europe/Warsaw`. Any setting from the [configuration table](#configuration) works, except the Discord ones.

After a successful post, the workflow commits the post history to `state/history.json`, so pictures never repeat. These daily commits also stop GitHub from pausing the schedule, which it does in repos with no activity for 60 days. GitHub can start scheduled runs a bit late, so the picture usually arrives within an hour after `POST_TIME`.

## Slash command without a computer (Cloudflare Workers)

[`discord-worker/worker.js`](discord-worker/worker.js) answers `/uma` with a random SFW picture. It uses the same sites and blacklist as the bot, without the post history. Discord sends each command to the Worker over HTTPS, so nothing has to stay online, and Cloudflare's free plan is plenty. Every step works in a phone browser; switch to "desktop site" if a page looks cut off.

1. **Create a Discord application:** open <https://discord.com/developers/applications> → **New Application**, give it a name (e.g. "Umamusume") → **Create**.
   - On **General Information**, copy the **Public Key** and keep it somewhere for step 3.
   - Open **Bot** → **Reset Token** and copy the token too.
2. **Deploy the Worker from GitHub:** sign up at <https://dash.cloudflare.com> (free) → **Workers & Pages** → **Create** → **Import a repository** → connect GitHub and pick this repo. Keep the suggested name `claude-test` and the default settings, then tap **Deploy**.
3. **Add the two keys:** in the new Worker, go to **Settings** → **Variables and Secrets** → **Add**. Choose type **Secret** for both:
   - `DISCORD_PUBLIC_KEY` = the Public Key from step 1
   - `DISCORD_TOKEN` = the bot token from step 1
4. **Register the command:** open the Worker's address with `/register` on the end, e.g. `https://claude-test.YOUR-NAME.workers.dev/register`. You'll find the address on the Worker's overview page. Then tap **Add to Discord** and pick your server.
5. **Point Discord at the Worker:** back in the Developer Portal → **General Information** → **Interactions Endpoint URL**, paste the Worker's address (without `/register`) → **Save Changes**.

Now type `/uma` in your server. Opening the Worker's plain address shows whether both keys are set. Every push to this repo redeploys the Worker automatically, and the keys stay.

## 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. Open **Bot** → **Reset Token** and copy the token. Keep it secret!
3. Copy your **Application ID** from **General Information**, then invite the bot with this link (replace `YOUR_APP_ID`):

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=52224
   ```

   (`52224` = View Channel + Send Messages + Embed Links + Attach Files.)
4. In Discord, turn on **Settings → Advanced → Developer Mode**. Then right-click the channel for the daily picture → **Copy Channel ID**.

No privileged intents are needed.

## 2. Install and configure

You need **Python 3.10+**.

```bash
git clone https://github.com/jedrek20005-byte/claude-test.git umabot
cd umabot
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env             # Windows: copy .env.example .env
```

Edit `.env` and set at least:

```ini
DISCORD_TOKEN=your-bot-token
CHANNEL_IDS=123456789012345678
POST_TIME=09:00
TIMEZONE=Europe/Warsaw
```

## 3. Test the image sources

Before starting the bot, check that every source works from your machine (this doesn't need Discord). Example output:

```bash
python -m umabot check
```

```
[OK]    Danbooru: 100 posts on the first page for 'umamusume', 71 pass the SFW filter
        e.g. https://danbooru.donmai.us/posts/...
[OK]    Safebooru: ...
[EMPTY] Konachan: 0 posts on the first page for 'uma_musume_pretty_derby', 0 pass the SFW filter
```

If a source shows `EMPTY`, the site probably uses a different tag name. Look up the right tag on the site and set it, e.g. `KONACHAN_TAGS=umamusume`. If a source shows `FAIL`, the site is down or blocking you. You can remove it with e.g. `SOURCES=danbooru,safebooru`.

## 4. Run the bot

```bash
python -m umabot
```

The bot has to keep running to post every day, so host it somewhere that's always on: a VPS, a Raspberry Pi, or a home server. With Docker:

```bash
docker compose up -d --build
```

Slash commands can take up to an hour to appear the first time. Set `GUILD_ID` to your server's ID to make them appear instantly.

## Configuration

Every setting goes in `.env` (see [`.env.example`](.env.example)):

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token (**required** for the full bot) |
| `CHANNEL_IDS` | — | Channel ID(s) for the daily post, comma-separated (**required** for the full bot) |
| `DISCORD_WEBHOOK_URL` | — | Webhook URL(s) for `python -m umabot post`, comma-separated (**required** in webhook mode) |
| `POST_TIME` | `12:00` | Time of the daily post (24-hour clock) |
| `TIMEZONE` | `UTC` | [IANA time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), e.g. `Europe/Warsaw` |
| `CATCH_UP` | `true` | Post on startup if today's post was missed |
| `DAILY_MESSAGE` | — | Text sent along with the daily picture |
| `GUILD_ID` | — | Register slash commands in this server instantly |
| `SOURCES` | `auto` | `auto` (all sources that have their credentials) or a list like `danbooru,safebooru` |
| `DANBOORU_LOGIN` / `DANBOORU_API_KEY` | — | Optional Danbooru account |
| `GELBOORU_USER_ID` / `GELBOORU_API_KEY` | — | From Gelbooru → My Account → Options → API Access Credentials |
| `ZEROCHAN_USERNAME` | — | Your Zerochan username (Zerochan asks API users to identify themselves) |
| `<SOURCE>_TAGS` | see `.env.example` | Search tag per source, e.g. `DANBOORU_TAGS` |
| `ALLOW_SENSITIVE` | `false` | `true` also allows posts rated *sensitive* (less strict) |
| `EXTRA_BLACKLIST_TAGS` | — | More tags to block, e.g. `comic,4koma,monochrome`. `*` wildcards work |
| `BLACKLIST_TAGS` | built-in list | Replaces the built-in blacklist entirely |
| `MIN_SCORE` | `0` | Skip posts with a lower score (leave empty to turn off) |
| `UPLOAD_IMAGES` | `true` | Upload the file instead of only linking it |
| `MAX_UPLOAD_MB` | `9` | Largest file to upload (Discord's limit is 10 MB without boosts) |
| `RETRY_COUNT` / `RETRY_DELAY_MINUTES` | `3` / `15` | Retries when no picture could be fetched |
| `COMMAND_COOLDOWN` | `30` | Per-user cooldown for `/uma` in seconds (`0` turns it off) |
| `STATE_FILE` | `data/state.json` | Where the post history is stored |

### Anonymous Danbooru tag limit

Without a paid account, Danbooru allows only 2 tags per search, and the bot already uses one for the rating. Keep `DANBOORU_TAGS` to a single tag. To focus on one character, use their tag instead, e.g. `DANBOORU_TAGS=special_week_(umamusume)`.

## How the SFW filtering works

1. Searches ask the site for safe ratings only where the site supports it (Danbooru `rating:g`, Gelbooru `rating:general`).
2. Each post's rating is converted to one common scale. Only *general* passes by default, or *sensitive* too with `ALLOW_SENSITIVE=true`. Posts with an unknown rating are always rejected.
3. Every post's tags are checked against the blacklist (see `DEFAULT_BLACKLIST` in [`umabot/config.py`](umabot/config.py)).
4. Only images are posted (jpg/png/gif/webp), never videos or archives.

No automatic filter is perfect. If something slips through, add its tag to `EXTRA_BLACKLIST_TAGS`.

## Development

```bash
pip install -r requirements-dev.txt
pytest
```

The tests run against local fake versions of every site's API, so they don't need network access.

The Cloudflare Worker has its own tests, which need only Node.js 20+: `node --test discord-worker/worker.test.mjs`.

Project layout:

```
umabot/
  __main__.py     entry point (python -m umabot [run|post|check])
  bot.py          Discord client, daily scheduler, slash commands
  webhook.py      `post` command: one daily post through a webhook (GitHub Actions)
  config.py       settings from .env, default tags and blacklist
  picker.py       picks a fresh, safe picture, falling back between sources
  filters.py      rating / blacklist / file-type filter
  history.py      remembers posted pictures
  posting.py      downloads the image and builds the embed
  schedule.py     time-zone and DST-safe scheduling helpers
  sources/        one module per site (Danbooru, Safebooru, Gelbooru, Konachan, Zerochan)
discord-worker/  /uma as a Cloudflare Worker (no always-on bot needed)
```

Please respect each site's terms of service and rate limits. The bot makes only a few requests per day plus one per `/uma`.
