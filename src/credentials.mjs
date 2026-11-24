import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertServer, assertUsername } from "./mastodon.mjs";

/**
 * Private files in ~/.config/561-group/mastodon/<server>/<username>.json (dirs
 * 0700, files 0600): the account's email, password, app and token. Written
 * before the server is asked for anything, so a run that stops halfway leaves
 * what the next run needs to finish.
 */
export const credentialsDir = (env = process.env) =>
  env.MASTODON_CREDENTIALS_DIR ?? join(env.HOME ?? homedir(), ".config", "561-group", "mastodon");

export const credentialsPath = (server, username, env) =>
  join(credentialsDir(env), assertServer(server), `${assertUsername(username).toLowerCase()}.json`);

export function openCredentials(env = process.env) {
  return Object.freeze({
    describe: credentialsDir(env),
    async read(server, username) {
      try {
        return JSON.parse(await readFile(credentialsPath(server, username, env), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async write(server, username, value) {
      const path = credentialsPath(server, username, env);
      for (const dir of [credentialsDir(env), join(credentialsDir(env), server)]) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700);
      }
      const staging = `${path}.${process.pid}.tmp`;
      await writeFile(staging, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await chmod(staging, 0o600);
      await rename(staging, path);
      return path;
    },
  });
}
