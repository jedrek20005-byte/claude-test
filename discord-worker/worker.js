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
// View Channel + Send Messages + Embed Links + Attach Files + Read Message History (for /uma_import)
const BOT_PERMISSIONS = "117760";
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
// What Belno says with each kind of GIF ("any" goes with GIFs that have no mood).
export const MOODS = {
  happy: { label: "Happy 😊", lines: ["Ehehe~ that makes me really happy! ✨", "Yay! That's wonderful news! 🎉", "I'm smiling so much right now! 💚"] },
  love: { label: "Love 💕", lines: ["Aww… I love you all so much! 💕", "Come here, you deserve a hug! 🤗", "You're doing amazing, I'm so proud of you! 💚"] },
  sad: { label: "Sad 😢", lines: ["Eh… that's a little sad… 😢", "Hmph… I'm sulking a little. 😤", "It's okay… we'll do better next time, right? 🥺"] },
  shocked: { label: "Shocked 😳", lines: ["W-wait, what?! 😳", "Eeeh?! Really?!", "I-I'm not nervous! …okay, maybe a little. 💦"] },
  bonk: { label: "Bonk 🔨", lines: ["Time to get to work! 🔨", "Behave, or I'm bringing out the hammer! 🔨", "Leave it to me, I'll fix it right up! 🔧"] },
  sleepy: { label: "Sleepy 💤", lines: ["Mmh… just five more minutes… 💤", "*yawn* Good night, trainers… 🌙"] },
  hungry: { label: "Hungry 🍙", lines: ["Is it lunch time yet? I'm starving~ 🍙", "Oguri, please save some for me! 🍔"] },
  any: { label: "Random 🎲", lines: ["Hi trainers, it's Belno! 💚", "Ganbatte, everyone! 🏇✨", "I'm cheering for you! 📣"] },
};
const MOOD_CHOICES = Object.entries(MOODS).map(([value, mood]) => ({ name: mood.label, value: value === "any" ? "random" : value }));

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
  {
    name: "uma_say",
    description: "Make me send a message (leave it empty for a longer, multi-line one)",
    type: 1,
    ...ADMIN_ONLY,
    options: [
      { type: 3, name: "message", description: "What to say", required: false, max_length: 2000 },
      {
        type: 7,
        name: "channel",
        description: "Where to send it (this channel if left empty)",
        required: false,
        channel_types: [0, 5, 10, 11, 12], // text, announcement and thread channels
      },
    ],
  },
  {
    name: "uma_monthly",
    description: "Post a message every month, like a club quota reminder",
    type: 1,
    ...ADMIN_ONLY,
    options: [
      {
        type: 4, name: "day", description: "Day of the month (in shorter months, 29-31 means the last day)",
        required: true, min_value: 1, max_value: 31,
      },
      { type: 3, name: "time", description: "24-hour time, like 18:00 (12:00 if left empty)", required: false, max_length: 5 },
      {
        type: 3, name: "message", description: "What to post (leave empty to write a longer, multi-line one)",
        required: false, max_length: 1900,
      },
      { type: 8, name: "ping", description: "A role to mention, like your club members", required: false },
      {
        type: 7, name: "channel", description: "Where to post it (this channel if left empty)",
        required: false, channel_types: [0, 5, 10, 11, 12],
      },
      { type: 3, name: "gif", description: "Add one of my GIFs, a new one each month (none if left empty)", required: false, choices: MOOD_CHOICES },
    ],
  },
  { name: "uma_monthly_off", description: "Stop the monthly message", type: 1, ...ADMIN_ONLY },
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
  {
    name: "uma_races",
    description: "Plan the races that give an Uma the most fans in one career",
    type: 1,
    options: [
      { type: 3, name: "uma", description: "Which Uma (start typing her name)", required: true, autocomplete: true, max_length: 100 },
      {
        type: 3, name: "aptitude", description: "Lowest surface and distance aptitude to race on (A if left empty)", required: false,
        choices: [{ name: "A or better", value: "A" }, { name: "B or better", value: "B" }, { name: "C or better", value: "C" }],
      },
      {
        type: 4, name: "in_a_row", description: "Most races in a row (3 if left empty; more risks a bad condition)",
        required: false, min_value: 1, max_value: 6,
      },
    ],
  },
  {
    name: "uma_import",
    description: "Read members' fans from another bot's Live Board (like UmaCore) instead of /uma_fans",
    type: 1,
    ...ADMIN_ONLY,
    options: [
      { type: 6, name: "bot", description: "The bot that posts the Live Board", required: false },
      {
        type: 7, name: "channel", description: "Where it posts the Live Board (this channel if left empty)",
        required: false, channel_types: [0, 5, 10, 11, 12],
      },
      { type: 5, name: "stop", description: "Stop reading it", required: false },
    ],
  },
  {
    name: "uma_test",
    description: "See how the monthly reminder or club summary looks, right now",
    type: 1,
    ...ADMIN_ONLY,
    options: [
      {
        type: 3, name: "what", description: "What to test", required: true,
        choices: [{ name: "Monthly reminder", value: "monthly" }, { name: "Club summary", value: "summary" }],
      },
      { type: 5, name: "post", description: "Also send it for real in its channel (otherwise only you see it)", required: false },
    ],
  },
  {
    name: "uma_fans",
    description: "Save the fans you got this month (for the club summary)",
    type: 1,
    contexts: [0],
    options: [
      { type: 3, name: "fans", description: "Fans gained this month, like 32.5m or 32500000", required: true, max_length: 24 },
      { type: 6, name: "member", description: "Save it for someone else (Manage Server only)", required: false },
    ],
  },
  {
    name: "uma_quota",
    description: "Set the monthly fan quota; I'll post a club summary on the 1st of every month",
    type: 1,
    ...ADMIN_ONLY,
    options: [
      { type: 3, name: "fans", description: "Fans each member should get per month, like 30m", required: true, max_length: 24 },
      {
        type: 7, name: "channel", description: "Where the monthly summary goes (this channel if left empty)",
        required: false, channel_types: [0, 5, 10, 11, 12],
      },
    ],
  },
  {
    name: "uma_summary",
    description: "Show the club's fans for a month, compared with the month before",
    type: 1,
    contexts: [0],
    options: [
      {
        type: 3, name: "month", description: "Which month", required: false,
        choices: [{ name: "This month", value: "this" }, { name: "Last month", value: "last" }],
      },
    ],
  },
  {
    name: "uma_react",
    description: "Post a Belno reaction GIF",
    type: 1,
    contexts: [0],
    options: [
      { type: 3, name: "mood", description: "What kind of reaction (any if left empty)", required: false, choices: MOOD_CHOICES },
      { type: 3, name: "message", description: "What I say with it (one of my lines if left empty)", required: false, max_length: 1000 },
      { type: 6, name: "to", description: "Someone to react to (they get pinged)", required: false },
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
    if (request.method === "GET" && url.pathname === "/gifs") {
      return gifsPage();
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
    if (interaction.type === 5 && interaction.data?.custom_id?.startsWith("uma_monthly:")) {
      return monthlyFromModal(interaction, env);
    }
    if (interaction.type === 5 && interaction.data?.custom_id?.startsWith("uma_say:")) {
      ctx.waitUntil(sayFromModal(interaction, env));
      return jsonResponse({ type: 5, data: { flags: 64 } });
    }
    if (interaction.type === 4) {
      return autocomplete(interaction, env);
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

  async uma_say(interaction, env, ctx) {
    const options = optionValues(interaction);
    const channelId = options.channel || interaction.channel_id;
    if (options.message) {
      ctx.waitUntil(say(interaction, env, channelId, options.message));
      return jsonResponse({ type: 5, data: { flags: 64 } });
    }
    // No text given: open a box for a longer message. The signature in the
    // custom_id ties the box to this person and channel.
    const signature = await sign(env, `uma-say:${userOf(interaction).id}:${channelId}`);
    return jsonResponse({
      type: 9,
      data: {
        custom_id: `uma_say:${channelId}:${signature}`,
        title: "Send a message as me 💚",
        components: [{
          type: 1,
          components: [{
            type: 4, custom_id: "text", label: "Message", style: 2,
            min_length: 1, max_length: 2000, required: true, placeholder: "Good morning, trainers! 💚",
          }],
        }],
      },
    });
  },

  uma_races(interaction, env, ctx) {
    ctx.waitUntil(answerRaces(interaction, env));
    return jsonResponse({ type: 5 });
  },

  uma_react(interaction) {
    return reactWithGif(interaction);
  },

  uma_test(interaction, env, ctx) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    ctx.waitUntil(runTest(interaction, env));
    return jsonResponse({ type: 5, data: { flags: 64 } });
  },

  async uma_import(interaction, env, ctx) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    const options = optionValues(interaction);
    const current = { ...DEFAULT_SETTINGS, ...(await loadGuilds(env))[interaction.guild_id] };
    if (options.stop) {
      await updateGuild(env, interaction.guild_id, { club: { ...current.club, source: null } });
      return reply("Okay, I stopped reading the Live Board. Members can save their fans with `/uma_fans` again 💚", { ephemeral: true });
    }
    if (!options.bot) {
      return reply("Pick the bot that posts the Live Board in `bot:` (for example UmaCore's).", { ephemeral: true });
    }
    const user = interaction.data.resolved?.users?.[options.bot];
    const source = {
      botId: options.bot, botName: user?.global_name || user?.username || "that bot",
      channelId: options.channel || interaction.channel_id,
    };
    ctx.waitUntil(setupImport(interaction, env, source));
    return jsonResponse({ type: 5, data: { flags: 64 } });
  },

  async uma_fans(interaction, env) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    const options = optionValues(interaction);
    const source = (await loadGuilds(env))[interaction.guild_id]?.club?.source;
    if (source) {
      return reply(
        `No need, I read everyone's fans from <@${source.botId}>'s Live Board automatically 💚 See \`/uma_summary\`.`,
        { ephemeral: true },
      );
    }
    const fans = parseFans(options.fans);
    if (fans === null) {
      return reply("Hmm… I didn't understand that number. Try something like `32.5m`, `850k` or `32500000`!", { ephemeral: true });
    }
    let target = { id: userOf(interaction).id, name: displayName(interaction.member, userOf(interaction)) };
    if (options.member && options.member !== target.id) {
      if (!canManageServer(interaction)) {
        return reply("Only people with Manage Server can save fans for someone else.", { ephemeral: true });
      }
      const resolved = interaction.data.resolved ?? {};
      target = { id: options.member, name: displayName(resolved.members?.[options.member], resolved.users?.[options.member]) };
    }
    const settings = { ...DEFAULT_SETTINGS, ...(await loadGuilds(env))[interaction.guild_id] };
    const month = localNow(new Date(), settings.timeZone).day.slice(0, 7);
    await saveFans(env, interaction.guild_id, month, target, fans);
    const previous = (await loadFans(env, interaction.guild_id, previousMonth(month)))[target.id];
    const who = target.id === userOf(interaction).id ? "your" : `<@${target.id}>'s`;
    let text = `Saved ${who} **${formatFans(fans)}** fans for ${monthName(month)} 💚`;
    if (previous) text += ` (${change(fans, previous.fans)} vs ${monthName(previousMonth(month))})`;
    const quota = settings.club?.quota;
    if (quota) {
      text += fans >= quota
        ? `\n✅ That's the ${formatFans(quota)} quota done. Great job, trainer!`
        : `\n🏃 ${formatFans(quota - fans)} to go to reach the ${formatFans(quota)} quota. You can do it!`;
    }
    return reply(text, { ephemeral: true });
  },

  async uma_quota(interaction, env) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    const options = optionValues(interaction);
    const quota = parseFans(options.fans);
    if (!quota) {
      return reply("Hmm… I didn't understand that number. Try something like `30m`!", { ephemeral: true });
    }
    const current = { ...DEFAULT_SETTINGS, ...(await loadGuilds(env))[interaction.guild_id] };
    const month = localNow(new Date(), current.timeZone).day.slice(0, 7);
    const club = {
      ...current.club,
      quota,
      channelId: options.channel || interaction.channel_id,
      // Starting now: the first summary covers this month, not ones from before.
      lastSummary: current.club?.lastSummary ?? previousMonth(month),
    };
    await updateGuild(env, interaction.guild_id, { club });
    return reply(
      `Got it! The quota is **${formatFans(quota)}** fans per member each month 💚\n` +
      `On the 1st of every month I'll post last month's summary in <#${club.channelId}>, compared with the month before.\n` +
      "Everyone can save their fans with `/uma_fans` (like `/uma_fans fans:32.5m`), and see how it's going with `/uma_summary`.",
      { ephemeral: true },
    );
  },

  async uma_summary(interaction, env) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    const settings = { ...DEFAULT_SETTINGS, ...(await loadGuilds(env))[interaction.guild_id] };
    const thisMonth = localNow(new Date(), settings.timeZone).day.slice(0, 7);
    const month = optionValues(interaction).month === "last" ? previousMonth(thisMonth) : thisMonth;
    const data = await loadClubFans(env, interaction.guild_id, month, settings);
    if (!Object.keys(data).length) {
      return reply(`Nobody has saved their fans for ${monthName(month)} yet. Use \`/uma_fans\` to add yours!`, { ephemeral: true });
    }
    const before = await loadClubFans(env, interaction.guild_id, previousMonth(month), settings);
    const embed = clubSummary(month, data, before, settings.club?.quota, { partial: month === thisMonth });
    return jsonResponse({ type: 4, data: { embeds: [embed], allowed_mentions: { parse: [] } } });
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

  async uma_monthly(interaction, env) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    const options = optionValues(interaction);
    const time = parseTime(options.time ?? "12:00");
    if (!time) {
      return reply("Hmm… I didn't understand that time. Please write it like `09:00` or `21:30`!", { ephemeral: true });
    }
    const monthly = {
      day: Number(options.day), time, channelId: options.channel || interaction.channel_id, roleId: options.ping || null,
      gif: MOOD_CHOICES.some((choice) => choice.value === options.gif) ? options.gif : null,
    };
    if (options.message) {
      return saveMonthly(interaction, env, { ...monthly, text: options.message });
    }
    // No text given: open a box for a longer message, signed like /uma_say's.
    const id = `${monthly.day}:${time.replace(":", "")}:${monthly.channelId}:${monthly.roleId || 0}:${monthly.gif || 0}`;
    const signature = await sign(env, `uma-monthly:${userOf(interaction).id}:${id}`);
    return jsonResponse({
      type: 9,
      data: {
        custom_id: `uma_monthly:${id}:${signature}`,
        title: "Monthly message 💚",
        components: [{
          type: 1,
          components: [{
            type: 4, custom_id: "text", label: "Message", style: 2, min_length: 1, max_length: 1900, required: true,
            value: BELNO_REMINDER,
          }],
        }],
      },
    });
  },

  async uma_monthly_off(interaction, env) {
    if (!env.UMA_STATE) return reply(NO_STORAGE, { ephemeral: true });
    await updateGuild(env, interaction.guild_id, { monthly: null });
    return reply("Okay, no more monthly message. Use `/uma_monthly` to set one up again 💚", { ephemeral: true });
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
    const monthly = settings.monthly;
    lines.push(monthly
      ? `📆 Monthly message: ${describeMonthly(monthly, settings.timeZone)}, in <#${monthly.channelId}>` +
        (monthly.lastError ? `\n⚠️ Last monthly problem: ${monthly.lastError.slice(0, 300)}` : "")
      : "📆 Monthly message: off (use `/uma_monthly`)");
    const club = settings.club;
    lines.push(club?.quota
      ? `📊 Club quota: ${formatFans(club.quota)} per member; summary on the 1st in <#${club.channelId}>` +
        (club.lastError ? `\n⚠️ Last summary problem: ${club.lastError.slice(0, 300)}` : "")
      : "📊 Club quota: off (use `/uma_quota`)");
    if (club?.source) {
      lines.push(`🔗 Reading fans from <@${club.source.botId}>'s Live Board in <#${club.source.channelId}> every 30 minutes` +
        (club.source.lastError ? `\n⚠️ Last read problem: ${club.source.lastError.slice(0, 300)}` : ""));
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

// Runs from the cron trigger: posts the scheduled pictures and monthly
// messages that are due. A failed post is retried 30 minutes later.
export async function runSchedule(env, now = new Date()) {
  if (!env.UMA_STATE || !env.DISCORD_TOKEN) return;
  const updates = {};
  for (const [guildId, stored] of Object.entries(await loadGuilds(env))) {
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    const picture = await postScheduledPicture(env, guildId, settings, now);
    const monthly = await postMonthlyMessage(env, guildId, settings, now);
    // Read the Live Board first, so a summary due now has the newest numbers.
    const imported = await pollImport(env, guildId, settings, now);
    const summary = await postClubSummary(env, guildId, settings, now);
    const club = imported || summary ? { ...summary, ...imported } : null;
    if (picture || monthly || club) {
      updates[guildId] = { ...picture, ...(monthly ? { monthly } : {}), ...(club ? { club } : {}) };
    }
  }
  if (Object.keys(updates).length) {
    // Re-read so a settings command run meanwhile isn't overwritten.
    const guilds = await loadGuilds(env);
    for (const [guildId, { monthly, club, ...update }] of Object.entries(updates)) {
      const current = { ...DEFAULT_SETTINGS, ...guilds[guildId], ...update };
      if (monthly && current.monthly) current.monthly = { ...current.monthly, ...monthly };
      if (club && current.club) {
        const { source, ...rest } = club;
        current.club = { ...current.club, ...rest };
        if (source && current.club.source) current.club.source = { ...current.club.source, ...source };
      }
      guilds[guildId] = current;
    }
    await env.UMA_STATE.put("guilds", JSON.stringify(guilds));
  }
}

async function postScheduledPicture(env, guildId, settings, now) {
  const slot = dueSlot(settings, localNow(now, settings.timeZone));
  if (
    !settings.enabled || !settings.channelId || !slot || settings.lastPost === slot ||
    now.getTime() < settings.retryAfter
  ) {
    return null;
  }
  try {
    const image = await pickImage(SOURCES, await loadSeen(env));
    if (!image) throw new Error("None of the image sites returned a picture.");
    const url = `${API}/channels/${settings.channelId}/messages`;
    await deliver(url, "POST", botHeaders(env), image, scheduledTitle(settings.everyHours));
    await remember(env, image);
    return { lastPost: slot, lastError: null, retryAfter: 0 };
  } catch (err) {
    console.error(`Scheduled picture for server ${guildId} failed: ${err.message}`);
    return { lastError: err.message, retryAfter: now.getTime() + RETRY_AFTER_MS };
  }
}

// ---- Monthly message (/uma_monthly) --------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// The month ("2026-11") whose message is due now and not sent yet, or null.
// In months shorter than the chosen day, it's sent on the last day.
export function monthlyDue(monthly, now, timeZone) {
  const local = localNow(now, timeZone);
  const [year, month, day] = local.day.split("-").map(Number);
  const dueDay = Math.min(monthly.day, daysIn(year, month));
  const passed = day > dueDay || (day === dueDay && local.time >= monthly.time);
  const monthKey = local.day.slice(0, 7);
  return passed && monthly.lastSent !== monthKey ? monthKey : null;
}

// "25 November 2026": the next time the message goes out.
function nextMonthlyDate(monthly, now, timeZone) {
  const local = localNow(now, timeZone);
  let [year, month] = local.day.split("-").map(Number);
  if (monthly.lastSent === local.day.slice(0, 7)) {
    [year, month] = month === 12 ? [year + 1, 1] : [year, month + 1];
  }
  return `${Math.min(monthly.day, daysIn(year, month))} ${MONTHS[month - 1]} ${year}`;
}

export function describeMonthly(monthly, timeZone, now = new Date()) {
  const ping = monthly.roleId ? `, mentioning ${monthly.roleId === "everyone" ? "@everyone" : `<@&${monthly.roleId}>`}` : "";
  const gif = monthly.gif
    ? `, with ${monthly.gif === "random" ? "one of my GIFs" : `a ${MOODS[monthly.gif]?.label.split(" ")[0].toLowerCase() ?? ""} GIF`}`
    : "";
  return `day **${monthly.day}** of every month at **${monthly.time}** (${timeZone})${ping}${gif}; ` +
    `next on ${nextMonthlyDate(monthly, now, timeZone)}`;
}

// Belno Light's default monthly reminder (pre-filled in the /uma_monthly box).
const BELNO_REMINDER =
  "Hi trainers, it's Belno! 💚\n" +
  "Our club's fan quota for this month ends soon. If you haven't reached it yet, let's run a few more races together!\n" +
  "I'll be cheering for you the whole way. Ganbatte! 🏇✨";

function monthlyContent(monthly) {
  const gif = monthly.gif ? { embeds: [gifEmbed(pickGif(monthly.gif))] } : {};
  if (!monthly.roleId) return { content: monthly.text, allowed_mentions: { parse: [] }, ...gif };
  if (monthly.roleId === "everyone") {
    return { content: `@everyone\n${monthly.text}`, allowed_mentions: { parse: ["everyone"] }, ...gif };
  }
  return { content: `<@&${monthly.roleId}>\n${monthly.text}`, allowed_mentions: { parse: [], roles: [monthly.roleId] }, ...gif };
}

async function saveMonthly(interaction, env, monthly, { now = new Date() } = {}) {
  // Picking @everyone in a role option gives the server's own ID.
  if (monthly.roleId === interaction.guild_id) monthly.roleId = "everyone";
  const guild = { ...DEFAULT_SETTINGS, ...(await loadGuilds(env))[interaction.guild_id] };
  // If this month's moment has already passed, start next month rather than posting right away.
  const thisMonth = monthlyDue({ ...monthly, lastSent: null }, now, guild.timeZone);
  const saved = { ...monthly, lastSent: thisMonth, lastError: null, retryAfter: 0 };
  await updateGuild(env, interaction.guild_id, { monthly: saved });
  const preview = saved.text.split("\n").slice(0, 6).map((line) => `> ${line}`).join("\n");
  let text = `Got it! I'll post in <#${saved.channelId}> on ${describeMonthly(saved, guild.timeZone, now)} 💚\n${preview}`;
  if (saved.roleId) {
    text += "\n-# If the mention doesn't notify anyone, let anyone mention that role, " +
      "or give me the \"Mention @everyone, @here and All Roles\" permission.";
  }
  if (guild.timeZone === "UTC") {
    text += "\n-# Times are in UTC; change the time zone with `/uma_time`.";
  }
  return reply(text, { ephemeral: true });
}

async function monthlyFromModal(interaction, env) {
  const [, day, hhmm, channelId, roleId, gif, signature] = interaction.data.custom_id.split(":");
  const id = `${day}:${hhmm}:${channelId}:${roleId}:${gif}`;
  const text = interaction.data.components?.[0]?.components?.[0]?.value;
  if (signature !== (await sign(env, `uma-monthly:${userOf(interaction).id}:${id}`)) || !text) {
    return reply("That message box didn't come from `/uma_monthly`, so I didn't save it.", { ephemeral: true });
  }
  const time = `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
  return saveMonthly(interaction, env, {
    day: Number(day), time, channelId, roleId: roleId === "0" ? null : roleId, gif: gif === "0" ? null : gif, text,
  });
}

async function postMonthlyMessage(env, guildId, settings, now) {
  const monthly = settings.monthly;
  const month = monthly && monthlyDue(monthly, now, settings.timeZone);
  if (!month || now.getTime() < (monthly.retryAfter || 0)) return null;
  try {
    const res = await fetch(`${API}/channels/${monthly.channelId}/messages`, {
      method: "POST",
      headers: { ...botHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify(monthlyContent(monthly)),
    });
    if (!res.ok) throw new Error(`Discord returned HTTP ${res.status}: ${await res.text()}`);
    return { lastSent: month, lastError: null, retryAfter: 0 };
  } catch (err) {
    console.error(`Monthly message for server ${guildId} failed: ${err.message}`);
    return { lastError: err.message, retryAfter: now.getTime() + RETRY_AFTER_MS };
  }
}

// ---- Messages as the app (/uma_say) ------------------------------------------

async function sign(env, text) {
  const signature = await crypto.subtle.sign("HMAC", await linkKey(env), new TextEncoder().encode(text));
  return toBase64Url(signature).slice(0, 22);
}

async function sayFromModal(interaction, env) {
  const [, channelId, signature] = interaction.data.custom_id.split(":");
  const text = interaction.data.components?.[0]?.components?.[0]?.value;
  const expected = await sign(env, `uma-say:${userOf(interaction).id}:${channelId}`);
  if (signature !== expected || !text) {
    const editUrl = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
    await sendToDiscord(editUrl, "PATCH", {}, { content: "That message box didn't come from `/uma_say`, so I didn't send it." });
    return;
  }
  await say(interaction, env, channelId, text);
}

// Posts as a normal message from the app (no "used /uma_say" line), never pinging @everyone, @here or roles.
async function say(interaction, env, channelId, text) {
  const editUrl = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  let result;
  try {
    const res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { ...botHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, allowed_mentions: { parse: ["users"] } }),
    });
    result = res.ok
      ? `Sent in <#${channelId}> 💚`
      : res.status === 403 || res.status === 404
        ? `I can't send messages in <#${channelId}>… Please let me see the channel and send messages there.`
        : `Discord didn't accept that message (HTTP ${res.status}).`;
  } catch (err) {
    console.error(err);
    result = "Something went wrong, sorry.";
  }
  await sendToDiscord(editUrl, "PATCH", {}, { content: result }).catch(() => {});
}

// ---- Club fan tracker (/uma_fans, /uma_quota, /uma_summary) --------------------

const MANAGE_SERVER = 0x20n;
const ADMINISTRATOR = 0x8n;
// Each report is its own KV key (data in its metadata), so two members saving
// at the same moment can't overwrite each other; old months expire after a year.
const FANS_TTL_SECONDS = 400 * 24 * 60 * 60;

function canManageServer(interaction) {
  try {
    return (BigInt(interaction.member?.permissions ?? 0) & (MANAGE_SERVER | ADMINISTRATOR)) !== 0n;
  } catch {
    return false;
  }
}

const displayName = (member, user) =>
  member?.nick || user?.global_name || member?.user?.global_name || user?.username || member?.user?.username || "Trainer";

// "32.5m", "850k", "1.2b", "32,500,000" or "32 500 000" -> a whole number of fans.
export function parseFans(text) {
  const match = String(text ?? "").trim().toLowerCase().replace(/fans?$/, "").trim()
    .match(/^(\d{1,3}(?:[ ,.]\d{3})+|\d+(?:[.,]\d+)?)\s*([kmb])?$/);
  if (!match) return null;
  let [, number, unit] = match;
  if (/^\d{1,3}([ ,.]\d{3})+$/.test(number) && !unit) {
    number = number.replace(/[ ,.]/g, ""); // thousands separators
  } else {
    number = number.replace(",", ".");
  }
  const fans = Math.round(Number(number) * ({ k: 1e3, m: 1e6, b: 1e9 }[unit] ?? 1));
  return Number.isFinite(fans) && fans >= 0 && fans <= 1e11 ? fans : null;
}

export function formatFans(fans) {
  const [value, unit] = fans >= 1e9 ? [fans / 1e9, "B"] : fans >= 1e6 ? [fans / 1e6, "M"] : fans >= 1e3 ? [fans / 1e3, "K"] : [fans, ""];
  return `${Number(value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2))}${unit}`;
}

function change(now, before) {
  if (!before) return "new";
  const percent = Math.round(((now - before) / before) * 100);
  return percent > 0 ? `▲ ${percent}%` : percent < 0 ? `▼ ${-percent}%` : "= same";
}

function previousMonth(month) {
  const [year, number] = month.split("-").map(Number);
  return number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, "0")}`;
}

const monthName = (month) => `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
const fansPrefix = (guildId, month) => `fans:${guildId}:${month}:`;

