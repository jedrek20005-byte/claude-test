// Run with: node --test warships-worker/worker.test.mjs
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import worker, {
  decodeEntities, htmlToText, matches, normalizeSource, parseFilter, parseRedditFeed, parseTelegramPage,
  parseYouTubeFeed, postMessage, runChecks, sourceKey,
} from "./worker.js";

const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");

function fakeKV(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  let writes = 0;
  return {
    json: (key) => (data.has(key) ? JSON.parse(data.get(key)) : null),
    writes: () => writes,
    async get(key, type) {
      if (!data.has(key)) return null;
      return type === "json" ? JSON.parse(data.get(key)) : data.get(key);
    },
    async put(key, value) {
      writes++;
      data.set(key, value);
    },
  };
}

const redditEntry = (id, title, extra = "") => `<entry><author><name>/u/sailor</name></author>
<content type="html">&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Body of ${title} &amp;amp; more&lt;/p&gt;&lt;/div&gt;${extra}
&amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/sailor&quot;&gt; /u/sailor &lt;/a&gt; &lt;a href=&quot;x&quot;&gt;[link]&lt;/a&gt;</content>
<id>t3_${id}</id><media:thumbnail url="https://b.thumbs.redditmedia.com/${id}.jpg" /><link href="https://www.reddit.com/r/ModernWarships/comments/${id}/x/" />
<updated>2026-11-07T15:00:00+00:00</updated><published>2026-11-07T14:59:00+00:00</published><title>${title}</title></entry>`;
const redditFeed = (...entries) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>newest submissions</title>${entries.join("")}</feed>`;

const YOUTUBE_FEED = `<?xml version="1.0"?><feed><title>MW News</title><author><name>MW News</name></author>
<entry><id>yt:video:abc123def45</id><yt:videoId>abc123def45</yt:videoId><title>NEW SHIP LEAKED! Season 30</title>
<link rel="alternate" href="https://www.youtube.com/watch?v=abc123def45"/><author><name>MW News</name></author>
<published>2026-11-07T12:00:00+00:00</published><media:group><media:thumbnail url="https://i1.ytimg.com/vi/abc123def45/hqdefault.jpg" width="480"/>
<media:description>All the leaks &amp; more</media:description></media:group></entry>
<entry><id>yt:video:old</id><yt:videoId>older000001</yt:videoId><title>Gameplay</title><author><name>MW News</name></author></entry></feed>`;

const telegramMessage = (n, text, photo = "") => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="mwleaks/${n}">
<div class="tgme_widget_message_author"><a class="tgme_widget_message_owner_name" href="https://t.me/mwleaks"><span dir="auto">MW Leaks</span></a></div>
${photo ? `<a class="tgme_widget_message_photo_wrap 1 1" href="https://t.me/mwleaks/${n}" style="width:800px;background-image:url('${photo}')"></a>` : ""}
<div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div>
<a class="tgme_widget_message_date" href="https://t.me/mwleaks/${n}"><time datetime="2026-11-07T10:0${n}:00+00:00" class="time">10:00</time></a></div></div>`;
const telegramPage = (...messages) => `<html><body>${messages.join("")}</body></html>`;

let calls;
let routes;
let kv;
let env;

beforeEach(() => {
  calls = [];
  kv = fakeKV();
  env = { DISCORD_PUBLIC_KEY: PUBLIC_KEY, DISCORD_TOKEN: "bot-token", LEAKS_STATE: kv };
  routes = {
    "www.reddit.com": () => new Response(redditFeed(redditEntry("aaa", "Old leak"))),
    "www.youtube.com": (url) => url.includes("/feeds/") ? new Response(YOUTUBE_FEED) : new Response('{"externalId":"UC1hDoirWXy7vdkuNUo4H_mQ"}'),
    "t.me": () => new Response(telegramPage(telegramMessage(1, "Hello"))),
    "discord.com": (url) => {
      if (url.endsWith("/applications/@me")) return Response.json({ id: "999", name: "MW Leaks" });
      if (url.endsWith("/commands")) return Response.json([]);
      return Response.json({ id: "1" });
    },
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const handler = routes[new URL(url).host];
    if (!handler) throw new TypeError(`unexpected fetch to ${url}`);
    return handler(url, init);
  };
});

const posts = () => calls.filter((c) => c.url.endsWith("/channels/555/messages") && c.init.method === "POST").map((c) => JSON.parse(c.init.body));
const edits = () => calls.filter((c) => c.url.includes("/messages/@original")).map((c) => JSON.parse(c.init.body));

async function signed(payload, { tamper = false } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body));
  return new Request("https://mwleaks.example.workers.dev/", {
    method: "POST",
    body: tamper ? body.replace("}", ',"x":1}') : body,
    headers: { "X-Signature-Ed25519": Buffer.from(signature).toString("hex"), "X-Signature-Timestamp": timestamp },
  });
}

