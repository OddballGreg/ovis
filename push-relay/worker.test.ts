import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import {
  DEVICE_RATE_LIMIT, ENDPOINTS_PER_TOKEN, ENDPOINT_TTL_SECONDS, FALLBACK_BODY, RATE_LIMIT, RATE_WINDOW_SECONDS,
  expire, handle, readRegistration, verifyVapid, type Env,
} from "./worker.ts";

const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
const RELAY = "https://push.test";
const TOKEN = "a1".repeat(32);
/** a P-256 key pair and auth secret the app keeps; the relay never sees the private half */
const device = { p256dh: webpush.generateVAPIDKeys().publicKey, auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url") };
const pcKey = webpush.generateVAPIDKeys();
const otherPcKey = webpush.generateVAPIDKeys();
const message = JSON.stringify({ pane_id: "w1-1", title: "secret-project - claude", body: "Needs your input", tag: "pane-w1-1" });

const apnsPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const apnsPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", apnsPair.privateKey)).toString("base64").replace(/.{64}/g, "$&\n")}\n-----END PRIVATE KEY-----\n`;

interface ApnsCall { url: string; headers: Record<string, string>; body: string }

/** a Rate Limiting binding that records each key it is asked about and lets through while `allow` */
function fakeLimiter(name: string, asked: string[]) {
  const limiter = { allow: true, limit: async ({ key }: { key: string }) => { asked.push(`${name}:${key}`); return { success: limiter.allow }; } };
  return limiter;
}

/** the relay over a real SQLite table, fake registration limiters, and an APNs that answers `apnsAnswer` and records each call */
function relay(keyId = "KEY1234567") {
  const db = new Database(":memory:");
  db.exec(schema);
  const limiterKeys: string[] = [];
  const perAddress = fakeLimiter("address", limiterKeys);
  const global = fakeLimiter("global", limiterKeys);
  const env: Env = {
    DB: { prepare: (query) => ({ bind: (...values) => ({
      first: async <T>() => (db.query(query).get(...(values as (string | number | null)[])) ?? null) as T | null,
      run: async () => db.query(query).run(...(values as (string | number | null)[])),
    }) }) },
    REGISTER_LIMITER: perAddress,
    REGISTER_GLOBAL_LIMITER: global,
    APNS_KEY: apnsPem, APNS_KEY_ID: keyId, APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "sh.ovis.app",
  };
  const calls: ApnsCall[] = [];
  let apnsAnswer = (): Response => new Response(null, { status: 200 });
  const send = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
    return apnsAnswer();
  };
  return {
    db, env, calls, limiterKeys, perAddress, global,
    answer(next: () => Response) { apnsAnswer = next; },
    handle: (request: Request, now = new Date()) => handle(request, env, now, send),
    rows: () => db.query("SELECT * FROM endpoints ORDER BY rowid").all() as Record<string, unknown>[],
  };
}
type Relay = ReturnType<typeof relay>;

const registration = (body: unknown, type = "application/json") =>
  new Request(`${RELAY}/v1/register`, { method: "POST", headers: { "content-type": type, "cf-connecting-ip": "203.0.113.9" }, body: typeof body === "string" ? body : JSON.stringify(body) });

async function register(r: Relay, body: Record<string, unknown> = {}, now = new Date()): Promise<string> {
  const response = await r.handle(registration({ token: TOKEN, vapid_key: pcKey.publicKey, ...body }), now);
  expect(response.status).toBe(201);
  return ((await response.json()) as { endpoint: string }).endpoint;
}
const idOf = (endpoint: string) => endpoint.split("/").at(-1)!;

