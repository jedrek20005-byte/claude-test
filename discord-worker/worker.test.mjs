// Run with: node --test discord-worker/
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import worker, { buildEmbed, isSafe, pickImage, prettyCharacter } from "./worker.js";

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
      if (url.endsWith("/applications/@me")) return Response.json({ id: "4242", name: "Uma Bot" });
      if (url.endsWith("/commands")) return Response.json([]);
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
  assert.equal(JSON.parse(put.init.body)[0].name, "uma");
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
  assert.match(page, /client_id=4242&scope=applications\.commands/);
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
