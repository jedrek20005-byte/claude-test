// The Umamusume Discord app as a Cloudflare Worker: /uma, the daily picture,
// and commands to set where and when the daily picture is posted.
//
// Discord sends each command to this Worker over HTTPS ("interactions
// endpoint"), and a cron trigger wakes it up to post the daily picture, so
// there's no bot process to keep online. Setup steps: README, "Slash commands
// without a computer".
//
// Worker → Settings:
//   Secret DISCORD_PUBLIC_KEY  Developer Portal → your app → General Information → Public Key
//   Secret DISCORD_TOKEN       Developer Portal → your app → Bot → Reset Token
//   KV namespace binding UMA_STATE   stores the settings and post history (needed for the daily picture)
//   Cron trigger */5 * * * *         checks every 5 minutes whether it's time for the daily picture

const API = "https://discord.com/api/v10";
const USER_AGENT = "UmamusumeDailyBot/1.0 (+https://github.com/jedrek20005-byte/claude-test)";
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const EMBED_COLOR = 0x5fbf6e;
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const GENERAL = 0;
const UNKNOWN = 9;
const DAILY_TITLE = "🐴 Umamusume of the Day";
const RANDOM_TITLE = "🐴 Random Umamusume";
const RETRY_AFTER_MS = 30 * 60 * 1000;
const HISTORY_LENGTH = 2000;
// View Channel + Send Messages + Embed Links + Attach Files
const BOT_PERMISSIONS = "52224";
const BOT_USER_AGENT = "DiscordBot (https://github.com/jedrek20005-byte/claude-test, 1.0)";

const DEFAULT_SETTINGS = {
  enabled: false,
  channelId: null,
  time: "12:00",
  timeZone: "UTC",
  lastDaily: null, // local date of the last daily picture
  lastError: null,
  retryAfter: 0,
};

const TIME_ZONES = [
  "UTC", "Europe/London", "Europe/Lisbon", "Europe/Paris", "Europe/Berlin", "Europe/Warsaw",
  "Europe/Rome", "Europe/Madrid", "Europe/Athens", "Europe/Kyiv", "Europe/Istanbul",
  "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok", "Asia/Shanghai",
  "Asia/Singapore", "Asia/Tokyo", "Asia/Seoul", "Australia/Sydney", "Pacific/Auckland",
  "America/Sao_Paulo", "America/New_York", "America/Chicago", "America/Los_Angeles",
];

// Settings commands are only shown to people with Manage Server, and only in servers.
const ADMIN_ONLY = { default_member_permissions: "32", contexts: [0] };

const COMMANDS = [
  { name: "uma", description: "Post a random SFW Umamusume picture", type: 1 },
  { name: "uma_here", description: "Post the daily Umamusume picture in this channel", type: 1, ...ADMIN_ONLY },
  {
    name: "uma_time",
    description: "Set what time the daily picture is posted",
    type: 1,
    ...ADMIN_ONLY,
    options: [
      { type: 3, name: "time", description: "24-hour time, like 09:00 or 21:30", required: true, max_length: 5 },
      {
        type: 3,
        name: "timezone",
        description: "Your time zone (keeps the current one if left empty)",
        required: false,
        choices: TIME_ZONES.map((zone) => ({ name: zone, value: zone })),
      },
    ],
  },
  { name: "uma_off", description: "Stop posting the daily picture", type: 1, ...ADMIN_ONLY },
  { name: "uma_status", description: "Show the daily picture settings", type: 1, ...ADMIN_ONLY },
];

