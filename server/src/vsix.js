import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';

/**
 * A .vsix is a zip with the extension rooted at `extension/`. Reading its
 * package.json is what lets someone publish an extension by dropping the file
 * into a GitHub release, with no extra metadata to keep in sync.
 */
export function readVsix(buffer) {
	const zip = new AdmZip(buffer);

	const manifestEntry = zip.getEntry('extension/package.json');
	if (!manifestEntry) {
		throw new Error('Not a valid .vsix: extension/package.json is missing.');
	}

	const manifest = JSON.parse(zip.readAsText(manifestEntry));
	const { publisher, name, version } = manifest;
	if (!publisher || !name || !version) {
		throw new Error('extension/package.json must declare publisher, name and version.');
	}

	// Documentation shown in the extension editor. vsce lowercases these names,
	// but publishers vary, so match case-insensitively.
	const findText = (...candidates) => {
		for (const entry of zip.getEntries()) {
			const name = entry.entryName.toLowerCase();
			if (candidates.some(c => name === `extension/${c}`)) {
				return zip.readAsText(entry);
			}
		}
		return undefined;
	};
	const readme = findText('readme.md', 'readme.markdown', 'readme.txt', 'readme');
	const changelog = findText('changelog.md', 'changelog.markdown', 'changelog.txt', 'changelog');
	const licenseText = findText('license.txt', 'license.md', 'license');

	let icon;
	if (manifest.icon) {
		const iconEntry = zip.getEntry(`extension/${manifest.icon.replace(/^\.\//, '')}`);
		if (iconEntry) {
			icon = {
				data: zip.readFile(iconEntry),
				contentType: contentTypeFor(manifest.icon)
			};
		}
	}

	return {
		id: `${publisher}.${name}`,
		publisher,
		name,
		version,
		displayName: manifest.displayName || name,
		description: manifest.description || '',
		categories: manifest.categories || [],
		engines: manifest.engines || {},
		license: manifest.license || '',
		repository: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url || '',
		sha256: createHash('sha256').update(buffer).digest('hex'),
		readme,
		changelog,
		licenseText,
		icon
	};
}

function contentTypeFor(path) {
	const ext = path.toLowerCase().split('.').pop();
	switch (ext) {
		case 'png': return 'image/png';
		case 'jpg':
		case 'jpeg': return 'image/jpeg';
		case 'svg': return 'image/svg+xml';
		case 'gif': return 'image/gif';
		case 'webp': return 'image/webp';
		default: return 'application/octet-stream';
	}
}

/** Semver-ish compare, good enough for extension versions (1.2.3, 1.2.3-pre.1). */
export function compareVersions(a, b) {
	const parse = (v) => {
		const [core, pre] = String(v).split('-', 2);
		const parts = core.split('.').map((n) => Number(n) || 0);
		return { parts, pre };
	};
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < 3; i++) {
		const diff = (left.parts[i] || 0) - (right.parts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}
	// A release version outranks a pre-release of the same core version.
	if (left.pre && !right.pre) {
		return -1;
	}
	if (!left.pre && right.pre) {
		return 1;
	}
	return String(left.pre || '').localeCompare(String(right.pre || ''));
}