async function saveFans(env, guildId, month, member, fans) {
  await env.UMA_STATE.put(fansPrefix(guildId, month) + member.id, "", {
    metadata: { fans, name: member.name.slice(0, 64) },
    expirationTtl: FANS_TTL_SECONDS,
  });
}

// { userId: { fans, name } } for everyone who reported that month.
async function loadFans(env, guildId, month) {
  const prefix = fansPrefix(guildId, month);
  const result = {};
  let cursor;
  do {
    const page = await env.UMA_STATE.list({ prefix, cursor });
    for (const key of page.keys) result[key.name.slice(prefix.length)] = key.metadata;
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return result;
}

// Real members show as mentions (never pinging); made-up example ones by name.
const who = (id, entry) => (/^\d{15,}$/.test(id) ? `<@${id}>` : `**${escapeMarkdown(entry?.name ?? "Trainer")}**`);

const listNames = (entries, limit = 15) =>
  entries.length <= limit ? entries.join(", ") : `${entries.slice(0, limit).join(", ")} +${entries.length - limit} more`;

export function clubSummary(month, data, before, quota, { partial = false } = {}) {
  const members = Object.entries(data).map(([id, entry]) => ({ id, ...entry })).sort((a, b) => b.fans - a.fans);
  const total = members.reduce((sum, m) => sum + m.fans, 0);
  const totalBefore = Object.values(before).reduce((sum, m) => sum + m.fans, 0);
  const previous = monthName(previousMonth(month));
  const lines = [
    partial
      ? "Here's how our club is doing so far. Keep going, everyone, I'm cheering for you! 💚"
      : "Thank you for all your hard work this month, trainers! Here's how our club did 💚",
    "",
    `**Total fans:** ${formatFans(total)}` + (totalBefore ? ` (${change(total, totalBefore)} vs ${previous})` : ""),
    `**Members reported:** ${members.length}` + (Object.keys(before).length ? ` (${Object.keys(before).length} in ${previous})` : ""),
  ];
  if (quota) {
    const done = members.filter((m) => m.fans >= quota);
    const doneBefore = Object.values(before).filter((m) => m.fans >= quota).length;
    lines.push(`**Quota (${formatFans(quota)}):** ${done.length}/${members.length} done` +
      (Object.keys(before).length ? ` (${doneBefore}/${Object.keys(before).length} in ${previous})` : ""));
  }
  lines.push("", "🏆 **Top fans:** " + members.slice(0, 3).map((m, i) => `${i + 1}. ${who(m.id, m)} ${formatFans(m.fans)}`).join(" · "));
  const improved = members
    .filter((m) => before[m.id]?.fans && m.fans > before[m.id].fans)
    .map((m) => ({ ...m, growth: (m.fans - before[m.id].fans) / before[m.id].fans }))
    .sort((a, b) => b.growth - a.growth)
    .slice(0, 3);
  if (improved.length) {
    lines.push("📈 **Most improved:** " + improved.map((m) =>
      `${who(m.id, m)} ${formatFans(before[m.id].fans)} → ${formatFans(m.fans)} (▲ ${Math.round(m.growth * 100)}%)`).join(" · "));
  }
  if (quota) {
    const done = members.filter((m) => m.fans >= quota).map((m) => who(m.id, m));
    const notYet = members.filter((m) => m.fans < quota).map((m) => `${who(m.id, m)} ${formatFans(m.fans)}`);
    if (done.length) lines.push(`✅ **Quota done:** ${listNames(done)}`);
    if (notYet.length) lines.push(`${partial ? "🏃 **Still going:**" : "❌ **Quota not reached:**"} ${listNames(notYet)}`);
  }
  const missing = Object.keys(before).filter((id) => !data[id]).map((id) => who(id, before[id]));
  if (missing.length) lines.push(`💤 **No report yet** (reported in ${previous}): ${listNames(missing)}`);
  return {
    title: `📊 Club summary for ${monthName(month)}${partial ? " (so far)" : ""}`,
    description: lines.join("\n").slice(0, 4000),
    color: EMBED_COLOR,
    footer: { text: "Save your fans with /uma_fans, like /uma_fans fans:32.5m" },
  };
}

// On the 1st (from 12:00, server time), posts last month's summary once.
async function postClubSummary(env, guildId, settings, now) {
  const club = settings.club;
  if (!club?.channelId) return null;
  const local = localNow(now, settings.timeZone);
  const month = previousMonth(local.day.slice(0, 7));
  const due = local.day.endsWith("-01") ? local.time >= "12:00" : true;
  if (!due || club.lastSummary === month || now.getTime() < (club.retryAfter || 0)) return null;
  try {
    const data = await loadClubFans(env, guildId, month, settings);
    if (Object.keys(data).length) {
      const before = await loadClubFans(env, guildId, previousMonth(month), settings);
      const res = await fetch(`${API}/channels/${club.channelId}/messages`, {
        method: "POST",
        headers: { ...botHeaders(env), "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [clubSummary(month, data, before, club.quota)], allowed_mentions: { parse: [] } }),
      });
      if (!res.ok) throw new Error(`Discord returned HTTP ${res.status}: ${await res.text()}`);
    }
    return { lastSummary: month, lastError: null, retryAfter: 0 };
  } catch (err) {
    console.error(`Club summary for server ${guildId} failed: ${err.message}`);
    return { lastError: err.message, retryAfter: now.getTime() + RETRY_AFTER_MS };
  }
}

// ---- Reading another bot's Live Board (/uma_import) ---------------------------------
// Made for UmaCore's default Live Board (github.com/oHaruki/UmaCore): one embed
// titled "📊 Live Board - {club}" with "Competition day: November 04", and one
// line per member such as "` 1` **Lorelei**: +7.44M (27.62M total)" or
// "**Misty**: 0 this month". Every board is kept as that month's numbers, the
// latest day winning, so the last day's final board ends up as the month's total.

const IMPORT_EVERY_MS = 30 * 60 * 1000;
const COMPETITION_DAY = /Competition day:\**\s*([A-Z][a-z]+)\s+(\d{1,2})/;
const BOARD_LINE =
  /\*\*(.+?)\*\*\s*:\s*(?:[+-][\d.,]+\s*[KMB]?\s*\()?([\d.,]+\s*[KMB]?)\s+(?:total|this month|since [A-Za-z]{3,9}\.? \d{1,2})\)?\s*$/i;
const boardKey = (guildId, month) => `board:${guildId}:${month}`;

export function parseLiveBoard(message) {
  const text = (message.embeds ?? [])
    .flatMap((e) => [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])])
    .filter(Boolean)
    .join("\n");
  const day = text.match(COMPETITION_DAY);
  const monthIndex = day ? MONTHS.indexOf(day[1]) : -1;
  if (monthIndex < 0 || !/Live Board/i.test(text)) return null;
  const posted = new Date(message.timestamp);
  // A December board can still be read in January.
  const year = posted.getUTCFullYear() - (monthIndex === 11 && posted.getUTCMonth() === 0 ? 1 : 0);
  const members = {};
  for (const line of text.split("\n")) {
    const match = line.trim().match(BOARD_LINE);
    const fans = match && parseFans(match[2].replace(/\s+/g, ""));
    if (match && fans !== null) members[match[1].replace(/\\(.)/g, "$1").trim()] = fans;
  }
  if (!Object.keys(members).length) return null;
  return { month: `${year}-${String(monthIndex + 1).padStart(2, "0")}`, day: Number(day[2]), members };
}