// Same list as DEFAULT_BLACKLIST in umabot/config.py; * is a wildcard.
const BLACKLIST = [
  "nude", "completely_nude", "topless", "bottomless", "nipples", "areolae",
  "sex", "cum", "penis", "pussy", "after_sex", "implied_sex", "nsfw", "ecchi",
  "fanservice", "sexually_suggestive", "lewd", "loli", "shota", "pregnant",
  "underwear", "underwear_only", "panties", "bra", "lingerie", "pantyshot",
  "upskirt", "cameltoe", "swimsuit", "*_swimsuit", "bikini", "*_bikini",
  "cleavage", "sideboob", "underboob", "breast_grab", "groping", "ass",
  "ass_focus", "crotch", "groin", "spread_legs", "see-through", "naked_towel",
  "bath", "bathing", "onsen", "wet_clothes", "undressing", "bdsm", "bondage",
  "shibari", "gore", "guro", "blood", "vore", "foot_focus",
];
const BLACKLIST_EXACT = new Set(BLACKLIST.filter((tag) => !tag.includes("*")));
const BLACKLIST_PATTERNS = BLACKLIST.filter((tag) => tag.includes("*")).map(
  (tag) => new RegExp(`^${tag.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`),
);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/register") {
      return registerPage(env);
    }
    if (request.method === "GET") {
      return statusPage(env);
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.text();
    if (!(await isFromDiscord(request, body, env.DISCORD_PUBLIC_KEY))) {
      return new Response("Invalid request signature", { status: 401 });
    }
    const interaction = JSON.parse(body);

    if (interaction.type === 1) {
      // Discord pings the endpoint when it's saved in the Developer Portal:
      // a good moment to make sure the commands are registered.
      ctx.waitUntil(registerCommands(env).catch((err) => console.error(err.message)));
      return jsonResponse({ type: 1 });
    }
    const handler = interaction.type === 2 && COMMAND_HANDLERS[interaction.data?.name];
    if (handler) {
      return handler(interaction, env, ctx);
    }
    return reply("Unknown command.", { ephemeral: true });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDaily(env, new Date(controller.scheduledTime)));
  },
};

// ---- Discord ---------------------------------------------------------------

function jsonResponse(data) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex.trim())) {
    throw new Error("not hex");
  }
  return new Uint8Array(hex.trim().match(/../g).map((byte) => parseInt(byte, 16)));
}

export async function isFromDiscord(request, body, publicKey) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKey) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

function botHeaders(env) {
  return { Authorization: `Bot ${env.DISCORD_TOKEN.trim()}`, "User-Agent": BOT_USER_AGENT };
}

function reply(content, { ephemeral = false } = {}) {
  return jsonResponse({ type: 4, data: { content, flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] } } });
}

const inviteLink = (appId) =>
  `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`;

async function discordApi(env, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...botHeaders(env), "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Discord returned HTTP ${res.status} for ${path}: ${await res.text()}`);
  }
  return res.json();
}

export async function registerCommands(env) {
  if (!env.DISCORD_TOKEN) {
    throw new Error("The DISCORD_TOKEN secret is not set.");
  }
  const app = await discordApi(env, "/applications/@me");
  await discordApi(env, `/applications/${app.id}/commands`, { method: "PUT", body: JSON.stringify(COMMANDS) });
  return app;
}

