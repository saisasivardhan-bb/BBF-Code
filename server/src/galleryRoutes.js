import { Router } from 'express';
import { config } from './config.js';
import { downloadAsset as downloadGithubAsset } from './github.js';
import { isLocalMode, readLocalAsset } from './local.js';
import { getAssetId, getCatalog, getDocs, getIcon, refresh } from './store.js';
import { AssetType, handleExtensionQuery } from './gallery.js';
import { readVsix } from './vsix.js';

/**
 * Gallery endpoints.
 *
 * VS Code sends its own headers to the gallery and cannot be told to add a
 * bearer token, so when BBF_API_TOKEN is set the secret travels in the URL
 * instead: point `extensionsGallery.serviceUrl` at /t/<token>/vscode/gallery.
 */
export function createGalleryRouter() {
	const router = Router({ mergeParams: true });

	router.post('/vscode/gallery/extensionquery', async (req, res) => {
		await handleExtensionQuery(req, res, req.tokenPath ?? '');
	});

	// Statistics reporting: accepted and discarded. BBF Code has telemetry off.
	router.post('/vscode/gallery/publishers/:publisher/extensions/:name/:version/stats', (_req, res) => {
		res.sendStatus(200);
	});

	router.get('/vscode/asset/:id/:version/:assetType', async (req, res) => {
		const { id, version, assetType } = req.params;
		try {
			await refresh();

			if (assetType === AssetType.Icon) {
				const icon = getIcon(id, version);
				if (!icon) {
					return res.sendStatus(404);
				}
				res.set('Content-Type', icon.contentType);
				res.set('Cache-Control', 'public, max-age=86400');
				return res.send(icon.data);
			}

			const assetId = getAssetId(id, version);
			if (assetId === undefined) {
				return res.status(404).json({ error: `Unknown extension ${id}@${version}` });
			}
			const buffer = isLocalMode() ? await readLocalAsset(assetId) : await downloadGithubAsset(assetId);

			if (assetType === AssetType.VSIX) {
				res.set('Content-Type', 'application/octet-stream');
				res.set('Content-Disposition', `attachment; filename="${id}-${version}.vsix"`);
				return res.send(buffer);
			}

			if (assetType === AssetType.Manifest) {
				const vsix = readVsix(buffer);
				res.set('Content-Type', 'application/json');
				return res.json({
					name: vsix.name,
					publisher: vsix.publisher,
					version: vsix.version,
					displayName: vsix.displayName,
					description: vsix.description,
					engines: vsix.engines,
					categories: vsix.categories
				});
			}

			// Documentation comes from inside the .vsix, so the editor shows the same
			// README the publisher wrote rather than the one-line description.
			if (assetType === AssetType.Details || assetType === AssetType.Changelog || assetType === AssetType.License) {
				const extensionDocs = getDocs(id, version) ?? {};
				const text = assetType === AssetType.Details ? extensionDocs.readme
					: assetType === AssetType.Changelog ? extensionDocs.changelog
						: extensionDocs.licenseText;
				if (text === undefined) {
					const entry = getCatalog().extensions.find(e => e.id === id);
					res.set('Content-Type', 'text/plain; charset=utf-8');
					return res.send(assetType === AssetType.Details ? (entry?.description ?? '') : '');
				}
				res.set('Content-Type', 'text/markdown; charset=utf-8');
				res.set('Cache-Control', 'public, max-age=3600');
				return res.send(text);
			}

			return res.sendStatus(404);
		} catch (error) {
			return res.status(502).json({ error: String(error.message || error) });
		}
	});

	return router;
}

/**
 * Accepts the shared secret as a path segment so gallery requests, which carry
 * no custom headers, can still be authenticated.
 */
export function tokenPathMiddleware(req, _res, next) {
	req.tokenPath = '';
	const match = /^\/t\/([^/]+)(\/.*)?$/.exec(req.url);
	if (match) {
		req.suppliedPathToken = decodeURIComponent(match[1]);
		req.tokenPath = `/t/${match[1]}`;
		req.url = match[2] || '/';
	}
	next();
}

export function requireGalleryToken(req, res, next) {
	if (!config.apiToken) {
		return next();
	}
	if (req.suppliedPathToken === config.apiToken) {
		return next();
	}
	const header = req.get('authorization') || '';
	const bearer = header.startsWith('Bearer ') ? header.slice(7) : undefined;
	if (bearer === config.apiToken || req.query.token === config.apiToken) {
		return next();
	}
	return res.status(401).json({ error: 'Unauthorized. Use /t/<BBF_API_TOKEN>/vscode/gallery as the service URL.' });
}
