import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

/**
 * AI Coder access.
 *
 * The company OpenCode Zen key lives in this process and nowhere else. BlackBox Code
 * never receives it, so a decompiled .vsix, a stray log line, or a stolen laptop
 * cannot leak it -- which matters more for a shared key than a personal one,
 * because a single leak would affect everyone at once.
 *
 * Two endpoints:
 *
 *   POST /ai-coder/session   Exchange a Google identity for a short-lived
 *                            session token scoped to this user.
 *   ALL  /ai-coder/zen/v1/*  Proxy to Zen, swapping the caller's session token
 *                            for the real key on the way out.
 *
 * The engine BlackBox Code runs locally is pointed at the proxy, so its model traffic
 * flows through here and the key stays server-side.
 */

const ZEN_UPSTREAM = 'https://opencode.ai/zen/v1';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
/** Public catalogue that knows what each Zen model costs; Zen's own list does not. */
const MODELS_DEV = 'https://models.dev/api.json';

/** models.dev's opencode models, keyed by id, and when they were fetched. */
let catalogueCache = { at: 0, models: undefined };

async function loadZenCatalogue() {
	if (catalogueCache.models && Date.now() - catalogueCache.at < config.refreshMs) {
		return catalogueCache.models;
	}
	const response = await fetch(MODELS_DEV);
	if (!response.ok) {
		throw new Error(`models.dev answered ${response.status}`);
	}
	const data = await response.json();
	const models = data?.opencode?.models;
	if (!models || typeof models !== 'object') {
		throw new Error('models.dev lists no opencode provider');
	}
	catalogueCache = { at: Date.now(), models };
	return models;
}

/** A model is free when both directions are priced at zero. Unknown models are not. */
function isFree(model) {
	return !!model && Number(model.cost?.input ?? 1) === 0 && Number(model.cost?.output ?? 1) === 0;
}

/** token -> { email, subject, expiresAt }. Cleared on restart; clients re-exchange. */
const sessions = new Map();

function sweep() {
	const now = Date.now();
	for (const [token, session] of sessions) {
		if (session.expiresAt <= now) {
			sessions.delete(token);
		}
	}
}

/**
 * Verifies a Google access token and returns the identity behind it.
 *
 * Asking Google rather than decoding the token locally means a revoked or
 * forged token fails here, and it keeps us from having to ship key material to
 * validate signatures.
 */
async function verifyGoogleIdentity(accessToken) {
	let response;
	try {
		response = await fetch(GOOGLE_USERINFO, {
			headers: { 'Authorization': `Bearer ${accessToken}` }
		});
	} catch {
		throw Object.assign(new Error('Could not reach Google to verify your sign-in.'), { status: 503 });
	}

	if (!response.ok) {
		throw Object.assign(new Error('Google rejected that sign-in.'), { status: 401 });
	}

	const profile = await response.json();
	const email = typeof profile.email === 'string' ? profile.email : '';
	// `hd` is the Workspace domain claim. Falling back to the email suffix alone
	// would accept a personal account that merely spells the domain in its
	// address, so the claim is checked first and the suffix only corroborates it.
	const domain = typeof profile.hd === 'string' ? profile.hd : '';
	const allowed = config.googleAllowedDomain;

	if (domain !== allowed || !email.toLowerCase().endsWith(`@${allowed.toLowerCase()}`)) {
		throw Object.assign(
			new Error(`AI Coder is limited to @${allowed} accounts.`),
			{ status: 403 });
	}

	return { email, subject: String(profile.sub || '') };
}

function issueSession(identity) {
	sweep();
	const token = randomBytes(32).toString('hex');
	const expiresAt = Date.now() + config.aiSessionTtlMs;
	sessions.set(token, { ...identity, expiresAt });
	return { token, expiresAt };
}

function readBearer(req) {
	const header = req.get('authorization') || '';
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? match[1].trim() : '';
}

function requireSession(req, res, next) {
	const token = readBearer(req);
	const session = token ? sessions.get(token) : undefined;

	if (!session || session.expiresAt <= Date.now()) {
		if (session) {
			sessions.delete(token);
		}
		// 401 tells BlackBox Code to exchange its Google session again, which it does
		// silently, so an expired token is invisible to the user.
		return res.status(401).json({ error: 'Session expired. Sign in again.' });
	}

	req.aiSession = session;
	return next();
}

/** Headers that must not be forwarded upstream or echoed back to the client. */
const STRIPPED_REQUEST_HEADERS = new Set([
	'authorization', 'host', 'connection', 'content-length', 'accept-encoding'
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
	'content-encoding', 'content-length', 'transfer-encoding', 'connection'
]);

