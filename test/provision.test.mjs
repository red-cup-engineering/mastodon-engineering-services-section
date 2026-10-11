import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { credentialsPath, openCredentials } from "../src/credentials.mjs";
import { provisionMastodonAccount } from "../src/provision.mjs";

/** A Mastodon server: registration, then email confirmation and approval, then the profile. */
function fakeServer({ minAge = 18, taken = [] } = {}) {
  const users = new Map(taken.map((name) => [name, { confirmed: true, approved: true }]));
  const tokens = new Map();
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, { method = "GET", headers = {}, body } = {}) => {
    const { pathname, searchParams } = new URL(url);
    const form = body instanceof FormData ? {} : Object.fromEntries(new URLSearchParams(body ?? ""));
    const user = tokens.get(headers.authorization?.slice(7));
    calls.push(`${method} ${pathname}`);
    switch (`${method} ${pathname}`) {
      case "GET /api/v2/instance": return reply(200, { version: "4.7.2", registrations: { enabled: true, approval_required: true, reason_required: true, min_age: minAge } });
      case "GET /api/v1/accounts/lookup": return users.get(searchParams.get("acct"))?.approved ? reply(200, { username: searchParams.get("acct") }) : reply(404, { error: "Record not found" });
      case "POST /api/v1/apps": return reply(200, { client_id: "cid", client_secret: "csecret" });
      case "POST /oauth/token": return reply(200, { access_token: "app-token" });
      case "POST /api/v1/accounts": {
        assert.equal(headers.authorization, "Bearer app-token");
        if (users.has(form.username)) return reply(422, { error: "Validation failed", details: { username: [{ error: "ERR_TAKEN" }] } });
        if (minAge && !form.date_of_birth) return reply(422, { error: "Validation failed", details: { date_of_birth: [{ error: "ERR_BLANK" }] } });
        const created = { ...form, confirmed: false, approved: false, profile: { display_name: "", source: { note: "", fields: [] }, bot: false } };
        users.set(form.username, created); tokens.set(`user-token-${form.username}`, created);
        return reply(200, { access_token: `user-token-${form.username}` });
      }
      case "GET /api/v1/accounts/verify_credentials":
        if (!user.confirmed) return reply(403, { error: "Your login is missing a confirmed e-mail address" });
        if (!user.approved) return reply(403, { error: "Your login is currently pending approval" });
        return reply(200, user.profile);
      case "PATCH /api/v1/accounts/update_credentials": {
        if (body instanceof FormData) {
          const avatar = body.get("avatar");
          assert.ok(avatar instanceof Blob && avatar.size > 0);
          user.profile = { ...user.profile, avatar: `https://files.mastodon.example/avatars/${calls.length}.png` };
          return reply(200, user.profile);
        }
        const fields = [0, 1, 2, 3].filter((i) => form[`fields_attributes[${i}][name]`]).map((i) => ({ name: form[`fields_attributes[${i}][name]`], value: form[`fields_attributes[${i}][value]`] }));
        user.profile = { ...user.profile, display_name: form.display_name, bot: form.bot === "true", source: { note: form.note, fields } };
        return reply(200, user.profile);
      }
      default: return reply(404, { error: "Record not found" });
    }
  };
  return { fetch, users, calls };
}

const credentialsIn = async () => {
  const dir = await mkdtemp(join(tmpdir(), "mastodon-creds-"));
  return { env: { MASTODON_CREDENTIALS_DIR: dir }, store: openCredentials({ MASTODON_CREDENTIALS_DIR: dir }) };
};
const PROFILE = { display_name: "Sigrid Song", note: "A fictional author-character.", bot: true, fields: [{ name: "Website", value: "https://sigridsong.neocities.org/" }] };
const person = (server, { dateOfBirth = "1990-01-01" } = {}) => {
  const asked = [];
  return {
    asked,
    ask: async ({ input }) => { asked.push("ask"); assert.ok(input.pattern.test(dateOfBirth)); return dateOfBirth; },
    confirm: async () => { asked.push("confirm"); for (const user of server.users.values()) user.confirmed = true; },
  };
};
const ARGS = { server: "mastodon.example", username: "sigridsong", email: "sigrid.song@example.com", reason: "A labelled author persona.", profile: PROFILE };

