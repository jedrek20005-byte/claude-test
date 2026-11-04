// Run with: node --test discord-worker/
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import worker, {
  buildDeck, buildEmbed, clearCardCache, clubSummary, deckEmbed, describeSchedule, formatFans, isSafe, localNow,
  makeCardsToken, monthlyDue, parseFans, parseTime, pickImage, postTimes, prettyCharacter, readCardsToken, runSchedule,
} from "./worker.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const DANBOORU_POSTS = [
  { id: 1, rating: "e", file_url: "https://cdn.donmai.us/original/1.png", tag_string: "umamusume" },
  { id: 2, rating: "g", file_url: "https://cdn.donmai.us/original/2.png", tag_string: "umamusume school_swimsuit" },
  { id: 3, rating: "g", file_url: "https://cdn.donmai.us/original/3.mp4", tag_string: "umamusume" },
  {
    id: 4,
    rating: "g",
    score: 12,
    file_url: "https://cdn.donmai.us/original/4.png",
    large_file_url: "https://cdn.donmai.us/sample/sample-4.jpg",
    tag_string: "umamusume special_week_(umamusume) smile",
    tag_string_artist: "some_artist",
    tag_string_character: "special_week_(umamusume)",
    source: "https://i.pximg.net/img-original/img/2024/01/01/00/00/00/111222333_p0.png",
  },
];

const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
const ENV = { DISCORD_PUBLIC_KEY: PUBLIC_KEY, DISCORD_TOKEN: "bot-token" };

let calls;
let routes;

