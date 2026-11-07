// Modern Warships leaks: a Discord app (Cloudflare Worker) that watches
// subreddits, YouTube channels and Telegram channels and posts new posts that
// match a keyword (like "leak") in a channel.
//
// Secrets: DISCORD_PUBLIC_KEY, DISCORD_TOKEN. KV binding: LEAKS_STATE.
// Deployed by .github/workflows/deploy-warships.yml (wrangler.warships.toml).

const API = "https://discord.com/api/v10";
const USER_AGENT = "Mozilla/5.0 (compatible; ModernWarshipsLeaks/1.0; +https://github.com/jedrek20005-byte/claude-test)";
const BOT_USER_AGENT = "DiscordBot (https://github.com/jedrek20005-byte/claude-test, 1.0)";
// View Channel + Send Messages + Embed Links
const BOT_PERMISSIONS = "19456";
const ADMIN_ONLY = { default_member_permissions: "32", contexts: [0] };
const EMBED_COLOR = 0x2f80ed;
const MAX_SOURCES = 15;
const MAX_SEEN = 150;
const MAX_POSTS_PER_SOURCE = 5;
const LEAK_WORDS = "leak, leaks, leaked";
const DEFAULT_SOURCE = { type: "reddit", name: "ModernWarships", filter: LEAK_WORDS };
// Every known Modern Warships leak source, for /leaks_all: the subreddit and
// leak YouTubers filtered to leak posts, and the official channels (which
// announce upcoming ships) unfiltered.
export const LEAK_SOURCES = [
  DEFAULT_SOURCE,
  { type: "youtube", name: "@ibragod", id: "UCWvpqeoGwRMRPbqsNFEPiiA", filter: LEAK_WORDS },
  { type: "youtube", name: "@LayszCH", id: "UCT-HRG3YZtWqGxKkVy0gLnA", filter: LEAK_WORDS },
  { type: "youtube", name: "@GUICKNES-FR", filter: LEAK_WORDS },
  { type: "youtube", name: "@GylaxMW", filter: LEAK_WORDS },
  { type: "youtube", name: "@ModernWarshipsOfficial", id: "UC1hDoirWXy7vdkuNUo4H_mQ" },
  { type: "telegram", name: "modernwarships" },
];

export const SOURCE_TYPES = {
  reddit: { label: "Reddit", icon: "🟠" },
  youtube: { label: "YouTube", icon: "▶️" },
  telegram: { label: "Telegram", icon: "✈️" },
};

const COMMANDS = [
  {
    name: "leaks_here",
    description: "Post new leaks in this channel (starts with r/ModernWarships posts that mention a leak)",
    type: 1,
    ...ADMIN_ONLY,
    options: [{ type: 7, name: "channel", description: "Where to post (this channel if left empty)", required: false, channel_types: [0, 5, 10, 11, 12] }],
  },
  {
    name: "leaks_add",
    description: "Watch a subreddit, YouTube channel or Telegram channel for leaks",
    type: 1,
    ...ADMIN_ONLY,
    options: [
      {
        type: 3, name: "source", description: "Where it is", required: true,
        choices: Object.entries(SOURCE_TYPES).map(([value, type]) => ({ name: type.label, value })),
      },
      { type: 3, name: "name", description: "Subreddit (ModernWarships), YouTube @handle or link, or Telegram channel", required: true, max_length: 200 },
      {
        type: 3, name: "filter", description: "Only posts with one of these words, comma-separated (everything if left empty)",
        required: false, max_length: 200,
      },
    ],
  },
  {
    name: "leaks_remove",
    description: "Stop watching a source",
    type: 1,
    ...ADMIN_ONLY,
    options: [{ type: 3, name: "name", description: "Which source", required: true, autocomplete: true, max_length: 200 }],
  },
  {
    name: "leaks_all",
    description: "Watch every known Modern Warships leak source (Reddit, leak YouTubers, official channels)",
    type: 1,
    ...ADMIN_ONLY,
    options: [{ type: 7, name: "channel", description: "Where to post (keeps the current one, or this channel)", required: false, channel_types: [0, 5, 10, 11, 12] }],
  },
  { name: "leaks_list", description: "Show the watched sources and the leaks channel", type: 1, ...ADMIN_ONLY },
  { name: "leaks_test", description: "Post the newest matching post from each source now", type: 1, ...ADMIN_ONLY },
  { name: "leaks_off", description: "Stop posting leaks (the sources are kept)", type: 1, ...ADMIN_ONLY },
];

