import { randomBytes } from "node:crypto";
import { openCredentials } from "./credentials.mjs";
import {
  accountState, appToken, assertServer, assertUsername, lookupAccount, profileOf,
  registerAccount, registerApp, registrationTerms, updateAvatar, updateProfile,
} from "./mastodon.mjs";

/**
 * A Mastodon account the house holds. Provisioning is a reconcile: it reads
 * the private credentials and the server, then does only what is missing.
 *
 * - A token is stored and the server lets it act: held; the profile is kept
 *   equal to the one asked for, and the avatar is the image asked for. The
 *   server re-encodes what it is sent, so the avatar is known by what was
 *   sent: `avatar` ({ bytes, digest, mimeType, filename }) is uploaded unless
 *   `heldAvatar` (the { digest, url } an earlier result reported) has its
 *   digest and the server still serves that url.
 * - A token is stored and the server still waits on the email confirmation:
 *   the person at the node is asked to click the link (the page may show a
 *   captcha); waiting on a moderator's approval needs nothing but time.
 * - No account: the username must be free; the password and app are stored
 *   first, then the server is asked to register the account, with the reason
 *   its moderators read and the date of birth its minimum age asks for. The
 *   date of birth is the person's, asked each time and never stored.
 *
 * `person` is the human at the node, or null: `ask({ text, input })` resolves
 * with a typed value, `confirm(text)` when they have done a step by hand.
 * Results are public facts only.
 */

const sameProfile = (have, want) => Object.entries(want).every(([key, value]) => JSON.stringify(have[key]) === JSON.stringify(value));
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function adult(dateOfBirth, minAge, today = new Date()) {
  const [y, m, d] = dateOfBirth.split("-").map(Number);
  const age = today.getUTCFullYear() - y - ((today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d)) ? 1 : 0);
  return age >= minAge;
}

export async function provisionMastodonAccount({
  server,
  username,
  email,
  reason,
  profile,
  avatar = null,
  heldAvatar = null,
  dryRun = false,
  credentials = openCredentials(),
  person = null,
  fetch: fetchImpl = fetch,
  random = randomBytes,
  notify = () => {},
  appName = "561 Group persona accounts",
  appWebsite = "https://561.group/",
} = {}) {
  assertServer(server); assertUsername(username);
  const options = { fetch: fetchImpl };
  const result = { platform: "mastodon", server, username, handle: `@${username}@${server}`, url: `https://${server}/@${username}` };
  let stored = await credentials.read(server, username);

  if (!stored?.access_token) {
    if (await lookupAccount(server, username, options)) throw new Error(`${result.handle} already exists and the house holds no token for it`);
    const terms = await registrationTerms(server, options);
    if (!terms.enabled) throw new Error(`${server} is not taking registrations`);
    if (terms.reason_required && !reason) throw new Error(`${server} asks why the account should exist; give a reason`);
    if (!email) throw new Error(`registering ${result.handle} needs an email address`);
    if (dryRun) return { ...result, state: "would-register", approvalRequired: terms.approval_required, minAge: terms.min_age ?? null };

    let dateOfBirth;
    if (terms.min_age) {
      if (!person) throw new Error(`${server} requires account holders to be ${terms.min_age} or older and asks for a date of birth; run with a person at the node`);
      dateOfBirth = await person.ask({
        text: `${server} only lets people ${terms.min_age} or older hold an account, and asks the date of birth of whoever is responsible for ${result.handle}. That is you: type your date of birth. It goes to ${server} once and is not kept.`,
        input: { label: "Your date of birth (YYYY-MM-DD)", pattern: DATE, secret: true, placeholder: "YYYY-MM-DD" },
      });
      if (!adult(dateOfBirth, terms.min_age)) throw new Error(`${server} requires account holders to be ${terms.min_age} or older`);
    }

    stored ??= { server, username, email, password: random(24).toString("base64url"), createdAt: new Date().toISOString() };
    stored.app ??= await registerApp(server, { name: appName, website: appWebsite }, options);
    await credentials.write(server, username, stored);
    const clientToken = await appToken(server, stored.app, options);
    stored.access_token = await registerAccount(server, clientToken, { username, email: stored.email, password: stored.password, reason, dateOfBirth }, options);
    stored.registeredAt = new Date().toISOString();
    await credentials.write(server, username, stored);
    notify(`mastodon: registered ${result.handle}; ${server} has emailed ${stored.email}`);
    result.registered = stored.registeredAt;
  }

  let { state, account } = await accountState(server, stored.access_token, options);
  if (state === "awaiting-email-confirmation" && person && !dryRun) {
    await person.confirm(`${server} has emailed ${stored.email} a link to confirm ${result.handle}. Open that email and click the link; if the page shows a captcha, solve it. Click Done once the page says the address is confirmed.`);
    ({ state, account } = await accountState(server, stored.access_token, options));
  }
  if (state === "disabled" || state === "token-revoked") throw new Error(`${server} says ${result.handle} is ${state}`);
  result.state = state === "active" ? "held" : state;
  if (state !== "active") return { ...result, profile: profile ? "waits-on-account" : "none-asked" };

  if (profile && !sameProfile(profileOf(account), profile)) {
    if (dryRun) return { ...result, profile: "would-update" };
    account = await updateProfile(server, stored.access_token, profile, options);
    result.profile = "updated";
  } else {
    result.profile = profile ? "current" : "none-asked";
  }

  if (avatar) {
    if (heldAvatar?.digest === avatar.digest && heldAvatar.url === account.avatar) {
      result.avatar = { digest: avatar.digest, url: account.avatar, state: "current" };
    } else if (dryRun) {
      result.avatar = { digest: avatar.digest, state: "would-update" };
    } else {
      account = await updateAvatar(server, stored.access_token, avatar, options);
      result.avatar = { digest: avatar.digest, url: account.avatar, state: "updated" };
    }
  }
  return result;
}