async function registerPage(env) {
  try {
    const app = await registerCommands(env);
    return new Response(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<body style="font:18px sans-serif;padding:16px;line-height:1.5">` +
        `<p>✅ The commands are registered for <b>${escapeHtml(app.name)}</b>.</p>` +
        `<p>Next, add it to your server (this also lets it post the daily picture):</p>` +
        `<p><a href="${inviteLink(app.id)}" style="font-size:22px">Add to Discord</a></p></body>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  } catch (err) {
    return new Response(`❌ ${err.message}`, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

function statusPage(env) {
  const check = (name) => `${env[name] ? "✅" : "❌"} ${name} ${env[name] ? "is set" : "is missing"}`;
  const text = [
    "Umamusume /uma worker is running.",
    "",
    check("DISCORD_PUBLIC_KEY"),
    check("DISCORD_TOKEN"),
    check("UMA_STATE") + (env.UMA_STATE ? "" : " (a KV namespace binding, needed for the daily picture)"),
    "",
    "Open /register on this address to register the commands and get the invite link.",
  ].join("\n");
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function answerUma(interaction, env) {
  const editUrl = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  try {
    const seen = await loadSeen(env);
    const image = await pickImage(SOURCES, seen);
    if (!image) {
      await sendToDiscord(editUrl, "PATCH", {}, { content: "Couldn't find a picture right now, try again in a bit." });
      return;
    }
    await deliver(editUrl, "PATCH", {}, image, RANDOM_TITLE);
    await remember(env, image);
  } catch (err) {
    console.error(err);
    await sendToDiscord(editUrl, "PATCH", {}, { content: "Something went wrong, sorry." }).catch(() => {});
  }
}

// Sends a message (or edits one), with the picture uploaded as a file when it
// could be downloaded, and as a link otherwise.
async function deliver(url, method, headers, image, title) {
  const file = await downloadImage(image);
  if (file) {
    try {
      await sendToDiscord(url, method, headers, { embeds: [buildEmbed(image, `attachment://${file.name}`, title)] }, file);
      return;
    } catch (err) {
      console.error(`Upload failed, linking instead: ${err.message}`);
    }
  }
  await sendToDiscord(url, method, headers, { embeds: [buildEmbed(image, image.imageUrl, title)] });
}

async function sendToDiscord(url, method, headers, payload, file) {
  let init;
  if (file) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ ...payload, attachments: [{ id: 0, filename: file.name }] }));
    form.append("files[0]", new Blob([file.data], { type: file.type }), file.name);
    init = { method, headers, body: form };
  } else {
    init = { method, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) };
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Discord returned HTTP ${res.status}: ${await res.text()}`);
  }
}

// ---- Settings commands -----------------------------------------------------

const NO_STORAGE =
  "I can't remember settings yet… The Worker needs a KV namespace binding called `UMA_STATE` (see the README).";

async function loadGuilds(env) {
  return (await env.UMA_STATE.get("guilds", "json")) || {};
}

async function updateGuild(env, guildId, change) {
  const guilds = await loadGuilds(env);
  const settings = { ...DEFAULT_SETTINGS, ...guilds[guildId], ...change };
  guilds[guildId] = settings;
  await env.UMA_STATE.put("guilds", JSON.stringify(guilds));
  return settings;
}

export function parseTime(text) {
  const match = String(text ?? "").trim().match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!match || Number(match[1]) > 23 || Number(match[2] ?? 0) > 59) {
    return null;
  }
  return `${match[1].padStart(2, "0")}:${match[2] ?? "00"}`;
}

function isTimeZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// The local date ("2026-11-03") and time ("09:05") at `date` in `timeZone`.
export function localNow(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const schedule = (settings) => `**${settings.time}** (${settings.timeZone})`;

const COMMAND_HANDLERS = {
  uma(interaction, env, ctx) {
    // Reply "thinking…" right away (Discord allows 3 seconds), then edit in the picture.
    ctx.waitUntil(answerUma(interaction, env));
    return jsonResponse({ type: 5 });
  },

  uma_here(interaction, env, ctx) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    ctx.waitUntil(useThisChannel(interaction, env));
    return jsonResponse({ type: 5 });
  },

  async uma_time(interaction, env) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    const options = Object.fromEntries((interaction.data.options || []).map((option) => [option.name, option.value]));
    const time = parseTime(options.time);
    if (!time) {
      return reply("Hmm… I didn't understand that time. Please write it like `09:00` or `21:30`!", { ephemeral: true });
    }
    if (options.timezone && !isTimeZone(options.timezone)) {
      return reply(`I don't know the time zone "${options.timezone}"… Try one from the list!`, { ephemeral: true });
    }
    const change = options.timezone ? { time, timeZone: options.timezone } : { time };
    const settings = await updateGuild(env, interaction.guild_id, change);
    let text = `Got it! I'll post a new picture every day at ${schedule(settings)} 💚`;
    if (!settings.enabled || !settings.channelId) {
      text += "\nNow use `/uma_here` in the channel where I should post!";
    }
    return reply(text);
  },

  async uma_off(interaction, env) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    await updateGuild(env, interaction.guild_id, { enabled: false });
    return reply("Okay, I'll take a little break from the daily picture. Use `/uma_here` to start again! 💚");
  },

  async uma_status(interaction, env) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    const settings = { ...DEFAULT_SETTINGS, ...(await loadGuilds(env))[interaction.guild_id] };
    const lines = [
      `📅 Daily picture: ${settings.enabled && settings.channelId ? "on" : "off"}`,
      `📍 Channel: ${settings.channelId ? `<#${settings.channelId}>` : "not set (use `/uma_here`)"}`,
      `⏰ Time: ${schedule(settings)}`,
      `🖼️ Last daily picture: ${settings.lastDaily || "not yet"}`,
    ];
    if (settings.lastError) {
      lines.push(`⚠️ Last problem: ${settings.lastError.slice(0, 300)}`);
    }
    return reply(lines.join("\n"), { ephemeral: true });
  },
};

