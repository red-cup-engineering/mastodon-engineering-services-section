/**
 * The parts of a Mastodon server's REST API that make and keep an account:
 * the instance's registration terms, an app and its client token, the account
 * itself, the signed-in account and its profile; and the parts an account
 * lives by: posting a status and reading its notifications. Credential-blind: every
 * token comes in as an argument, and no error carries one.
 */

export class MastodonApiError extends Error {
  constructor(status, body, where) {
    super(`${where}: ${status} ${body?.error ?? ""}${body?.details ? ` ${JSON.stringify(body.details)}` : ""}`.trim());
    Object.assign(this, { status, body });
  }
}

/** A server's host name, as the house names servers: "mastodon.world". */
export function assertServer(server) {
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/u.test(String(server))) throw new TypeError(`not a server host name: ${server}`);
  return server;
}

/** Mastodon usernames: letters, digits and underscores, at most 30. */
export function assertUsername(username) {
  if (!/^[A-Za-z0-9_]{1,30}$/u.test(String(username))) throw new TypeError(`not a Mastodon username: ${username}`);
  return username;
}

async function call(server, path, { fetch: fetchImpl = fetch, token, method = "GET", form, json, multipart, headers: extra = {} } = {}) {
  const headers = { accept: "application/json", ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (form) { body = new URLSearchParams(form); headers["content-type"] = "application/x-www-form-urlencoded"; }
  if (json) { body = JSON.stringify(json); headers["content-type"] = "application/json"; }
  if (multipart) body = multipart; // FormData sets its own content-type with the boundary
  const response = await fetchImpl(`https://${assertServer(server)}${path}`, { method, headers, body });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text.slice(0, 200) }; }
  if (!response.ok) throw new MastodonApiError(response.status, parsed, `${method} ${server}${path.split("?")[0]}`);
  return parsed;
}

/** Registration terms: { enabled, approval_required, reason_required, min_age }. */
export async function registrationTerms(server, options) {
  const instance = await call(server, "/api/v2/instance", options);
  return { version: instance.version, ...instance.registrations, limits: instance.configuration?.accounts ?? {} };
}

/** The server's rules, as its moderators state them: what anything posted there must keep. */
export async function serverRules(server, options) {
  const rules = await call(server, "/api/v1/instance/rules", options);
  return (rules ?? []).map(({ text, hint }) => (hint ? `${text} (${hint})` : text));
}

/** The local account with this username, or null. Unapproved accounts are not shown. */
export async function lookupAccount(server, username, options) {
  try {
    return await call(server, `/api/v1/accounts/lookup?acct=${encodeURIComponent(assertUsername(username))}`, options);
  } catch (error) {
    if (error instanceof MastodonApiError && error.status === 404) return null;
    throw error;
  }
}

export const SCOPES = "read write";
const OOB = "urn:ietf:wg:oauth:2.0:oob";

/** An app on the server: { client_id, client_secret }. */
export async function registerApp(server, { name, website } = {}, options) {
  const app = await call(server, "/api/v1/apps", { ...options, method: "POST", form: { client_name: name, redirect_uris: OOB, scopes: SCOPES, ...(website ? { website } : {}) } });
  return { client_id: app.client_id, client_secret: app.client_secret };
}

/** The app's own token (client credentials), which registration needs. */
export async function appToken(server, { client_id, client_secret }, options) {
  const token = await call(server, "/oauth/token", { ...options, method: "POST", form: { grant_type: "client_credentials", client_id, client_secret, redirect_uri: OOB, scope: SCOPES } });
  return token.access_token;
}

/**
 * Register an account. The server emails a confirmation link to `email`, then
 * (when it asks for approval) a moderator reads `reason`. The token returned
 * works once both are done.
 */
export async function registerAccount(server, token, { username, email, password, reason, dateOfBirth, locale = "en" }, options) {
  const form = { username: assertUsername(username), email, password, agreement: "true", locale };
  if (reason) form.reason = reason;
  if (dateOfBirth) form.date_of_birth = dateOfBirth;
  const created = await call(server, "/api/v1/accounts", { ...options, token, method: "POST", form });
  return created.access_token;
}