// The Live Boards among the bot's recent messages, newest first.
async function readBoards(env, source) {
  const res = await fetch(`${API}/channels/${source.channelId}/messages?limit=25`, { headers: botHeaders(env) });
  if (res.status === 403 || res.status === 404) {
    throw new Error(`I can't read <#${source.channelId}>. Please let me View Channel and Read Message History there.`);
  }
  if (!res.ok) throw new Error(`Discord returned HTTP ${res.status} when I read the channel.`);
  const fromBot = (await res.json()).filter((m) => m.author?.id === source.botId);
  if (fromBot.length && fromBot.every((m) => !m.content && !m.embeds?.length && !m.attachments?.length)) {
    // Discord hides other bots' message text unless the Message Content Intent is on.
    throw new Error("I can see the bot's messages but not what's in them. Turn on Message Content Intent " +
      "(Developer Portal → Bot → Privileged Gateway Intents) and save.");
  }
  return fromBot.map(parseLiveBoard).filter(Boolean);
}

async function mergeBoard(env, guildId, board) {
  const key = boardKey(guildId, board.month);
  const stored = await env.UMA_STATE.get(key, "json");
  const same = stored && stored.day === board.day && JSON.stringify(stored.members) === JSON.stringify(board.members);
  if (same || (stored && stored.day > board.day)) return;
  await env.UMA_STATE.put(key, JSON.stringify({ day: board.day, members: board.members }), { expirationTtl: FANS_TTL_SECONDS });
}