async function useThisChannel(interaction, env) {
  const editUrl = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  try {
    const channelId = interaction.channel_id ?? interaction.channel?.id;
    // Only works once Belno is in the server as a bot and can see the channel.
    const check = env.DISCORD_TOKEN ? await fetch(`${API}/channels/${channelId}`, { headers: botHeaders(env) }) : null;
    if (!check?.ok) {
      const content =
        `I can't post in this channel yet… 🥺 Please [add me as a bot](${inviteLink(interaction.application_id)}) ` +
        "and make sure I can see this channel, then use `/uma_here` again!";
      await sendToDiscord(editUrl, "PATCH", {}, { content });
      return;
    }
    const settings = await updateGuild(env, interaction.guild_id, {
      channelId, enabled: true, lastError: null, retryAfter: 0,
    });
    await sendToDiscord(editUrl, "PATCH", {}, {
      content: `Yay! From now on I'll post a picture here every day at ${schedule(settings)} 💚\n` +
        "Use `/uma_time` to change the time.",
    });
  } catch (err) {
    console.error(err);
    await sendToDiscord(editUrl, "PATCH", {}, { content: "Something went wrong, sorry." }).catch(() => {});
  }
}

// ---- Daily picture ---------------------------------------------------------

// Runs from the cron trigger: posts in every server whose time has come and
// that hasn't had today's picture yet. A failed post is retried 30 minutes later.
export async function runDaily(env, now = new Date()) {
  if (!env.UMA_STATE || !env.DISCORD_TOKEN) return;
  const updates = {};
  for (const [guildId, stored] of Object.entries(await loadGuilds(env))) {
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    const local = localNow(now, settings.timeZone);
    if (
      !settings.enabled || !settings.channelId || settings.lastDaily === local.day ||
      local.time < settings.time || now.getTime() < settings.retryAfter
    ) {
      continue;
    }
    try {
      const image = await pickImage(SOURCES, await loadSeen(env));
      if (!image) throw new Error("None of the image sites returned a picture.");
      await deliver(`${API}/channels/${settings.channelId}/messages`, "POST", botHeaders(env), image, DAILY_TITLE);
      await remember(env, image);
      updates[guildId] = { lastDaily: local.day, lastError: null, retryAfter: 0 };
    } catch (err) {
      console.error(`Daily picture for server ${guildId} failed: ${err.message}`);
      updates[guildId] = { lastError: err.message, retryAfter: now.getTime() + RETRY_AFTER_MS };
    }
  }
  if (Object.keys(updates).length) {
    // Re-read so a settings command run meanwhile isn't overwritten.
    const guilds = await loadGuilds(env);
    for (const [guildId, update] of Object.entries(updates)) {
      guilds[guildId] = { ...DEFAULT_SETTINGS, ...guilds[guildId], ...update };
    }
    await env.UMA_STATE.put("guilds", JSON.stringify(guilds));
  }
}

// ---- Post history (so pictures don't repeat) -------------------------------

const imageKey = (image) => `${image.source}:${image.id}`;

async function loadSeen(env) {
  if (!env.UMA_STATE) return new Set();
  return new Set((await env.UMA_STATE.get("history", "json")) || []);
}

async function remember(env, image) {
  if (!env.UMA_STATE) return;
  try {
    const history = (await env.UMA_STATE.get("history", "json")) || [];
    history.push(imageKey(image), ...(image.md5 ? [image.md5] : []));
    await env.UMA_STATE.put("history", JSON.stringify(history.slice(-HISTORY_LENGTH)));
  } catch (err) {
    console.error(`Couldn't save the post history: ${err.message}`);
  }
}

// ---- Picking a picture -----------------------------------------------------

function normalizeTag(tag) {
  return tag.toLowerCase().trim().split(/\s+/).join("_");
}

function extensionOf(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return "";
  }
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
}

function sourceLink(source, pixivId) {
  if (pixivId) {
    return `https://www.pixiv.net/artworks/${pixivId}`;
  }
  if (!source || !/^https?:\/\//.test(source)) {
    return null;
  }
  const pixiv = source.match(/pximg\.net\/.*?\/(\d+)_(?:p\d+|ugoira)/);
  return pixiv ? `https://www.pixiv.net/artworks/${pixiv[1]}` : source;
}

