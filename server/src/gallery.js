import { config } from './config.js';
import { getCatalog, getIcon, refresh } from './store.js';

/**
 * VS Code extension gallery API, implemented over the BBF catalog and proxied
 * to Open VSX for everything else.
 *
 * BBF Code can only point at one gallery, so this server becomes that gallery:
 * BBF extensions are served from GitHub Releases, and every other extension is
 * forwarded upstream. The payoff is that BBF extensions become ordinary gallery
 * extensions — listed whether installed or not, with native install, update and
 * search — instead of needing a private side-channel.
 */

const UPSTREAM = (process.env.UPSTREAM_GALLERY || 'https://open-vsx.org/vscode/gallery').replace(/\/$/, '');

/** Filter ids, from the gallery manifest VS Code builds for this service. */
const FilterType = {
	Tag: 1,
	ExtensionId: 4,
	Category: 5,
	ExtensionName: 7,
	Target: 8,
	Featured: 9,
	SearchText: 10,
	ExcludeWithFlags: 12
};

const AssetType = {
	Icon: 'Microsoft.VisualStudio.Services.Icons.Default',
	Details: 'Microsoft.VisualStudio.Services.Content.Details',
	Changelog: 'Microsoft.VisualStudio.Services.Content.Changelog',
	Manifest: 'Microsoft.VisualStudio.Code.Manifest',
	VSIX: 'Microsoft.VisualStudio.Services.VSIXPackage',
	License: 'Microsoft.VisualStudio.Services.Content.License',
	Repository: 'Microsoft.VisualStudio.Services.Links.Source'
};

const PropertyType = {
	Engine: 'Microsoft.VisualStudio.Code.Engine',
	PreRelease: 'Microsoft.VisualStudio.Code.PreRelease',
	Dependency: 'Microsoft.VisualStudio.Code.ExtensionDependencies',
	ExtensionPack: 'Microsoft.VisualStudio.Code.ExtensionPack'
};

/** Stable synthetic guid per extension id; the client uses it as an identity key. */
function syntheticGuid(value) {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < value.length; i++) {
		h1 = Math.imul(h1 ^ value.charCodeAt(i), 0x01000193) >>> 0;
		h2 = Math.imul(h2 + value.charCodeAt(i), 0x85ebca6b) >>> 0;
	}
	const hex = (n) => n.toString(16).padStart(8, '0');
	const a = hex(h1);
	const b = hex(h2);
	return `${a}-${b.slice(0, 4)}-4${b.slice(4, 7)}-8${a.slice(0, 3)}-${b}${a.slice(0, 4)}`;
}

function assetBase(id, version, tokenPath) {
	return `${config.publicUrl}${tokenPath}/vscode/asset/${id}/${version}`;
}

/** Convert one catalog entry into the raw gallery shape VS Code expects. */
function toGalleryExtension(entry, tokenPath) {
	const versions = (entry.versions?.length ? entry.versions : [entry]).map((v) => {
		const base = assetBase(entry.id, v.version, tokenPath);
		const files = [
			{ assetType: AssetType.VSIX, source: `${base}/${AssetType.VSIX}` },
			{ assetType: AssetType.Manifest, source: `${base}/${AssetType.Manifest}` }
		];
		// Only advertise documentation the .vsix actually contains, otherwise the
		// editor renders an empty tab instead of hiding it.
		if (entry.hasReadme) {
			files.push({ assetType: AssetType.Details, source: `${base}/${AssetType.Details}` });
		}
		if (entry.hasChangelog) {
			files.push({ assetType: AssetType.Changelog, source: `${base}/${AssetType.Changelog}` });
		}
		if (entry.hasLicense) {
			files.push({ assetType: AssetType.License, source: `${base}/${AssetType.License}` });
		}
		if (entry.repository) {
			files.push({ assetType: AssetType.Repository, source: entry.repository });
		}
		// The workbench CSP is img-src 'self' data: blob: vscode-remote-resource:,
		// so an http:// icon URL is blocked no matter which host serves it.
		// Inline the icon instead; there are only ever a handful of BBF extensions.
		const icon = getIcon(entry.id, v.version);
		if (icon) {
			files.push({
				assetType: AssetType.Icon,
				source: `data:${icon.contentType};base64,${icon.data.toString('base64')}`
			});
		}
		const properties = [
			{ key: PropertyType.Engine, value: entry.engines?.vscode || '*' },
			{ key: PropertyType.PreRelease, value: String(!!v.prerelease) }
		];
		return {
			version: v.version,
			lastUpdated: v.publishedAt || entry.publishedAt || new Date().toISOString(),
			assetUri: base,
			fallbackAssetUri: base,
			files,
			properties
		};
	});

	return {
		extensionId: syntheticGuid(entry.id),
		extensionName: entry.name,
		displayName: entry.displayName || entry.name,
		shortDescription: entry.description || '',
		publisher: {
			displayName: entry.publisher,
			publisherId: syntheticGuid(entry.publisher),
			publisherName: entry.publisher
		},
		versions,
		statistics: [{ statisticName: 'install', value: 0 }],
		tags: [],
		releaseDate: entry.publishedAt || new Date().toISOString(),
		publishedDate: entry.publishedAt || new Date().toISOString(),
		lastUpdated: entry.publishedAt || new Date().toISOString(),
		categories: entry.categories || [],
		flags: 'validated, public'
	};
}