/** a push exactly as server/push.ts builds it: web-push's aes128gcm body and VAPID header */
function pushRequest(endpoint: string, options: { key?: { publicKey: string; privateKey: string }; payload?: string; urgency?: "normal" | "high"; TTL?: number; topic?: string; to?: string } = {}) {
  const key = options.key ?? pcKey;
  const details = webpush.generateRequestDetails({ endpoint, keys: device }, options.payload ?? message, {
    vapidDetails: { subject: "https://github.com/devswha/ovis", publicKey: key.publicKey, privateKey: key.privateKey },
    TTL: options.TTL ?? 43_200, urgency: options.urgency ?? "high", contentEncoding: "aes128gcm",
    ...(options.topic ? { topic: options.topic } : {}),
  });
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(details.headers)) if (name.toLowerCase() !== "content-length") headers[name] = String(value);
  const body = new Uint8Array(details.body);
  return { request: new Request(options.to ?? details.endpoint, { method: "POST", headers, body }), body, headers };
}

function decodeJwt(token: string) {
  const [header, claims, signature] = token.split(".") as [string, string, string];
  const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  return { header: json(header), claims: json(claims), signature: Buffer.from(signature, "base64url"), signed: `${header}.${claims}` };
}

describe("push relay: registration", () => {
  test("hands back an endpoint on this relay holding a random ID, pinned to the PC's key, never the token", async () => {
    const r = relay();
    const now = new Date();
    const response = await r.handle(registration({ token: TOKEN.toUpperCase(), vapid_key: pcKey.publicKey }), now);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text.toLowerCase()).not.toContain(TOKEN);
    const { endpoint } = JSON.parse(text) as { endpoint: string };
    expect(endpoint).toMatch(/^https:\/\/push\.test\/v1\/push\/[A-Za-z0-9_-]{22}$/);
    const seconds = Math.floor(now.getTime() / 1000);
    expect(r.rows()).toEqual([{
      id: idOf(endpoint), token: TOKEN, environment: "production", vapid_key: pcKey.publicKey,
      created_at: seconds, used_at: seconds, window_start: 0, window_count: 0,
    }]);
    // the address only keys its limiter: it is not stored
    expect(r.limiterKeys).toEqual(["address:203.0.113.9", "global:all"]);
    expect(JSON.stringify(r.rows())).not.toContain("203.0.113.9");
    // each registration is an endpoint of its own: one per PC, each pinned to its PC's key
    expect(await register(r, { vapid_key: otherPcKey.publicKey })).not.toBe(endpoint);
  });

  test("refuses what is not one registration", async () => {
    const r = relay();
    const valid = { token: TOKEN, vapid_key: pcKey.publicKey };
    const shortKey = Buffer.from(new Uint8Array(32).fill(4)).toString("base64url");
    const compressed = Buffer.from([2, ...new Uint8Array(64).fill(7)]).toString("base64url");
    for (const body of [
      "not json", "[]", {}, { token: TOKEN }, { vapid_key: pcKey.publicKey },
      { ...valid, token: 42 }, { ...valid, token: "a1".repeat(31) }, { ...valid, token: "zz".repeat(32) }, { ...valid, token: `${TOKEN}0` },
      { ...valid, environment: "development" }, { ...valid, email: "person@example.com" },
      { ...valid, vapid_key: shortKey }, { ...valid, vapid_key: compressed }, { ...valid, vapid_key: "not base64!" }, { ...valid, vapid_key: 7 },
    ]) expect((await r.handle(registration(body))).status).toBe(400);
    expect((await r.handle(registration(valid, "text/plain"))).status).toBe(415);
    expect((await r.handle(registration({ ...valid, pad: "x".repeat(1100) }))).status).toBe(413);
    expect((await r.handle(new Request(`${RELAY}/v1/register`))).status).toBe(405);
    expect(r.rows()).toEqual([]);
    // the key is kept in one spelling, so a padded or base64 copy of it pins the same key
    const padded = Buffer.from(pcKey.publicKey, "base64url").toString("base64");
    expect(readRegistration({ token: TOKEN, environment: "sandbox", vapid_key: padded })).toEqual({ token: TOKEN, environment: "sandbox", vapid_key: pcKey.publicKey });
  });

  test("a registration its address's limiter refuses writes nothing, whatever token it names, and leaves the global cap alone", async () => {
    const r = relay();
    r.perAddress.allow = false;
    for (const token of [TOKEN, "b2".repeat(32), "c3".repeat(32)]) {
      const refused = await r.handle(registration({ token, vapid_key: pcKey.publicKey }));
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("60");
    }
    // a refused request is refused before its body is read
    expect((await r.handle(registration("not json"))).status).toBe(429);
    expect(r.rows()).toEqual([]);
    // one address over its limit never counts against the cap every phone shares
    expect(r.limiterKeys).toEqual(Array(4).fill("address:203.0.113.9"));
    r.perAddress.allow = true;
    await register(r);
    expect(r.rows()).toHaveLength(1);
  });

  test("the global cap refuses a registration its address may make, before any write", async () => {
    const r = relay();
    r.global.allow = false;
    const refused = await r.handle(registration({ token: TOKEN, vapid_key: pcKey.publicKey }));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    // refused before its body is read: a malformed body is not a 400
    expect((await r.handle(registration("not json"))).status).toBe(429);
    expect(r.rows()).toEqual([]);
    expect(r.limiterKeys).toEqual(["address:203.0.113.9", "global:all", "address:203.0.113.9", "global:all"]);
    r.global.allow = true;
    await register(r);
    expect(r.rows()).toHaveLength(1);
  });

  test(`keeps the ${ENDPOINTS_PER_TOKEN} most recently registered endpoints of one token`, async () => {
    const r = relay();
    const start = Date.now();
    const endpoints: string[] = [];
    for (let i = 0; i < ENDPOINTS_PER_TOKEN - 1; i++) endpoints.push(await register(r, {}, new Date(start + i * 1000)));
    // registered earliest but stored last: the registration time decides, not the row's place
    r.db.query("INSERT INTO endpoints (id, token, environment, vapid_key, created_at, used_at) VALUES (?, ?, 'production', ?, ?, ?)")
      .run("old_endpoint_000000000", TOKEN, pcKey.publicKey, Math.floor(start / 1000) - 3600, Math.floor(start / 1000));
    const newest = await register(r, {}, new Date(start + 60_000));
    await register(r, { token: "b2".repeat(32) });
    const ids = new Set(r.rows().map((row) => row["id"]));
    expect(ids.size).toBe(ENDPOINTS_PER_TOKEN + 1);
    expect(ids.has("old_endpoint_000000000")).toBe(false);
    expect(ids.has(idOf(endpoints[0]!))).toBe(true);
    expect(ids.has(idOf(newest))).toBe(true);
  });

  test(`deletes endpoints unused for ${ENDPOINT_TTL_SECONDS / 86_400} days, and only those`, async () => {
    const r = relay();
    const start = Date.now();
    const pushed = await register(r, {}, new Date(start));
    const idle = await register(r, {}, new Date(start));
    // pushed to 30 days later (a push sets used_at: "forwards the ciphertext..." checks it)
    r.db.query("UPDATE endpoints SET used_at = ? WHERE id = ?").run(Math.floor(start / 1000) + 30 * 86_400, idOf(pushed));
    await expire(r.env, new Date(start + ENDPOINT_TTL_SECONDS * 1000 - 1000));
    expect(r.rows()).toHaveLength(2);
    await expire(r.env, new Date(start + ENDPOINT_TTL_SECONDS * 1000 + 1000));
    expect(r.rows().map((row) => row["id"])).toEqual([idOf(pushed)]);
    expect((await r.handle(pushRequest(idle).request)).status).toBe(404);
  });
});

