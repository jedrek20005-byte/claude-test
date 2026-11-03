// The /uma slash command as a Cloudflare Worker.
//
// Discord sends each command to this Worker over HTTPS ("interactions
// endpoint"), so there's no bot process to keep online. The daily post is
// handled separately by the GitHub Actions workflow. Setup steps: README,
// "Slash command without a computer".
//
// Secrets (Worker → Settings → Variables and Secrets):
//   DISCORD_PUBLIC_KEY  Developer Portal → your app → General Information → Public Key
//   DISCORD_TOKEN       Developer Portal → your app → Bot → Reset Token (only used to register /uma)

const API = "https://discord.com/api/v10";
const USER_AGENT = "UmamusumeDailyBot/1.0 (+https://github.com/jedrek20005-byte/claude-test)";
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const EMBED_COLOR = 0x5fbf6e;
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const GENERAL = 0;
const UNKNOWN = 9;

const COMMANDS = [{ name: "uma", description: "Post a random SFW Umamusume picture", type: 1 }];

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
      // a good moment to make sure /uma is registered.
      ctx.waitUntil(registerCommands(env).catch((err) => console.error(err.message)));
      return jsonResponse({ type: 1 });
    }
    if (interaction.type === 2 && interaction.data?.name === "uma") {
      // Reply "thinking…" right away (Discord allows 3 seconds), then edit in the picture.
      ctx.waitUntil(answerUma(interaction));
      return jsonResponse({ type: 5 });
    }
    return jsonResponse({ type: 4, data: { content: "Unknown command.", flags: 64 } });
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

async function discordApi(env, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${env.DISCORD_TOKEN.trim()}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://github.com/jedrek20005-byte/claude-test, 1.0)",
    },
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
    const invite = `https://discord.com/oauth2/authorize?client_id=${app.id}&scope=applications.commands`;
    return new Response(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<body style="font:18px sans-serif;padding:16px;line-height:1.5">` +
        `<p>✅ /uma is registered for <b>${escapeHtml(app.name)}</b>.</p>` +
        `<p>Next, add it to your server:</p>` +
        `<p><a href="${invite}" style="font-size:22px">Add to Discord</a></p></body>`,
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
    "",
    "Open /register on this address to register /uma and get the invite link.",
  ].join("\n");
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function answerUma(interaction) {
  const editUrl = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  try {
    const image = await pickImage();
    if (!image) {
      await editReply(editUrl, { content: "Couldn't find a picture right now, try again in a bit." });
      return;
    }
    const file = await downloadImage(image);
    if (file) {
      try {
        await editReply(editUrl, { embeds: [buildEmbed(image, `attachment://${file.name}`)] }, file);
        return;
      } catch (err) {
        console.error(`Upload failed, linking instead: ${err.message}`);
      }
    }
    await editReply(editUrl, { embeds: [buildEmbed(image, image.imageUrl)] });
  } catch (err) {
    console.error(err);
    await editReply(editUrl, { content: "Something went wrong, sorry." }).catch(() => {});
  }
}

async function editReply(url, payload, file) {
  let init;
  if (file) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ ...payload, attachments: [{ id: 0, filename: file.name }] }));
    form.append("files[0]", new Blob([file.data], { type: file.type }), file.name);
    init = { method: "PATCH", body: form };
  } else {
    init = { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Discord returned HTTP ${res.status}: ${await res.text()}`);
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

export async function pickImage(sources = SOURCES) {
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
      const safe = posts.filter(isSafe);
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

export function buildEmbed(image, imageUrl) {
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
    title: "🐴 Random Umamusume",
    url: image.pageUrl,
    description: lines.join("\n") || undefined,
    color: EMBED_COLOR,
    image: { url: imageUrl },
    footer: { text: `${image.source} · post #${image.id}` },
    timestamp: new Date().toISOString(),
  };
}