test("registers, has the person confirm, waits on approval, then keeps the profile", async () => {
  const server = fakeServer();
  const { env, store } = await credentialsIn();
  const at = person(server);
  const first = await provisionMastodonAccount({ ...ARGS, fetch: server.fetch, credentials: store, person: at });
  assert.equal(first.state, "awaiting-approval");
  assert.deepEqual(at.asked, ["ask", "confirm"]);
  assert.equal(server.users.get("sigridsong").date_of_birth, "1990-01-01");
  const saved = await store.read("mastodon.example", "sigridsong");
  assert.equal(saved.access_token, "user-token-sigridsong");
  assert.equal(saved.dateOfBirth, undefined, "the date of birth is never kept");
  assert.equal((await stat(credentialsPath("mastodon.example", "sigridsong", env))).mode & 0o777, 0o600);

  server.users.get("sigridsong").approved = true;
  const second = await provisionMastodonAccount({ ...ARGS, fetch: server.fetch, credentials: store, person: null });
  assert.deepEqual([second.state, second.profile], ["held", "updated"]);
  const third = await provisionMastodonAccount({ ...ARGS, fetch: server.fetch, credentials: store, person: null });
  assert.deepEqual([third.state, third.profile], ["held", "current"]);
  assert.equal(server.calls.filter((c) => c === "POST /api/v1/accounts").length, 1);
});

test("refuses a username someone else holds", async () => {
  const server = fakeServer({ taken: ["sigridsong"] });
  const { store } = await credentialsIn();
  await assert.rejects(provisionMastodonAccount({ ...ARGS, fetch: server.fetch, credentials: store }), /already exists/u);
});

test("a server with a minimum age needs a person, and an adult one", async () => {
  const server = fakeServer();
  const { store } = await credentialsIn();
  await assert.rejects(provisionMastodonAccount({ ...ARGS, fetch: server.fetch, credentials: store }), /run with a person/u);
  await assert.rejects(provisionMastodonAccount({ ...ARGS, fetch: server.fetch, credentials: store, person: person(server, { dateOfBirth: new Date().toISOString().slice(0, 10) }) }), /18 or older/u);
  assert.ok(!server.calls.includes("POST /api/v1/accounts"));
});

test("a dry run registers nothing", async () => {
  const server = fakeServer();
  const { store } = await credentialsIn();
  const result = await provisionMastodonAccount({ ...ARGS, fetch: server.fetch, credentials: store, dryRun: true });
  assert.deepEqual([result.state, result.minAge, result.approvalRequired], ["would-register", 18, true]);
  assert.equal(await store.read("mastodon.example", "sigridsong"), null);
});

test("the avatar is uploaded once, and a later run that finds the server still serving it reports it current", async () => {
  const server = fakeServer({ minAge: 0 });
  const { store } = await credentialsIn();
  const at = person(server);
  await provisionMastodonAccount({ ...ARGS, fetch: server.fetch, credentials: store, person: at });
  server.users.get("sigridsong").approved = true;
  const avatar = { bytes: new Uint8Array([137, 80, 78, 71]), digest: "sha256:aa", mimeType: "image/png", filename: "avatar.png" };
  const first = await provisionMastodonAccount({ ...ARGS, avatar, fetch: server.fetch, credentials: store });
  assert.equal(first.avatar.state, "updated");
  assert.match(first.avatar.url, /^https:\/\/files\.mastodon\.example\/avatars\//u);
  const uploads = () => server.calls.filter((c) => c === "PATCH /api/v1/accounts/update_credentials").length;
  const before = uploads();
  const again = await provisionMastodonAccount({ ...ARGS, avatar, heldAvatar: first.avatar, fetch: server.fetch, credentials: store });
  assert.deepEqual([again.profile, again.avatar.state, uploads()], ["current", "current", before]);
  // A new mark is uploaded again.
  const next = await provisionMastodonAccount({ ...ARGS, avatar: { ...avatar, digest: "sha256:bb" }, heldAvatar: first.avatar, fetch: server.fetch, credentials: store });
  assert.equal(next.avatar.state, "updated");
  assert.equal(uploads(), before + 1);
});