const waits = [];
const ctx = { waitUntil: (promise) => waits.push(promise) };
async function run(request) {
  const response = await worker.fetch(request, env, ctx);
  await Promise.all(waits.splice(0));
  return response;
}
const command = (name, options = []) => ({
  type: 2, application_id: "999", token: "tok", guild_id: "777", channel_id: "555",
  member: { user: { id: "1" }, permissions: "32" }, data: { name, options },
});

// ---- Parsing ------------------------------------------------------------------------

test("entities and HTML become plain text", () => {
  assert.equal(decodeEntities("a &amp; b &#39;c&#x27; &quot;d&quot; &#32;"), "a & b 'c' \"d\"  ");
  assert.equal(htmlToText("<p>Line 1<br/>Line &amp; 2</p><p>Next</p>"), "Line 1\nLine & 2\nNext");
});

test("Reddit's feed gives the newest posts with title, body, link and picture", () => {
  const image = "&lt;a href=&quot;https://i.redd.it/pic1.png&quot;&gt;[link]&lt;/a&gt;";
  const [post] = parseRedditFeed(redditFeed(redditEntry("xyz", "Leak: new carrier &amp; jets", image)));
  assert.deepEqual(post, {
    id: "t3_xyz", title: "Leak: new carrier & jets", text: "Body of Leak: new carrier & jets & more",
    url: "https://www.reddit.com/r/ModernWarships/comments/xyz/x/", image: "https://i.redd.it/pic1.png",
    author: "/u/sailor", time: "2026-11-07T14:59:00+00:00",
  });
  assert.equal(parseRedditFeed(redditFeed(redditEntry("q", "No pic")))[0].image, "https://b.thumbs.redditmedia.com/q.jpg");
});

test("YouTube's feed gives each video, not the channel title", () => {
  const videos = parseYouTubeFeed(YOUTUBE_FEED);
  assert.equal(videos.length, 2);
  assert.deepEqual(videos[0], {
    id: "abc123def45", title: "NEW SHIP LEAKED! Season 30", text: "All the leaks & more",
    url: "https://www.youtube.com/watch?v=abc123def45", image: "https://i1.ytimg.com/vi/abc123def45/hqdefault.jpg",
    author: "MW News", time: "2026-11-07T12:00:00+00:00",
  });
});

test("Telegram's page gives the newest message first, with its photo", () => {
  const page = telegramPage(telegramMessage(1, "Old"), telegramMessage(2, "<b>LEAK</b> new frigate<br/>stats inside", "https://cdn.telegram.org/p.jpg"));
  const [post, older] = parseTelegramPage(page, "mwleaks");
  assert.deepEqual(post, {
    id: "mwleaks/2", title: "LEAK new frigate", text: "LEAK new frigate\nstats inside", url: "https://t.me/mwleaks/2",
    image: "https://cdn.telegram.org/p.jpg", author: "MW Leaks", time: "2026-11-07T10:02:00+00:00",
  });
  assert.equal(older.id, "mwleaks/1");
});

test("filters and source names", () => {
  assert.deepEqual(parseFilter(" Leak, LEAKED ,, "), ["leak", "leaked"]);
  assert.ok(matches({ title: "Big LEAK", text: "" }, ["leak"]));
  assert.ok(matches({ title: "Patch", text: "leaked ships" }, ["leak"]));
  assert.ok(!matches({ title: "Patch notes", text: "" }, ["leak"]));
  assert.ok(matches({ title: "Anything", text: "" }, []));
  assert.deepEqual(normalizeSource("reddit", "https://www.reddit.com/r/ModernWarships/new/"), { type: "reddit", name: "ModernWarships" });
  assert.deepEqual(normalizeSource("reddit", "r/ModernWarships"), { type: "reddit", name: "ModernWarships" });
  assert.deepEqual(normalizeSource("telegram", "https://t.me/s/mwleaks"), { type: "telegram", name: "mwleaks" });
  assert.deepEqual(normalizeSource("telegram", "@mwleaks"), { type: "telegram", name: "mwleaks" });
  assert.deepEqual(normalizeSource("telegram", "t.me/mwleaks"), { type: "telegram", name: "mwleaks" });
  assert.deepEqual(normalizeSource("reddit", "reddit.com/r/ModernWarships"), { type: "reddit", name: "ModernWarships" });
  assert.deepEqual(normalizeSource("youtube", "https://www.youtube.com/@MWNews/videos"), { type: "youtube", name: "@MWNews" });
  assert.deepEqual(normalizeSource("youtube", "https://youtube.com/channel/UC1hDoirWXy7vdkuNUo4H_mQ"),
    { type: "youtube", name: "UC1hDoirWXy7vdkuNUo4H_mQ", id: "UC1hDoirWXy7vdkuNUo4H_mQ" });
  assert.equal(normalizeSource("reddit", "not a sub!"), null);
  assert.equal(sourceKey({ type: "reddit", name: "ModernWarships" }), "reddit:modernwarships");
});