/** What a token's account can do now. */
export const ACCOUNT_STATES = Object.freeze({
  "Your login is missing a confirmed e-mail address": "awaiting-email-confirmation",
  "Your login is currently pending approval": "awaiting-approval",
  "Your login is currently disabled": "disabled",
});

/** { state: "active", account } or { state } for an account the server does not yet (or no longer) let act. */
export async function accountState(server, token, options) {
  try {
    return { state: "active", account: await call(server, "/api/v1/accounts/verify_credentials", { ...options, token }) };
  } catch (error) {
    if (error instanceof MastodonApiError && error.status === 403 && ACCOUNT_STATES[error.body?.error]) return { state: ACCOUNT_STATES[error.body.error] };
    if (error instanceof MastodonApiError && error.status === 401) return { state: "token-revoked" };
    throw error;
  }
}

/** Send the confirmation email again. */
export const resendConfirmation = (server, token, options) => call(server, "/api/v1/emails/confirmations", { ...options, token, method: "POST" });

/** The profile as the house asks for it: { display_name, note, bot, fields: [{ name, value }] }. */
export function profileOf(account) {
  return {
    display_name: account.display_name ?? "",
    note: account.source?.note ?? "",
    bot: Boolean(account.bot),
    fields: (account.source?.fields ?? account.fields ?? []).map(({ name, value }) => ({ name, value })),
  };
}

export async function updateProfile(server, token, { display_name, note, bot, fields }, options) {
  const form = {};
  if (display_name !== undefined) form.display_name = display_name;
  if (note !== undefined) form.note = note;
  if (bot !== undefined) form.bot = String(Boolean(bot));
  (fields ?? []).forEach(({ name, value }, index) => {
    form[`fields_attributes[${index}][name]`] = name;
    form[`fields_attributes[${index}][value]`] = value;
  });
  return call(server, "/api/v1/accounts/update_credentials", { ...options, token, method: "PATCH", form });
}

/**
 * Set the account's avatar to these image bytes (PNG, JPEG, GIF or WebP; the server re-encodes and crops it
 * square). Returns the account, whose `avatar` is the address the server now serves it at.
 */
export async function updateAvatar(server, token, { bytes, mimeType, filename }, options) {
  const multipart = new FormData();
  multipart.append("avatar", new Blob([bytes], { type: mimeType }), filename);
  return call(server, "/api/v1/accounts/update_credentials", { ...options, token, method: "PATCH", multipart });
}

/**
 * Post a status. `idempotencyKey` makes the server answer a repeat of the
 * same key with the status it already made, so a post retried after a lost
 * reply is not posted twice. Returns { id, url, created_at }.
 */
export async function postStatus(server, token, { status, visibility = "public", language = "en", spoilerText, inReplyToId, idempotencyKey }, options) {
  const form = { status, visibility, language };
  if (spoilerText) form.spoiler_text = spoilerText;
  if (inReplyToId) form.in_reply_to_id = inReplyToId;
  const posted = await call(server, "/api/v1/statuses", { ...options, token, method: "POST", form, headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {} });
  return { id: posted.id, url: posted.url, created_at: posted.created_at };
}

/** A status's public link, or null when the server no longer has it. */
export async function statusOf(server, id, options) {
  try {
    const status = await call(server, `/api/v1/statuses/${encodeURIComponent(id)}`, options);
    return { id: status.id, url: status.url, created_at: status.created_at };
  } catch (error) {
    if (error instanceof MastodonApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Notifications newer than `sinceId`, oldest first: mentions, replies,
 * follows, boosts and favourites. Each is { id, type, at, from, status? },
 * where `status` carries its visibility, so a reader can keep a direct
 * message out of anything public.
 */
export async function notifications(server, token, { sinceId, limit = 40 } = {}, options) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (sinceId) query.set("since_id", sinceId);
  const rows = await call(server, `/api/v1/notifications?${query}`, { ...options, token });
  return rows.map((row) => ({
    id: row.id, type: row.type, at: row.created_at, from: row.account?.acct ?? null,
    ...(row.status ? { status: { id: row.status.id, url: row.status.url, visibility: row.status.visibility, inReplyToId: row.status.in_reply_to_id, content: row.status.content } } : {}),
  })).reverse();
}