// ---- Text helpers -------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html) {
  return decodeEntities(String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const tag = (xml, name) => xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "";
const attr = (xml, name, attribute) => xml.match(new RegExp(`<${name}\\b[^>]*\\b${attribute}="([^"]*)"`))?.[1] ?? "";

export function parseFilter(filter) {
  return String(filter ?? "").split(",").map((word) => word.trim().toLowerCase()).filter(Boolean);
}

export function matches(item, words) {
  if (!words.length) return true;
  const text = `${item.title} ${item.text}`.toLowerCase();
  return words.some((word) => text.includes(word));
}

// ---- Sources --------------------------------------------------------------------------

// Each parser returns posts newest first: { id, title, text, url, image, author, time }.

export function parseRedditFeed(xml) {
  return xml.split("<entry>").slice(1).map((entry) => {
    const content = decodeEntities(tag(entry, "content"));
    const image = content.match(/href="(https:\/\/(?:i\.redd\.it|i\.imgur\.com)\/[^"]+\.(?:jpe?g|png|gif|webp))"/i)?.[1] ||
      decodeEntities(attr(entry, "media:thumbnail", "url")) || null;
    const text = htmlToText(content.replace(/<a\b[^>]*>\s*\[(link|comments)\]\s*<\/a>/gi, "").replace(/submitted by[\s\S]*$/i, ""));
    return {
      id: tag(entry, "id").trim(),
      title: decodeEntities(tag(entry, "title")).trim(),
      text,
      url: decodeEntities(attr(entry, "link", "href")),
      image,
      author: decodeEntities(tag(tag(entry, "author"), "name")).trim(),
      time: tag(entry, "published") || tag(entry, "updated") || null,
    };
  }).filter((post) => post.id && post.url);
}

export function parseYouTubeFeed(xml) {
  return xml.split("<entry>").slice(1).map((entry) => {
    const id = tag(entry, "yt:videoId").trim();
    return {
      id,
      title: decodeEntities(tag(entry, "title")).trim(),
      text: decodeEntities(tag(entry, "media:description")).trim(),
      url: `https://www.youtube.com/watch?v=${id}`,
      image: decodeEntities(attr(entry, "media:thumbnail", "url")) || null,
      author: decodeEntities(tag(tag(entry, "author"), "name")).trim(),
      time: tag(entry, "published") || null,
    };
  }).filter((video) => video.id);
}

export function parseTelegramPage(html, channel) {
  const posts = html.split('class="tgme_widget_message_wrap').slice(1).map((block) => {
    const post = block.match(/data-post="([^"]+)"/)?.[1];
    const textHtml = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    const text = htmlToText(textHtml);
    const image = block.match(/tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/)?.[1] ||
      block.match(/tgme_widget_message_video_thumb[^>]*background-image:url\('([^']+)'\)/)?.[1] || null;
    return post && {
      id: post,
      title: text.split("\n")[0].slice(0, 200),
      text,
      url: `https://t.me/${post}`,
      image,
      author: decodeEntities(block.match(/<span dir="auto">([^<]+)<\/span>/)?.[1] ?? channel),
      time: block.match(/<time datetime="([^"]+)"/)?.[1] ?? null,
    };
  }).filter(Boolean);
  return posts.reverse(); // the page shows the oldest first
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