test("messages: YouTube as a bare link (Discord shows the player), others as embeds", () => {
  const video = postMessage({ type: "youtube", name: "@MWNews" }, parseYouTubeFeed(YOUTUBE_FEED)[0]);
  assert.equal(video.content, "▶️ **MW News** posted a new video: **NEW SHIP LEAKED! Season 30**\nhttps://www.youtube.com/watch?v=abc123def45");
  const [post] = parseRedditFeed(redditFeed(redditEntry("xyz", "Leak!")));
  const { embeds, allowed_mentions } = postMessage({ type: "reddit", name: "ModernWarships" }, post);
  assert.equal(embeds[0].author.name, "🟠 r/ModernWarships · /u/sailor");
  assert.equal(embeds[0].url, post.url);
  assert.equal(embeds[0].timestamp, "2026-11-07T14:59:00.000Z");
  assert.deepEqual(allowed_mentions, { parse: [] });
});

// ---- The timer ----------------------------------------------------------------------

const guildWith = (sources) => ({ 777: { enabled: true, channelId: "555", sources } });
const REDDIT = { type: "reddit", name: "ModernWarships", filter: "leak" };

test("the first check only remembers what's there; later ones post new matching posts, oldest first", async () => {
  kv = fakeKV({ guilds: guildWith([REDDIT]) });
  env.LEAKS_STATE = kv;
  await runChecks(env);
  assert.equal(posts().length, 0);
  assert.deepEqual(kv.json("state:777")["reddit:modernwarships"].seen, ["t3_aaa"]);

  routes["www.reddit.com"] = () => new Response(redditFeed(
    redditEntry("ccc", "Second LEAK"), redditEntry("bbb", "Patch notes"), redditEntry("bb2", "First leak"), redditEntry("aaa", "Old leak"),
  ));
  await runChecks(env);
  assert.deepEqual(posts().map((p) => p.embeds[0].title), ["First leak", "Second LEAK"]);
  assert.deepEqual(kv.json("state:777")["reddit:modernwarships"].seen, ["t3_ccc", "t3_bbb", "t3_bb2", "t3_aaa"]);

  calls = [];
  const writes = kv.writes();
  await runChecks(env);
  assert.equal(posts().length, 0); // nothing new
  assert.equal(kv.writes(), writes); // and no storage write
});

