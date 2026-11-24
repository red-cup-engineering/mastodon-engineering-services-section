#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { provisionMastodonAccount } from "../src/provision.mjs";

const USAGE = "usage: mastodon-account <username@server> [--email <address>] [--reason <text>] [--profile <profile.json>] [--dry-run]\n"
  + "  Makes @<username>@<server> a Mastodon account the house holds: registers it when the name is free,\n"
  + "  keeping its password and token in ~/.config/561-group/mastodon, reports what the server still waits on\n"
  + "  (the email confirmation, a moderator's approval), then keeps its public profile equal to --profile.\n"
  + "  Servers that ask a date of birth need a person: use persona-provision, which opens the assisted browser.";

export async function main(argv, { output = process.stdout } = {}) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { email: { type: "string" }, reason: { type: "string" }, profile: { type: "string" }, "dry-run": { type: "boolean" } },
  });
  const [username, server] = (positionals[0] ?? "").replace(/^@/u, "").split("@");
  if (positionals.length !== 1 || !username || !server) throw new Error(USAGE);
  const profile = values.profile ? JSON.parse(await readFile(values.profile, "utf8")) : undefined;
  const result = await provisionMastodonAccount({
    server, username, email: values.email, reason: values.reason, profile, dryRun: values["dry-run"],
    notify: (message) => process.stderr.write(`${message}\n`),
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(error.message ?? error); process.exitCode = 1; }
}