beforeEach(() => {
  calls = [];
  routes = {
    "danbooru.donmai.us": () => Response.json(DANBOORU_POSTS),
    "safebooru.org": () => new Response(""),
    "konachan.net": () => Response.json([]),
    "cdn.donmai.us": () => new Response(PNG, { headers: { "Content-Type": "image/jpeg" } }),
    "discord.com": (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/applications/@me")) return Response.json({ id: "4242", name: "Uma Bot" });
      if (path.endsWith("/commands")) return Response.json([]);
      if (/\/channels\/\d+$/.test(path)) return Response.json({ id: path.split("/").pop() });
      return new Response(null, { status: 200 });
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

async function signedRequest(payload, { tamper = false } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body));
  return new Request("https://uma.example.workers.dev/", {
    method: "POST",
    body: tamper ? body.replace("}", ',"x":1}') : body,
    headers: { "X-Signature-Ed25519": Buffer.from(signature).toString("hex"), "X-Signature-Timestamp": timestamp },
  });
}

async function run(request, env = ENV) {
  const pending = [];
  const response = await worker.fetch(request, env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  return response;
}

const UMA = { type: 2, application_id: "4242", token: "interaction-token", data: { name: "uma" } };
const editCalls = () => calls.filter((c) => c.url.includes("/webhooks/4242/interaction-token/messages/@original"));

test("rejects requests that aren't signed by Discord", async () => {
  assert.equal((await run(await signedRequest({ type: 1 }, { tamper: true }))).status, 401);
  assert.equal((await run(new Request("https://x/", { method: "POST", body: "{}" }))).status, 401);
  assert.equal((await run(await signedRequest({ type: 1 }), { ...ENV, DISCORD_PUBLIC_KEY: "zz" })).status, 401);
});

test("answers Discord's ping and registers /uma", async () => {
  const response = await run(await signedRequest({ type: 1 }));
  assert.deepEqual(await response.json(), { type: 1 });
  const put = calls.find((c) => c.init.method === "PUT");
  assert.ok(put.url.endsWith("/applications/4242/commands"));
  assert.equal(put.init.headers.Authorization, "Bot bot-token");
  const commands = JSON.parse(put.init.body);
  assert.deepEqual(commands.map((c) => c.name), [
    "uma", "uma_here", "uma_every", "uma_time", "uma_off", "uma_status", "uma_say", "uma_monthly", "uma_monthly_off",
    "uma_cards", "uma_deck", "uma_fans", "uma_quota", "uma_summary",
  ]);
  assert.equal(commands.find((c) => c.name === "uma_quota").default_member_permissions, "32");
  assert.equal(commands.find((c) => c.name === "uma_fans").default_member_permissions, undefined); // for everyone
  for (const command of commands.slice(1, 9)) {
    assert.equal(command.default_member_permissions, "32"); // Manage Server
    assert.deepEqual(command.contexts, [0]); // servers only
  }
  const timezone = commands.find((c) => c.name === "uma_time").options[1];
  assert.ok(timezone.choices.length <= 25 && timezone.choices.some((c) => c.value === "Europe/Warsaw"));
});

test("/uma defers, then edits in a safe picture as an upload", async () => {
  const response = await run(await signedRequest(UMA));
  assert.deepEqual(await response.json(), { type: 5 });

  const [edit] = editCalls();
  assert.equal(edit.init.method, "PATCH");
  const payload = JSON.parse(edit.init.body.get("payload_json"));
  const [embed] = payload.embeds;
  assert.equal(embed.url, "https://danbooru.donmai.us/posts/4"); // the only safe post
  assert.equal(embed.image.url, "attachment://umamusume_danbooru_4.jpg");
  assert.match(embed.description, /Special Week/);
  assert.match(embed.description, /pixiv\.net\/artworks\/111222333/);
  assert.deepEqual(payload.attachments, [{ id: 0, filename: "umamusume_danbooru_4.jpg" }]);
  const file = edit.init.body.get("files[0]");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), PNG);
  // The smaller sample is downloaded, with the post page as referer.
  const download = calls.find((c) => c.url.includes("cdn.donmai.us"));
  assert.ok(download.url.includes("sample-4.jpg"));
  assert.equal(download.init.headers.Referer, "https://danbooru.donmai.us/posts/4");
});

test("/uma links the image when it can't be downloaded", async () => {
  routes["cdn.donmai.us"] = () => new Response("<html>blocked</html>", { headers: { "Content-Type": "text/html" } });
  await run(await signedRequest(UMA));
  const [edit] = editCalls();
  const payload = JSON.parse(edit.init.body);
  assert.equal(payload.embeds[0].image.url, "https://cdn.donmai.us/original/4.png");
});

test("/uma falls back to linking when Discord rejects the upload", async () => {
  routes["discord.com"] = (url, init) =>
    init.body instanceof FormData ? new Response("too big", { status: 413 }) : new Response(null, { status: 200 });
  await run(await signedRequest(UMA));
  const [upload, link] = editCalls();
  assert.ok(upload.init.body instanceof FormData);
  assert.equal(JSON.parse(link.init.body).embeds[0].image.url, "https://cdn.donmai.us/original/4.png");
});

test("/uma says so when no site has a picture", async () => {
  routes["danbooru.donmai.us"] = () => new Response("down", { status: 503 });
  await run(await signedRequest(UMA));
  const [edit] = editCalls();
  assert.match(JSON.parse(edit.init.body).content, /Couldn't find a picture/);
});

test("unknown commands get a private reply", async () => {
  const response = await run(await signedRequest({ ...UMA, data: { name: "other" } }));
  assert.equal((await response.json()).data.flags, 64);
});

test("status and register pages", async () => {
  const status = await (await run(new Request("https://x/"), { DISCORD_PUBLIC_KEY: "ab" })).text();
  assert.match(status, /✅ DISCORD_PUBLIC_KEY is set/);
  assert.match(status, /❌ DISCORD_TOKEN is missing/);

  const page = await (await run(new Request("https://x/register"))).text();
  assert.match(page, /client_id=4242&amp;scope=bot\+applications\.commands&amp;permissions=52224|client_id=4242&scope=bot\+applications\.commands&permissions=52224/);
  assert.match(page, /Uma Bot/);

  const failed = await run(new Request("https://x/register"), { DISCORD_PUBLIC_KEY: "ab" });
  assert.equal(failed.status, 500);
  assert.match(await failed.text(), /DISCORD_TOKEN secret is not set/);
});

test("safety filter", () => {
  const base = { rating: 0, imageUrl: "https://x/a.png", tags: ["umamusume"], score: 1 };
  assert.ok(isSafe(base));
  assert.ok(!isSafe({ ...base, rating: 1 }));
  assert.ok(!isSafe({ ...base, tags: ["Swimsuit"] }));
  assert.ok(!isSafe({ ...base, tags: ["frilled_bikini"] }));
  assert.ok(!isSafe({ ...base, imageUrl: "https://x/a.webm" }));
  assert.ok(!isSafe({ ...base, imageUrl: "not a url" }));
  assert.ok(!isSafe({ ...base, score: -3 }));
  assert.ok(isSafe({ ...base, score: null }));
});

test("character names", () => {
  assert.equal(prettyCharacter("special_week_(umamusume)"), "Special Week");
  assert.equal(prettyCharacter("t.m._opera_o_(umamusume)"), "T.M. Opera O");
  assert.equal(prettyCharacter("rice_shower_(make_up_vampire!)_(umamusume)"), "Rice Shower (Make Up Vampire!)");
});

test("pickImage skips broken sources", async () => {
  const broken = { name: "Broken", pages: 1, fetchPage: async () => { throw new Error("down"); } };
  const empty = { name: "Empty", pages: 3, fetchPage: async () => [] };
  const good = {
    name: "Good",
    pages: 1,
    fetchPage: async () => [{ rating: 0, imageUrl: "https://x/a.png", tags: [], score: null, id: "9" }],
  };
  for (let i = 0; i < 10; i++) {
    assert.equal((await pickImage([broken, empty, good])).id, "9");
  }
  assert.equal(await pickImage([broken, empty]), null);
});

test("embed without metadata", () => {
  const embed = buildEmbed(
    { source: "Konachan", id: "5", pageUrl: "https://k/5", characters: [], artists: [], sourceUrl: null },
    "https://k/5.png",
  );
  assert.equal(embed.description, undefined);
  assert.equal(embed.footer.text, "Konachan · post #5");
});

// ---- Settings commands and the daily picture -------------------------------

function fakeKV(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const meta = new Map();
  return {
    data,
    meta,
    json: (key) => (data.has(key) ? JSON.parse(data.get(key)) : null),
    async get(key, type) {
      if (!data.has(key)) return null;
      return type === "json" ? JSON.parse(data.get(key)) : data.get(key);
    },
    async put(key, value, options = {}) {
      data.set(key, value);
      if (options.metadata) meta.set(key, options.metadata);
    },
    async list({ prefix = "" } = {}) {
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix)).sort();
      return { keys: keys.map((name) => ({ name, metadata: meta.get(name) })), list_complete: true };
    },
  };
}

const command = (name, options) => ({
  type: 2, application_id: "4242", token: "interaction-token", guild_id: "777", channel_id: "555",
  data: { name, ...(options ? { options } : {}) },
});

test("settings commands need the KV binding", async () => {
  const data = (await (await run(await signedRequest(command("uma_status")))).json()).data;
  assert.match(data.content, /UMA_STATE/);
  assert.equal(data.flags, 64);
});