test("a failed post is retried, errors are remembered, and off servers are skipped", async () => {
  kv = fakeKV({ guilds: guildWith([REDDIT]), "state:777": { "reddit:modernwarships": { seen: [], primed: true } } });
  env.LEAKS_STATE = kv;
  routes["discord.com"] = () => Response.json({ message: "Missing Access" }, { status: 403 });
  await runChecks(env);
  const state = kv.json("state:777")["reddit:modernwarships"];
  assert.match(state.error, /can't post in the leaks channel \(HTTP 403\)/);
  assert.deepEqual(state.seen, []); // the leak wasn't posted, so it's tried again

  routes["discord.com"] = () => Response.json({ id: "1" });
  await runChecks(env);
  assert.equal(posts().length, 2); // the failed try and the successful one
  assert.equal(kv.json("state:777")["reddit:modernwarships"].error, null);

  routes["www.reddit.com"] = () => new Response("blocked", { status: 403 });
  await runChecks(env);
  assert.equal(kv.json("state:777")["reddit:modernwarships"].error, "HTTP 403 from www.reddit.com");

  calls = [];
  kv = fakeKV({ guilds: { 777: { enabled: false, channelId: "555", sources: [REDDIT] } } });
  env.LEAKS_STATE = kv;
  await runChecks(env);
  assert.equal(calls.length, 0);
});

test("a source watched by several servers is fetched once", async () => {
  kv = fakeKV({ guilds: { ...guildWith([REDDIT]), 888: { enabled: true, channelId: "556", sources: [REDDIT] } } });
  env.LEAKS_STATE = kv;
  await runChecks(env);
  assert.equal(calls.filter((c) => c.url.includes("reddit.com")).length, 1);
});

// ---- Commands -------------------------------------------------------------------------

test("rejects requests not signed by Discord, answers pings and registers commands", async () => {
  assert.equal((await run(await signed({ type: 1 }, { tamper: true }))).status, 401);
  assert.deepEqual(await (await run(await signed({ type: 1 }))).json(), { type: 1 });
  const put = calls.find((c) => c.init.method === "PUT");
  assert.ok(put.url.endsWith("/applications/999/commands"));
  const names = JSON.parse(put.init.body).map((c) => c.name);
  assert.deepEqual(names, ["leaks_here", "leaks_add", "leaks_remove", "leaks_list", "leaks_test", "leaks_off"]);
  assert.ok(JSON.parse(put.init.body).every((c) => c.default_member_permissions === "32"));
  const page = await (await run(new Request("https://mwleaks.example.workers.dev/register"))).text();
  assert.match(page, /client_id=999&scope=bot\+applications\.commands&permissions=19456/);
});

test("/leaks_here starts with r/ModernWarships leaks; /leaks_off pauses", async () => {
  const { data } = await (await run(await signed(command("leaks_here")))).json();
  assert.equal(data.flags, 64);
  assert.match(data.content, /post new leaks in <#555>/);
  assert.match(data.content, /r\/ModernWarships\*\* \(only: leak, leaks, leaked\)/);
  assert.deepEqual(kv.json("guilds")["777"], { enabled: true, channelId: "555", sources: [{ type: "reddit", name: "ModernWarships", filter: "leak, leaks, leaked" }] });
  await run(await signed(command("leaks_off")));
  assert.equal(kv.json("guilds")["777"].enabled, false);
  assert.equal(kv.json("guilds")["777"].sources.length, 1);
});

test("/leaks_add checks the source first and saves YouTube channels by their ID", async () => {
  const response = await run(await signed(command("leaks_add", [
    { name: "source", value: "youtube" }, { name: "name", value: "@MWNews" }, { name: "filter", value: "leak" },
  ])));
  assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
  assert.match(edits()[0].content, /Added ▶️ \*\*YouTube @MWNews\*\* \(only: leak\)/);
  assert.match(edits()[0].content, /Newest matching post: \*\*NEW SHIP LEAKED! Season 30\*\*/);
  assert.deepEqual(kv.json("guilds")["777"].sources, [{ type: "youtube", name: "@MWNews", filter: "leak", id: "UC1hDoirWXy7vdkuNUo4H_mQ" }]);

  calls = [];
  routes["t.me"] = () => new Response("nope", { status: 404 });
  await run(await signed(command("leaks_add", [{ name: "source", value: "telegram" }, { name: "name", value: "t.me/missing_channel" }])));
  assert.match(edits()[0].content, /couldn't read t\.me\/missing_channel \(HTTP 404 from t\.me\), so I didn't add it/);
  assert.equal(kv.json("guilds")["777"].sources.length, 1);

  const bad = (await (await run(await signed(command("leaks_add", [{ name: "source", value: "reddit" }, { name: "name", value: "no spaces allowed" }])))).json()).data;
  assert.match(bad.content, /doesn't look like a Reddit name/);
});

test("/leaks_list shows each source's status; /leaks_remove autocompletes and removes", async () => {
  kv = fakeKV({
    guilds: guildWith([REDDIT, { type: "telegram", name: "mwleaks" }]),
    "state:777": { "reddit:modernwarships": { seen: [], primed: true, error: "HTTP 403 from www.reddit.com" } },
  });
  env.LEAKS_STATE = kv;
  const list = (await (await run(await signed(command("leaks_list")))).json()).data.content;
  assert.match(list, /posting \*\*on\*\*/);
  assert.match(list, /r\/ModernWarships\*\* \(only: leak\) · ⚠️ HTTP 403 from www\.reddit\.com/);
  assert.match(list, /t\.me\/mwleaks\*\* \(everything\) · ⏳ first check soon/);

  const typing = { ...command("leaks_remove", [{ name: "name", value: "t.me", focused: true }]), type: 4 };
  assert.deepEqual(await (await run(await signed(typing))).json(), { type: 8, data: { choices: [{ name: "t.me/mwleaks", value: "telegram:mwleaks" }] } });
  const removed = (await (await run(await signed(command("leaks_remove", [{ name: "name", value: "telegram:mwleaks" }])))).json()).data.content;
  assert.match(removed, /stopped watching t\.me\/mwleaks/);
  assert.deepEqual(kv.json("guilds")["777"].sources, [REDDIT]);
});

test("/leaks_test posts the newest matching post from each source", async () => {
  kv = fakeKV({ guilds: guildWith([REDDIT, { type: "telegram", name: "mwleaks", filter: "frigate" }]) });
  env.LEAKS_STATE = kv;
  await run(await signed(command("leaks_test")));
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].embeds[0].title, "Old leak");
  assert.match(edits()[0].content, /r\/ModernWarships: posted ✅\nt\.me\/mwleaks: no matching posts right now/);
});