// The month's fans from the Live Board when one is linked, otherwise from /uma_fans.
async function loadClubFans(env, guildId, month, settings) {
  if (!settings.club?.source) return loadFans(env, guildId, month);
  const board = await env.UMA_STATE.get(boardKey(guildId, month), "json");
  return Object.fromEntries(Object.entries(board?.members ?? {}).map(([name, fans]) => [`board:${name}`, { fans, name }]));
}

async function pollImport(env, guildId, settings, now) {
  const source = settings.club?.source;
  if (!source || now.getTime() - (source.lastRead || 0) < IMPORT_EVERY_MS) return null;
  try {
    const boards = await readBoards(env, source);
    for (const board of boards) await mergeBoard(env, guildId, board);
    return { source: { lastRead: now.getTime(), lastError: boards.length ? null : "No Live Board in the bot's last messages." } };
  } catch (err) {
    console.error(`Live Board for server ${guildId}: ${err.message}`);
    return { source: { lastRead: now.getTime(), lastError: err.message } };
  }
}

async function setupImport(interaction, env, source) {
  const editUrl = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  let content;
  try {
    const boards = await readBoards(env, source);
    for (const board of boards) await mergeBoard(env, interaction.guild_id, board);
    const current = { ...DEFAULT_SETTINGS, ...(await loadGuilds(env))[interaction.guild_id] };
    await updateGuild(env, interaction.guild_id, {
      club: { ...current.club, source: { ...source, lastRead: Date.now(), lastError: null } },
    });
    const latest = boards[0];
    if (latest) {
      const top = Object.entries(latest.members).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([name, fans]) => `${escapeMarkdown(name)} ${formatFans(fans)}`).join(", ");
      content = `Linked! 💚 I read <@${source.botId}>'s Live Board in <#${source.channelId}> every 30 minutes.\n` +
        `Latest board: **${monthName(latest.month).split(" ")[0]} ${latest.day}**, ${Object.keys(latest.members).length} trainers ` +
        `(${top}…).`;
    } else {
      content = `Linked, but I didn't find a Live Board from <@${source.botId}> in <#${source.channelId}>'s last 25 messages. ` +
        "I'll keep checking every 30 minutes. If its board doesn't look like UmaCore's default, I may not be able to read it.";
    }
    if (!current.club?.quota) content += "\nSet your quota with `/uma_quota` (like `/uma_quota fans:15m`) to get the monthly summary.";
  } catch (err) {
    content = `I couldn't read the Live Board yet: ${err.message}\nNothing was changed; run \`/uma_import\` again once that's fixed.`;
  }
  await sendToDiscord(editUrl, "PATCH", {}, { content, allowed_mentions: { parse: [] } }).catch((err) => console.error(err));
}

