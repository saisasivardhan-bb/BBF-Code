import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, loadDotEnv } from './config.js';
import { createRouter } from './routes.js';
import { refresh } from './store.js';
import { isLocalMode } from './local.js';
import { createGalleryRouter, tokenPathMiddleware, requireGalleryToken } from './galleryRoutes.js';
import { createAiCoderRouter } from './aiCoder.js';

const here = dirname(fileURLToPath(import.meta.url));
loadDotEnv(join(here, '..', '.env'));

const app = express();
app.disable('x-powered-by');

// BBF Code runs from a vscode-file:// origin, so the feed has to be CORS-open.
// Reads only; the shared secret is what actually gates access.
app.use((req, res, next) => {
	res.set('Access-Control-Allow-Origin', '*');
	// VS Code sends marketplace headers (X-Market-Client-Id, VSCode-SessionId, ...).
	// Echo whatever the preflight asks for rather than maintaining a list.
	res.set('Access-Control-Allow-Headers', req.get('access-control-request-headers') || '*');
	res.set('Access-Control-Max-Age', '86400');
	res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	if (req.method === 'OPTIONS') {
		return res.sendStatus(204);
	}
	return next();
});

app.use(express.json({ limit: '2mb' }));

// AI Coder is mounted ahead of the gallery guard deliberately. That guard checks
// for BBF_API_TOKEN on every path, and these routes carry a Google-verified
// per-user identity instead -- a stronger check, not a bypass.
app.use(createAiCoderRouter());

// Gallery API. The token may arrive as a /t/<token> path prefix, because VS Code
// cannot be configured to send an Authorization header to its gallery.
app.use(tokenPathMiddleware);
app.use(requireGalleryToken, createGalleryRouter());

app.use('/api', createRouter());
app.use(express.static(join(here, '..', 'public')));

// Fail fast on missing configuration rather than 502ing on the first request.
if (!isLocalMode()) {
	try {
		void config.repo;
		void config.githubToken;
	} catch (error) {
		console.error(`\n[bbf-extensions] ${error.message}\n`);
		process.exit(1);
	}
}

app.listen(config.port, () => {
	console.log(`[bbf-extensions] listening on ${config.publicUrl}`);
	console.log(`[bbf-extensions] source: ${isLocalMode() ? 'local dir ' + process.env.LOCAL_VSIX_DIR : 'github ' + config.repo}`);
	console.log(`[bbf-extensions] auth: ${config.apiToken ? 'BBF_API_TOKEN required' : 'OPEN (set BBF_API_TOKEN to lock down)'}`);
	console.log(`[bbf-ai-coder] zen key: ${config.zenApiKey ? 'configured (server-side only)' : 'MISSING (set ZEN_API_KEY to enable AI Coder)'}`);
	console.log(`[bbf-ai-coder] allowed domain: @${config.googleAllowedDomain}`);
	const tokenPath = config.apiToken ? `/t/${config.apiToken}` : '';
	console.log(`[bbf-extensions] gallery serviceUrl: ${config.publicUrl}${tokenPath}/vscode/gallery`);
	// Warm the catalog so the first client request is fast.
	refresh({ force: true })
		.then((c) => console.log(`[bbf-extensions] catalog ready: ${c.extensions.length} extension(s)`))
		.catch((e) => console.error(`[bbf-extensions] initial refresh failed: ${e.message}`));
});