test("/uma_time saves the time and time zone", async () => {
  const kv = fakeKV();
  const env = { ...ENV, UMA_STATE: kv };
  const options = [{ name: "time", value: "9" }, { name: "timezone", value: "Europe/Warsaw" }];
  const { data } = await (await run(await signedRequest(command("uma_time", options)), env)).json();
  assert.match(data.content, /\*\*09:00\*\* \(Europe\/Warsaw\)/);
  assert.match(data.content, /uma_here/); // no channel yet
  assert.deepEqual(kv.json("guilds")["777"], {
    enabled: false, channelId: null, time: "09:00", timeZone: "Europe/Warsaw", everyHours: 24,
    lastPost: null, lastError: null, retryAfter: 0,
  });

  // Changing only the time keeps the time zone.
  await run(await signedRequest(command("uma_time", [{ name: "time", value: "21:30" }])), env);
  assert.equal(kv.json("guilds")["777"].time, "21:30");
  assert.equal(kv.json("guilds")["777"].timeZone, "Europe/Warsaw");

  for (const bad of [[{ name: "time", value: "25:00" }], [{ name: "time", value: "9:00" }, { name: "timezone", value: "Mars/Base" }]]) {
    const reply = (await (await run(await signedRequest(command("uma_time", bad)), env)).json()).data;
    assert.equal(reply.flags, 64);
  }
  assert.equal(kv.json("guilds")["777"].time, "21:30");
});

test("/uma_here turns on the daily picture for this channel", async () => {
  const kv = fakeKV({ guilds: { 777: { time: "09:00", timeZone: "Europe/Warsaw" } } });
  const response = await run(await signedRequest(command("uma_here")), { ...ENV, UMA_STATE: kv });
  assert.deepEqual(await response.json(), { type: 5 });
  const check = calls.find((c) => c.url.endsWith("/channels/555"));
  assert.equal(check.init.headers.Authorization, "Bot bot-token");
  const settings = kv.json("guilds")["777"];
  assert.equal(settings.enabled, true);
  assert.equal(settings.channelId, "555");
  assert.match(JSON.parse(editCalls()[0].init.body).content, /every day at \*\*09:00\*\* \(Europe\/Warsaw\)/);
});

test("/uma_here explains how to add the bot when it can't see the channel", async () => {
  const kv = fakeKV();
  routes["discord.com"] = (url) =>
    url.endsWith("/channels/555") ? Response.json({ message: "Missing Access" }, { status: 403 }) : new Response(null);
  await run(await signedRequest(command("uma_here")), { ...ENV, UMA_STATE: kv });
  const content = JSON.parse(editCalls()[0].init.body).content;
  assert.match(content, /scope=bot\+applications\.commands&permissions=52224/);
  assert.equal(kv.json("guilds"), null);
});

