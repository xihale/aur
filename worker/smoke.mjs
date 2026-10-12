import worker from './src/index.js';

const mk = (headers, body) =>
	`${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${body}\n`;

const GITHUB_HEADERS = {
	From: 'GitHub <notifications@github.com>',
	To: 'releases@example.com',
	'Authentication-Results': 'mx.cloudflare.com; dkim=pass header.d=github.com',
	'List-Id': 'usestrix/strix <usestrix.strix.github.com>',
};

const env = { GITHUB_REPO: 'xihale/aur', GITHUB_TOKEN: 't', FORWARD_TO: 'inbox@qq.com' };
const INDEX = { 'usestrix/strix': [{ pkg: 'strix-bin', tag_to_pkgver: ['s/^v//'] }] };

async function run(name, mime) {
	const calls = [];
	const rejects = [];
	const forwards = [];
	globalThis.fetch = async (url, opts) => {
		calls.push({ url: String(url), method: opts?.method, body: opts?.body });
		if (String(url).includes('/contents/index.json'))
			return new Response(JSON.stringify(INDEX), { status: 200 });
		return new Response(null, { status: 204 });
	};
	const message = { raw: new Response(mime).body, setReject: (r) => rejects.push(r), forward: async () => forwards.push(1) };
	await worker.email(message, env, { waitUntil: (p) => p });
	console.log(`--- ${name}`);
	console.log('rejects:', rejects);
	console.log('dispatches:', calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body)));
	console.log('forwards:', forwards.length);
}

// 1. real release mail, watched repo -> dispatch
await run('watched release', mk(GITHUB_HEADERS, 'usestrix/strix released v1.7.0:\nhttps://github.com/usestrix/strix/releases/tag/v1.7.0'));

// 2. unwatched repo -> no dispatch
await run('unwatched repo', mk(GITHUB_HEADERS, 'see https://github.com/foo/bar/releases/tag/v1.0.0'));

// 3. forged sender -> reject
await run('forged sender', mk({ ...GITHUB_HEADERS, From: 'attacker@evil.example' }, 'https://github.com/usestrix/strix/releases/tag/v9.9.9'));

// 4. dkim fail -> reject
await run('dkim fail', mk({ ...GITHUB_HEADERS, 'Authentication-Results': 'mx.cloudflare.com; dkim=fail' }, 'https://github.com/usestrix/strix/releases/tag/v9.9.9'));

// 5. subject fallback, tag from subject
await run('subject only', mk({ ...GITHUB_HEADERS, Subject: '[usestrix/strix] Release v1.7.1' }, 'new release is out'));

// 6. html body with quoted link
await run('html body', mk({ ...GITHUB_HEADERS, 'Content-Type': 'text/html; charset=utf-8' }, '<a href="https://github.com/usestrix/strix/releases/tag/v1.8.0">Release</a>'));
