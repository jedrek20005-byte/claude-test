// The Umamusume Discord app as a Cloudflare Worker: /uma, scheduled pictures
// (daily or every few hours), and commands to set where and when they're posted.
//
// Discord sends each command to this Worker over HTTPS ("interactions
// endpoint"), and a cron trigger wakes it up to post scheduled pictures, so
// there's no bot process to keep online. Setup steps: README, "Slash commands
// without a computer".
//
// Worker → Settings:
//   Secret DISCORD_PUBLIC_KEY  Developer Portal → your app → General Information → Public Key
//   Secret DISCORD_TOKEN       Developer Portal → your app → Bot → Reset Token
//   KV namespace binding UMA_STATE   stores the settings and post history (needed for scheduled pictures)
//   Cron trigger */5 * * * *         checks every 5 minutes whether it's time to post

const API = "https://discord.com/api/v10";
const USER_AGENT = "UmamusumeDailyBot/1.0 (+https://github.com/jedrek20005-byte/claude-test)";
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const EMBED_COLOR = 0x5fbf6e;
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const GENERAL = 0;
const UNKNOWN = 9;
const RANDOM_TITLE = "🐴 Random Umamusume";
const RETRY_AFTER_MS = 30 * 60 * 1000;
// Keys and hashes of posted pictures: about four months of hourly posts.
const HISTORY_LENGTH = 6000;
export const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12, 24];
// View Channel + Send Messages + Embed Links + Attach Files
const BOT_PERMISSIONS = "52224";
const BOT_USER_AGENT = "DiscordBot (https://github.com/jedrek20005-byte/claude-test, 1.0)";