// Turns what someone typed into a source: { type, name, id? }.
export function normalizeSource(type, input) {
  let name = String(input ?? "").trim();
  if (type === "reddit") {
    name = name.replace(/^(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com/i, "").replace(/^\/?r\//i, "").split(/[/?#]/)[0];
    return /^\w{2,21}$/.test(name) ? { type, name } : null;
  }
  if (type === "telegram") {
    name = name.replace(/^(?:https?:\/\/)?(?:www\.)?t(?:elegram)?\.me\/(?:s\/)?/i, "").replace(/^@/, "").split(/[/?#]/)[0];
    return /^\w{4,32}$/.test(name) ? { type, name } : null;
  }
  if (type === "youtube") {
    const id = name.match(/UC[\w-]{22}/)?.[0];
    if (id) return { type, name: id, id };
    const handle = name.match(/@([\w.-]{3,30})/)?.[1] ?? (/^[\w.-]{3,30}$/.test(name) ? name : null);
    return handle ? { type, name: `@${handle}` } : null;
  }
  return null;
}

// A YouTube @handle's channel ID, read from the channel page.
async function youtubeChannelId(handle) {
  const html = await fetchText(`https://www.youtube.com/${handle}`);
  const id = html.match(/"(?:externalId|channelId)":"(UC[\w-]{22})"/)?.[1] ??
    html.match(/youtube\.com\/channel\/(UC[\w-]{22})/)?.[1];
  if (!id) throw new Error(`Couldn't find the YouTube channel ${handle}`);
  return id;
}

export async function fetchPosts(source) {
  if (source.type === "reddit") {
    return parseRedditFeed(await fetchText(`https://www.reddit.com/r/${source.name}/new/.rss`));
  }
  if (source.type === "youtube") {
    const id = source.id ?? (await youtubeChannelId(source.name));
    return parseYouTubeFeed(await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`));
  }
  if (source.type === "telegram") {
    return parseTelegramPage(await fetchText(`https://t.me/s/${source.name}`), source.name);
  }
  throw new Error(`Unknown source type ${source.type}`);
}

export const sourceKey = (source) => `${source.type}:${source.name.toLowerCase()}`;
const sourceLabel = (source) =>
  source.type === "reddit" ? `r/${source.name}` : source.type === "telegram" ? `t.me/${source.name}` : `YouTube ${source.name}`;

// ---- Messages -------------------------------------------------------------------------

export function postMessage(source, post) {
  if (source.type === "youtube") {
    // Discord shows the video player for a bare YouTube link.
    return {
      content: `${SOURCE_TYPES.youtube.icon} **${post.author || source.name}** posted a new video: **${clip(post.title, 200)}**\n${post.url}`,
      allowed_mentions: { parse: [] },
    };
  }
  const embed = {
    color: EMBED_COLOR,
    author: { name: clip(`${SOURCE_TYPES[source.type].icon} ${sourceLabel(source)}${post.author ? ` · ${post.author}` : ""}`, 256) },
    title: clip(post.title || "New post", 256),
    url: post.url,
    description: clip(post.text || "", source.type === "telegram" ? 2000 : 700) || undefined,
  };
  if (post.image) embed.image = { url: post.image };
  if (post.time && !Number.isNaN(Date.parse(post.time))) embed.timestamp = new Date(post.time).toISOString();
  return { embeds: [embed], allowed_mentions: { parse: [] } };
}

// ---- Storage --------------------------------------------------------------------------

// "guilds" holds each server's settings (written by commands); "state:<server>"
// holds what each source has already shown (written by the timer), so the two
// never overwrite each other.
async function loadGuilds(env) {
  return (await env.LEAKS_STATE.get("guilds", "json")) ?? {};
}

async function updateGuild(env, guildId, change) {
  const guilds = await loadGuilds(env);
  const current = guilds[guildId] ?? { enabled: false, channelId: null, sources: [] };
  guilds[guildId] = typeof change === "function" ? change(current) : { ...current, ...change };
  await env.LEAKS_STATE.put("guilds", JSON.stringify(guilds));
  return guilds[guildId];
}

const stateKey = (guildId) => `state:${guildId}`;

// ---- The timer ----------------------------------------------------------------------

export async function runChecks(env, now = new Date()) {
  const guilds = await loadGuilds(env);
  const cache = new Map(); // each source is fetched once per run, however many servers watch it
  const fetchOnce = (source) => {
    const key = sourceKey(source);
    if (!cache.has(key)) cache.set(key, fetchPosts(source).then((posts) => ({ posts }), (err) => ({ error: err.message })));
    return cache.get(key);
  };
  for (const [guildId, guild] of Object.entries(guilds)) {
    if (!guild.enabled || !guild.channelId || !guild.sources?.length) continue;
    try {
      await checkGuild(env, guildId, guild, fetchOnce, now);
    } catch (err) {
      console.error(`Leak check for server ${guildId} failed: ${err.message}`);
    }
  }
}

async function checkGuild(env, guildId, guild, fetchOnce, now) {
  const state = (await env.LEAKS_STATE.get(stateKey(guildId), "json")) ?? {};
  let changed = false;
  for (const source of guild.sources) {
    const key = sourceKey(source);
    const before = state[key];
    const result = await fetchOnce(source);
    if (result.error) {
      if (before?.error !== result.error) {
        state[key] = { ...before, seen: before?.seen ?? [], error: result.error, checkedAt: now.getTime() };
        changed = true;
      }
      continue;
    }
    const seen = new Set(before?.seen ?? []);
    let fresh = [];
    if (before?.primed) {
      // Oldest first, and only a few at a time so a busy source can't flood the channel.
      fresh = result.posts.filter((post) => !seen.has(post.id) && matches(post, parseFilter(source.filter)))
        .slice(0, MAX_POSTS_PER_SOURCE).reverse();
    }
    const posted = new Set();
    let error = null;
    for (const post of fresh) {
      const res = await sendMessage(env, guild.channelId, postMessage(source, post));
      if (!res.ok) {
        error = res.status === 403 || res.status === 404
          ? `I can't post in the leaks channel (HTTP ${res.status}); check I can see it and send messages and embeds there.`
          : `Discord refused a post (HTTP ${res.status}).`;
        break;
      }
      posted.add(post.id);
    }
    // Everything fetched counts as seen, except matching posts that couldn't be
    // posted: those are tried again next time.
    const retry = new Set(fresh.filter((post) => !posted.has(post.id)).map((post) => post.id));
    const ids = result.posts.map((post) => post.id).filter((id) => !retry.has(id));
    const oldSeen = before?.seen ?? [];
    const newSeen = [...new Set([...ids, ...oldSeen])].filter((id) => !retry.has(id)).slice(0, MAX_SEEN);
    const sameSeen = before?.primed && newSeen.length === oldSeen.length && newSeen.every((id, i) => id === oldSeen[i]);
    if (!sameSeen || error !== (before?.error ?? null)) {
      state[key] = { seen: newSeen, primed: true, error, checkedAt: now.getTime(), lastPost: posted.size ? now.getTime() : before?.lastPost ?? null };
      changed = true;
    }
  }
  if (changed) await env.LEAKS_STATE.put(stateKey(guildId), JSON.stringify(state));
}

function botHeaders(env) {
  return { Authorization: `Bot ${env.DISCORD_TOKEN}`, "User-Agent": BOT_USER_AGENT };
}

function sendMessage(env, channelId, message) {
  return fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { ...botHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
}

// ---- Discord plumbing ---------------------------------------------------------------

function jsonResponse(data) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

function reply(content, { ephemeral = true } = {}) {
  return jsonResponse({ type: 4, data: { content, flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] } } });
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex.trim())) throw new Error("not hex");
  return new Uint8Array(hex.trim().match(/../g).map((byte) => parseInt(byte, 16)));
}

export async function isFromDiscord(request, body, publicKey) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKey) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

const optionValues = (interaction) =>
  Object.fromEntries((interaction.data.options || []).map((option) => [option.name, option.value]));
const inviteLink = (appId) =>
  `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`;

async function edit(interaction, message) {
  await fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "User-Agent": BOT_USER_AGENT },
    body: JSON.stringify({ allowed_mentions: { parse: [] }, ...message }),
  });
}

