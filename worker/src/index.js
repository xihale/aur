// Cloudflare Email Worker: relay GitHub release notification emails to the
// aur monorepo CI as repository_dispatch events.
//
// Email Routing rule "releases@<domain>" -> this worker.
// Secrets (wrangler secret put):
//   GITHUB_TOKEN  fine-grained PAT: repo <GITHUB_REPO>, Contents: read+write
// Vars (wrangler.toml):
//   GITHUB_REPO   "owner/repo" of the monorepo
import PostalMime from 'postal-mime';

const NOTIFICATIONS_ADDR = /@github\.com$/i;
// https://github.com/<owner>/<repo>/releases/tag/<tag>
const RELEASE_LINK =
	/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/tag\/([^?#\s"'`)<>\\]+)/g;
// subject fallback: "[owner/repo] Release <tag-or-title>"
const SUBJECT_RELEASE = /^\[([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\] Release (.+)$/;

// postal-mime exposes headers as [{key, value}, ...]
const header = (parsed, name) =>
	parsed.headers?.find?.((h) => h.key === name)?.value ?? '';

export default {
	async email(message, env, ctx) {
		const parsed = await PostalMime.parse(message.raw);
		const from = parsed.from?.address ?? '';
		if (!NOTIFICATIONS_ADDR.test(from)) {
			return message.setReject(`unexpected sender: ${from}`);
		}
		// Soft authentication check: GitHub signs with d=github.com. A forged
		// mail can at worst point CI at a tag that really exists upstream,
		// which the workflow resolves through the GitHub API anyway.
		const ar = header(parsed, 'authentication-results');
		if (ar && !/dkim\s*=\s*pass/i.test(ar)) {
			return message.setReject('dkim did not pass');
		}

		const index = await getIndex(env);
		const body = `${parsed.subject ?? ''}\n${parsed.text ?? ''}\n${parsed.html ?? ''}`;

		// repo -> tag; links win over the subject line
		const found = new Map();
		for (const [, owner, repo, tag] of body.matchAll(RELEASE_LINK)) {
			found.set(`${owner}/${repo}`, tag);
		}
		const sm = SUBJECT_RELEASE.exec(parsed.subject ?? '');
		if (sm && !found.has(`${sm[1]}/${sm[2]}`) && /^[v]?\d/.test(sm[3])) {
			found.set(`${sm[1]}/${sm[2]}`, sm[3]);
		}

		for (const [repo, tag] of found) {
			if (!index[repo]) continue; // not watched
			console.log(`dispatch: ${repo} ${tag} -> ${index[repo].map((p) => p.pkg).join(',')}`);
			ctx.waitUntil(dispatch(env, repo, tag));
		}
		// GitHub mail that isn't a watched release (issues, PRs, security
		// alerts): forward so pointing the notification address here loses
		// nothing. FORWARD_TO must be a verified destination on the account.
		if (env.FORWARD_TO) await message.forward(env.FORWARD_TO);
	},

	async fetch() {
		return new Response('aur-release-relay: email worker, nothing over HTTP\n');
	},
};

async function getIndex(env) {
	const res = await fetch(
		`https://api.github.com/repos/${env.GITHUB_REPO}/contents/index.json`,
		{
			headers: {
				Authorization: `Bearer ${env.GITHUB_TOKEN}`,
				Accept: 'application/vnd.github.raw',
				'User-Agent': 'aur-release-relay',
				'X-GitHub-Api-Version': '2022-11-28',
			},
		},
	);
	if (!res.ok) throw new Error(`index fetch failed: ${res.status}`);
	return res.json();
}

async function dispatch(env, repo, tag) {
	const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'aur-release-relay',
			'X-GitHub-Api-Version': '2022-11-28',
		},
		body: JSON.stringify({event_type: 'upstream-release', client_payload: {repo, tag}}),
	});
	if (!res.ok) throw new Error(`dispatch failed: ${res.status} ${await res.text()}`);
}
