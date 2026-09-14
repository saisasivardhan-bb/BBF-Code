import { config } from './config.js';
import { listVsixAssets as listGithubAssets, downloadAsset as downloadGithubAsset } from './github.js';
import { listLocalAssets, readLocalAsset, isLocalMode } from './local.js';
import { readVsix, compareVersions } from './vsix.js';

/**
 * The catalog: every .vsix found across the repo's releases, parsed once and
 * cached. Each asset is downloaded a single time to read its manifest; after
 * that only the bytes for an actual install are fetched again.
 */

/** assetId -> parsed metadata (icon stripped out, held separately). */
const parsedAssets = new Map();
/** `${id}@${version}` -> { data, contentType } */
const icons = new Map();
/** `${id}@${version}` -> { readme, changelog, licenseText } */
const docs = new Map();
/** `${id}@${version}` -> assetId, so downloads can find their asset. */
const assetForVersion = new Map();

let catalog = { updatedAt: null, extensions: [] };
let lastRefresh = 0;
let inFlight = null;

export function getCatalog() {
	return catalog;
}

export function getIcon(id, version) {
	return icons.get(`${id}@${version}`);
}

export function getDocs(id, version) {
	return docs.get(`${id}@${version}`);
}

export function getAssetId(id, version) {
	return assetForVersion.get(`${id}@${version}`);
}

export async function refresh({ force = false } = {}) {
	const fresh = Date.now() - lastRefresh < config.refreshMs;
	if (!force && fresh && catalog.updatedAt) {
		return catalog;
	}
	// Collapse concurrent refreshes into one GitHub round-trip.
	if (inFlight) {
		return inFlight;
	}
	inFlight = doRefresh().finally(() => { inFlight = null; });
	return inFlight;
}

async function doRefresh() {
	const assets = isLocalMode() ? await listLocalAssets() : await listGithubAssets();
	const seen = new Set();
	const versions = [];
	const problems = [];

	for (const asset of assets) {
		seen.add(asset.assetId);
		try {
			let parsed = parsedAssets.get(asset.assetId);
			if (!parsed) {
				const buffer = isLocalMode() ? await readLocalAsset(asset.assetId) : await downloadGithubAsset(asset.assetId);
				const vsix = readVsix(buffer);
				const key = `${vsix.id}@${vsix.version}`;
				if (vsix.icon) {
					icons.set(key, vsix.icon);
				}
				docs.set(key, { readme: vsix.readme, changelog: vsix.changelog, licenseText: vsix.licenseText });
				// Keep the large text out of the catalog; it is fetched per asset.
				parsed = {
					...vsix,
					icon: undefined,
					readme: undefined,
					changelog: undefined,
					licenseText: undefined,
					hasIcon: !!vsix.icon,
					hasReadme: !!vsix.readme,
					hasChangelog: !!vsix.changelog,
					hasLicense: !!vsix.licenseText
				};
				parsedAssets.set(asset.assetId, parsed);
			}
			assetForVersion.set(`${parsed.id}@${parsed.version}`, asset.assetId);
			versions.push({ ...parsed, ...asset });
		} catch (error) {
			// One malformed .vsix must not take down the whole feed.
			problems.push({ asset: asset.assetName, release: asset.releaseTag, error: String(error.message || error) });
		}
	}

	// Drop caches for assets that no longer exist (release or asset deleted).
	for (const assetId of [...parsedAssets.keys()]) {
		if (!seen.has(assetId)) {
			parsedAssets.delete(assetId);
		}
	}

	// Keep every version, but mark the newest non-prerelease as `latest`.
	const byId = new Map();
	for (const entry of versions) {
		const list = byId.get(entry.id) ?? [];
		list.push(entry);
		byId.set(entry.id, list);
	}

	const extensions = [];
	for (const [id, list] of byId) {
		list.sort((a, b) => compareVersions(b.version, a.version));
		const stable = list.filter((e) => !e.prerelease);
		const latest = (stable[0] ?? list[0]);
		extensions.push({
			id,
			publisher: latest.publisher,
			name: latest.name,
			displayName: latest.displayName,
			description: latest.description,
			categories: latest.categories,
			license: latest.license,
			repository: latest.repository,
			engines: latest.engines,
			version: latest.version,
			sha256: latest.sha256,
			size: latest.size,
			prerelease: latest.prerelease,
			releaseTag: latest.releaseTag,
			publishedAt: latest.publishedAt,
			iconUrl: latest.hasIcon ? `${config.publicUrl}/api/extensions/${id}/${latest.version}/icon` : null,
			hasReadme: !!latest.hasReadme,
			hasChangelog: !!latest.hasChangelog,
			hasLicense: !!latest.hasLicense,
			downloadUrl: `${config.publicUrl}/api/extensions/${id}/${latest.version}/vsix`,
			versions: list.map((v) => ({
				version: v.version,
				prerelease: v.prerelease,
				releaseTag: v.releaseTag,
				publishedAt: v.publishedAt,
				size: v.size,
				sha256: v.sha256,
				downloadUrl: `${config.publicUrl}/api/extensions/${id}/${v.version}/vsix`
			}))
		});
	}

	extensions.sort((a, b) => a.displayName.localeCompare(b.displayName));

	catalog = { updatedAt: new Date().toISOString(), extensions, problems };
	lastRefresh = Date.now();
	return catalog;
}
