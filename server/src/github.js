import { config } from './config.js';

const API = 'https://api.github.com';

function headers(accept = 'application/vnd.github+json') {
	return {
		'Accept': accept,
		'Authorization': `Bearer ${config.githubToken}`,
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'bbf-extensions-server'
	};
}

async function ghFetch(url, accept) {
	const response = await fetch(url, { headers: headers(accept), redirect: 'follow' });
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw Object.assign(
			new Error(`GitHub ${response.status} ${response.statusText} for ${url}${body ? ` - ${body.slice(0, 200)}` : ''}`),
			{ status: response.status }
		);
	}
	return response;
}

/**
 * Every release in the repo, newest first, with only the .vsix assets kept.
 * Drafts are skipped; pre-releases are kept and flagged so the client can choose.
 */
export async function listVsixAssets() {
	const results = [];
	for (let page = 1; page <= 10; page++) {
		const response = await ghFetch(`${API}/repos/${config.repo}/releases?per_page=100&page=${page}`);
		const releases = await response.json();
		if (!Array.isArray(releases) || releases.length === 0) {
			break;
		}
		for (const release of releases) {
			if (release.draft) {
				continue;
			}
			for (const asset of release.assets ?? []) {
				if (!asset.name.toLowerCase().endsWith('.vsix')) {
					continue;
				}
				results.push({
					assetId: asset.id,
					assetName: asset.name,
					size: asset.size,
					updatedAt: asset.updated_at,
					releaseTag: release.tag_name,
					releaseName: release.name,
					prerelease: !!release.prerelease,
					publishedAt: release.published_at
				});
			}
		}
		if (releases.length < 100) {
			break;
		}
	}
	return results;
}

/** Download one release asset's bytes. Works for private repos; the token stays server-side. */
export async function downloadAsset(assetId) {
	const response = await ghFetch(`${API}/repos/${config.repo}/releases/assets/${assetId}`, 'application/octet-stream');
	return Buffer.from(await response.arrayBuffer());
}

/** Cheap credential/permission check used by /api/health. */
export async function checkAccess() {
	const response = await ghFetch(`${API}/repos/${config.repo}`);
	const repo = await response.json();
	return { repo: repo.full_name, private: repo.private };
}