const UMA_QUALIFIER = /_\((?:umamusume|uma_musume(?:_pretty_derby)?)\)$/;

function guessCharacters(tags) {
  return tags.filter((tag) => UMA_QUALIFIER.test(tag)).sort();
}

export function prettyCharacter(tag) {
  return tag
    .replace(UMA_QUALIFIER, "")
    .split("_")
    .filter(Boolean)
    .map((word) => {
      if (/^(?:[a-z]\.)+$/.test(word)) return word.toUpperCase();
      const start = word.startsWith("(") ? 1 : 0;
      return word.slice(0, start) + word.charAt(start).toUpperCase() + word.slice(start + 1);
    })
    .join(" ");
}

export function isSafe(image) {
  if (image.rating !== GENERAL) return false;
  if (!ALLOWED_EXTENSIONS.has(extensionOf(image.imageUrl))) return false;
  if (typeof image.score === "number" && image.score < 0) return false;
  return !image.tags.some((raw) => {
    const tag = normalizeTag(raw);
    return BLACKLIST_EXACT.has(tag) || BLACKLIST_PATTERNS.some((pattern) => pattern.test(tag));
  });
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  }
  const text = (await res.text()).trim();
  return text ? JSON.parse(text) : null;
}

const toInt = (value) => (Number.isInteger(Number(value)) && value !== null && value !== "" ? Number(value) : null);
const absolute = (url) => (url ? (url.startsWith("//") ? `https:${url}` : url) : null);

export const SOURCES = [
  {
    name: "Danbooru",
    pages: 20,
    async fetchPage(page) {
      // Anonymous Danbooru searches allow two tags: the franchise and the rating.
      const query = new URLSearchParams({ tags: "umamusume rating:g", limit: "50", page: String(page + 1) });
      const posts = await getJson(`https://danbooru.donmai.us/posts.json?${query}`);
      return (Array.isArray(posts) ? posts : [])
        .filter((post) => post.id && post.file_url && !post.is_deleted && !post.is_banned)
        .map((post) => ({
          source: "Danbooru",
          id: String(post.id),
          imageUrl: post.file_url,
          sampleUrl: post.large_file_url || null,
          pageUrl: `https://danbooru.donmai.us/posts/${post.id}`,
          rating: { g: 0, s: 1, q: 2, e: 3 }[post.rating] ?? UNKNOWN,
          tags: (post.tag_string || "").split(" ").filter(Boolean),
          artists: (post.tag_string_artist || "").split(" ").filter(Boolean),
          characters: (post.tag_string_character || "").split(" ").filter(Boolean),
          sourceUrl: sourceLink(post.source, post.pixiv_id),
          score: toInt(post.score),
          md5: post.md5 || null,
        }));
    },
  },
  {
    name: "Safebooru",
    pages: 20,
    async fetchPage(page) {
      const query = new URLSearchParams({
        page: "dapi", s: "post", q: "index", json: "1", tags: "umamusume", limit: "50", pid: String(page),
      });
      const data = await getJson(`https://safebooru.org/index.php?${query}`);
      const posts = Array.isArray(data) ? data : data?.post || [];
      const ratings = { general: 0, safe: 0, sensitive: 1, questionable: 2, explicit: 3 };
      return posts
        .filter((post) => post.id != null)
        .map((post) => {
          const built = post.directory && post.image ? `https://safebooru.org/images/${post.directory}/${post.image}` : null;
          const sample = post.sample && post.directory && post.image
            ? `https://safebooru.org/samples/${post.directory}/sample_${String(post.image).replace(/\.[^.]+$/, "")}.jpg`
            : null;
          const tags = String(post.tags || "").split(" ").filter(Boolean);
          return {
            source: "Safebooru",
            id: String(post.id),
            imageUrl: absolute(post.file_url) || built,
            sampleUrl: absolute(post.sample_url) || sample,
            pageUrl: `https://safebooru.org/index.php?page=post&s=view&id=${post.id}`,
            rating: ratings[String(post.rating || "").toLowerCase()] ?? UNKNOWN,
            tags,
            artists: [],
            characters: guessCharacters(tags),
            sourceUrl: sourceLink(post.source),
            score: toInt(post.score),
            md5: post.hash || post.md5 || null,
          };
        })
        .filter((post) => post.imageUrl);
    },
  },
  {
    name: "Konachan",
    pages: 10,
    async fetchPage(page) {
      const query = new URLSearchParams({ tags: "uma_musume_pretty_derby", limit: "50", page: String(page + 1) });
      const posts = await getJson(`https://konachan.net/post.json?${query}`);
      return (Array.isArray(posts) ? posts : [])
        .filter((post) => post.id && post.file_url && post.status !== "deleted")
        .map((post) => {
          const tags = String(post.tags || "").split(" ").filter(Boolean);
          return {
            source: "Konachan",
            id: String(post.id),
            imageUrl: absolute(post.file_url),
            sampleUrl: absolute(post.sample_url),
            pageUrl: `https://konachan.net/post/show/${post.id}`,
            // Moebooru's lowest rating is "safe"; the blacklist catches borderline posts.
            rating: { s: 0, q: 2, e: 3 }[post.rating] ?? UNKNOWN,
            tags,
            artists: [],
            characters: guessCharacters(tags),
            sourceUrl: sourceLink(post.source),
            score: toInt(post.score),
            md5: post.md5 || null,
          };
        });
    },
  },
];

