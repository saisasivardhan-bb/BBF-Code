import { Router } from 'express';
import { config } from './config.js';
import { checkAccess, downloadAsset as downloadGithubAsset } from './github.js';
import { isLocalMode, readLocalAsset, checkLocalAccess } from './local.js';
import { getAssetId, getCatalog, getIcon, refresh } from './store.js';

export function createRouter() {
	const router = Router();

	/**
	 * Require the shared secret when one is configured. Icons are exempt so the
	 * frontend can render them in an <img> tag, which cannot send headers.
	 */
	const requireToken = (req, res, next) => {
		if (!config.apiToken) {
			return next();
		}
		const header = req.get('authorization') || '';
		const supplied = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
		if (supplied !== config.apiToken) {
			return res.status(401).json({ error: 'Unauthorized. Send Authorization: Bearer <BBF_API_TOKEN>.' });
		}
		return next();
	};

	router.get('/health', async (_req, res) => {
		try {
			const access = isLocalMode() ? await checkLocalAccess() : await checkAccess();
			res.json({ ok: true, ...access, catalogUpdatedAt: getCatalog().updatedAt });
		} catch (error) {
			res.status(502).json({ ok: false, error: String(error.message || error) });
		}
	});

	/** The feed BBF Code polls. */
	router.get('/extensions', requireToken, async (req, res) => {
		try {
			await refresh({ force: req.query.refresh === '1' });
			res.json(getCatalog());
		} catch (error) {
			res.status(502).json({ error: String(error.message || error) });
		}
	});

	router.get('/extensions/:id/:version/icon', async (req, res) => {
		try {
			await refresh();
		} catch {
			// fall through: a cached icon may still be serveable
		}
		const icon = getIcon(req.params.id, req.params.version);
		if (!icon) {
			return res.status(404).json({ error: 'No icon for that extension version.' });
		}
		res.set('Content-Type', icon.contentType);
		res.set('Cache-Control', 'public, max-age=86400');
		return res.send(icon.data);
	});

	/** Streams the .vsix bytes. The GitHub token is never exposed to the client. */
	router.get('/extensions/:id/:version/vsix', requireToken, async (req, res) => {
		try {
			await refresh();
			const assetId = getAssetId(req.params.id, req.params.version);
			if (!assetId) {
				return res.status(404).json({ error: `No .vsix for ${req.params.id}@${req.params.version}.` });
			}
			const buffer = isLocalMode() ? await readLocalAsset(assetId) : await downloadGithubAsset(assetId);
			res.set('Content-Type', 'application/octet-stream');
			res.set('Content-Disposition', `attachment; filename="${req.params.id}-${req.params.version}.vsix"`);
			return res.send(buffer);
		} catch (error) {
			return res.status(502).json({ error: String(error.message || error) });
		}
	});

	return router;
}