test("/uma_off and /uma_status", async () => {
  const kv = fakeKV({ guilds: { 777: { enabled: true, channelId: "555", lastPost: "2026-11-03 12:00", lastError: "HTTP 403" } } });
  const env = { ...ENV, UMA_STATE: kv };
  let { data } = await (await run(await signedRequest(command("uma_status")), env)).json();
  assert.match(data.content, /Scheduled pictures: on/);
  assert.match(data.content, /<#555>/);
  assert.match(data.content, /Last picture: 2026-11-03 12:00/);
  assert.match(data.content, /Last problem: HTTP 403/);
  assert.equal(data.flags, 64);

  await run(await signedRequest(command("uma_off")), env);
  assert.equal(kv.json("guilds")["777"].enabled, false);
  ({ data } = await (await run(await signedRequest(command("uma_status")), env)).json());
  assert.match(data.content, /Scheduled pictures: off/);
});

const dailyCalls = () => calls.filter((c) => c.url.endsWith("/channels/555/messages"));

test("the daily picture is posted once, after the set time", async () => {
  const kv = fakeKV({ guilds: { 777: { enabled: true, channelId: "555", time: "09:00", timeZone: "Europe/Warsaw" } } });
  const env = { ...ENV, UMA_STATE: kv };

  await runSchedule(env, new Date("2026-11-03T07:55:00Z")); // 08:55 in Warsaw
  assert.equal(dailyCalls().length, 0);

  await runSchedule(env, new Date("2026-11-03T08:05:00Z")); // 09:05 in Warsaw
  const [post] = dailyCalls();
  assert.equal(post.init.method, "POST");
  assert.equal(post.init.headers.Authorization, "Bot bot-token");
  const embed = JSON.parse(post.init.body.get("payload_json")).embeds[0];
  assert.equal(embed.title, "🐴 Umamusume of the Day");
  assert.equal(embed.url, "https://danbooru.donmai.us/posts/4");
  assert.equal(kv.json("guilds")["777"].lastPost, "2026-11-03 09:00");
  assert.ok(kv.json("history").includes("Danbooru:4"));

  await runSchedule(env, new Date("2026-11-03T15:00:00Z")); // later the same day
  assert.equal(dailyCalls().length, 1);
});

test("a failed daily picture is retried after 30 minutes", async () => {
  const kv = fakeKV({ guilds: { 777: { enabled: true, channelId: "555", time: "09:00", timeZone: "UTC" } } });
  const env = { ...ENV, UMA_STATE: kv };
  routes["discord.com"] = () => Response.json({ message: "Missing Permissions" }, { status: 403 });

  await runSchedule(env, new Date("2026-11-03T09:00:00Z"));
  let settings = kv.json("guilds")["777"];
  assert.match(settings.lastError, /403/);
  assert.equal(settings.lastPost, null);
  const attempts = dailyCalls().length;

  await runSchedule(env, new Date("2026-11-03T09:10:00Z"));
  assert.equal(dailyCalls().length, attempts); // waiting

  routes["discord.com"] = () => new Response(null, { status: 200 });
  await runSchedule(env, new Date("2026-11-03T09:31:00Z"));
  settings = kv.json("guilds")["777"];
  assert.equal(settings.lastPost, "2026-11-03 09:00");
  assert.equal(settings.lastError, null);
});

test("paused or unset servers get no daily picture", async () => {
  const kv = fakeKV({ guilds: { 1: { enabled: false, channelId: "555" }, 2: { enabled: true, channelId: null } } });
  await runSchedule({ ...ENV, UMA_STATE: kv }, new Date("2026-11-03T23:00:00Z"));
  assert.equal(calls.length, 0);
});

test("/uma doesn't repeat posted pictures", async () => {
  const kv = fakeKV({ history: ["Danbooru:4"] }); // the only safe post in the fixture
  await run(await signedRequest(UMA), { ...ENV, UMA_STATE: kv });
  assert.match(JSON.parse(editCalls()[0].init.body).content, /Couldn't find a picture/);
});

test("time helpers", () => {
  assert.equal(parseTime("9"), "09:00");
  assert.equal(parseTime("9:05"), "09:05");
  assert.equal(parseTime("21.30"), "21:30");
  assert.equal(parseTime("24:00"), null);
  assert.equal(parseTime("noon"), null);
  // Warsaw switches from summer time (UTC+2) to winter time (UTC+1) on 2026-10-25.
  assert.deepEqual(localNow(new Date("2026-10-24T07:00:00Z"), "Europe/Warsaw"), { day: "2026-10-24", time: "09:00" });
  assert.deepEqual(localNow(new Date("2026-10-26T08:00:00Z"), "Europe/Warsaw"), { day: "2026-10-26", time: "09:00" });
  assert.deepEqual(localNow(new Date("2026-11-03T23:30:00Z"), "Europe/Warsaw"), { day: "2026-11-04", time: "00:30" });
});

test("/uma_every sets how often pictures are posted", async () => {
  const kv = fakeKV({ guilds: { 777: { enabled: true, channelId: "555", time: "09:30", timeZone: "Europe/Warsaw" } } });
  const env = { ...ENV, UMA_STATE: kv };
  let { data } = await (await run(await signedRequest(command("uma_every", [{ name: "hours", value: 1 }])), env)).json();
  assert.match(data.content, /every hour at \*\*:30\*\* \(Europe\/Warsaw\)/);
  assert.doesNotMatch(data.content, /uma_here/); // already has a channel
  assert.equal(kv.json("guilds")["777"].everyHours, 1);

  ({ data } = await (await run(await signedRequest(command("uma_every", [{ name: "hours", value: 5 }])), env)).json());
  assert.equal(data.flags, 64); // not one of the choices
  assert.equal(kv.json("guilds")["777"].everyHours, 1);
});

test("hourly pictures are posted once per hour", async () => {
  // Every picture must be new, so serve a different post id on every request.
  let id = 100;
  routes["danbooru.donmai.us"] = () =>
    Response.json([{ id: ++id, rating: "g", file_url: `https://cdn.donmai.us/original/${id}.png`, tag_string: "umamusume" }]);
  const kv = fakeKV({ guilds: { 777: { enabled: true, channelId: "555", time: "09:00", timeZone: "UTC", everyHours: 1 } } });
  const env = { ...ENV, UMA_STATE: kv };
  for (const time of ["08:59", "09:00", "09:05", "09:55", "10:00", "10:30", "13:20"]) {
    await runSchedule(env, new Date(`2026-11-03T${time}:00Z`));
  }
  // Posts at 08:59 (the 08:00 slot), 09:00, 10:00 and 13:20 (the 13:00 slot).
  assert.equal(dailyCalls().length, 4);
  assert.equal(kv.json("guilds")["777"].lastPost, "2026-11-03 13:00");
  const titles = dailyCalls().map((c) => JSON.parse(c.init.body.get("payload_json")).embeds[0].title);
  assert.ok(titles.every((title) => title === "🐴 Umamusume of the Hour"));
  assert.equal(new Set(kv.json("history")).size, 4); // four different pictures
});

test("schedule helpers", () => {
  assert.deepEqual(postTimes({ time: "09:00", everyHours: 6 }), ["03:00", "09:00", "15:00", "21:00"]);
  assert.deepEqual(postTimes({ time: "21:30", everyHours: 24 }), ["21:30"]);
  assert.equal(postTimes({ time: "09:15", everyHours: 1 }).length, 24);
  assert.deepEqual(postTimes({ time: "00:00", everyHours: 8 }), ["00:00", "08:00", "16:00"]);
  assert.equal(describeSchedule({ time: "09:00", timeZone: "UTC", everyHours: 24 }), "every day at **09:00** (UTC)");
  assert.equal(describeSchedule({ time: "09:15", timeZone: "UTC", everyHours: 1 }), "every hour at **:15** (UTC)");
  assert.equal(
    describeSchedule({ time: "09:00", timeZone: "UTC", everyHours: 6 }),
    "every 6 hours, at **03:00, 09:00, 15:00, 21:00** (UTC)",
  );
  assert.equal(describeSchedule({ time: "09:00", timeZone: "UTC", everyHours: 2 }), "every 2 hours, at **01:00, 03:00, 05:00…** (UTC)");
});

// ---- Deck builder ------------------------------------------------------------

const CARD = (id, character, rarity, fans, race, extra = {}) => ({
  id, character, rarity, type: "Speed", title: `Title ${id}`, levels: [30, 35, 40, 45, 50],
  effects: { ...(fans ? { "Fan Bonus": fans } : {}), ...(race ? { "Race Bonus": race } : {}), ...extra },
});
const CARDS = [
  CARD(30028, "Kitasan Black", "SSR", [10, 11, 13, 15, 15], [5, 5, 5, 5, 5]),
  CARD(20023, "Kitasan Black", "SR", [5, 5, 5, 5, 5], [3, 3, 3, 3, 3]), // same character: only the better one
  CARD(30016, "Mejiro Ryan", "SSR", [15, 16, 17, 18, 20], [5, 6, 7, 8, 10]),
  CARD(30043, "Gold Ship", "SSR", [0, 0, 0, 10, 15], [0, 0, 0, 5, 10]),
  CARD(30065, "Zenno Rob Roy", "SSR", [10, 11, 12, 13, 15], [5, 5, 5, 5, 5]),
  CARD(20013, "Nice Nature", "SR", [10, 10, 10, 10, 10], null),
  CARD(10050, "Haru Urara", "R", [5, 5, 5, 5, 5], [5, 5, 5, 5, 5]),
  CARD(30001, "Special Week", "SSR", null, null, { "Friendship Bonus": [20, 20, 20, 20, 20] }),
];
const BY_ID = new Map(CARDS.map((card) => [String(card.id), card]));

test("buildDeck picks the best card per character, top five", () => {
  const owned = { 30028: 4, 20023: 4, 30016: 2, 30043: 0, 30065: 4, 20013: 4, 10050: 4, 30001: 4 };
  const deck = buildDeck(owned, BY_ID, "fans");
  assert.deepEqual(deck.map((e) => [e.card.id, e.primary, e.secondary]), [
    [30016, 17, 7], [30028, 15, 5], [30065, 15, 5], [20013, 10, 0], [10050, 5, 5],
  ]);
  // Gold Ship at LB0 has nothing yet, the SR Kitasan Black loses to the SSR, Special Week has neither bonus.

  // For Race Bonus, a card with only Fan Bonus still fills the last slot rather than leaving it empty.
  const race = buildDeck(owned, BY_ID, "race");
  assert.deepEqual(race.map((e) => [e.card.id, e.primary, e.secondary]), [
    [30016, 7, 17], [30028, 5, 15], [30065, 5, 15], [10050, 5, 5], [20013, 0, 10],
  ]);
});

test("deck embed shows each card and the totals", () => {
  const deck = buildDeck({ 30016: 4, 30028: 3 }, BY_ID, "fans");
  const embed = deckEmbed("fans", deck);
  assert.match(embed.title, /most fans/);
  // Names are escaped for Discord markdown, which still shows them as "[Title 30016]".
  assert.match(embed.description, /1\. SSR \\\[Title 30016\\\] Mejiro Ryan\*\* · LB4\nFan Bonus \+20% · Race Bonus \+10%/);
  assert.match(embed.description, /Total: Fan Bonus \+35% · Race Bonus \+15%/);
  assert.match(embed.description, /Only 2 of your cards help here/);
  assert.match(embed.footer.text, /borrow a friend's card/);
});

test("card box links are signed, personal and expire", async () => {
  const now = Date.UTC(2026, 10, 4);
  const token = await makeCardsToken(ENV, "123456789", now);
  assert.equal(await readCardsToken(ENV, token, now), "123456789");
  assert.equal(await readCardsToken(ENV, token, now + 31 * 24 * 3600 * 1000), null); // expired
  assert.equal(await readCardsToken(ENV, token.replace("123456789", "987654321"), now), null); // someone else
  assert.equal(await readCardsToken({ ...ENV, DISCORD_TOKEN: "other" }, token, now), null); // different key
  assert.equal(await readCardsToken(ENV, "garbage", now), null);
});

const asUser = (name, options) => ({ ...command(name, options), member: { user: { id: "123456789" } } });

test("/uma_cards replies privately with a personal link", async () => {
  const kv = fakeKV({ "cards:123456789": { 30028: 4, 30016: 2 } });
  const { data } = await (await run(await signedRequest(asUser("uma_cards")), { ...ENV, UMA_STATE: kv })).json();
  assert.equal(data.flags, 64);
  assert.match(data.content, /\*\*2\*\* cards saved/);
  const url = new URL(data.components[0].components[0].url);
  assert.equal(url.origin + url.pathname, "https://uma.example.workers.dev/cards");
  assert.equal(await readCardsToken(ENV, url.searchParams.get("t")), "123456789");
});

test("card box page and save API", async () => {
  const kv = fakeKV();
  const env = { ...ENV, UMA_STATE: kv };
  const token = await makeCardsToken(env, "123456789");
  const at = (path) => `https://uma.example.workers.dev${path}?t=${encodeURIComponent(token)}`;

  const page = await run(new Request(at("/cards")), env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /raw\.githubusercontent\.com\/.*support-cards\.json/);
  assert.equal((await run(new Request("https://uma.example.workers.dev/cards?t=nope"), env)).status, 401);

  const save = (cards) => run(new Request(at("/cards/mine"), { method: "POST", body: JSON.stringify({ cards }) }), env);
  assert.deepEqual(await (await save({ 30028: 4, 30016: 0 })).json(), { ok: true, count: 2 });
  assert.deepEqual(kv.json("cards:123456789"), { 30028: 4, 30016: 0 });
  assert.deepEqual(await (await run(new Request(at("/cards/mine")), env)).json(), { cards: { 30028: 4, 30016: 0 } });

  for (const bad of [{ 30028: 5 }, { 30028: "4" }, { "../x": 1 }, null]) {
    assert.equal((await save(bad)).status, 400);
  }
  assert.deepEqual(kv.json("cards:123456789"), { 30028: 4, 30016: 0 });
  const forged = new Request("https://uma.example.workers.dev/cards/mine?t=1.9999999999.abc", { method: "POST", body: "{}" });
  assert.equal((await run(forged, env)).status, 401);
});

test("/uma_deck builds a deck from the saved cards", async () => {
  clearCardCache();
  routes["raw.githubusercontent.com"] = () => Response.json({ cards: CARDS });
  const kv = fakeKV({ "cards:123456789": { 30016: 4, 30028: 4, 20023: 4 } });
  const response = await run(await signedRequest(asUser("uma_deck", [{ name: "goal", value: "fans" }])), { ...ENV, UMA_STATE: kv });
  assert.deepEqual(await response.json(), { type: 5 });
  const [embed] = JSON.parse(editCalls()[0].init.body).embeds;
  assert.match(embed.description, /Mejiro Ryan[\s\S]*Kitasan Black/);
  assert.doesNotMatch(embed.description, /SR \[Title 20023\]/);
});

test("/uma_deck without saved cards points to /uma_cards", async () => {
  await run(await signedRequest(asUser("uma_deck")), { ...ENV, UMA_STATE: fakeKV() });
  assert.match(JSON.parse(editCalls()[0].init.body).content, /uma_cards/);
});

// ---- /uma_say ------------------------------------------------------------------

const sentMessages = () => calls.filter((c) => /\/channels\/\d+\/messages$/.test(c.url) && c.init.method === "POST");

test("/uma_say with a message posts it as the app, privately confirming", async () => {
  const response = await run(await signedRequest(asUser("uma_say", [{ name: "message", value: "Hello @everyone!" }])));
  assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
  const [sent] = sentMessages();
  assert.ok(sent.url.endsWith("/channels/555/messages"));
  assert.equal(sent.init.headers.Authorization, "Bot bot-token");
  assert.deepEqual(JSON.parse(sent.init.body), { content: "Hello @everyone!", allowed_mentions: { parse: ["users"] } });
  assert.match(JSON.parse(editCalls()[0].init.body).content, /Sent in <#555>/);
});

test("/uma_say can post in another channel", async () => {
  const options = [{ name: "message", value: "News!" }, { name: "channel", value: "999" }];
  await run(await signedRequest(asUser("uma_say", options)));
  assert.ok(sentMessages()[0].url.endsWith("/channels/999/messages"));
});

test("/uma_say without a message opens a box, and its answer gets posted", async () => {
  const opened = await (await run(await signedRequest(asUser("uma_say", [{ name: "channel", value: "999" }])))).json();
  assert.equal(opened.type, 9);
  assert.match(opened.data.custom_id, /^uma_say:999:[\w-]{22}$/);
  assert.equal(opened.data.components[0].components[0].style, 2); // multi-line
  assert.equal(sentMessages().length, 0);

  const submit = {
    type: 5, application_id: "4242", token: "interaction-token", guild_id: "777", channel_id: "555",
    member: { user: { id: "123456789" } },
    data: { custom_id: opened.data.custom_id, components: [{ type: 1, components: [{ custom_id: "text", value: "Line 1\nLine 2" }] }] },
  };
  assert.deepEqual(await (await run(await signedRequest(submit))).json(), { type: 5, data: { flags: 64 } });
  const [sent] = sentMessages();
  assert.ok(sent.url.endsWith("/channels/999/messages"));
  assert.equal(JSON.parse(sent.init.body).content, "Line 1\nLine 2");

  // A box for someone else, or a changed channel, isn't accepted.
  calls = [];
  for (const forged of [
    { ...submit, member: { user: { id: "1" } } },
    { ...submit, data: { ...submit.data, custom_id: opened.data.custom_id.replace(":999:", ":888:") } },
  ]) {
    await run(await signedRequest(forged));
  }
  assert.equal(sentMessages().length, 0);
  assert.match(JSON.parse(editCalls()[0].init.body).content, /didn't come from/);
});

test("/uma_say explains when it can't post in the channel", async () => {
  routes["discord.com"] = (url, init) =>
    url.endsWith("/messages") && init.method === "POST"
      ? Response.json({ message: "Missing Permissions" }, { status: 403 })
      : new Response(null);
  await run(await signedRequest(asUser("uma_say", [{ name: "message", value: "hi" }])));
  assert.match(JSON.parse(editCalls()[0].init.body).content, /can't send messages in <#555>/);
});

// ---- /uma_monthly ----------------------------------------------------------------

test("monthlyDue: once a month, on the chosen day or the month's last day", () => {
  const monthly = { day: 25, time: "18:00", lastSent: null };
  const at = (iso) => new Date(iso);
  assert.equal(monthlyDue(monthly, at("2026-11-25T16:59:00Z"), "Europe/Berlin"), null); // 17:59 in Berlin
  assert.equal(monthlyDue(monthly, at("2026-11-25T17:00:00Z"), "Europe/Berlin"), "2026-11");
  assert.equal(monthlyDue(monthly, at("2026-11-27T09:00:00Z"), "Europe/Berlin"), "2026-11"); // catches up later in the month
  assert.equal(monthlyDue({ ...monthly, lastSent: "2026-11" }, at("2026-11-28T09:00:00Z"), "Europe/Berlin"), null);
  assert.equal(monthlyDue(monthly, at("2026-11-20T09:00:00Z"), "Europe/Berlin"), null);
  const last = { day: 31, time: "12:00", lastSent: null };
  assert.equal(monthlyDue(last, at("2026-11-29T12:00:00Z"), "UTC"), null);
  assert.equal(monthlyDue(last, at("2026-11-30T12:00:00Z"), "UTC"), "2026-11"); // November has 30 days
  assert.equal(monthlyDue(last, at("2027-02-28T12:00:00Z"), "UTC"), "2027-02");
});

test("/uma_monthly saves the message and shows when it's next sent", async () => {
  const kv = fakeKV({ guilds: { 777: { timeZone: "Europe/Berlin" } } });
  const env = { ...ENV, UMA_STATE: kv };
  const options = [
    { name: "day", value: 25 }, { name: "time", value: "18:00" }, { name: "message", value: "Quota ends soon!\nGo go go" },
    { name: "ping", value: "4444" },
  ];
  const { data } = await (await run(await signedRequest(asUser("uma_monthly", options)), env)).json();
  assert.equal(data.flags, 64);
  assert.match(data.content, /in <#555> on day \*\*25\*\* of every month at \*\*18:00\*\* \(Europe\/Berlin\), mentioning <@&4444>/);
  assert.match(data.content, /> Quota ends soon!\n> Go go go/);
  const monthly = kv.json("guilds")["777"].monthly;
  assert.deepEqual(
    { ...monthly, lastSent: undefined },
    { day: 25, time: "18:00", channelId: "555", roleId: "4444", text: "Quota ends soon!\nGo go go", lastSent: undefined, lastError: null, retryAfter: 0 },
  );

  const bad = await (await run(await signedRequest(asUser("uma_monthly", [{ name: "day", value: 5 }, { name: "time", value: "25:00" }, { name: "message", value: "x" }])), env)).json();
  assert.equal(bad.data.flags, 64);
  assert.match(bad.data.content, /didn't understand that time/);
});

test("/uma_monthly without a message opens a box, and the box saves it", async () => {
  const kv = fakeKV();
  const env = { ...ENV, UMA_STATE: kv };
  const opened = await (await run(await signedRequest(asUser("uma_monthly", [{ name: "day", value: 1 }, { name: "ping", value: "777" }])), env)).json();
  assert.equal(opened.type, 9);
  assert.match(opened.data.custom_id, /^uma_monthly:1:1200:555:777:[\w-]{22}$/);
  const submit = (custom_id, user = "123456789") => ({
    type: 5, application_id: "4242", token: "interaction-token", guild_id: "777", channel_id: "555",
    member: { user: { id: user } },
    data: { custom_id, components: [{ type: 1, components: [{ custom_id: "text", value: "New month, new quota! 💚" }] }] },
  });
  const saved = (await (await run(await signedRequest(submit(opened.data.custom_id)), env)).json()).data;
  assert.match(saved.content, /day \*\*1\*\* of every month at \*\*12:00\*\* \(UTC\), mentioning @everyone/);
  assert.equal(kv.json("guilds")["777"].monthly.roleId, "everyone"); // picking @everyone gives the server's ID
  assert.equal(kv.json("guilds")["777"].monthly.text, "New month, new quota! 💚");

  const forged = (await (await run(await signedRequest(submit(opened.data.custom_id, "1")), env)).json()).data;
  assert.match(forged.content, /didn't come from/);
});

test("the monthly message is posted once a month, with the role mention", async () => {
  const monthly = { day: 25, time: "18:00", channelId: "555", roleId: "4444", text: "Quota!", lastSent: "2026-10" };
  const kv = fakeKV({ guilds: { 777: { timeZone: "UTC", monthly } } });
  const env = { ...ENV, UMA_STATE: kv };
  await runSchedule(env, new Date("2026-11-25T17:55:00Z"));
  assert.equal(dailyCalls().length, 0);
  await runSchedule(env, new Date("2026-11-25T18:00:00Z"));
  await runSchedule(env, new Date("2026-11-25T18:05:00Z"));
  const posts = dailyCalls();
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].init.body), {
    content: "<@&4444>\nQuota!", allowed_mentions: { parse: [], roles: ["4444"] },
  });
  assert.equal(kv.json("guilds")["777"].monthly.lastSent, "2026-11");
  assert.equal(kv.json("guilds")["777"].monthly.text, "Quota!"); // the rest of the settings are kept
});

test("a failed monthly message is retried, and /uma_monthly_off stops it", async () => {
  const monthly = { day: 1, time: "00:00", channelId: "555", roleId: null, text: "Hi", lastSent: null };
  const kv = fakeKV({ guilds: { 777: { timeZone: "UTC", monthly } } });
  const env = { ...ENV, UMA_STATE: kv };
  routes["discord.com"] = () => Response.json({ message: "Missing Access" }, { status: 403 });
  await runSchedule(env, new Date("2026-12-01T00:00:00Z"));
  assert.match(kv.json("guilds")["777"].monthly.lastError, /403/);
  assert.equal(kv.json("guilds")["777"].monthly.lastSent, null);

  const status = (await (await run(await signedRequest(command("uma_status")), env)).json()).data.content;
  assert.match(status, /Monthly message: day \*\*1\*\*/);
  assert.match(status, /Last monthly problem: .*403/);

  await run(await signedRequest(command("uma_monthly_off")), env);
  assert.equal(kv.json("guilds")["777"].monthly, null);
  routes["discord.com"] = () => new Response(null);
  calls = [];
  await runSchedule(env, new Date("2026-12-01T01:00:00Z"));
  assert.equal(dailyCalls().length, 0);
});

// ---- Club fan tracker -------------------------------------------------------------

test("parseFans and formatFans", () => {
  for (const [text, fans] of [
    ["32.5m", 32_500_000], ["32,5M", 32_500_000], ["850k", 850_000], ["1.2b", 1_200_000_000], ["32500000", 32_500_000],
    ["32,500,000", 32_500_000], ["32 500 000", 32_500_000], ["32.500.000", 32_500_000], ["1.234m", 1_234_000],
    ["45m fans", 45_000_000], [" 12 M ", 12_000_000], ["0", 0],
  ]) {
    assert.equal(parseFans(text), fans, text);
  }
  for (const bad of ["lots", "", "-5m", "12x", "999999b"]) assert.equal(parseFans(bad), null, bad);
  assert.equal(formatFans(32_500_000), "32.5M");
  assert.equal(formatFans(1_234_000_000), "1.23B");
  assert.equal(formatFans(850_000), "850K");
  assert.equal(formatFans(999), "999");
});

const clubCommand = (name, options, { user = "111", permissions = "0", resolved } = {}) => ({
  type: 2, application_id: "4242", token: "interaction-token", guild_id: "777", channel_id: "555",
  member: { user: { id: user, username: `user${user}` }, nick: user === "111" ? "Jedrek" : null, permissions },
  data: { name, options, ...(resolved ? { resolved } : {}) },
});

test("/uma_quota and /uma_fans save the quota and each member's fans", async () => {
  const kv = fakeKV({ guilds: { 777: { timeZone: "UTC" } } });
  const env = { ...ENV, UMA_STATE: kv };
  const quota = (await (await run(await signedRequest(clubCommand("uma_quota", [{ name: "fans", value: "30m" }])), env)).json()).data;
  assert.match(quota.content, /\*\*30M\*\* fans per member/);
  assert.match(quota.content, /summary in <#555>/);
  assert.equal(kv.json("guilds")["777"].club.quota, 30_000_000);

  const month = new Date().toISOString().slice(0, 7);
  let reply = (await (await run(await signedRequest(clubCommand("uma_fans", [{ name: "fans", value: "32.5m" }])), env)).json()).data;
  assert.equal(reply.flags, 64);
  assert.match(reply.content, /Saved your \*\*32.5M\*\* fans/);
  assert.match(reply.content, /quota done/);
  assert.deepEqual(kv.meta.get(`fans:777:${month}:111`), { fans: 32_500_000, name: "Jedrek" });

  reply = (await (await run(await signedRequest(clubCommand("uma_fans", [{ name: "fans", value: "12m" }], { user: "222" })), env)).json()).data;
  assert.match(reply.content, /18M to go/);

  // Saving for someone else needs Manage Server.
  const forOther = [{ name: "fans", value: "40m" }, { name: "member", value: "333" }];
  const resolved = { users: { 333: { id: "333", username: "nature", global_name: "Nice Nature" } } };
  reply = (await (await run(await signedRequest(clubCommand("uma_fans", forOther, { resolved })), env)).json()).data;
  assert.match(reply.content, /Only people with Manage Server/);
  reply = (await (await run(await signedRequest(clubCommand("uma_fans", forOther, { permissions: "32", resolved })), env)).json()).data;
  assert.match(reply.content, /Saved <@333>'s \*\*40M\*\* fans/);
  assert.deepEqual(kv.meta.get(`fans:777:${month}:333`), { fans: 40_000_000, name: "Nice Nature" });

  reply = (await (await run(await signedRequest(clubCommand("uma_fans", [{ name: "fans", value: "a lot" }])), env)).json()).data;
  assert.match(reply.content, /didn't understand that number/);
});

test("club summary compares with the month before", () => {
  const before = { 111: { fans: 20_000_000, name: "A" }, 222: { fans: 31_000_000, name: "B" }, 444: { fans: 5_000_000, name: "D" } };
  const now = { 111: { fans: 32_500_000, name: "A" }, 222: { fans: 12_000_000, name: "B" }, 333: { fans: 40_000_000, name: "C" } };
  const embed = clubSummary("2026-11", now, before, 30_000_000);
  assert.equal(embed.title, "📊 Club summary for November 2026");
  const text = embed.description;
  assert.match(text, /Total fans:\*\* 84.5M \(▲ 51% vs October 2026\)/);
  assert.match(text, /Members reported:\*\* 3 \(3 in October 2026\)/);
  assert.match(text, /Quota \(30M\):\*\* 2\/3 done \(1\/3 in October 2026\)/);
  assert.match(text, /Top fans:\*\* 1\. <@333> 40M · 2\. <@111> 32.5M · 3\. <@222> 12M/);
  assert.match(text, /Most improved:\*\* <@111> 20M → 32.5M \(▲ 63%\)/);
  assert.match(text, /Quota done:\*\* <@333>, <@111>/);
  assert.match(text, /Quota not reached:\*\* <@222> 12M/);
  assert.match(text, /No report yet\*\* \(reported in October 2026\): <@444>/);
  assert.match(clubSummary("2026-11", now, {}, null, { partial: true }).title, /\(so far\)/);
});

test("/uma_summary shows this month, or says nobody reported", async () => {
  const month = new Date().toISOString().slice(0, 7);
  const kv = fakeKV({ guilds: { 777: { timeZone: "UTC", club: { quota: 30_000_000, channelId: "555" } } } });
  const env = { ...ENV, UMA_STATE: kv };
  let response = await (await run(await signedRequest(clubCommand("uma_summary")), env)).json();
  assert.equal(response.data.flags, 64);
  assert.match(response.data.content, /Nobody has saved/);
  await kv.put(`fans:777:${month}:111`, "", { metadata: { fans: 31_000_000, name: "A" } });
  response = await (await run(await signedRequest(clubCommand("uma_summary")), env)).json();
  assert.match(response.data.embeds[0].title, /\(so far\)/);
  assert.deepEqual(response.data.allowed_mentions, { parse: [] });
});

test("last month's summary is posted on the 1st from 12:00, once", async () => {
  const kv = fakeKV({ guilds: { 777: { timeZone: "UTC", club: { quota: 30_000_000, channelId: "555", lastSummary: "2026-10" } } } });
  const env = { ...ENV, UMA_STATE: kv };
  await kv.put("fans:777:2026-11:111", "", { metadata: { fans: 32_000_000, name: "A" } });
  await kv.put("fans:777:2026-10:111", "", { metadata: { fans: 16_000_000, name: "A" } });
  await kv.put("fans:777:2026-12:111", "", { metadata: { fans: 1_000_000, name: "A" } }); // the new month: not included

  await runSchedule(env, new Date("2026-12-01T11:55:00Z"));
  assert.equal(dailyCalls().length, 0);
  await runSchedule(env, new Date("2026-12-01T12:00:00Z"));
  await runSchedule(env, new Date("2026-12-01T12:05:00Z"));
  const posts = dailyCalls();
  assert.equal(posts.length, 1);
  const body = JSON.parse(posts[0].init.body);
  assert.equal(body.embeds[0].title, "📊 Club summary for November 2026");
  assert.match(body.embeds[0].description, /Total fans:\*\* 32M \(▲ 100% vs October 2026\)/);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(kv.json("guilds")["777"].club.lastSummary, "2026-11");
  assert.equal(kv.json("guilds")["777"].club.quota, 30_000_000); // the rest of the settings are kept
});