const randomInt = (max) => Math.floor(Math.random() * max);

function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export async function pickImage(sources = SOURCES, seen = new Set()) {
  for (const source of shuffled(sources)) {
    // A random page for variety; page 0 as a fallback if that one is past the end.
    for (const page of new Set([randomInt(source.pages), 0])) {
      let posts;
      try {
        posts = await source.fetchPage(page);
      } catch (err) {
        console.error(`${source.name} is unavailable: ${err.message}`);
        break;
      }
      const safe = posts.filter((post) => isSafe(post) && !seen.has(imageKey(post)) && !(post.md5 && seen.has(post.md5)));
      if (safe.length) {
        return safe[randomInt(safe.length)];
      }
    }
  }
  return null;
}

async function downloadImage(image) {
  // The smaller sample first: it's quicker and well within Discord's upload limit.
  for (const url of new Set([image.sampleUrl, image.imageUrl].filter(Boolean))) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Referer: image.pageUrl } });
      const type = res.headers.get("Content-Type") || "";
      if (!res.ok || !type.startsWith("image/") || Number(res.headers.get("Content-Length")) > MAX_UPLOAD_BYTES) {
        continue;
      }
      const data = await res.arrayBuffer();
      if (data.byteLength > MAX_UPLOAD_BYTES) {
        continue;
      }
      const ext = ALLOWED_EXTENSIONS.has(extensionOf(url)) ? extensionOf(url) : ".jpg";
      return { name: `umamusume_${image.source.toLowerCase()}_${image.id}${ext}`, data, type };
    } catch (err) {
      console.error(`Couldn't download ${url}: ${err.message}`);
    }
  }
  return null;
}

function escapeMarkdown(text) {
  return text.replace(/([\\*_~`|>[\]()])/g, "\\$1");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function joinLimited(items, limit = 4) {
  return items.length <= limit ? items.join(", ") : `${items.slice(0, limit).join(", ")} +${items.length - limit} more`;
}

export function buildEmbed(image, imageUrl, title = RANDOM_TITLE) {
  const lines = [];
  if (image.characters.length) {
    lines.push(`**Characters:** ${joinLimited(image.characters.map((c) => escapeMarkdown(prettyCharacter(c))))}`);
  }
  if (image.artists.length) {
    lines.push(`**Artist:** ${joinLimited(image.artists.map((a) => escapeMarkdown(a.replace(/_/g, " "))))}`);
  }
  if (image.sourceUrl) {
    lines.push(`**Original:** [source](${image.sourceUrl.replace(/\(/g, "%28").replace(/\)/g, "%29")})`);
  }
  return {
    title,
    url: image.pageUrl,
    description: lines.join("\n") || undefined,
    color: EMBED_COLOR,
    image: { url: imageUrl },
    footer: { text: `${image.source} · post #${image.id}` },
    timestamp: new Date().toISOString(),
  };
}