/** Does a BBF extension satisfy the criteria VS Code sent? */
function matches(entry, criteria) {
	// Criteria of the same type are OR'd by the marketplace protocol; different
	// types are AND'd. ExcludeWithFlags/Target are filters we always satisfy.
	const byType = new Map();
	for (const c of criteria) {
		const list = byType.get(c.filterType) ?? [];
		list.push((c.value ?? '').toLowerCase());
		byType.set(c.filterType, list);
	}

	for (const [filterType, values] of byType) {
		switch (filterType) {
			case FilterType.ExtensionName:
				if (!values.includes(entry.id.toLowerCase())) { return false; }
				break;
			case FilterType.ExtensionId:
				if (!values.includes(syntheticGuid(entry.id))) { return false; }
				break;
			case FilterType.SearchText: {
				const haystack = `${entry.id} ${entry.displayName} ${entry.description}`.toLowerCase();
				if (!values.some(v => !v || haystack.includes(v))) { return false; }
				break;
			}
			case FilterType.Category: {
				const cats = (entry.categories || []).map(c => c.toLowerCase());
				if (!values.some(v => cats.includes(v))) { return false; }
				break;
			}
			case FilterType.Featured:
				return false; // BBF extensions are never "featured"
			default:
				break; // Target, ExcludeWithFlags, Tag: not a reason to exclude
		}
	}
	return true;
}

async function queryUpstream(body, headers) {
	try {
		const response = await fetch(`${UPSTREAM}/extensionquery`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': headers.accept || 'application/json;api-version=3.0-preview.1'
			},
			body: JSON.stringify(body)
		});
		if (!response.ok) {
			return { extensions: [], total: 0 };
		}
		const json = await response.json();
		const result = json?.results?.[0] ?? {};
		const count = result.resultMetadata
			?.find(m => m.metadataType === 'ResultCount')
			?.metadataItems?.find(i => i.name === 'TotalCount')?.count ?? (result.extensions?.length ?? 0);
		return { extensions: result.extensions ?? [], total: count };
	} catch {
		// Upstream being unreachable must not take BBF extensions down with it.
		return { extensions: [], total: 0 };
	}
}

export async function handleExtensionQuery(req, res, tokenPath = '') {
	const body = req.body ?? {};
	const filter = body.filters?.[0] ?? {};
	const criteria = filter.criteria ?? [];

	let bbf = [];
	try {
		await refresh();
		bbf = getCatalog().extensions.filter(e => matches(e, criteria)).map(e => toGalleryExtension(e, tokenPath));
	} catch {
		bbf = [];
	}

	const upstream = await queryUpstream(body, req.headers);

	// BBF extensions lead and win ties: an extension published to both the BBF
	// release repo and Open VSX must not appear twice, and the BBF build is the
	// one this organisation ships.
	const bbfIds = new Set(bbf.map(e => `${e.publisher.publisherName}.${e.extensionName}`.toLowerCase()));
	const deduped = upstream.extensions.filter(
		e => !bbfIds.has(`${e.publisher?.publisherName}.${e.extensionName}`.toLowerCase()));
	const extensions = [...bbf, ...deduped];

	res.json({
		results: [{
			extensions,
			resultMetadata: [{
				metadataType: 'ResultCount',
				metadataItems: [{ name: 'TotalCount', count: bbf.length + Math.max(0, upstream.total - (upstream.extensions.length - deduped.length)) }]
			}]
		}]
	});
}

export { AssetType, toGalleryExtension };
