// Run with: node --test discord-worker/
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import worker, {
  buildDeck, buildEmbed, clearCardCache, clubSummary, countdownMessage, deckEmbed, describeMonthly, describeSchedule, formatFans, isSafe, localNow,
  makeCardsToken, monthlyDue, parseFans, parseLiveBoard, parseTime, pickImage, postTimes, prettyCharacter, readCardsToken,
  clearRaceCache, findUma, memberComparison, MOODS, pickGif, planRaces, REACTION_GIFS, runSchedule, umaChoices,
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
    "uma_cards", "uma_deck", "uma_races", "uma_import", "uma_test", "uma_fans", "uma_quota", "uma_summary",
    "uma_react",
  ]);
  assert.equal(commands.find((c) => c.name === "uma_import").default_member_permissions, "32");
  assert.equal(commands.find((c) => c.name === "uma_test").default_member_permissions, "32");
  assert.equal(commands.find((c) => c.name === "uma_quota").default_member_permissions, "32");
  assert.equal(commands.find((c) => c.name === "uma_fans").default_member_permissions, undefined); // for everyone
  assert.equal(commands.find((c) => c.name === "uma_react").default_member_permissions, undefined);
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
  assert.match(page, /client_id=4242&amp;scope=bot\+applications\.commands&amp;permissions=117760|client_id=4242&scope=bot\+applications\.commands&permissions=117760/);
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
  assert.match(content, /scope=bot\+applications\.commands&permissions=117760/);
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
  const monthly = { day: 25, time: "18:00", lastSent: null, once: true };
  const at = (iso) => new Date(iso);
  assert.equal(monthlyDue(monthly, at("2026-11-25T16:59:00Z"), "Europe/Berlin"), null); // 17:59 in Berlin
  assert.equal(monthlyDue(monthly, at("2026-11-25T17:00:00Z"), "Europe/Berlin"), "2026-11");
  assert.equal(monthlyDue(monthly, at("2026-11-27T09:00:00Z"), "Europe/Berlin"), "2026-11"); // catches up later in the month
  assert.equal(monthlyDue({ ...monthly, lastSent: "2026-11" }, at("2026-11-28T09:00:00Z"), "Europe/Berlin"), null);
  assert.equal(monthlyDue(monthly, at("2026-11-20T09:00:00Z"), "Europe/Berlin"), null);
  const last = { day: 31, time: "12:00", lastSent: null, once: true };
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
  assert.match(data.content, /in <#555> on every day from day \*\*25\*\* to the end of the month at \*\*18:00\*\* \(Europe\/Berlin\), mentioning <@&4444>/);
  assert.match(data.content, /> Quota ends soon!\n> Go go go/);
  const monthly = kv.json("guilds")["777"].monthly;
  assert.deepEqual(
    { ...monthly, lastSent: undefined },
    { day: 25, time: "18:00", channelId: "555", roleId: "4444", gif: null, text: "Quota ends soon!\nGo go go", lastSent: undefined, lastError: null, retryAfter: 0 },
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
  assert.match(opened.data.custom_id, /^uma_monthly:1:1200:555:777:0:0:[\w-]{22}$/);
  assert.match(opened.data.components[0].components[0].value, /it's Belno! 💚/); // pre-filled with Belno's text
  const submit = (custom_id, user = "123456789") => ({
    type: 5, application_id: "4242", token: "interaction-token", guild_id: "777", channel_id: "555",
    member: { user: { id: user } },
    data: { custom_id, components: [{ type: 1, components: [{ custom_id: "text", value: "New month, new quota! 💚" }] }] },
  });
  const saved = (await (await run(await signedRequest(submit(opened.data.custom_id)), env)).json()).data;
  assert.match(saved.content, /every day from day \*\*1\*\* to the end of the month at \*\*12:00\*\* \(UTC\), mentioning @everyone/);
  assert.equal(kv.json("guilds")["777"].monthly.roleId, "everyone"); // picking @everyone gives the server's ID
  assert.equal(kv.json("guilds")["777"].monthly.text, "New month, new quota! 💚");

  const forged = (await (await run(await signedRequest(submit(opened.data.custom_id, "1")), env)).json()).data;
  assert.match(forged.content, /didn't come from/);
});

test("the monthly message is posted once a month, with the role mention", async () => {
  const monthly = { day: 25, time: "18:00", channelId: "555", roleId: "4444", text: "Quota!", lastSent: "2026-10", once: true };
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
  const monthly = { day: 1, time: "00:00", channelId: "555", roleId: null, text: "Hi", lastSent: null, once: true };
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
  // Real Discord IDs (snowflakes) show as mentions.
  const [A, B, C, D] = ["100000000000000111", "100000000000000222", "100000000000000333", "100000000000000444"];
  const before = { [A]: { fans: 20_000_000, name: "A" }, [B]: { fans: 31_000_000, name: "B" }, [D]: { fans: 5_000_000, name: "D" } };
  const now = { [A]: { fans: 32_500_000, name: "A" }, [B]: { fans: 12_000_000, name: "B" }, [C]: { fans: 40_000_000, name: "C" } };
  const embed = clubSummary("2026-11", now, before, 30_000_000);
  assert.equal(embed.title, "📊 Club summary for November 2026");
  const text = embed.description;
  assert.match(text, /^Thank you for all your hard work this month, trainers!/);
  assert.match(text, /Total fans:\*\* 84.5M \(▲ 51% vs October 2026\)/);
  assert.match(text, /Members reported:\*\* 3 \(3 in October 2026\)/);
  assert.match(text, /Quota \(30M\):\*\* 2\/3 done \(1\/3 in October 2026\)/);
  assert.ok(text.includes(`Top fans:** 1. <@${C}> 40M · 2. <@${A}> 32.5M · 3. <@${B}> 12M`));
  assert.ok(text.includes(`Most improved:** <@${A}> 20M → 32.5M (▲ 63%)`));
  assert.ok(text.includes(`Quota done:** <@${C}>, <@${A}>`));
  assert.ok(text.includes(`Quota not reached:** <@${B}> 12M`));
  assert.ok(text.includes(`No report yet** (reported in October 2026): <@${D}>`));
  assert.match(clubSummary("2026-11", now, {}, null, { partial: true }).title, /\(so far\)/);
  // Made-up example members (no real Discord ID) show by name instead.
  assert.match(clubSummary("2026-11", { 1: { fans: 5, name: "Gold Ship" } }, {}, null).description, /1\. \*\*Gold Ship\*\* 5/);
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

// ---- /uma_test ----------------------------------------------------------------------

const testCalls = () => calls.filter((c) => /\/channels\/\d+\/messages$/.test(c.url) && c.init.method === "POST");

test("/uma_test previews the monthly reminder privately, or sends it for real", async () => {
  const monthly = { day: 25, time: "18:00", channelId: "556", roleId: "4444", text: "Quota time!", lastSent: "2026-10", once: true };
  const kv = fakeKV({ guilds: { 777: { timeZone: "UTC", monthly } } });
  const env = { ...ENV, UMA_STATE: kv };
  const response = await run(await signedRequest(command("uma_test", [{ name: "what", value: "monthly" }])), env);
  assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
  assert.equal(testCalls().length, 0);
  const preview = JSON.parse(editCalls()[0].init.body);
  assert.match(preview.content, /goes out on day \*\*25\*\*[\s\S]*<@&4444>\nQuota time!/);
  assert.deepEqual(preview.allowed_mentions, { parse: [] });

  calls = [];
  await run(await signedRequest(command("uma_test", [{ name: "what", value: "monthly" }, { name: "post", value: true }])), env);
  const [sent] = testCalls();
  assert.ok(sent.url.endsWith("/channels/556/messages"));
  assert.deepEqual(JSON.parse(sent.init.body), { content: "<@&4444>\nQuota time!", allowed_mentions: { parse: [], roles: ["4444"] } });
  assert.match(JSON.parse(editCalls()[0].init.body).content, /Sent a test in <#556>/);
  assert.equal(kv.json("guilds")["777"].monthly.lastSent, "2026-10"); // a test isn't the real one
});

test("/uma_test monthly without a reminder shows Belno's default text", async () => {
  await run(await signedRequest(command("uma_test", [{ name: "what", value: "monthly" }])), { ...ENV, UMA_STATE: fakeKV() });
  const content = JSON.parse(editCalls()[0].init.body).content;
  assert.match(content, /No monthly reminder yet/);
  assert.match(content, /it's Belno! 💚[\s\S]*Ganbatte/);
});

test("/uma_test summary shows real data, or an example before anyone reports", async () => {
  const kv = fakeKV({ guilds: { 777: { timeZone: "UTC", club: { quota: 30_000_000, channelId: "555" } } } });
  const env = { ...ENV, UMA_STATE: kv };
  await run(await signedRequest(command("uma_test", [{ name: "what", value: "summary" }])), env);
  let edit = JSON.parse(editCalls()[0].init.body);
  assert.match(edit.embeds[0].title, /\(example\)$/);
  assert.match(edit.content, /example with made-up members/);

  const month = new Date().toISOString().slice(0, 7);
  await kv.put(`fans:777:${month}:111`, "", { metadata: { fans: 31_000_000, name: "A" } });
  calls = [];
  await run(await signedRequest(command("uma_test", [{ name: "what", value: "summary" }, { name: "post", value: true }])), env);
  const [sent] = testCalls();
  assert.ok(sent.url.endsWith("/channels/555/messages"));
  assert.match(JSON.parse(sent.init.body).embeds[0].title, /\(so far\)/);
  edit = JSON.parse(editCalls()[0].init.body);
  assert.match(edit.content, /Sent a test in <#555>/);
});

test("/uma_test with post but no channel says so", async () => {
  await run(await signedRequest(command("uma_test", [{ name: "what", value: "summary" }, { name: "post", value: true }])), { ...ENV, UMA_STATE: fakeKV() });
  assert.equal(testCalls().length, 0);
  assert.match(JSON.parse(editCalls()[0].init.body).content, /no channel for it yet/);
});

// ---- /uma_import (reading UmaCore's Live Board) ---------------------------------

const BOT = "222222222222222222";
// Built from UmaCore's default Live Board templates (services/embed_style.py).
const liveBoard = (day, { raced = [], idle = [], joined = [] } = {}, timestamp = "2026-11-04T16:07:00Z") => ({
  id: `m${day}`, author: { id: BOT, bot: true, username: "Still in love" }, content: "", timestamp, attachments: [],
  embeds: [
    {
      title: "📊 Live Board - Umamania",
      description: `**Competition day:** November ${day}\nUpdating through the day — **not final** until the day closes.`,
      fields: [{ name: "Fans today", value: "8.24M", inline: true }, { name: "Rank", value: "#1,975", inline: true }],
      footer: { text: "Umamusume Quota Tracker - Umamania · uma.moe as of 15:55 UTC" },
    },
    { title: "✅ Raced Today", description: raced.join("\n") },
    { title: "⚠️ No Fans Yet Today", description: idle.join("\n") },
    ...(joined.length ? [{ title: "🆕 Joined Today", description: joined.join("\n") }] : []),
  ],
});
const NOV_04 = liveBoard("04", {
  raced: ["` 1` **Lorelei**: +7.44M (27.62M total)", "` 2` **Bogeysoon**: +6.67M (15.53M total)",
    "`12` **vikYt**: +648.8K (1.23M total)", "`13` **New One**: +1.2M (3.40M since Nov 9)"],
  idle: ["**Eli**: 822.3K since Nov 2", "**Misty**: 0 this month", "**lex \\:3**: 0 this month"],
  joined: ["**Newbie**"],
});

test("parseLiveBoard reads every member's month total", () => {
  assert.deepEqual(parseLiveBoard(NOV_04), {
    month: "2026-11",
    day: 4,
    members: {
      Lorelei: 27_620_000, Bogeysoon: 15_530_000, vikYt: 1_230_000, "New One": 3_400_000,
      Eli: 822_300, Misty: 0, "lex :3": 0, // "Newbie" joined today, so has no number yet
    },
  });
  assert.equal(parseLiveBoard({ ...NOV_04, embeds: [{ title: "Umamania", image: { url: "x.png" } }] }), null); // the picture report
  const december = liveBoard("31", { idle: ["**Misty**: 1.00M this month"] }, "2027-01-01T10:00:00Z");
  december.embeds[0].description = december.embeds[0].description.replace("November", "December");
  assert.equal(parseLiveBoard(december).month, "2026-12"); // read in January, still last year's December
});

function boardChannel(messages, { status = 200 } = {}) {
  routes["discord.com"] = (url, init) => {
    if (url.includes("/channels/556/messages") && (init.method ?? "GET") === "GET") {
      return status === 200 ? Response.json(messages) : Response.json({ message: "Missing Access" }, { status });
    }
    return new Response(null);
  };
}

const importCommand = (options) => ({
  ...command("uma_import", options),
  data: { name: "uma_import", options, resolved: { users: { [BOT]: { id: BOT, username: "Still in love", bot: true } } } },
});

test("/uma_import links the board and shows what it read", async () => {
  boardChannel([{ id: "x", author: { id: "1" }, content: "hi", embeds: [] }, NOV_04]);
  const kv = fakeKV({ guilds: { 777: { timeZone: "UTC" } } });
  const env = { ...ENV, UMA_STATE: kv };
  const response = await run(await signedRequest(importCommand([{ name: "bot", value: BOT }, { name: "channel", value: "556" }])), env);
  assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
  const content = JSON.parse(editCalls()[0].init.body).content;
  assert.match(content, /Linked! 💚/);
  assert.match(content, /November 4\*\*, 7 trainers \(Lorelei 27.6M, Bogeysoon 15.5M, New One 3.4M…\)/);
  assert.match(content, /\/uma_quota/); // no quota yet
  assert.equal(kv.json("guilds")["777"].club.source.botId, BOT);
  assert.equal(kv.json("board:777:2026-11").members.Lorelei, 27_620_000);

  // Members don't need /uma_fans any more.
  const fans = (await (await run(await signedRequest(command("uma_fans", [{ name: "fans", value: "1m" }])), env)).json()).data;
  assert.match(fans.content, /read everyone's fans/);
  const status = (await (await run(await signedRequest(command("uma_status")), env)).json()).data.content;
  assert.match(status, /Club quota: off/);
  assert.match(status, /Reading fans from <@222222222222222222>'s Live Board in <#556>/);

  await run(await signedRequest(importCommand([{ name: "stop", value: true }])), env);
  assert.equal(kv.json("guilds")["777"].club.source, null);
});

test("/uma_import explains permission and Message Content problems", async () => {
  const env = { ...ENV, UMA_STATE: fakeKV() };
  boardChannel([], { status: 403 });
  await run(await signedRequest(importCommand([{ name: "bot", value: BOT }, { name: "channel", value: "556" }])), env);
  assert.match(JSON.parse(editCalls()[0].init.body).content, /Read Message History/);

  calls = [];
  boardChannel([{ ...NOV_04, embeds: [] }]); // what Discord sends without the Message Content Intent
  await run(await signedRequest(importCommand([{ name: "bot", value: BOT }, { name: "channel", value: "556" }])), env);
  assert.match(JSON.parse(editCalls()[0].init.body).content, /Message Content Intent/);
  assert.equal(env.UMA_STATE.json("guilds"), null); // nothing saved
});

test("the board is re-read every 30 minutes, and the last day's final board wins", async () => {
  const source = { botId: BOT, channelId: "556", lastRead: Date.parse("2026-11-30T14:50:00Z") };
  const kv = fakeKV({ guilds: { 777: { timeZone: "UTC", club: { quota: 15_000_000, channelId: "555", source, lastSummary: "2026-10" } } } });
  const env = { ...ENV, UMA_STATE: kv };
  const nov30 = (lorelei) => liveBoard("30", { raced: [`\` 1\` **Lorelei**: +1.00M (${lorelei} total)`], idle: ["**Misty**: 2.00M this month"] }, "2026-11-30T00:05:00Z");
  boardChannel([nov30("60.00M")]);
  await runSchedule(env, new Date("2026-11-30T15:00:00Z")); // only 10 minutes since the last read
  assert.equal(kv.json("board:777:2026-11"), null);
  await runSchedule(env, new Date("2026-11-30T15:20:00Z"));
  assert.equal(kv.json("board:777:2026-11").members.Lorelei, 60_000_000);

  // The day closes; the next board is December's, and November's board shows its final numbers.
  const dec01 = liveBoard("01", { idle: ["**Lorelei**: 0 this month"] }, "2026-12-01T00:05:00Z");
  dec01.embeds[0].description = dec01.embeds[0].description.replace("November", "December");
  boardChannel([dec01, nov30("61.50M")]);
  await runSchedule(env, new Date("2026-11-30T15:55:00Z"));
  assert.equal(kv.json("board:777:2026-11").members.Lorelei, 61_500_000);
  assert.equal(kv.json("board:777:2026-12").members.Lorelei, 0);

  // On the 1st, the summary uses the board's final November numbers.
  calls = [];
  await runSchedule(env, new Date("2026-12-01T12:30:00Z"));
  const summary = calls.find((c) => c.url.endsWith("/channels/555/messages") && c.init.method === "POST");
  const embed = JSON.parse(summary.init.body).embeds[0];
  assert.equal(embed.title, "📊 Club summary for November 2026");
  assert.match(embed.description, /Top fans:\*\* 1\. \*\*Lorelei\*\* 61.5M · 2\. \*\*Misty\*\* 2M/);
  assert.match(embed.description, /Quota \(15M\):\*\* 1\/2 done/);
  assert.equal(kv.json("guilds")["777"].club.source.botId, BOT); // the link is kept while its read time updates
  assert.ok(kv.json("guilds")["777"].club.source.lastRead >= Date.parse("2026-12-01T12:30:00Z"));
});

// ---- Belno's reaction GIFs ------------------------------------------------------------

const GIF_URL = /^https:\/\/media\.tenor\.com\/[\w-]{11}AAAAd\/[\w-]+\.gif$/;

test("the chosen GIFs: 34 in use, each with a known mood", () => {
  assert.equal(REACTION_GIFS.length, 34);
  assert.ok(!REACTION_GIFS.some((gif) => [10, 16, 19, 20, 21, 23, 25, 31, 38, 41, 43, 44, 45, 47, 48].includes(gif.n)));
  for (const gif of REACTION_GIFS) assert.ok(!gif.mood || MOODS[gif.mood], `GIF ${gif.n}`);
  assert.equal(pickGif("love", () => 0).mood, "love");
  assert.equal(pickGif("sleepy", () => 0.99).n, 33);
  assert.equal(pickGif("random", () => 0).n, 1); // any GIF
  assert.equal(pickGif(undefined, () => 0.999).n, 49);
});

test("/uma_react posts a GIF of the mood with a Belno line", async () => {
  const { type, data } = await (await run(await signedRequest(asUser("uma_react", [{ name: "mood", value: "bonk" }])))).json();
  assert.equal(type, 4);
  assert.ok(!data.flags); // everyone sees it
  assert.ok(MOODS.bonk.lines.includes(data.content));
  assert.match(data.embeds[0].image.url, GIF_URL);
  const bonk = REACTION_GIFS.filter((gif) => gif.mood === "bonk").map((gif) => gif.id);
  assert.ok(bonk.some((id) => data.embeds[0].image.url.includes(id)));
  assert.deepEqual(data.allowed_mentions, { parse: [], users: [] });
});

test("/uma_react can say something else and ping only the chosen person", async () => {
  const options = [{ name: "message", value: "Great race @everyone!" }, { name: "to", value: "4321" }];
  const { data } = await (await run(await signedRequest(asUser("uma_react", options)))).json();
  assert.equal(data.content, "<@4321> Great race @everyone!");
  assert.deepEqual(data.allowed_mentions, { parse: [], users: ["4321"] });
  assert.match(data.embeds[0].image.url, GIF_URL);
});

test("/gifs shows the GIFs in use and the left-out ones, by number", async () => {
  const html = await (await run(new Request("https://x.workers.dev/gifs"))).text();
  assert.match(html, /In use \(34\)/);
  assert.match(html, /Left out \(15\)/);
  assert.match(html, /<figure><div class="n">33<\/div><img src="https:\/\/media.tenor.com\/25AeQzf_JLoAAAAM\/cute-berno.gif".*?Sleepy 💤/);
  assert.match(html, /<figure class="out"><div class="n">10<\/div>.*?left out/);
});

test("/uma_monthly can add a new GIF each month, also through the message box", async () => {
  const kv = fakeKV();
  const env = { ...ENV, UMA_STATE: kv };
  const options = [{ name: "day", value: 25 }, { name: "message", value: "Quota!" }, { name: "gif", value: "happy" }];
  const saved = (await (await run(await signedRequest(asUser("uma_monthly", options)), env)).json()).data;
  assert.match(saved.content, /at \*\*12:00\*\* \(UTC\), with a happy GIF;/);
  assert.equal(kv.json("guilds")["777"].monthly.gif, "happy");

  const opened = (await (await run(await signedRequest(asUser("uma_monthly", [{ name: "day", value: 2 }, { name: "gif", value: "random" }])), env)).json()).data;
  assert.match(opened.custom_id, /^uma_monthly:2:1200:555:0:random:0:[\w-]{22}$/);
  const submit = {
    type: 5, application_id: "4242", token: "interaction-token", guild_id: "777", channel_id: "555",
    member: { user: { id: "123456789" } },
    data: { custom_id: opened.custom_id, components: [{ type: 1, components: [{ custom_id: "text", value: "Hi!" }] }] },
  };
  const boxed = (await (await run(await signedRequest(submit), env)).json()).data;
  assert.match(boxed.content, /with one of my GIFs;/);
  assert.equal(kv.json("guilds")["777"].monthly.gif, "random");
  // A box whose GIF choice was changed isn't saved.
  const tampered = { ...submit, data: { ...submit.data, custom_id: opened.custom_id.replace(":random:", ":sad:") } };
  assert.match((await (await run(await signedRequest(tampered), env)).json()).data.content, /didn't come from/);

  const monthly = { day: 25, time: "18:00", channelId: "555", roleId: null, gif: "sad", text: "Quota!", lastSent: "2026-10", once: true };
  const posting = fakeKV({ guilds: { 777: { timeZone: "UTC", monthly } } });
  await runSchedule({ ...ENV, UMA_STATE: posting }, new Date("2026-11-25T18:00:00Z"));
  const body = JSON.parse(dailyCalls()[0].init.body);
  assert.equal(body.content, "Quota!");
  const sad = REACTION_GIFS.filter((gif) => gif.mood === "sad").map((gif) => gif.id);
  assert.ok(sad.some((id) => body.embeds[0].image.url.includes(id)));
});

// ---- Race scheduler ------------------------------------------------------------------

const race = (name, year, month, half, fans, extra = {}) => ({
  id: name.length, name, grade: "G2", surface: "turf", distance: 2000, type: "medium", year, month, half, fans, needed: 0, ...extra,
});
const TURF_MEDIUM = { id: 1, name: "Turfy", title: "Green", aptitude: { turf: "A", dirt: "G", short: "F", mile: "B", medium: "A", long: "C" } };

test("planRaces never races more than the limit in a row and picks the most fans", () => {
  const data = {
    debut_fans: 700,
    races: [
      race("Jul 1", 1, 7, 1, 1000), race("Jul 2", 1, 7, 2, 5000), race("Aug 1", 1, 8, 1, 1000),
      race("Aug 2", 1, 8, 2, 5000), race("Sep 1", 1, 9, 1, 1000),
    ],
    umas: [TURF_MEDIUM],
  };
  // The debut (Jun 2) counts as a race, so with 2 in a row the best is Jul 2, then Aug 2 + Sep 1.
  const plan = planRaces(data, TURF_MEDIUM, { maxInARow: 2 });
  assert.deepEqual(plan.races.map((r) => r.name), ["Jul 2", "Aug 2", "Sep 1"]);
  assert.equal(plan.fans, 11000);
  assert.equal(planRaces(data, TURF_MEDIUM, { maxInARow: 6 }).fans, 13000); // all of them
});

test("planRaces keeps to her aptitudes, the fans needed to enter and the server", () => {
  const data = {
    debut_fans: 700,
    races: [
      race("Dirt cup", 1, 9, 1, 9000, { surface: "dirt" }),
      race("Sprint", 1, 10, 1, 9000, { type: "short", distance: 1200 }),
      race("Mile cup", 1, 11, 1, 3000, { type: "mile", distance: 1600 }),
      race("Big one", 2, 2, 1, 30000, { needed: 5000 }),
      race("Too early", 1, 12, 1, 20000, { needed: 25000 }),
      race("JP only", 2, 3, 1, 9000, { jp_only: true }),
      race("Starter", 1, 12, 2, 4300), // with the debut, exactly the 5,000 "Big one" needs
    ],
  };
  assert.deepEqual(planRaces(data, TURF_MEDIUM).races.map((r) => r.name), ["Starter", "Big one"]);
  // With B allowed, the mile race counts too, which also gets her to 5,000 fans sooner.
  assert.deepEqual(planRaces(data, TURF_MEDIUM, { minAptitude: "B" }).races.map((r) => r.name), ["Mile cup", "Starter", "Big one"]);
  assert.deepEqual(planRaces(data, { ...TURF_MEDIUM, jp_only: true }).races.map((r) => r.name), ["Starter", "Big one", "JP only"]);
});

const RACE_DATA = {
  debut_fans: 700,
  races: [race("Hopeful Stakes", 1, 12, 2, 7000, { grade: "G1" }), race("Japan Cup", 2, 11, 2, 30000, { grade: "G1", distance: 2400, needed: 6000 })],
  umas: [
    { id: 100101, name: "Special Week", title: "Special Dreamer", aptitude: TURF_MEDIUM.aptitude },
    { id: 100102, name: "Special Week", title: "Hopp'n♪Happy Heart", aptitude: TURF_MEDIUM.aptitude, jp_only: true },
    { id: 100201, name: "Silence Suzuka", title: "Innocent Silence", aptitude: TURF_MEDIUM.aptitude },
  ],
};

test("Umas can be found by id or name, and are suggested while typing", () => {
  assert.equal(findUma(RACE_DATA, "100201").name, "Silence Suzuka");
  assert.equal(findUma(RACE_DATA, "suzuka").id, 100201);
  assert.equal(findUma(RACE_DATA, "nobody"), null);
  assert.deepEqual(umaChoices(RACE_DATA, "special"), [
    { name: "Special Week [Special Dreamer]", value: "100101" },
    { name: "Special Week [Hopp'n♪Happy Heart] (JP)", value: "100102" },
  ]);
});

test("/uma_races plans the races, and the uma option autocompletes", async () => {
  clearRaceCache();
  routes["raw.githubusercontent.com"] = (url) => (url.endsWith("/race-data/races.json") ? Response.json(RACE_DATA) : new Response("", { status: 404 }));
  const response = await run(await signedRequest(asUser("uma_races", [{ name: "uma", value: "100101" }])));
  assert.deepEqual(await response.json(), { type: 5 });
  const { embeds } = JSON.parse(editCalls()[0].init.body);
  assert.equal(embeds[0].title, "🏇 Most fans: Special Week [Special Dreamer]");
  assert.match(embeds[0].description, /Turf \*\*A\*\* · Dirt \*\*G\*\*/);
  assert.match(embeds[0].description, /\*\*Junior year\*\* \(1\)\n`Dec 2` \*\*G1\*\* Hopeful Stakes · 2000m turf · 7k/);
  assert.match(embeds[0].description, /`Nov 2` \*\*G1\*\* Japan Cup · 2400m turf · 30k/);
  assert.match(embeds[0].footer.text, /^2 races · 37,000 fans/);

  calls = [];
  await run(await signedRequest(asUser("uma_races", [{ name: "uma", value: "Nobody" }])));
  assert.match(JSON.parse(editCalls()[0].init.body).content, /don't know that Uma/);

  const typing = { ...asUser("uma_races", [{ name: "uma", value: "suz", focused: true }]), type: 4 };
  assert.deepEqual(await (await run(await signedRequest(typing))).json(), {
    type: 8, data: { choices: [{ name: "Silence Suzuka [Innocent Silence]", value: "100201" }] },
  });
});

test("without a debut fan count, the debut counts like the smallest Junior Pre-OP win", () => {
  const data = {
    debut_fans: 0,
    races: [race("Newcomer", 1, 7, 2, 1000, { grade: "Pre-OP" }), race("Needs 350", 1, 8, 1, 3100, { needed: 350 })],
  };
  assert.deepEqual(planRaces(data, TURF_MEDIUM).races.map((r) => r.name), ["Newcomer", "Needs 350"]);
});

// ---- Every-member comparison -----------------------------------------------------------

test("the member comparison lists everyone with their last two months and Belno's note", () => {
  const now = {
    "111111111111111111": { fans: 40_000_000, name: "Spe" }, "222222222222222222": { fans: 31_000_000, name: "Suz" },
    "333333333333333333": { fans: 12_000_000, name: "Gol" }, "444444444444444444": { fans: 20_000_000, name: "New" },
    "555555555555555555": { fans: 30_000_000, name: "Flat" },
  };
  const before = {
    "111111111111111111": { fans: 30_000_000 }, "222222222222222222": { fans: 33_000_000 }, "333333333333333333": { fans: 20_000_000 },
    "555555555555555555": { fans: 30_000_000 }, "666666666666666666": { fans: 15_000_000, name: "Gone" },
  };
  const earlier = { "111111111111111111": { fans: 25_000_000 }, "222222222222222222": { fans: 31_000_000 } };
  const embed = memberComparison("2026-11", now, before, earlier, 30_000_000);
  assert.equal(embed.title, "👥 Every member: November 2026 vs Oct & Sep");
  const lines = embed.description.split("\n");
  assert.equal(lines[0], "1. <@111111111111111111> **40M** ✅ (Oct 30M · Sep 25M) ▲ 33% · three months up in a row! ⭐");
  assert.equal(lines[1], "2. <@222222222222222222> **31M** ✅ (Oct 33M · Sep 31M) ▼ 6% · a little dip 📉");
  assert.equal(lines[2], "3. <@555555555555555555> **30M** ✅ (Oct 30M) = same · rock solid 🪨");
  assert.equal(lines[3], "4. <@444444444444444444> **20M** ❌ · welcome to the club! 🌱");
  assert.equal(lines[4], "5. <@333333333333333333> **12M** ❌ (Oct 20M) ▼ 40% · rest up, we'll bounce back together 💪");
  assert.match(embed.description, /💤 \*\*Missing this month:\*\* <@666666666666666666> \(Oct 15M\)/);
  assert.match(memberComparison("2026-11", now, before, earlier, 30_000_000, { partial: true }).description, /\*\*12M\*\* 🏃/);
  assert.doesNotMatch(memberComparison("2026-01", now, {}, {}, null).description, /✅|❌/);
  assert.match(memberComparison("2026-01", now, {}, {}, null).title, /vs Dec & Nov$/);
});

test("the summary is posted with the member comparison", async () => {
  const kv = fakeKV({ guilds: { 777: { timeZone: "UTC", club: { quota: 30_000_000, channelId: "556" } } } });
  await kv.put("fans:777:2026-10:111111111111111111", "", { metadata: { fans: 30_000_000, name: "A" } });
  await kv.put("fans:777:2026-09:111111111111111111", "", { metadata: { fans: 20_000_000, name: "A" } });
  await kv.put("fans:777:2026-11:111111111111111111", "", { metadata: { fans: 45_000_000, name: "A" } });
  const response = await run(await signedRequest(command("uma_summary")), { ...ENV, UMA_STATE: kv });
  const { embeds } = (await response.json()).data;
  assert.equal(embeds.length, 2);
  assert.match(embeds[1].description, /^1\. <@111111111111111111> \*\*45M\*\* 🏃|^1\. <@111111111111111111> \*\*45M\*\* ✅/);
  assert.match(embeds[1].description, /\(Oct 30M · Sep 20M\) ▲ 50% · three months up in a row! ⭐/);
});

// ---- Daily reminders until the month ends ---------------------------------------------

test("by default the reminder goes out every day from the chosen day to the month's end", () => {
  const monthly = { day: 25, time: "18:00", lastSent: null };
  const at = (iso) => new Date(iso);
  assert.equal(monthlyDue(monthly, at("2026-11-24T19:00:00Z"), "UTC"), null); // before the day
  assert.equal(monthlyDue(monthly, at("2026-11-25T17:59:00Z"), "UTC"), null); // before the time
  assert.equal(monthlyDue(monthly, at("2026-11-25T18:00:00Z"), "UTC"), "2026-11-25");
  assert.equal(monthlyDue({ ...monthly, lastSent: "2026-11-25" }, at("2026-11-25T23:00:00Z"), "UTC"), null); // once a day
  assert.equal(monthlyDue({ ...monthly, lastSent: "2026-11-25" }, at("2026-11-26T18:05:00Z"), "UTC"), "2026-11-26");
  assert.equal(monthlyDue({ ...monthly, lastSent: "2026-11-29" }, at("2026-11-30T18:00:00Z"), "UTC"), "2026-11-30"); // last day
  assert.equal(monthlyDue({ ...monthly, lastSent: "2026-11-30" }, at("2026-12-01T18:00:00Z"), "UTC"), null); // a new month waits for the 25th
  assert.equal(monthlyDue({ ...monthly, lastSent: "2026-11" }, at("2026-11-26T18:00:00Z"), "UTC"), "2026-11-26"); // saved by the old version
  assert.equal(monthlyDue({ day: 31, time: "12:00" }, at("2027-02-28T12:00:00Z"), "UTC"), "2027-02-28"); // short month: its last day
});

test("the daily reminder says when it's next, and counts down the days left", () => {
  const monthly = { day: 25, time: "18:00", lastSent: "2026-11-26" };
  assert.match(describeMonthly(monthly, "UTC", new Date("2026-11-26T19:00:00Z")), /^every day from day \*\*25\*\* to the end of the month at \*\*18:00\*\* \(UTC\); next on 27 November 2026$/);
  assert.match(describeMonthly({ ...monthly, lastSent: "2026-11-30" }, "UTC", new Date("2026-11-30T19:00:00Z")), /next on 25 December 2026$/);
  assert.match(describeMonthly({ ...monthly, lastSent: "2026-10-31" }, "UTC", new Date("2026-11-10T19:00:00Z")), /next on 25 November 2026$/);
  assert.match(describeMonthly({ ...monthly, once: true, lastSent: "2026-11" }, "UTC", new Date("2026-11-26T19:00:00Z")), /^day \*\*25\*\* of every month .*next on 25 December 2026$/);
  const at = (day) => countdownMessage(new Date(`2026-11-${day}T18:00:00Z`), "UTC");
  assert.match(at(10), /^\*\*.+\*\*\n-# ⏳ 20 days left this month$/);
  assert.match(at(10), /Plenty of time|No rush yet|plan your runs/); // a week or more: calm
  assert.match(at(25), /finish line|Less than a week|Getting closer/); // 5 left
  assert.match(at(27), /Almost there|Final stretch|last straight/); // 3 left
  assert.match(at(29), /Tomorrow is the very last day|Only one day left/);
  assert.equal(at(29).split("\n")[1], "-# ⏳ 1 day left this month");
  assert.match(at(30), /^\*\*🏁 .+\*\*\n-# ⏳ Ends tonight$/);
  assert.notEqual(at(25), at(26)); // a different line from one day to the next
});

test("the daily reminder is posted each day with the countdown", async () => {
  const monthly = { day: 29, time: "18:00", channelId: "555", roleId: null, text: "Run your races!", lastSent: null };
  const kv = fakeKV({ guilds: { 777: { timeZone: "UTC", monthly } } });
  const env = { ...ENV, UMA_STATE: kv };
  await runSchedule(env, new Date("2026-11-29T18:00:00Z"));
  await runSchedule(env, new Date("2026-11-29T18:05:00Z"));
  await runSchedule(env, new Date("2026-11-30T18:00:00Z"));
  await runSchedule(env, new Date("2026-12-01T18:00:00Z"));
  const bodies = dailyCalls().map((c) => JSON.parse(c.init.body).content);
  assert.equal(bodies.length, 2);
  assert.match(bodies[0], /^Run your races!\n\*\*(Tomorrow is the very last day|Only one day left).+\*\*\n-# ⏳ 1 day left this month$/);
  assert.match(bodies[1], /^Run your races!\n\*\*🏁 .+\*\*\n-# ⏳ Ends tonight$/);
  assert.equal(kv.json("guilds")["777"].monthly.lastSent, "2026-11-30");
});

test("/uma_monthly once:True keeps it to one post a month, also through the message box", async () => {
  const kv = fakeKV();
  const env = { ...ENV, UMA_STATE: kv };
  const saved = (await (await run(await signedRequest(asUser("uma_monthly", [
    { name: "day", value: 25 }, { name: "message", value: "Quota!" }, { name: "once", value: true },
  ])), env)).json()).data;
  assert.match(saved.content, /on day \*\*25\*\* of every month at \*\*12:00\*\*/);
  assert.equal(kv.json("guilds")["777"].monthly.once, true);
  const opened = (await (await run(await signedRequest(asUser("uma_monthly", [{ name: "day", value: 3 }, { name: "once", value: true }])), env)).json()).data;
  assert.match(opened.custom_id, /^uma_monthly:3:1200:555:0:0:1:[\w-]{22}$/);
  const submit = {
    type: 5, application_id: "4242", token: "interaction-token", guild_id: "777", channel_id: "555", member: { user: { id: "123456789" } },
    data: { custom_id: opened.custom_id, components: [{ type: 1, components: [{ custom_id: "text", value: "Hi!" }] }] },
  };
  await run(await signedRequest(submit), env);
  assert.equal(kv.json("guilds")["777"].monthly.once, true);
  assert.equal(kv.json("guilds")["777"].monthly.day, 3);
});