// ---- Reaction GIF candidates (/gifs) -------------------------------------------------
// ---- Race scheduler (/uma_races) ---------------------------------------------------

// Built weekly from GameTora by .github/workflows/update-card-data.yml.
const RACE_DATA_URL =
  "https://raw.githubusercontent.com/jedrek20005-byte/claude-test/ccr-5787c415-0zgod8/race-data/races.json";
const APTITUDE_RANK = { S: 7, A: 6, B: 5, C: 4, D: 3, E: 2, F: 1, G: 0 };
const CAREER_YEARS = ["Junior", "Classic", "Senior"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Turns are half-months: 24 a year. The debut is the second half of June in
// the Junior year; the regular races start right after it.
const TURNS = 72;
const FIRST_RACE_TURN = 12;
const DEFAULT_IN_A_ROW = 3;

let raceCache = null;

export function clearRaceCache() {
  raceCache = null;
}

async function loadRaces(env) {
  if (raceCache && Date.now() - raceCache.loadedAt < 6 * 60 * 60 * 1000) return raceCache;
  const res = await fetch(env.RACE_DATA_URL || RACE_DATA_URL, { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new Error(`Couldn't load the race data (HTTP ${res.status})`);
  raceCache = { loadedAt: Date.now(), ...(await res.json()) };
  return raceCache;
}

const turnOf = (race) => (race.year - 1) * 24 + (race.month - 1) * 2 + (race.half - 1);
const umaName = (uma) => `${uma.name}${uma.title ? ` [${uma.title}]` : ""}${uma.jp_only ? " (JP)" : ""}`;

// The races that give the most fans in one career: one per turn, never more
// than maxInARow in a row, each with good enough surface and distance
// aptitude, and only once she has the fans to enter. Fans counted are for 1st
// place, before fan bonuses (which only add to them).
export function planRaces(data, uma, { minAptitude = "A", maxInARow = DEFAULT_IN_A_ROW } = {}) {
  const min = APTITUDE_RANK[minAptitude] ?? APTITUDE_RANK.A;
  const fits = (race) =>
    (APTITUDE_RANK[uma.aptitude[race.surface]] ?? 0) >= min &&
    (APTITUDE_RANK[uma.aptitude[race.type]] ?? 0) >= min &&
    (!race.jp_only || uma.jp_only);
  const byTurn = Array.from({ length: TURNS }, () => []);
  for (const race of data.races) {
    const turn = turnOf(race);
    if (turn >= FIRST_RACE_TURN && turn < TURNS && fits(race)) byTurn[turn].push(race);
  }
  for (const races of byTurn) races.sort((a, b) => b.fans - a.fans);

  // Best fans so far for each number of races in a row; more fans is always
  // at least as good, so this finds the best plan.
  let states = new Map([[1, { fans: data.debut_fans || 0, picks: null }]]); // the debut was just raced
  for (let turn = FIRST_RACE_TURN; turn < TURNS; turn++) {
    const next = new Map();
    const keep = (inARow, state) => {
      if (!next.has(inARow) || next.get(inARow).fans < state.fans) next.set(inARow, state);
    };
    for (const [inARow, state] of states) {
      keep(0, state); // train or rest
      if (inARow >= maxInARow) continue;
      const race = byTurn[turn].find((r) => state.fans >= r.needed);
      if (race) keep(inARow + 1, { fans: state.fans + race.fans, picks: { race, prev: state.picks } });
    }
    states = next;
  }
  const best = [...states.values()].reduce((a, b) => (b.fans > a.fans ? b : a));
  const picks = [];
  for (let node = best.picks; node; node = node.prev) picks.unshift(node.race);
  return { races: picks, fans: picks.reduce((sum, race) => sum + race.fans, 0) };
}

export function findUma(data, query) {
  const text = String(query || "").trim().toLowerCase();
  if (!text) return null;
  return data.umas.find((uma) => String(uma.id) === text) ??
    data.umas.find((uma) => umaName(uma).toLowerCase() === text) ??
    data.umas.find((uma) => umaName(uma).toLowerCase().includes(text)) ?? null;
}

// Suggestions while typing the Uma's name (global ones first).
export function umaChoices(data, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  return data.umas
    .filter((uma) => words.every((word) => umaName(uma).toLowerCase().includes(word)))
    .sort((a, b) => Number(Boolean(a.jp_only)) - Number(Boolean(b.jp_only)))
    .slice(0, 25)
    .map((uma) => ({ name: umaName(uma).slice(0, 100), value: String(uma.id) }));
}

const shortFans = (fans) => (fans >= 1000 ? `${Math.round(fans / 100) / 10}k` : String(fans));

export function racePlanEmbed(uma, plan, { minAptitude, maxInARow }) {
  const a = uma.aptitude;
  const lines = [
    `Turf **${a.turf}** · Dirt **${a.dirt}** · Short **${a.short}** · Mile **${a.mile}** · Medium **${a.medium}** · Long **${a.long}**`,
    `Races where her surface and distance are **${minAptitude}** or better, at most **${maxInARow}** in a row.`,
  ];
  CAREER_YEARS.forEach((year, index) => {
    const races = plan.races.filter((race) => race.year === index + 1);
    if (!races.length) return;
    lines.push("", `**${year} year** (${races.length})`);
    for (const race of races) {
      lines.push(`\`${SHORT_MONTHS[race.month - 1]} ${race.half}\` **${race.grade}** ${race.name} · ${race.distance}m ${race.surface} · ${shortFans(race.fans)}`);
    }
  });
  if (!plan.races.length) lines.push("", "No races fit those aptitudes. Try `aptitude:B or better`.");
  let description = lines.join("\n");
  if (description.length > 4000) description = `${description.slice(0, 3990)}\n…`;
  return {
    title: `🏇 Most fans: ${umaName(uma)}`.slice(0, 256),
    description,
    color: EMBED_COLOR,
    footer: {
      text: `${plan.races.length} races · ${plan.fans.toLocaleString("en-US")} fans for winning them all (before fan bonus). ` +
        "Her career goals still come first! Race data: GameTora",
    },
  };
}

async function answerRaces(interaction, env) {
  const editUrl = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  try {
    const options = optionValues(interaction);
    const data = await loadRaces(env);
    const uma = findUma(data, options.uma);
    let payload;
    if (!uma) {
      payload = { content: "Hmm… I don't know that Uma. Start typing her name and pick her from the list! 💚" };
    } else {
      const settings = {
        minAptitude: APTITUDE_RANK[options.aptitude] ? options.aptitude : "A",
        maxInARow: Math.min(Math.max(Number(options.in_a_row) || DEFAULT_IN_A_ROW, 1), 6),
      };
      payload = { embeds: [racePlanEmbed(uma, planRaces(data, uma, settings), settings)] };
    }
    await sendToDiscord(editUrl, "PATCH", {}, payload);
  } catch (err) {
    console.error(err);
    await sendToDiscord(editUrl, "PATCH", {}, { content: "Something went wrong, sorry." }).catch(() => {});
  }
}

async function autocomplete(interaction, env) {
  const focused = (interaction.data.options || []).find((option) => option.focused);
  let choices = [];
  if (interaction.data.name === "uma_races" && focused?.name === "uma") {
    try {
      choices = umaChoices(await loadRaces(env), focused.value);
    } catch (err) {
      console.error(err);
    }
  }
  return jsonResponse({ type: 8, data: { choices } });
}

// ---- Belno's reaction GIFs (/uma_react, monthly reminder) -------------------------

// Belno Light GIFs from Tenor, picked by the server owner on the /gifs page.
// The numbers are that page's, so picks can be changed by number. Files are
// Tenor's: media.tenor.com/<id><size>/<file>.gif, tenor.com/view/<view>.
const GIFS = [
  { n: 1, id: "YfkFzctQb7g", file: "uma-musume-cinderella-gray", view: "uma-musume-cinderella-gray-belno-light-oguri-cap-tamamo-cross-gif-7059680272317444024" },
  { n: 2, id: "oOZhCF8SHpY", file: "berno-light-sulk", view: "berno-light-sulk-belno-light-uma-musume-uma-musume-cinderella-gray-gif-11594060979294576278", mood: "sad" },
  { n: 3, id: "pHIA4HrnLHU", file: "ep4-gs", view: "ep4-gs-cinderella-gray-cingray-headpat-gif-11849534533699841141", mood: "love" },
  { n: 4, id: "tpWYqn_Mq-8", file: "berno-light-pround-smile", view: "berno-light-pround-smile-belno-light-smile-uma-musume-gif-13156589744488754159", mood: "happy" },
  { n: 5, id: "StWPwzgEMUg", file: "belno-berno-light", view: "belno-berno-light-belno-light-ep7-gs-gif-5392374197467230536" },
  { n: 6, id: "CxvrOup4CVs", file: "berno-light-berno", view: "berno-light-berno-ep4-gs-cinderella-gray-gif-800491997062760795", mood: "sad" },
  { n: 7, id: "-QiY6XIuXr4", file: "uma-uma-musume", view: "uma-uma-musume-anime-hammering-hammer-time-gif-17944760843668184766", mood: "bonk" },
  { n: 8, id: "wWmHzYFP6d0", file: "ep11-cingray", view: "ep11-cingray-cinderella-gray-gs-berno-light-gif-13936819838582254045" },
  { n: 9, id: "Io-MbzcfZQo", file: "umamusume-oguri-cap", view: "umamusume-oguri-cap-belno-light-evil-and-intimidating-horse-cinderella-gray-gif-2490363528253236490" },
  { n: 10, id: "GRwhtt5w3Ho", file: "berno-light", view: "berno-light-berno-light-glaring-glare-gif-1809358219595799674", leftOut: true },
  { n: 11, id: "tuBcdbrllck", file: "gs-ep16", view: "gs-ep16-cingray-cinderella-gray-anime-gif-13177634170402608585" },
  { n: 12, id: "qPy3dz-UZ9U", file: "belno-berno", view: "belno-berno-light-belno-light-berno-light-gif-12176809215298660309" },
  { n: 13, id: "jTHjz4F43QY", file: "ep10-cingray", view: "ep10-cingray-cinderella-gray-gs-uma-gif-10174163513576578310", mood: "bonk" },
  { n: 14, id: "k51ksymLtdM", file: "berno-berno-light", view: "berno-berno-light-uma-cinderella-gray-umamusume-gif-10636768615577925075" },
  { n: 15, id: "KXLpEDjWQu0", file: "belno-light", view: "belno-light-gif-2986705758782374637" },
  { n: 16, id: "sPreQsupsIY", file: "cinderella-gray-ep5", view: "cinderella-gray-ep5-gs-pats-berno-light-gif-12752749673319084166", leftOut: true },
  { n: 17, id: "A3rMU8UdDp8", file: "uma-musume-berno-light", view: "uma-musume-berno-light-belno-light-confuse-uma-musume-cinderella-gray-gif-250737389433851551", mood: "shocked" },
  { n: 18, id: "vLe4rSPYsVQ", file: "gs-cingray", view: "gs-cingray-cingrey-cinderella-gray-anime-gif-13598540653638758740" },
  { n: 19, id: "0mFFkrM2rXo", file: "cinderella-gray-ep3", view: "cinderella-gray-ep3-gs-ondo-over-gif-15159474317080046970", leftOut: true },
  { n: 20, id: "2A6Sbd5ItYc", file: "belno-light-umamusume", view: "belno-light-umamusume-umamusume-cinderella-gray-ice-cube-war-of-the-worlds-gif-15568541962444780935", leftOut: true },
  { n: 21, id: "qIbTYxwRn10", file: "berno-belno", view: "berno-belno-berno-light-belno-light-ep7-gif-12143625867877261149", leftOut: true },
  { n: 22, id: "IPorMWZqSiU", file: "oguri-cap-belno-light", view: "oguri-cap-belno-light-ogubel-oguri-belno-gif-2376259244562991653", mood: "love" },
  { n: 23, id: "xVFhEHXVQOM", file: "uma-musume-umamusume", view: "uma-musume-umamusume-uma-musume-picmix-umamusume-picmix-cinderella-grey-gif-14218252221909647587", leftOut: true },
  { n: 24, id: "MVlpFHviiB4", file: "berno-light-bored", view: "berno-light-bored-dispoint-belno-light-uma-musume-gif-3555988917484423198", mood: "sad" },
  { n: 25, id: "wzw0LMZNgjs", file: "ep10-umamusume", view: "ep10-umamusume-cinderella-gray-cingray-gs-gif-14068176702908760635", leftOut: true },
  { n: 26, id: "AXXWnNV0utg", file: "cinderella-gray-ep6", view: "cinderella-gray-ep6-gs-clear-smile-berno-light-gif-105226135397513944", mood: "happy" },
  { n: 27, id: "wqdIjSGwdU0", file: "cinderella-gray-berno-light", view: "cinderella-gray-berno-light-belno-light-oguri-cap-uma-musume-gif-14026259335461500237" },
  { n: 28, id: "st-VwDJYCS8", file: "cinderella-grey-berno-light", view: "cinderella-grey-berno-light-gif-12889185311268538671" },
  { n: 29, id: "rUOSTsNJGgI", file: "panic-panicap", view: "panic-panicap-oguri-oguri-cap-berno-light-gif-12484983458982599170", mood: "shocked" },
  { n: 30, id: "XN38JqyvSiM", file: "oguri-cap-berno-light", view: "oguri-cap-berno-light-belno-light-hug-uma-musume-gif-6691781864378550819", mood: "love" },
  { n: 31, id: "2ebb-vLbKjA", file: "cingray-ep15", view: "cingray-ep15-cinderella-gray-cinderella-gray-gif-15701479021736569392", leftOut: true },
  { n: 32, id: "JlqPXls42kI", file: "hires-berno", view: "hires-berno-belno-berno-light-belno-light-gif-2763678956765370946" },
  { n: 33, id: "25AeQzf_JLo", file: "cute-berno", view: "cute-berno-belno-berno-light-belno-light-gif-15821178765003662522", mood: "sleepy" },
  { n: 34, id: "ssb-_bnMWvM", file: "nervous-berno-light", view: "nervous-berno-light-cinderella-gray-ep2-gs-gif-12882264149837241075", mood: "shocked" },
  { n: 35, id: "hfRn_H2UIaw", file: "oguri-cap-oguri", view: "oguri-cap-oguri-cap-berno-light-berno-gif-9652454235498095020" },
  { n: 36, id: "DO4i5JwwaQo", file: "bernonerves-bernosweat", view: "bernonerves-bernosweat-berno-light-umamusume-cinderella-gray-gif-931720538180577546", mood: "shocked" },
  { n: 37, id: "8MtN8CWETXs", file: "bernotes-berno-light", view: "bernotes-berno-light-berno-learning-cinderella-gray-gif-17351047683191885179" },
  { n: 38, id: "EPBFedmQFYQ", file: "gs-cingrey", view: "gs-cingrey-cingray-ep17-cinderella-gray-gif-1220551888660862340", leftOut: true },
  { n: 39, id: "0F1AnUMZsZQ", file: "minecraft-mine", view: "minecraft-mine-craft-uma-uma-musume-gif-15014227776902902164", mood: "bonk" },
  { n: 40, id: "7_t4Kf-2na8", file: "belno-light-uma-musume", view: "belno-light-uma-musume-umamusume-cinderella-gray-happy-gif-17292547315998301615", mood: "happy" },
  { n: 41, id: "ZjWyY7cErtc", file: "berno-light-umamusume", view: "berno-light-umamusume-uma-musume-cinderella-gray-honest-reaction-berno-gif-7364988906976358103", leftOut: true },
  { n: 42, id: "mRi5gd7U1UM", file: "jo-kitahara-kitahara-jo", view: "jo-kitahara-kitahara-jo-belno-belno-light-umamusume-cinderella-gray-gif-11031771254684439875" },
  { n: 43, id: "F9KXJGlhKQQ", file: "belno-light-oguri-cap", view: "belno-light-oguri-cap-uma-musume-cinderella-gray-gif-1716600590624172292", leftOut: true },
  { n: 44, id: "Sbk84UOiAaA", file: "cap-oguri-cap", view: "cap-oguri-cap-oguri-gs-ep3-gif-5312344173660209568", leftOut: true },
  { n: 45, id: "tMrXryBNDWM", file: "berno-light-uma-musume", view: "berno-light-uma-musume-uma-musume-pretty-derby-cinderella-grey-cute-anime-girl-gif-13027462019283750243", leftOut: true },
  { n: 46, id: "PW9NjHWy_FQ", file: "belno-light-i-love-you", view: "belno-light-i-love-you-ily-berno-light-uma-musume-gif-4426842224393911380", mood: "love" },
  { n: 47, id: "-wmLhQqJYuM", file: "hat-theft", view: "hat-theft-stealing-obey-obey-san-gif-18089142781833994979", leftOut: true },
  { n: 48, id: "JjBue-njqqE", file: "umamusume-belno-light", view: "umamusume-belno-light-belno-uma-musume-uma-gif-2751820850807417505", leftOut: true },
  { n: 49, id: "2pDgAeRqLHM", file: "umamusume-uma-musume", view: "umamusume-uma-musume-oguri-cap-belno-berno-light-gif-15749334195646377075", mood: "hungry" },
];
export const REACTION_GIFS = GIFS.filter((gif) => !gif.leftOut);

const pickFrom = (items, random = Math.random) => items[Math.floor(random() * items.length)];
const gifUrl = (gif, size = "AAAAd") => `https://media.tenor.com/${gif.id}${size}/${gif.file}.gif`;

// A GIF for the mood ("random" or unknown: any of them).
export function pickGif(mood, random = Math.random) {
  const matching = mood && mood !== "any" && MOODS[mood] ? REACTION_GIFS.filter((gif) => gif.mood === mood) : [];
  return pickFrom(matching.length ? matching : REACTION_GIFS, random);
}

function belnoLine(gif, random = Math.random) {
  return pickFrom(MOODS[gif.mood ?? "any"].lines, random);
}

const gifEmbed = (gif) => ({ color: EMBED_COLOR, image: { url: gifUrl(gif) } });

function reactWithGif(interaction) {
  const options = optionValues(interaction);
  const gif = pickGif(options.mood);
  const to = options.to ? `<@${options.to}> ` : "";
  return jsonResponse({
    type: 4,
    data: {
      content: `${to}${options.message || belnoLine(gif)}`,
      embeds: [gifEmbed(gif)],
      // Only the person picked in "to" is pinged, whatever the message says.
      allowed_mentions: { parse: [], users: options.to ? [options.to] : [] },
    },
  });
}

// Shows every GIF with its number and mood, so picks can be checked and changed by number.
function gifsPage() {
  const figure = (gif) =>
    `<figure${gif.leftOut ? ' class="out"' : ""}><div class="n">${gif.n}</div>` +
    `<img src="${gifUrl(gif, "AAAAM")}" loading="lazy" referrerpolicy="no-referrer" alt="">` +
    `<figcaption>${gif.leftOut ? "left out" : MOODS[gif.mood ?? "any"].label.replace("Random", "Any mood")} · ` +
    `<a href="https://tenor.com/view/${gif.view}">Tenor</a></figcaption></figure>`;
  const used = REACTION_GIFS;
  const out = GIFS.filter((gif) => gif.leftOut);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Belno GIFs</title><style>body{margin:0;padding:16px;font:15px/1.4 system-ui,sans-serif;background:#151813;color:#e8ebe3}` +
      `h1{font-size:20px;margin:0 0 8px}h2{font-size:17px;margin:20px 0 8px}a{color:#62c271}` +
      `.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}` +
      `figure{margin:0;position:relative;background:#1f241c;border-radius:12px;overflow:hidden}figure.out{opacity:.45}img{width:100%;display:block}` +
      `.n{position:absolute;top:6px;left:6px;background:#62c271;color:#000;font-weight:700;border-radius:999px;padding:2px 9px}` +
      `figcaption{padding:6px 8px;font-size:12px;color:#9aa391}</style></head><body>` +
      `<h1>Belno's reaction GIFs</h1><p>Used by <code>/uma_react</code> and the monthly reminder. ` +
      `To change them, tell Claude the numbers, like “add 25, remove 9, 12 is happy”.</p>` +
      `<h2>In use (${used.length})</h2><div class="grid">${used.map(figure).join("")}</div>` +
      `<h2>Left out (${out.length})</h2><div class="grid">${out.map(figure).join("")}</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" } },
  );
}

// ---- /uma_test ----------------------------------------------------------------------

// Sample members for a summary preview before anyone has reported.
const EXAMPLE_FANS = {
  now: { 1: { fans: 41_000_000, name: "Special Week" }, 2: { fans: 32_500_000, name: "Silence Suzuka" }, 3: { fans: 18_000_000, name: "Gold Ship" } },
  before: { 1: { fans: 30_000_000, name: "Special Week" }, 2: { fans: 33_000_000, name: "Silence Suzuka" }, 4: { fans: 25_000_000, name: "Tokai Teio" } },
};

async function runTest(interaction, env) {
  const editUrl = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  try {
    await sendTest(interaction, env, editUrl);
  } catch (err) {
    console.error(err);
    await sendToDiscord(editUrl, "PATCH", {}, { content: "Something went wrong, sorry." }).catch(() => {});
  }
}

async function sendTest(interaction, env, editUrl) {
  const options = optionValues(interaction);
  const settings = { ...DEFAULT_SETTINGS, ...(await loadGuilds(env))[interaction.guild_id] };
  let preview, channelId, note;
  if (options.what === "monthly") {
    const monthly = settings.monthly;
    channelId = monthly?.channelId;
    preview = monthlyContent(monthly ?? { text: BELNO_REMINDER, roleId: null });
    note = monthly
      ? `This is your monthly reminder; it goes out on ${describeMonthly(monthly, settings.timeZone)}.`
      : "No monthly reminder yet, so here's my default text. Set it up with `/uma_monthly`!";
  } else {
    channelId = settings.club?.channelId;
    const thisMonth = localNow(new Date(), settings.timeZone).day.slice(0, 7);
    const lastMonth = previousMonth(thisMonth);
    let month = lastMonth;
    let data = await loadClubFans(env, interaction.guild_id, lastMonth, settings);
    if (!Object.keys(data).length) {
      month = thisMonth;
      data = await loadClubFans(env, interaction.guild_id, thisMonth, settings);
    }
    if (Object.keys(data).length) {
      const before = await loadClubFans(env, interaction.guild_id, previousMonth(month), settings);
      preview = { embeds: [clubSummary(month, data, before, settings.club?.quota, { partial: month === thisMonth })] };
      note = month === lastMonth
        ? "This is last month's summary, like the one I post on the 1st."
        : "Nobody reported fans for last month, so this is this month so far.";
    } else {
      const embed = clubSummary(lastMonth, EXAMPLE_FANS.now, EXAMPLE_FANS.before, settings.club?.quota ?? 30_000_000);
      preview = { embeds: [{ ...embed, title: `${embed.title} (example)` }] };
      note = "Nobody has saved their fans yet, so this is an example with made-up members.";
    }
    if (!settings.club) note += " Turn on the monthly summary with `/uma_quota`.";
  }

  let content = note;
  if (options.post) {
    if (!channelId) {
      content = `${note}\nI didn't send it anywhere: there's no channel for it yet.`;
    } else {
      const res = await fetch(`${API}/channels/${channelId}/messages`, {
        method: "POST",
        headers: { ...botHeaders(env), "Content-Type": "application/json" },
        body: JSON.stringify({ ...preview, allowed_mentions: preview.allowed_mentions ?? { parse: [] } }),
      });
      content = res.ok
        ? `Sent a test in <#${channelId}> 💚 (it doesn't count as this month's real one)`
        : `I couldn't post in <#${channelId}> (HTTP ${res.status}). Please check I can see the channel and send messages there.`;
    }
  }
  // The private preview never pings anyone.
  const shown = preview.content ? `${content}\n\n${preview.content}` : content;
  await sendToDiscord(editUrl, "PATCH", {}, { content: shown.slice(0, 2000), embeds: preview.embeds ?? [], allowed_mentions: { parse: [] } });
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
// The same key signs /uma_say message boxes.
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
