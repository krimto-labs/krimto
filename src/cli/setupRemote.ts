// `krimto setup-remote <url>` — wire the data folder's git repo to a remote (GitHub, GitLab, etc.)
// and verify the push works on the spot. Krimto's batcher will auto-push every batch from this
// point on; setting KRIMTO_GIT_REMOTE in the env on next boot also turns on auto-pull.

import { GitRepo } from "../storage/git";

export interface SetupRemoteResult {
  /** "ok" — remote configured + first push succeeded. */
  /** "push_failed" — remote configured locally; push errored (empty repo, ssh key, etc.). */
  /** "invalid_url" — URL didn't look like a git remote at all. */
  status: "ok" | "push_failed" | "invalid_url";
  message: string;
  /** The URL the user provided, surfaced back so error messages can quote it. */
  url: string;
}

// Minimal guard against obvious typos. Anything with whitespace or no `/`/`:` separator
// (e.g. "not a url") is rejected up front; everything else is handed to git, which is the
// authoritative URL parser (accepts ssh, https, file://, bare local paths, etc.).
function looksLikeRemoteUrl(url: string): boolean {
  if (url.trim() !== url || url.length === 0) return false;
  if (/\s/.test(url)) return false;
  return /[:/]/.test(url);
}

export async function runSetupRemote(dataDir: string, url: string): Promise<SetupRemoteResult> {
  if (!looksLikeRemoteUrl(url)) {
    return {
      status: "invalid_url",
      url,
      message:
        `\n🔴 Invalid URL: "${url}"\n` +
        `\n   Expected something like:\n` +
        `     git@github.com:acme/krimto-data.git\n` +
        `     https://github.com/acme/krimto-data.git\n`,
    };
  }
  const repo = await GitRepo.open(dataDir);
  await repo.setRemote(url);
  const push = await repo.push();
  if (push.status === "ok") {
    return {
      status: "ok",
      url,
      message:
        `\n✅ Remote configured and initial push succeeded.\n` +
        `\n   ${url}\n` +
        `\n━━ Next ━━\n` +
        `\n   To also auto-pull teammates' edits (every 60s), set on next boot:\n` +
        `     $ export KRIMTO_GIT_REMOTE=${url}\n` +
        `\n   The batcher will auto-push every commit from now on regardless.\n`,
    };
  }
  return {
    status: "push_failed",
    url,
    message:
      `\n⚠️  Remote added locally — initial push failed\n` +
      `\n   ${url}\n` +
      `\n   Git said: ${push.detail ?? "(no detail)"}\n` +
      `\n━━ Common causes ━━\n` +
      `\n   • The remote repo isn't empty (has a README or initial commit).\n` +
      `     Fix: delete the README on the remote, then re-run setup-remote.\n` +
      `\n   • Your SSH key isn't set up for ${url.startsWith("git@") ? "this host" : "the remote"}.\n` +
      `     Fix: see your git host's "Add SSH key" docs.\n` +
      `\n   • Wrong URL, or you don't have write access.\n`,
  };
}
