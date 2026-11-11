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
  - Or use **[a free Cloudflare Worker](#slash-commands-without-a-computer-cloudflare-workers)** instead: `/uma`, plus commands to set where and when the daily picture is posted.
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

## Slash commands without a computer (Cloudflare Workers)

[`discord-worker/worker.js`](discord-worker/worker.js) is the whole app as a Cloudflare Worker. Discord sends each command to it over HTTPS, and a cron trigger wakes it up for the daily picture, so nothing has to stay online. Cloudflare's free plan is plenty. It uses the same sites and blacklist as the bot.

| Command | Who sees it | What it does |
| --- | --- | --- |
| `/uma` | everyone | posts a random SFW picture right away |
| `/uma_here` | Manage Server | posts the scheduled pictures in this channel (and turns them on) |
| `/uma_every hours:Every hour` | Manage Server | how often: every 1, 2, 3, 4, 6, 8 or 12 hours, or once a day (the default) |
| `/uma_time time:09:00 timezone:Europe/Warsaw` | Manage Server | what time to post (for hourly posts, the minute); the time zone is picked from a list |
| `/uma_off` | Manage Server | pauses scheduled pictures (`/uma_here` turns them back on) |
| `/uma_status` | Manage Server | shows the channel, schedule, last post and last problem |
| `/uma_say message:Hi!` | Manage Server | posts the message as the app (leave `message` empty for a multi-line box; `channel:` posts elsewhere; never pings @everyone, @here or roles) |
| `/uma_monthly day:25 time:18:00 message:…` | Manage Server | posts a reminder every day from that day of the month until the month ends, with a days-left countdown, like a club quota reminder (`once:True` posts only on that day; `ping:` mentions a role, `channel:` posts elsewhere, `gif:` adds one of Belno's GIFs, a new one each month; no `message` opens a multi-line box; 29–31 means the last day in shorter months) |
| `/uma_monthly_off` | Manage Server | stops the monthly message |
| `/uma_import bot:@UmaCore channel:#…` | Manage Server | reads each member's monthly fans from [UmaCore](https://github.com/oHaruki/UmaCore)'s Live Board (default layout) every 30 minutes, instead of `/uma_fans`; `stop:True` turns it off. Needs **Message Content Intent** and View Channel + Read Message History there |
| `/uma_test what:Monthly reminder` | Manage Server | privately previews the monthly reminder or club summary (an example before anyone reports); `post:True` also sends it in its channel without counting as the real one |
| `/uma_quota fans:30m` | Manage Server | sets the monthly fan quota per member and posts last month's club summary on the 1st (from 12:00) in this channel (or `channel:`) |
| `/uma_fans fans:32.5m` | everyone | saves the fans you gained this month (latest number counts; admins can add `member:` to save for someone else) |
| `/uma_summary` | everyone | club summary for this (or last) month: total, quota done/not yet, top fans, most improved, compared with the month before, plus a card comparing every member with their last two months (change, quota mark and a note from Belno) |
| `/uma_cards` | everyone | private link to your card box: tap the support cards you own and pick their limit break |
| `/uma_deck goal:Most fans` | everyone | builds your best 5-card deck from your cards (goals: **Most fans**, **Race bonus**) |
| `/uma_races uma:Special Week` | everyone | plans the races that give that Uma the most fans in one career: one per turn, only on surfaces and distances she's A at (`aptitude:` allows B or C), at most 3 in a row (`in_a_row:` 1–6), and only once she has the fans to enter |
| `/uma_react mood:Happy` | everyone | posts a Belno Light reaction GIF with one of her lines (moods: Happy, Love, Sad, Shocked, Bonk, Sleepy, Hungry, or any); `message:` says something else, `to:` pings someone |

**Race planner.** `/uma_races` uses `race-data/races.json`, rebuilt every Monday from [GameTora](https://gametora.com)'s copy of the game data: every career race's turn, grade, surface, distance, fans for 1st place and fans needed to enter, plus each Uma's aptitudes. It counts fans for winning, before fan bonuses, and doesn't know her career goals, so race those too.

**Reaction GIFs.** Belno's GIFs are Tenor links picked by hand; `<worker address>/gifs` shows them all by number with their mood, plus the ones left out. Change them in `GIFS` in [`discord-worker/worker.js`](discord-worker/worker.js).

**Deck builder.** `/uma_deck` adds up each card's Fan Bonus and Race Bonus at the max level for its limit break. It picks one card per character, as the game requires, and keeps slot 6 free for a borrowed friend card. The card data (`card-data/support-cards.json`) is rebuilt every Monday from the [Umamusume Wiki](https://umamusu.wiki), which reads the game's own master data. The *Update support card data* workflow can also be run by hand after a new banner.

Scheduled pictures come from the app itself, within 5 minutes of each post time. Pictures don't repeat: the post history is kept in Cloudflare KV. If posting fails, the Worker tries again 30 minutes later.

Every step below works in a phone browser; switch to "desktop site" if a page looks cut off.

1. **Create a Discord application:** open <https://discord.com/developers/applications> → **New Application**, give it a name → **Create**.
   - On **General Information**, copy the **Public Key**.
   - Open **Bot** → **Reset Token** and copy the token too.
2. **Create the Worker:** sign up at <https://dash.cloudflare.com> (free) → **Workers & Pages** → **Create**. Either:
   - **Import a repository** → pick this repo → **Deploy**, or
   - **Let GitHub deploy it** (best on a phone, and every code change deploys itself): create a token at **My Profile → API Tokens → Create Token → Edit Cloudflare Workers**, add it to this repo as the Actions secret `CLOUDFLARE_API_TOKEN`, and run the **Deploy Cloudflare Worker** workflow. Set `name`, `account_id` and the KV `id` in [`wrangler.toml`](wrangler.toml) to your own first; it then also creates the storage binding and timer from steps 4–5. Or:
   - **Start with Hello World!** → **Deploy** → **Edit code**, then paste the contents of [`discord-worker/worker.js`](https://raw.githubusercontent.com/jedrek20005-byte/claude-test/ccr-5787c415-0zgod8/discord-worker/worker.js) and tap **Deploy**.
3. **Add the keys** in the Worker → **Settings** → **Variables and Secrets** → **Add**, with type **Secret**:
   - `DISCORD_PUBLIC_KEY` = the Public Key
   - `DISCORD_TOKEN` = the bot token
4. **Add storage:** Worker → **Settings** → **Bindings** → **Add** → **KV namespace**. Name the variable `UMA_STATE` and create a new namespace for it (any name).
5. **Add the timer:** Worker → **Settings** → **Trigger events** (or **Triggers**) → **Add** → **Cron trigger** → every 5 minutes (`*/5 * * * *`).
6. **Register the commands:** open the Worker's address with `/register` on the end, e.g. `https://NAME.YOUR-NAME.workers.dev/register`. Then tap **Add to Discord** and pick your server. This adds the app as a bot so it can post the daily picture.
7. **Point Discord at the Worker:** Developer Portal → **General Information** → **Interactions Endpoint URL**, paste the Worker's address (without `/register`) → **Save Changes**. Reload the page to check it stayed.
8. **Set it up in Discord:** run `/uma_here` in the channel for the pictures, then `/uma_every` and `/uma_time`.

Opening the Worker's plain address shows whether the keys and storage are set up. If you used the GitHub Actions daily post before, turn it off (Actions → **Daily Umamusume picture** → **⋯** → **Disable workflow**) so the picture isn't posted twice.

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
discord-worker/  slash commands + daily picture as a Cloudflare Worker (no always-on bot needed)
```

Please respect each site's terms of service and rate limits. The bot makes only a few requests per day plus one per `/uma`.

## Modern Warships leaks bot

A second, separate Discord app in [`warships-worker/`](warships-worker/worker.js). Every 10 minutes it checks subreddits (through their RSS feed, since Reddit blocks its API from servers), YouTube channels and public Telegram channels. Each new post that matches a keyword is read by an AI model (Cloudflare Workers AI, free daily allowance; for videos it reads the description and, when YouTube provides them, the subtitles), and only the specific leak details it finds (ship names, weapons, events, dates) are posted, with a link to the source. Posts with nothing specific in them are skipped. X (Twitter) isn't supported: it doesn't allow free automatic reading.

| Command | What it does |
| --- | --- |
| `/leaks_here` | posts leaks in this channel (or `channel:`), starting with r/ModernWarships posts that mention "leak" |
| `/leaks_all` | watches every known leak source at once: r/ModernWarships and the leak YouTubers @ibragod, @LayszCH, @GUICKNES-FR and @GylaxMW (leak posts only), plus the official YouTube and Telegram channels (everything); skips ones already watched |
| `/leaks_add source:YouTube name:@SomeChannel filter:leak` | watches a subreddit, YouTube channel (@handle or link) or Telegram channel (`t.me/name`); `filter:` is comma-separated words, empty means everything |
| `/leaks_remove name:…` | stops watching a source (autocompletes) |
| `/leaks_list` | shows the sources, their filters and any problem |
| `/leaks_test` | posts the newest matching post from each source now |
| `/leaks_off` | pauses posting (sources are kept) |

All commands need Manage Server. Posts from before a source was added aren't reposted, and at most 5 new posts per source go out per check.

**Setup (phone friendly):**

1. <https://discord.com/developers/applications> → **New Application** (name and picture are up to you). Copy the **Public Key** from General Information, then **Bot → Reset Token** and copy the token.
2. In this repo: **Settings → Secrets and variables → Actions → New repository secret**: `LEAKS_KEY` = the Public Key, `LEAKS_TOKEN` = the bot token.
3. **Actions → Deploy leaks bot → Run workflow.** It creates the storage, deploys `mwleaks` (on the same Cloudflare account as Belno, using `CLOUDFLARE_API_TOKEN`), sets the app's Interactions Endpoint URL, registers the commands and shows the invite link in the run's summary.
4. Invite the bot with that link and use `/leaks_here` in your leaks channel.