// Runs slow work after a private "thinking…" answer, then edits it in.
function later(ctx, interaction, work) {
  ctx.waitUntil((async () => {
    let message;
    try {
      message = await work();
    } catch (err) {
      console.error(err);
      message = { content: "Something went wrong, sorry." };
    }
    await edit(interaction, typeof message === "string" ? { content: message } : message).catch((err) => console.error(err));
  })());
  return jsonResponse({ type: 5, data: { flags: 64 } });
}

async function registerCommands(env) {
  const res = await fetch(`${API}/applications/@me`, { headers: botHeaders(env) });
  if (!res.ok) throw new Error(`Discord returned HTTP ${res.status} for the app (is DISCORD_TOKEN right?)`);
  const app = await res.json();
  const put = await fetch(`${API}/applications/${app.id}/commands`, {
    method: "PUT",
    headers: { ...botHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(COMMANDS),
  });
  if (!put.ok) throw new Error(`Registering commands failed: HTTP ${put.status} ${await put.text()}`);
  return app;
}

// ---- Commands -------------------------------------------------------------------------

const NO_STORAGE = "My storage isn't connected yet (the LEAKS_STATE binding is missing).";

function describeSource(source, state) {
  const status = state?.error ? `⚠️ ${clip(state.error, 150)}` : state ? "✅" : "⏳ first check soon";
  const filter = parseFilter(source.filter);
  return `${SOURCE_TYPES[source.type].icon} **${sourceLabel(source)}**` +
    (filter.length ? ` (only: ${filter.join(", ")})` : " (everything)") + ` · ${status}`;
}

const HANDLERS = {
  async leaks_here(interaction, env) {
    const channelId = optionValues(interaction).channel || interaction.channel_id;
    const guild = await updateGuild(env, interaction.guild_id, (current) => ({
      ...current,
      enabled: true,
      channelId,
      sources: current.sources?.length ? current.sources : [DEFAULT_SOURCE],
    }));
    return reply(
      `⚓ I'll post new leaks in <#${channelId}>, checking every 10 minutes.\n` +
        guild.sources.map((source) => describeSource(source)).join("\n") +
        "\nAdd YouTube or Telegram channels with `/leaks_add`. Posts from before now aren't reposted.",
    );
  },

  leaks_add(interaction, env, ctx) {
    const options = optionValues(interaction);
    const source = normalizeSource(options.source, options.name);
    if (!source) {
      return reply(`That doesn't look like a ${SOURCE_TYPES[options.source]?.label ?? ""} name. Examples: \`ModernWarships\`, \`@SomeChannel\`, \`t.me/somechannel\`.`);
    }
    if (options.filter) source.filter = options.filter;
    return later(ctx, interaction, async () => {
      let posts;
      try {
        if (source.type === "youtube" && !source.id) source.id = await youtubeChannelId(source.name);
        posts = await fetchPosts(source);
      } catch (err) {
        return `I couldn't read ${sourceLabel(source)} (${err.message}), so I didn't add it.`;
      }
      let full = false;
      await updateGuild(env, interaction.guild_id, (current) => {
        const others = (current.sources ?? []).filter((s) => sourceKey(s) !== sourceKey(source));
        full = others.length >= MAX_SOURCES;
        return full ? current : { ...current, sources: [...others, source] };
      });
      if (full) return `I can watch up to ${MAX_SOURCES} sources; remove one with \`/leaks_remove\` first.`;
      const matching = posts.filter((post) => matches(post, parseFilter(source.filter)));
      const newest = matching[0];
      return `Added ${describeSource(source, {})}\n` +
        (newest ? `Newest matching post: **${clip(newest.title || "(no title)", 150)}**` : `None of the ${posts.length} newest posts match yet.`) +
        "\nOnly new posts from now on get posted; use `/leaks_test` to see the newest ones.";
    });
  },

  leaks_all(interaction, env, ctx) {
    return later(ctx, interaction, async () => {
      const guilds = await loadGuilds(env);
      const watched = new Set((guilds[interaction.guild_id]?.sources ?? []).map(sourceKey));
      const added = [];
      const failed = [];
      for (const pack of LEAK_SOURCES) {
        if (watched.has(sourceKey(pack))) continue;
        const source = { ...pack };
        try {
          if (source.type === "youtube" && !source.id) source.id = await youtubeChannelId(source.name);
          added.push(source);
        } catch (err) {
          failed.push(`${sourceLabel(source)} (${err.message})`);
        }
      }
      const channelOption = optionValues(interaction).channel;
      let full = false;
      const guild = await updateGuild(env, interaction.guild_id, (current) => {
        const keys = new Set((current.sources ?? []).map(sourceKey));
        const fresh = added.filter((source) => !keys.has(sourceKey(source)));
        const sources = [...(current.sources ?? []), ...fresh].slice(0, MAX_SOURCES);
        full = sources.length < (current.sources ?? []).length + fresh.length;
        return { ...current, enabled: true, channelId: channelOption || current.channelId || interaction.channel_id, sources };
      });
      return `⚓ Watching every known leak source, posting in <#${guild.channelId}> every 10 minutes:\n` +
        guild.sources.map((source) => describeSource(source)).join("\n") +
        (added.length ? "" : "\n(You were already watching all of them.)") +
        (failed.length ? `\n⚠️ Couldn't add: ${failed.join(", ")}` : "") +
        (full ? `\n⚠️ I can watch up to ${MAX_SOURCES} sources, so some weren't added.` : "") +
        "\nOnly new posts from now on get posted; `/leaks_test` shows the newest ones.";
    });
  },

  async leaks_remove(interaction, env) {
    const wanted = String(optionValues(interaction).name || "").toLowerCase();
    let removed = null;
    await updateGuild(env, interaction.guild_id, (current) => {
      const sources = current.sources ?? [];
      removed = sources.find((s) => sourceKey(s) === wanted) ??
        sources.find((s) => s.name.toLowerCase() === wanted || sourceLabel(s).toLowerCase().includes(wanted)) ?? null;
      return { ...current, sources: sources.filter((s) => s !== removed) };
    });
    return reply(removed ? `Okay, I stopped watching ${sourceLabel(removed)}.` : "I'm not watching anything with that name; see `/leaks_list`.");
  },

  async leaks_list(interaction, env) {
    const guild = (await loadGuilds(env))[interaction.guild_id];
    if (!guild?.sources?.length) return reply("Nothing set up yet. Use `/leaks_here` in your leaks channel to start! ⚓");
    const state = (await env.LEAKS_STATE.get(stateKey(interaction.guild_id), "json")) ?? {};
    return reply(
      `📍 Leaks channel: ${guild.channelId ? `<#${guild.channelId}>` : "not set"} · posting ${guild.enabled ? "**on**" : "**off**"}\n` +
        guild.sources.map((source) => describeSource(source, state[sourceKey(source)])).join("\n"),
    );
  },

  leaks_test(interaction, env, ctx) {
    return later(ctx, interaction, async () => {
      const guild = (await loadGuilds(env))[interaction.guild_id];
      if (!guild?.sources?.length) return "Nothing set up yet. Use `/leaks_here` first!";
      const channelId = guild.channelId || interaction.channel_id;
      const lines = [];
      for (const source of guild.sources) {
        try {
          const post = (await fetchPosts(source)).find((p) => matches(p, parseFilter(source.filter)));
          if (!post) {
            lines.push(`${sourceLabel(source)}: no matching posts right now`);
            continue;
          }
          const res = await sendMessage(env, channelId, postMessage(source, post));
          lines.push(`${sourceLabel(source)}: ${res.ok ? "posted ✅" : `Discord said HTTP ${res.status}`}`);
        } catch (err) {
          lines.push(`${sourceLabel(source)}: ⚠️ ${err.message}`);
        }
      }
      return `Test posts in <#${channelId}>:\n${lines.join("\n")}`;
    });
  },

  async leaks_off(interaction, env) {
    await updateGuild(env, interaction.guild_id, { enabled: false });
    return reply("Okay, no more leak posts for now. `/leaks_here` turns them back on (the sources are kept).");
  },
};

async function autocomplete(interaction, env) {
  const focused = (interaction.data.options || []).find((option) => option.focused);
  const guild = (await loadGuilds(env))[interaction.guild_id];
  const typed = String(focused?.value || "").toLowerCase();
  const choices = (guild?.sources ?? [])
    .filter((source) => sourceLabel(source).toLowerCase().includes(typed))
    .slice(0, 25)
    .map((source) => ({ name: sourceLabel(source).slice(0, 100), value: sourceKey(source) }));
  return jsonResponse({ type: 8, data: { choices } });
}

// ---- Pages --------------------------------------------------------------------------

function statusPage(env) {
  const check = (ok, name) => `${ok ? "✅" : "❌"} ${name}`;
  const text = [
    "Modern Warships leaks bot",
    check(Boolean(env.DISCORD_PUBLIC_KEY), "DISCORD_PUBLIC_KEY"),
    check(Boolean(env.DISCORD_TOKEN), "DISCORD_TOKEN"),
    check(Boolean(env.LEAKS_STATE), "LEAKS_STATE"),
    "Open /register to register the slash commands and get the invite link.",
  ].join("\n");
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/register") {
      try {
        const app = await registerCommands(env);
        return new Response(`Slash commands registered for ${app.name}.\nInvite link: ${inviteLink(app.id)}\n`, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Couldn't register: ${err.message}\n`, { status: 500 });
      }
    }
    if (request.method === "GET") return statusPage(env);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const body = await request.text();
    if (!(await isFromDiscord(request, body, env.DISCORD_PUBLIC_KEY))) {
      return new Response("Invalid request signature", { status: 401 });
    }
    const interaction = JSON.parse(body);
    if (interaction.type === 1) {
      ctx.waitUntil(registerCommands(env).catch((err) => console.error(err.message)));
      return jsonResponse({ type: 1 });
    }
    if (!env.LEAKS_STATE) return reply(NO_STORAGE);
    if (interaction.type === 4) return autocomplete(interaction, env);
    const handler = interaction.type === 2 && HANDLERS[interaction.data?.name];
    if (handler) return handler(interaction, env, ctx);
    return reply("Unknown command.");
  },

  async scheduled(controller, env, ctx) {
    if (env.LEAKS_STATE) ctx.waitUntil(runChecks(env, new Date(controller.scheduledTime)));
  },
};