describe("push relay: pushes", () => {
  let r: Relay;
  beforeEach(() => { r = relay(); });

  test("forwards the ciphertext untouched to APNs in a mutable-content push it cannot read", async () => {
    const endpoint = await register(r);
    const now = new Date();
    const { request, body } = pushRequest(endpoint, { topic: "pane-w1-1" });
    const response = await r.handle(request, now);
    expect(response.status).toBe(201);
    expect(response.headers.get("ttl")).toBe("43200");
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0]!;
    expect(call.url).toBe(`https://api.push.apple.com/3/device/${TOKEN}`);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    expect(call.headers).toMatchObject({
      "apns-topic": "sh.ovis.app", "apns-push-type": "alert", "apns-priority": "10",
      "apns-expiration": String(nowSeconds + 43_200), "apns-collapse-id": "pane-w1-1",
    });
    const payload = JSON.parse(call.body) as { aps: unknown; ovis: string };
    expect(payload.aps).toEqual({ alert: { body: FALLBACK_BODY }, "mutable-content": 1 });
    expect(new Uint8Array(Buffer.from(payload.ovis, "base64"))).toEqual(body);
    expect(call.body).not.toMatch(/secret-project|Needs your input|w1-1"/);
    // the provider token is Apple's ES256 JWT, signed with the APNs key
    const jwt = decodeJwt(call.headers["authorization"]!.replace(/^bearer /, ""));
    expect(jwt.header).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(jwt.claims).toEqual({ iss: "TEAM123456", iat: nowSeconds });
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, apnsPair.publicKey, jwt.signature, new TextEncoder().encode(jwt.signed))).toBe(true);
    expect(r.rows()[0]!["used_at"]).toBe(nowSeconds);
  });

  test("maps urgency to APNs priority, a sandbox token to Apple's sandbox, and TTL 0 to deliver-now-or-never", async () => {
    const endpoint = await register(r, { environment: "sandbox" });
    expect((await r.handle(pushRequest(endpoint, { urgency: "normal", TTL: 0 }).request)).status).toBe(201);
    expect(r.calls[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
    expect(r.calls[0]!.headers).toMatchObject({ "apns-priority": "5", "apns-expiration": "0" });
    expect(r.calls[0]!.headers["apns-collapse-id"]).toBeUndefined();
  });

  test("reuses the APNs provider token for 50 minutes, then signs a new one", async () => {
    const own = relay("KEYREUSE01");
    const endpoint = await register(own);
    const start = new Date();
    for (const at of [start, new Date(start.getTime() + 49 * 60_000), new Date(start.getTime() + 51 * 60_000)]) {
      expect((await own.handle(pushRequest(endpoint).request, at)).status).toBe(201);
    }
    const tokens = own.calls.map((call) => call.headers["authorization"]);
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  test("a provider token APNs calls expired is signed again and the push sent once more", async () => {
    const own = relay("KEYRETRY01");
    const endpoint = await register(own);
    expect((await own.handle(pushRequest(endpoint).request)).status).toBe(201);
    let answers = [Response.json({ reason: "ExpiredProviderToken" }, { status: 403 }), new Response(null, { status: 200 })];
    own.answer(() => answers.shift()!);
    expect((await own.handle(pushRequest(endpoint).request)).status).toBe(201);
    const [first, stale, fresh] = own.calls.map((call) => call.headers["authorization"]);
    expect(stale).toBe(first);
    expect(fresh).not.toBe(stale);
    // the new token is the one kept
    own.answer(() => new Response(null, { status: 200 }));
    expect((await own.handle(pushRequest(endpoint).request)).status).toBe(201);
    expect(own.calls.at(-1)!.headers["authorization"]).toBe(fresh);
    // once more only: a key APNs keeps refusing is a relay failure, and the endpoint stays
    answers = [];
    own.answer(() => Response.json({ reason: "InvalidProviderToken" }, { status: 403 }));
    const before = own.calls.length;
    expect((await own.handle(pushRequest(endpoint).request)).status).toBe(502);
    expect(own.calls.length - before).toBe(2);
    expect(own.rows()).toHaveLength(1);
  });

  test("refuses every key but the one pinned at registration, the first push included", async () => {
    const endpoint = await register(r);
    expect((await r.handle(pushRequest(endpoint, { key: otherPcKey }).request)).status).toBe(403);
    expect(r.calls).toEqual([]);
    expect(r.rows()[0]!["vapid_key"]).toBe(pcKey.publicKey);
    expect((await r.handle(pushRequest(endpoint).request)).status).toBe(201);
    expect((await r.handle(pushRequest(endpoint, { key: otherPcKey }).request)).status).toBe(403);
    expect(r.calls).toHaveLength(1);
  });

  test("refuses a push without a valid VAPID token for this relay", async () => {
    const endpoint = await register(r);
    const bare = pushRequest(endpoint);
    const send = (headers: Record<string, string>) => r.handle(new Request(endpoint, { method: "POST", headers, body: bare.body }));
    const { Authorization: authorization, ...unsigned } = bare.headers as Record<string, string>;
    expect((await send(unsigned)).status).toBe(401);
    expect((await send({ ...unsigned, Authorization: authorization!.replace(/^vapid/, "WebPush") })).status).toBe(401);
    // a signature that does not match the token
    const tampered = authorization!.replace(/t=([^,]+)/, (_, jwt: string) => `t=${jwt.slice(0, -4)}${jwt.endsWith("AAAA") ? "BBBB" : "AAAA"}`);
    expect((await send({ ...unsigned, Authorization: tampered })).status).toBe(401);
    // signed by another key than the one it names
    const otherK = authorization!.replace(/k=.+$/, `k=${otherPcKey.publicKey}`);
    expect((await send({ ...unsigned, Authorization: otherK })).status).toBe(401);
    // signed for another push service's audience
    expect((await r.handle(pushRequest(`https://elsewhere.test/v1/push/${idOf(endpoint)}`, { to: endpoint }).request)).status).toBe(401);
    expect(r.calls).toEqual([]);

    const header = pushRequest(endpoint).headers["Authorization"]!;
    const { claims } = decodeJwt(/t=([^,]+)/.exec(header)![1]!);
    const exp = claims["exp"] as number;
    expect(await verifyVapid(header, RELAY, exp - 60)).toBe(pcKey.publicKey);
    // expired, or valid for longer than RFC 8292's 24 hours
    expect(await verifyVapid(header, RELAY, exp)).toBeNull();
    expect(await verifyVapid(header, RELAY, exp - 24 * 3600 - 1)).toBeNull();
  });

  test(`rate-limits an endpoint to ${RATE_LIMIT} pushes per window, without counting refused senders`, async () => {
    const endpoint = await register(r);
    const start = new Date();
    for (let i = 0; i < RATE_LIMIT; i++) expect((await r.handle(pushRequest(endpoint).request, start)).status).toBe(201);
    const limited = await r.handle(pushRequest(endpoint).request, new Date(start.getTime() + 100_000));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(RATE_WINDOW_SECONDS - 100));
    expect((await r.handle(pushRequest(endpoint, { key: otherPcKey }).request, start)).status).toBe(403);
    expect(r.calls).toHaveLength(RATE_LIMIT);
    expect((await r.handle(pushRequest(endpoint).request, new Date(start.getTime() + RATE_WINDOW_SECONDS * 1000))).status).toBe(201);
    expect(r.rows()[0]!["window_count"]).toBe(1);
  });

  test(`rate-limits a phone to ${DEVICE_RATE_LIMIT} pushes per window across its endpoints`, async () => {
    const start = new Date();
    const endpoints = [await register(r, {}, start), await register(r, {}, start), await register(r, {}, start)];
    const other = await register(r, { token: "b2".repeat(32) }, start);
    for (const endpoint of endpoints.slice(0, 2)) {
      for (let i = 0; i < DEVICE_RATE_LIMIT / 2; i++) expect((await r.handle(pushRequest(endpoint).request, start)).status).toBe(201);
    }
    // a fresh endpoint of the same phone buys no more pushes
    const limited = await r.handle(pushRequest(endpoints[2]!).request, new Date(start.getTime() + 60_000));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(RATE_WINDOW_SECONDS - 60));
    expect(r.rows().find((row) => row["id"] === idOf(endpoints[2]!))!["window_count"]).toBe(0);
    // another phone is not held back
    expect((await r.handle(pushRequest(other).request, start)).status).toBe(201);
    expect((await r.handle(pushRequest(endpoints[2]!).request, new Date(start.getTime() + RATE_WINDOW_SECONDS * 1000))).status).toBe(201);
  });

  test("a token APNs calls gone deletes all its endpoints and answers 410, which the PC takes as an unsubscribe", async () => {
    for (const [status, reason] of [[410, "Unregistered"], [410, "ExpiredToken"], [400, "BadDeviceToken"], [400, "DeviceTokenNotForTopic"]] as const) {
      const own = relay();
      const endpoint = await register(own);
      const sibling = await register(own, { vapid_key: otherPcKey.publicKey });
      const other = await register(own, { token: "b2".repeat(32) });
      own.answer(() => Response.json({ reason }, { status }));
      expect((await own.handle(pushRequest(endpoint).request)).status).toBe(410);
      expect(own.rows().map((row) => row["id"])).toEqual([idOf(other)]);
      expect((await own.handle(pushRequest(endpoint).request)).status).toBe(404);
      expect((await own.handle(pushRequest(sibling, { key: otherPcKey }).request)).status).toBe(404);
      expect(own.calls).toHaveLength(1);
    }
  });

  test("any other APNs failure keeps the endpoint", async () => {
    const endpoint = await register(r);
    for (const [answer, expected] of [
      [() => Response.json({ reason: "TooManyRequests" }, { status: 429 }), 429],
      [() => Response.json({ reason: "BadCollapseId" }, { status: 400 }), 502],
      [() => Response.json({ reason: "InternalServerError" }, { status: 500 }), 502],
      [() => new Response("not json", { status: 503 }), 502],
      [() => { throw new Error("network down"); }, 502],
    ] as const) {
      r.answer(answer);
      expect((await r.handle(pushRequest(endpoint).request)).status).toBe(expected);
    }
    expect(r.rows()).toHaveLength(1);
  });

  test("refuses what is not one push before it reaches APNs or counts against the limit", async () => {
    const endpoint = await register(r);
    const { request, headers, body } = pushRequest(endpoint);
    const resend = (changed: Record<string, string | null>, content: BodyInit = body) => {
      const next: Record<string, string> = {};
      for (const [name, value] of Object.entries({ ...headers, ...changed })) if (value !== null) next[name] = value;
      return r.handle(new Request(endpoint, { method: "POST", headers: next, body: content }));
    };
    expect((await resend({ "Content-Encoding": "aesgcm" })).status).toBe(415);
    expect((await resend({ TTL: null })).status).toBe(400);
    expect((await resend({ TTL: "soon" })).status).toBe(400);
    expect((await resend({ Topic: "not a topic!" })).status).toBe(400);
    expect((await resend({}, new Uint8Array(0))).status).toBe(400);
    expect((await resend({}, new Uint8Array(4097))).status).toBe(413);
    // fits a push service, but not APNs once encoded
    expect((await r.handle(pushRequest(endpoint, { payload: "x".repeat(3200) }).request)).status).toBe(413);
    expect((await r.handle(new Request(endpoint))).status).toBe(405);
    expect(r.calls).toEqual([]);
    expect(r.rows()[0]!["window_count"]).toBe(0);
    expect((await r.handle(request)).status).toBe(201);
  });

  test("an unknown endpoint is 404, like any other path", async () => {
    expect((await r.handle(pushRequest(`${RELAY}/v1/push/${"A".repeat(22)}`).request)).status).toBe(404);
    for (const path of ["/", "/v1/push/short", "/v1/push/", `/v1/push/${"A".repeat(22)}/x`]) {
      expect((await r.handle(new Request(`${RELAY}${path}`, { method: "POST" }))).status).toBe(404);
    }
    expect(r.calls).toEqual([]);
  });

  test("refuses an oversized push before it ends", async () => {
    const endpoint = await register(r);
    const { headers } = pushRequest(endpoint);
    // More than 4 KB arrive and the stream never closes: do not wait for the rest.
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4097)); } });
    const request = new Request(endpoint, { method: "POST", headers, body, duplex: "half" } as RequestInit);
    expect((await r.handle(request)).status).toBe(413);
    expect(r.calls).toEqual([]);
  });
});