const DEFAULT_SETTINGS = {
  enabled: false,
  channelId: null,
  time: "12:00",
  timeZone: "UTC",
  everyHours: 24,
  lastPost: null, // local date and time of the last scheduled picture, like "2026-11-03 09:00"
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
  { name: "uma_here", description: "Post the scheduled Umamusume pictures in this channel", type: 1, ...ADMIN_ONLY },
  {
    name: "uma_every",
    description: "Set how often a picture is posted",
    type: 1,
    ...ADMIN_ONLY,
    options: [
      {
        type: 4,
        name: "hours",
        description: "How often to post",
        required: true,
        choices: EVERY_HOURS.map((hours) => ({
          name: hours === 24 ? "Once a day" : hours === 1 ? "Every hour" : `Every ${hours} hours`,
          value: hours,
        })),
      },
    ],
  },
  {
    name: "uma_time",
    description: "Set what time pictures are posted (for hourly posts, the minute)",
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
  { name: "uma_off", description: "Stop posting scheduled pictures", type: 1, ...ADMIN_ONLY },
  { name: "uma_status", description: "Show the scheduled picture settings", type: 1, ...ADMIN_ONLY },
  { name: "uma_cards", description: "Pick the support cards you own (for /uma_deck)", type: 1 },
  {
    name: "uma_deck",
    description: "Build your best support card deck from the cards you own",
    type: 1,
    options: [
      {
        type: 3,
        name: "goal",
        description: "What the deck should be best at",
        required: false,
        choices: [
          { name: "Most fans", value: "fans" },
          { name: "Race bonus", value: "race" },
        ],
      },
    ],
  },
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
    if (request.method === "GET" && url.pathname === "/cards") {
      return cardsPage(env, url);
    }
    if (url.pathname === "/cards/mine") {
      return myCardsApi(request, env, url);
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
      return handler(interaction, env, ctx, url.origin);
    }
    return reply("Unknown command.", { ephemeral: true });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runSchedule(env, new Date(controller.scheduledTime)));
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
        `<p>Next, add it to your server (this also lets it post scheduled pictures):</p>` +
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
    check("UMA_STATE") + (env.UMA_STATE ? "" : " (a KV namespace binding, needed for scheduled pictures)"),
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

const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const fromMinutes = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// The day's post times: the set time, then every `everyHours` hours around the clock.
export function postTimes(settings) {
  const step = settings.everyHours * 60;
  const times = [];
  for (let minutes = toMinutes(settings.time) % step; minutes < 24 * 60; minutes += step) {
    times.push(fromMinutes(minutes));
  }
  return times;
}

// The latest post time that has passed today, like "2026-11-03 09:00" (null before the first one).
function dueSlot(settings, local) {
  const passed = postTimes(settings).filter((time) => time <= local.time);
  return passed.length ? `${local.day} ${passed[passed.length - 1]}` : null;
}

export function describeSchedule(settings) {
  const zone = `(${settings.timeZone})`;
  if (settings.everyHours === 24) return `every day at **${settings.time}** ${zone}`;
  if (settings.everyHours === 1) return `every hour at **:${settings.time.slice(3)}** ${zone}`;
  const times = postTimes(settings);
  const list = times.length <= 4 ? times.join(", ") : `${times.slice(0, 3).join(", ")}…`;
  return `every ${settings.everyHours} hours, at **${list}** ${zone}`;
}

const scheduledTitle = (everyHours) =>
  everyHours === 24 ? "🐴 Umamusume of the Day" : everyHours === 1 ? "🐴 Umamusume of the Hour" : "🐴 Umamusume Time!";

const optionValues = (interaction) =>
  Object.fromEntries((interaction.data.options || []).map((option) => [option.name, option.value]));

function withChannelHint(text, settings) {
  return settings.enabled && settings.channelId ? text : `${text}\nNow use \`/uma_here\` in the channel where I should post!`;
}

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
    const options = optionValues(interaction);
    const time = parseTime(options.time);
    if (!time) {
      return reply("Hmm… I didn't understand that time. Please write it like `09:00` or `21:30`!", { ephemeral: true });
    }
    if (options.timezone && !isTimeZone(options.timezone)) {
      return reply(`I don't know the time zone "${options.timezone}"… Try one from the list!`, { ephemeral: true });
    }
    const change = options.timezone ? { time, timeZone: options.timezone } : { time };
    const settings = await updateGuild(env, interaction.guild_id, change);
    return reply(withChannelHint(`Got it! I'll post a new picture ${describeSchedule(settings)} 💚`, settings));
  },

  async uma_every(interaction, env) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    const hours = Number(optionValues(interaction).hours);
    if (!EVERY_HOURS.includes(hours)) {
      return reply("Please pick one of the choices from the list!", { ephemeral: true });
    }
    const settings = await updateGuild(env, interaction.guild_id, { everyHours: hours });
    return reply(withChannelHint(`Okay! I'll post a new picture ${describeSchedule(settings)} 💚`, settings));
  },

  async uma_off(interaction, env) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    await updateGuild(env, interaction.guild_id, { enabled: false });
    return reply("Okay, I'll take a little break from posting pictures. Use `/uma_here` to start again! 💚");
  },

  async uma_cards(interaction, env, ctx, origin) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    if (!env.DISCORD_TOKEN) return reply("The Worker needs its DISCORD_TOKEN secret first.", { ephemeral: true });
    const userId = userOf(interaction).id;
    const token = await makeCardsToken(env, userId);
    const count = Object.keys(await loadOwned(env, userId)).length;
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content:
          "Here's your card box! Tap the cards you have and pick their limit break. I save as you go 💚" +
          (count ? `\nYou have **${count}** cards saved.` : "") +
          `\n-# The link is just for you and works for ${LINK_DAYS} days.`,
        components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open my card box", url: `${origin}/cards?t=${token}` }] }],
      },
    });
  },

  uma_deck(interaction, env, ctx) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    ctx.waitUntil(answerDeck(interaction, env));
    return jsonResponse({ type: 5 });
  },

  async uma_status(interaction, env) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    const settings = { ...DEFAULT_SETTINGS, ...(await loadGuilds(env))[interaction.guild_id] };
    const lines = [
      `📅 Scheduled pictures: ${settings.enabled && settings.channelId ? "on" : "off"}`,
      `📍 Channel: ${settings.channelId ? `<#${settings.channelId}>` : "not set (use `/uma_here`)"}`,
      `⏰ Schedule: ${describeSchedule(settings)}`,
      `🖼️ Last picture: ${settings.lastPost || "not yet"}`,
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
      content: `Yay! From now on I'll post a picture here ${describeSchedule(settings)} 💚\n` +
        "Use `/uma_every` to change how often, and `/uma_time` to change the time.",
    });
  } catch (err) {
    console.error(err);
    await sendToDiscord(editUrl, "PATCH", {}, { content: "Something went wrong, sorry." }).catch(() => {});
  }
}

