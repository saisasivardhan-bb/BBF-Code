import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Alternative source: serve .vsix files from a directory instead of GitHub.
 *
 * Set LOCAL_VSIX_DIR to use it. Handy for trying the feed before a release
 * repository exists, and for air-gapped installs where GitHub is unreachable.
 */

export function isLocalMode() {
	return !!process.env.LOCAL_VSIX_DIR;
}

function dir() {
	return process.env.LOCAL_VSIX_DIR;
}

export async function listLocalAssets() {
	const base = dir();
	let names;
	try {
		names = await readdir(base);
	} catch (error) {
		throw new Error(`LOCAL_VSIX_DIR "${base}" cannot be read: ${error.message}`);
	}

	const assets = [];
	for (const name of names) {
		if (!name.toLowerCase().endsWith('.vsix')) {
			continue;
		}
		const full = join(base, name);
		const info = await stat(full);
		assets.push({
			// The path doubles as the asset id in local mode.
			assetId: full,
			assetName: name,
			size: info.size,
			updatedAt: info.mtime.toISOString(),
			releaseTag: 'local',
			releaseName: 'Local directory',
			prerelease: false,
			publishedAt: info.mtime.toISOString()
		});
	}
	return assets;
}

export async function readLocalAsset(assetId) {
	return readFile(assetId);
}

export async function checkLocalAccess() {
	const base = dir();
	const assets = await listLocalAssets();
	return { source: 'local', directory: base, vsixCount: assets.length };
}