export function createAiCoderRouter() {
	const router = Router();

	router.post('/ai-coder/session', async (req, res) => {
		if (!config.zenApiKey) {
			return res.status(503).json({ error: 'AI Coder is not configured on this server.' });
		}

		const googleToken = readBearer(req);
		if (!googleToken) {
			return res.status(401).json({ error: 'Sign in to BlackBox Code with your Google account first.' });
		}

		try {
			const identity = await verifyGoogleIdentity(googleToken);
			const { token, expiresAt } = issueSession(identity);
			// The response carries a token minted here, never the Zen key.
			return res.json({
				token,
				expiresAt,
				baseUrl: `${config.publicUrl}/ai-coder/zen/v1`,
				account: identity.email
			});
		} catch (error) {
			const status = error.status || 500;
			// Log the outcome, never the credential that produced it.
			console.warn(`[bbf-ai-coder] session denied (${status}): ${error.message}`);
			return res.status(status).json({ error: error.message });
		}
	});

	/**
	 * The model list, without requiring a session.
	 *
	 * Listing models is not sensitive -- Zen answers /models unauthenticated --
	 * but requiring a session here deadlocks the client: the workbench asks for
	 * the model list silently, before any sign-in prompt is possible, and an
	 * empty list means the chat never runs, so nothing ever triggers the prompt.
	 *
	 * Using a model still requires a session; only the catalogue is open.
	 */
	router.get('/ai-coder/models', async (_req, res) => {
		if (!config.zenApiKey) {
			return res.status(503).json({ error: 'AI Coder is not configured on this server.' });
		}

		let offered;
		try {
			const upstream = await fetch(`${ZEN_UPSTREAM}/models`, {
				headers: { 'Authorization': `Bearer ${config.zenApiKey}` }
			});
			if (!upstream.ok) {
				return res.status(upstream.status).json({ error: `OpenCode Zen refused the model list (${upstream.status}).` });
			}
			const payload = await upstream.json();
			offered = Array.isArray(payload?.data) ? payload.data : [];
		} catch (error) {
			console.error(`[bbf-ai-coder] model list unreachable: ${error.message}`);
			return res.status(502).json({ error: 'OpenCode Zen is unreachable.' });
		}

		// Only models that cost nothing are offered. Zen's own /models answer
		// carries no price, so it is joined with the models.dev catalogue here,
		// on the server, where the policy belongs. If models.dev cannot be
		// reached the last catalogue is reused; with none at all the list is
		// withheld rather than silently widened to paid models.
		let catalogue;
		try {
			catalogue = await loadZenCatalogue();
		} catch (error) {
			console.error(`[bbf-ai-coder] models.dev unreachable: ${error.message}`);
			if (!catalogueCache.models) {
				return res.status(503).json({ error: 'The model catalogue is temporarily unavailable.' });
			}
			catalogue = catalogueCache.models;
		}

		const data = offered
			.filter(model => isFree(catalogue[model.id]))
			.map(model => {
				const meta = catalogue[model.id];
				return {
					...model,
					name: meta.name || model.id,
					free: true,
					context_length: meta.limit?.context,
					max_output_tokens: meta.limit?.output,
					tool_call: meta.tool_call !== false
				};
			});
		return res.json({ object: 'list', data });
	});

	// Everything under here is Zen's own OpenAI-compatible surface. The path and
	// body pass through untouched; only the credential is swapped.
	router.all(/^\/ai-coder\/zen\/v1(\/.*)?$/, requireSession, async (req, res) => {
		const suffix = req.params[0] || '';
		const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
		const target = `${ZEN_UPSTREAM}${suffix}${query}`;

		const headers = {};
		for (const [name, value] of Object.entries(req.headers)) {
			if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase()) && typeof value === 'string') {
				headers[name] = value;
			}
		}
		headers['authorization'] = `Bearer ${config.zenApiKey}`;

		const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined;

		let upstream;
		try {
			upstream = await fetch(target, {
				method: req.method,
				headers,
				body: hasBody ? JSON.stringify(req.body) : undefined
			});
		} catch (error) {
			console.error(`[bbf-ai-coder] upstream unreachable: ${error.message}`);
			return res.status(502).json({ error: 'OpenCode Zen is unreachable.' });
		}

		res.status(upstream.status);
		for (const [name, value] of upstream.headers) {
			if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
				res.set(name, value);
			}
		}

		if (!upstream.body) {
			return res.end();
		}

		// Completions stream as server-sent events. Flush each chunk rather than
		// buffering, or tokens would arrive in one lump at the end.
		res.flushHeaders?.();
		try {
			// pipeline, not pipe: pipe returns the destination rather than a
			// promise, so awaiting it would return before the stream finished and
			// leave errors unhandled.
			await pipeline(Readable.fromWeb(upstream.body), res);
		} catch (error) {
			console.error(`[bbf-ai-coder] stream interrupted: ${error.message}`);
			res.end();
		}
		return undefined;
	});

	return router;
}