// ---- Scheduled pictures ----------------------------------------------------

// Runs from the cron trigger: posts in every server whose next post time has
// passed and that hasn't had that picture yet. A failed post is retried 30 minutes later.
export async function runSchedule(env, now = new Date()) {
  if (!env.UMA_STATE || !env.DISCORD_TOKEN) return;
  const updates = {};
  for (const [guildId, stored] of Object.entries(await loadGuilds(env))) {
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    const slot = dueSlot(settings, localNow(now, settings.timeZone));
    if (
      !settings.enabled || !settings.channelId || !slot || settings.lastPost === slot ||
      now.getTime() < settings.retryAfter
    ) {
      continue;
    }
    try {
      const image = await pickImage(SOURCES, await loadSeen(env));
      if (!image) throw new Error("None of the image sites returned a picture.");
      const url = `${API}/channels/${settings.channelId}/messages`;
      await deliver(url, "POST", botHeaders(env), image, scheduledTitle(settings.everyHours));
      await remember(env, image);
      updates[guildId] = { lastPost: slot, lastError: null, retryAfter: 0 };
    } catch (err) {
      console.error(`Scheduled picture for server ${guildId} failed: ${err.message}`);
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

// ---- Deck builder ----------------------------------------------------------

// Built weekly from the Umamusume Wiki by .github/workflows/update-card-data.yml.
const CARD_DATA_URL =
  "https://raw.githubusercontent.com/jedrek20005-byte/claude-test/ccr-5787c415-0zgod8/card-data/support-cards.json";
const LINK_DAYS = 30;
// A deck has 6 slots, but the 6th is always a card borrowed from a friend.
const DECK_SIZE = 5;
const DECK_GOALS = {
  fans: { title: "the most fans", primary: "Fan Bonus", secondary: "Race Bonus" },
  race: { title: "the best Race Bonus", primary: "Race Bonus", secondary: "Fan Bonus" },
};
const RARITY_RANK = { SSR: 0, SR: 1, R: 2 };

const userOf = (interaction) => interaction.member?.user ?? interaction.user;
const cardName = (card) => `${card.rarity} ${card.title ? `[${card.title}] ` : ""}${card.character}`;
const ownedKey = (userId) => `cards:${userId}`;

let cardCache = null;

export function clearCardCache() {
  cardCache = null;
}

async function loadCards(env) {
  if (cardCache && Date.now() - cardCache.loadedAt < 6 * 60 * 60 * 1000) return cardCache;
  const res = await fetch(env.CARD_DATA_URL || CARD_DATA_URL, { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new Error(`Couldn't load the card data (HTTP ${res.status})`);
  const { cards } = await res.json();
  cardCache = { loadedAt: Date.now(), byId: new Map(cards.map((card) => [String(card.id), card])) };
  return cardCache;
}

async function loadOwned(env, userId) {
  return (await env.UMA_STATE.get(ownedKey(userId), "json")) || {};
}

const compareEntries = (a, b) =>
  b.primary - a.primary || b.secondary - a.secondary || b.lb - a.lb ||
  (RARITY_RANK[a.card.rarity] ?? 9) - (RARITY_RANK[b.card.rarity] ?? 9);

// Best cards for the goal, at most one per character (the game doesn't allow two).
// Every effect value is a plain sum across the deck, so picking each character's
// best card and then the top five is optimal.
export function buildDeck(owned, byId, goal) {
  const { primary, secondary } = DECK_GOALS[goal];
  const best = new Map();
  for (const [id, lb] of Object.entries(owned)) {
    const card = byId.get(String(id));
    if (!card) continue;
    const value = (effect) => card.effects[effect]?.[lb] ?? 0;
    const entry = { card, lb, primary: value(primary), secondary: value(secondary) };
    if (!entry.primary && !entry.secondary) continue;
    const current = best.get(card.character);
    if (!current || compareEntries(entry, current) < 0) best.set(card.character, entry);
  }
  return [...best.values()].sort(compareEntries).slice(0, DECK_SIZE);
}

export function deckEmbed(goal, deck) {
  const { title, primary, secondary } = DECK_GOALS[goal];
  const total = (key) => deck.reduce((sum, entry) => sum + entry[key], 0);
  const lines = deck.map((entry, i) =>
    `**${i + 1}. ${escapeMarkdown(cardName(entry.card))}** · LB${entry.lb}\n` +
    `${primary} +${entry.primary}% · ${secondary} +${entry.secondary}%`);
  lines.push("", `**Total: ${primary} +${total("primary")}% · ${secondary} +${total("secondary")}%**`);
  if (deck.length < DECK_SIZE) {
    lines.push(`Only ${deck.length} of your cards help here, so fill the other slots with your favourite training cards!`);
  }
  return {
    title: `🐴 Your deck for ${title}`,
    description: lines.join("\n"),
    color: EMBED_COLOR,
    footer: {
      text: "Slot 6: borrow a friend's card with a high " + primary + ". " +
        "Values assume each card is at the max level for its limit break.",
    },
  };
}

async function answerDeck(interaction, env) {
  const editUrl = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  try {
    const goal = DECK_GOALS[optionValues(interaction).goal] ? optionValues(interaction).goal : "fans";
    const owned = await loadOwned(env, userOf(interaction).id);
    let payload;
    if (!Object.keys(owned).length) {
      payload = { content: "You haven't told me which cards you have yet! Use `/uma_cards` to pick them 💚" };
    } else {
      const deck = buildDeck(owned, (await loadCards(env)).byId, goal);
      payload = deck.length
        ? { embeds: [deckEmbed(goal, deck)] }
        : { content: `None of your cards have ${DECK_GOALS[goal].primary} or ${DECK_GOALS[goal].secondary}… yet!` };
    }
    await sendToDiscord(editUrl, "PATCH", {}, payload);
  } catch (err) {
    console.error(err);
    await sendToDiscord(editUrl, "PATCH", {}, { content: "Something went wrong, sorry." }).catch(() => {});
  }
}

// Card box links: "<user id>.<expiry>.<signature>", signed with a key derived
// from DISCORD_TOKEN, so only the person who ran /uma_cards can edit their list.
async function linkKey(env) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`uma-cards:${env.DISCORD_TOKEN}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (text) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function makeCardsToken(env, userId, now = Date.now()) {
  const payload = `${userId}.${Math.floor(now / 1000) + LINK_DAYS * 24 * 60 * 60}`;
  const signature = await crypto.subtle.sign("HMAC", await linkKey(env), new TextEncoder().encode(payload));
  return `${payload}.${toBase64Url(signature)}`;
}

// The user ID the link belongs to, or null if it's forged or expired.
export async function readCardsToken(env, token, now = Date.now()) {
  const [userId, expires, signature] = String(token ?? "").split(".");
  if (!env.DISCORD_TOKEN || !/^\d+$/.test(userId ?? "") || !/^\d+$/.test(expires ?? "") || !signature) return null;
  if (Number(expires) * 1000 < now) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC", await linkKey(env), fromBase64Url(signature), new TextEncoder().encode(`${userId}.${expires}`),
    );
    return ok ? userId : null;
  } catch {
    return null;
  }
}

async function myCardsApi(request, env, url) {
  const userId = env.UMA_STATE ? await readCardsToken(env, url.searchParams.get("t")) : null;
  if (!userId) {
    return Response.json({ error: "This link has expired. Use /uma_cards in Discord for a new one." }, { status: 401 });
  }
  if (request.method === "GET") {
    return Response.json({ cards: await loadOwned(env, userId) });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  let cards;
  try {
    ({ cards } = await request.json());
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const entries = cards && typeof cards === "object" ? Object.entries(cards) : null;
  const valid = entries && entries.length <= 3000 &&
    entries.every(([id, lb]) => /^\d{1,7}$/.test(id) && Number.isInteger(lb) && lb >= 0 && lb <= 4);
  if (!valid) {
    return Response.json({ error: "Bad card list" }, { status: 400 });
  }
  await env.UMA_STATE.put(ownedKey(userId), JSON.stringify(Object.fromEntries(entries)));
  return Response.json({ ok: true, count: entries.length });
}

async function cardsPage(env, url) {
  const valid = env.UMA_STATE && (await readCardsToken(env, url.searchParams.get("t")));
  const page = valid
    ? CARDS_PAGE.replace("__DATA_URL__", env.CARD_DATA_URL || CARD_DATA_URL)
    : CARDS_PAGE_EXPIRED;
  return new Response(page, {
    status: valid ? 200 : 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" },
  });
}

const PAGE_HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Card box</title><style>
:root{--bg:#f6f7f4;--fg:#1d2318;--muted:#68705f;--card:#fff;--line:#dfe3d8;--accent:#3f9a4f;--chip:#eef1ea}
@media (prefers-color-scheme:dark){:root{--bg:#151813;--fg:#e8ebe3;--muted:#9aa391;--card:#1f241c;--line:#323a2d;--accent:#62c271;--chip:#272d23}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);padding:12px 16px 8px;border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0 0 8px;display:flex;justify-content:space-between;gap:8px}
#status{font-size:13px;font-weight:normal;color:var(--muted)}
input[type=search]{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:16px}
.chips{display:flex;gap:6px;overflow-x:auto;padding:8px 0 2px}
.chips button{flex:none;border:1px solid var(--line);background:var(--chip);color:var(--fg);border-radius:999px;padding:6px 12px;font-size:14px}
.chips button.on{background:var(--accent);border-color:var(--accent);color:#fff}
main{padding:12px 16px 40px}#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px}
.tile{position:relative;border:2px solid var(--line);background:var(--card);border-radius:12px;padding:6px;text-align:center;color:var(--fg);font:inherit}
.tile.owned{border-color:var(--accent)}.tile img{width:64px;height:64px;object-fit:contain;display:block;margin:0 auto 4px}
.tile .name{font-size:12px;font-weight:600;display:block}.tile .title{font-size:11px;color:var(--muted);display:block;max-height:2.8em;overflow:hidden}
.tile .tag{position:absolute;top:4px;left:6px;font-size:10px;color:var(--muted)}.tile .lb{display:block;font-size:12px;color:var(--accent);letter-spacing:1px}
#sheet{position:fixed;inset:auto 0 0 0;z-index:3;background:var(--card);border-top:1px solid var(--line);border-radius:16px 16px 0 0;padding:16px;box-shadow:0 -8px 24px #0003;transform:translateY(110%);transition:transform .2s}
#sheet.open{transform:none}#sheet h2{font-size:16px;margin:0 0 12px}#sheet .row{display:flex;gap:8px;flex-wrap:wrap}
#sheet button{flex:1 1 18%;min-width:56px;padding:12px 0;border-radius:10px;border:1px solid var(--line);background:var(--chip);color:var(--fg);font-size:15px}
#sheet button.on{background:var(--accent);color:#fff;border-color:var(--accent)}#sheet .remove{flex-basis:100%;margin-top:8px;background:none}
.empty{color:var(--muted);text-align:center;padding:40px 0}
</style></head><body>`;

const CARDS_PAGE_EXPIRED = PAGE_HEAD +
  `<main><p class="empty">This link has expired. Use <b>/uma_cards</b> in Discord to get a new one 💚</p></main></body></html>`;

const CARDS_PAGE = PAGE_HEAD + `
<header><h1>🐴 My card box <span id="status">Loading…</span></h1>
<input id="q" type="search" placeholder="Search a character or card…" autocomplete="off">
<div class="chips" id="filters"></div></header>
<main><div id="grid"></div><p class="empty" id="none" hidden>No cards match.</p></main>
<div id="sheet"><h2 id="sheet-title"></h2><div class="row" id="lbs"></div>
<div class="row"><button class="remove" id="remove">I don't have this card</button></div></div>
<script>
const DATA_URL = "__DATA_URL__";
const token = new URLSearchParams(location.search).get("t");
const api = "/cards/mine?t=" + encodeURIComponent(token);
const RARITY = { SSR: 0, SR: 1, R: 2 };
const TYPES = ["Speed", "Stamina", "Power", "Guts", "Wit", "Pal", "Group"];
const FILTERS = [["mine", "★ Mine"], ["global", "Hide JP-only"], ["SSR", "SSR"], ["SR", "SR"], ["R", "R"], ...TYPES.map((t) => [t, t])];
const $ = (id) => document.getElementById(id);
let cards = [], owned = {}, active = new Set(), current = null, saveTimer = null;

const lbText = (lb) => "◆".repeat(lb) + "◇".repeat(4 - lb);
function status(text) { $("status").textContent = text; }

function matches(card) {
  const q = $("q").value.trim().toLowerCase();
  if (q && !(card.character + " " + card.title).toLowerCase().includes(q)) return false;
  if (active.has("mine") && !(card.id in owned)) return false;
  if (active.has("global") && card.jp_only) return false;
  const rarities = ["SSR", "SR", "R"].filter((r) => active.has(r));
  if (rarities.length && !rarities.includes(card.rarity)) return false;
  const types = TYPES.filter((t) => active.has(t));
  return !types.length || types.includes(card.type);
}

function tile(card) {
  const b = document.createElement("button");
  b.className = "tile" + (card.id in owned ? " owned" : "");
  b.dataset.id = card.id;
  const img = document.createElement("img");
  img.loading = "lazy"; img.alt = ""; img.referrerPolicy = "no-referrer";
  // The wiki's thumbnail script; its Special:FilePath redirect answers 403.
  img.src = "https://umamusu.wiki/w/thumb.php?f=Support_Card_" + card.id + "_Icon.png&width=128";
  img.onerror = () => img.remove();
  const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = card.rarity + " · " + card.type + (card.jp_only ? " · JP" : "");
  const name = document.createElement("span"); name.className = "name"; name.textContent = card.character;
  const title = document.createElement("span"); title.className = "title"; title.textContent = card.title;
  b.append(tag, img, name, title);
  if (card.id in owned) {
    const lb = document.createElement("span"); lb.className = "lb"; lb.textContent = lbText(owned[card.id]); b.append(lb);
  }
  b.onclick = () => openSheet(card);
  return b;
}

function render() {
  const list = cards.filter(matches);
  $("grid").replaceChildren(...list.map(tile));
  $("none").hidden = list.length > 0;
}

function openSheet(card) {
  current = card;
  $("sheet-title").textContent = card.rarity + " [" + card.title + "] " + card.character;
  $("lbs").replaceChildren(...[0, 1, 2, 3, 4].map((lb) => {
    const b = document.createElement("button");
    b.textContent = "LB" + lb; b.title = lbText(lb);
    if (owned[card.id] === lb) b.className = "on";
    b.onclick = () => choose(lb);
    return b;
  }));
  $("remove").hidden = !(card.id in owned);
  $("sheet").classList.add("open");
}

function choose(lb) {
  if (lb === null) delete owned[current.id]; else owned[current.id] = lb;
  $("sheet").classList.remove("open");
  const old = document.querySelector('.tile[data-id="' + current.id + '"]');
  if (old) old.replaceWith(tile(current));
  save();
}

function save() {
  status("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const res = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cards: owned }) });
      const body = await res.json();
      status(res.ok ? "Saved ✓ " + body.count + " cards" : body.error || "Couldn't save");
    } catch { status("Couldn't save, check your connection"); }
  }, 600);
}

$("remove").onclick = () => choose(null);
document.addEventListener("click", (e) => {
  if ($("sheet").classList.contains("open") && !e.target.closest("#sheet, .tile")) $("sheet").classList.remove("open");
});
$("q").oninput = render;
$("filters").replaceChildren(...FILTERS.map(([key, label]) => {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = () => { active.has(key) ? active.delete(key) : active.add(key); b.classList.toggle("on"); render(); };
  return b;
}));

(async () => {
  try {
    const [data, mine] = await Promise.all([fetch(DATA_URL).then((r) => r.json()), fetch(api).then((r) => r.json())]);
    if (mine.error) throw new Error(mine.error);
    owned = mine.cards || {};
    // Cards on the English server first (JP-only ones are tagged), then by rarity, newest first.
    cards = data.cards.sort((a, b) => (a.jp_only - b.jp_only) || (RARITY[a.rarity] - RARITY[b.rarity]) || (b.id - a.id));
    status(Object.keys(owned).length + " cards");
    render();
  } catch (err) { status(String(err.message || err)); }
})();
</script></body></html>`;

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
    pages: 100,
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
    pages: 100,
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
    pages: 20,
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
    // Random pages for variety; page 0 as a fallback in case they're past the end.
    for (const page of new Set([randomInt(source.pages), randomInt(source.pages), 0])) {
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
