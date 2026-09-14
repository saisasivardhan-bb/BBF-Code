/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AiCoderAccess } from './auth.js';
import { ENGINE_LOCAL_PROVIDER_ID, ENGINE_ZEN_PROVIDER_ID, localAiEnabled } from './config.js';
import { EngineEvent, IEngineFileChange, IEngineModel, IEnginePermission, IEngineSession, IEngineTransport, IPromptOptions } from './engine.js';
import { listLocalModels, localApiBaseUrl } from './localModels.js';
import { EngineProcess } from './engineProcess.js';

/** Provider the engine registers the Zen catalogue under. */
const ENGINE_PROVIDER_ID = ENGINE_ZEN_PROVIDER_ID;

/** How often the active-session set is polled to detect the end of a turn. */
const COMPLETION_POLL_MS = 400;

/** How long a freshly started engine is given to list the requested model. */
const MODEL_READY_TIMEOUT_MS = 20_000;

/**
 * Talks to the local OpenCode engine over its HTTP API.
 *
 * Three things about that API shaped this implementation, and each was checked
 * against the vendored source rather than assumed:
 *
 * 1. `POST /api/session/{id}/prompt` returns as soon as the turn is admitted,
 *    not when it finishes.
 * 2. The per-session event stream carries only durable records -- it filters
 *    out the delta types that make streaming look like streaming. Token-level
 *    output only appears on the server-wide `/api/event`, which therefore has
 *    to be subscribed to and filtered by session id.
 * 3. There is no turn-complete event. `POST /wait` looks like the answer and is
 *    in the OpenAPI spec, but the service behind it throws
 *    `OperationUnavailableError` unconditionally, so completion is detected by
 *    watching the session drop out of `GET /api/session/active`.
 */
export class HttpEngineTransport implements IEngineTransport {

	private baseUrl: string | undefined;
	/** `Authorization` for the local engine: HTTP Basic, user `opencode`. */
	private authHeader: string | undefined;
	/** The local models the running engine was launched with. */
	private localModelIds: ReadonlySet<string> = new Set();

	/** Forgets the endpoint when the engine dies, so the next request starts a new one. */
	private readonly engineExitListener: vscode.Disposable;

	constructor(
		private readonly engine: EngineProcess,
		private readonly access: AiCoderAccess,
		private readonly output: vscode.LogOutputChannel
	) {
		this.engineExitListener = engine.onDidExit(() => {
			this.baseUrl = undefined;
			this.authHeader = undefined;
			this.output.warn('engine stopped; it will be started again on the next request');
		});
	}

	async start(): Promise<void> {
		if (this.baseUrl) {
			return;
		}
		const credential = await this.access.acquire({ interactive: true });
		if (!credential) {
			throw new Error('Sign in to BBF Code with your Blackbox Factories Google account to use BBF AI Coder.');
		}
		// The local catalogue is resolved here rather than inside the engine so
		// the picker and the engine are offered exactly the same list. It is
		// read once per engine launch: a model pulled afterwards appears only
		// after the engine restarts.
		const local = localAiEnabled()
			? { baseUrl: localApiBaseUrl(), models: await listLocalModels() }
			: undefined;
		const endpoint = await this.engine.start(credential, local?.models.length ? local : undefined);
		this.localModelIds = new Set(local?.models.map(model => model.id));
		this.baseUrl = endpoint.baseUrl;
		this.authHeader = 'Basic ' + Buffer.from(`opencode:${endpoint.password}`).toString('base64');
	}

	/**
	 * Ends the running engine so the next request launches a fresh one.
	 *
	 * Engine sessions live in the engine's storage, so a turn can carry on
	 * across the relaunch; only the process, and what it was launched with,
	 * is replaced.
	 */
	private restart(): void {
		this.engine.stop();
		this.baseUrl = undefined;
		this.authHeader = undefined;
	}

	private async request(path: string, init?: RequestInit): Promise<Response> {
		await this.start();
		const response = await fetch(`${this.baseUrl}${path}`, this.withAuth(init));
		if (!response.ok) {
			// Carry the engine's own message. A bare status code says only that
			// something was refused, not what, which turns every failure into a
			// guessing round.
			const detail = await response.text().catch(() => '');
			this.output.error(`${init?.method ?? 'GET'} ${path} -> ${response.status}: ${detail}`);
			throw new Error(`BBF AI Coder engine refused the request (${response.status}). ${summarise(detail)}`);
		}
		return response;
	}

	/** Adds engine credentials without disturbing the caller's own headers. */
	private withAuth(init?: RequestInit): RequestInit {
		const headers = new Headers(init?.headers);
		if (this.authHeader) {
			headers.set('Authorization', this.authHeader);
		}
		return { ...init, headers };
	}

	async listModels(): Promise<IEngineModel[]> {
		const response = await this.request('/config/providers');
		const payload = await response.json() as {
			providers?: Array<{ id?: string; models?: Record<string, { id?: string; name?: string }> }>;
		};
		const models: IEngineModel[] = [];
		for (const provider of payload.providers ?? []) {
			for (const model of Object.values(provider.models ?? {})) {
				if (model.id) {
					models.push({ id: model.id, providerId: provider.id ?? '', name: model.name ?? model.id });
				}
			}
		}
		return models;
	}

	async createSession(_workspaceFolder: vscode.Uri | undefined): Promise<IEngineSession> {
		// The body is deliberately empty. `location` is schema-valid and still
		// fails the request with a 500 inside the engine, and sending it buys
		// nothing: the engine derives the same directory from its working
		// directory, which `EngineProcess` already sets to this workspace folder.
		const response = await this.request('/api/session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}'
		});
		const payload = await response.json() as { data?: { id?: string }; id?: string };
		const id = payload.data?.id ?? payload.id;
		if (!id) {
			throw new Error('The engine did not return a session id.');
		}
		return { id };
	}

	async resumeSession(id: string): Promise<IEngineSession | undefined> {
		try {
			await this.request(`/api/session/${id}`);
			return { id };
		} catch (error) {
			// The engine's storage was cleared, or the session belonged to another
			// directory. Either way a fresh session is the right answer.
			this.output.info(`session ${id} could not be resumed: ${error}`);
			return undefined;
		}
	}

	async prompt(
		session: IEngineSession,
		text: string,
		options: IPromptOptions,
		onEvent: (event: EngineEvent) => void,
		token: vscode.CancellationToken,
		retried = false
	): Promise<void> {
		const providerId = options.providerId ?? ENGINE_PROVIDER_ID;
		if (options.modelId) {
			// The engine learns the local catalogue at launch (see `start`). A
			// model pulled since, or served by a runtime started since, is in the
			// picker but unknown to the running engine until it is relaunched.
			if (providerId === ENGINE_LOCAL_PROVIDER_ID && this.baseUrl && !this.localModelIds.has(options.modelId)) {
				this.output.info(`the running engine does not know local model "${options.modelId}"; relaunching it with the current local catalogue`);
				this.restart();
			}

			// The engine fills its model catalogue asynchronously after it starts
			// listening. A prompt that arrives first fails inside the engine with
			// "Model unavailable" and nothing on the stream, so wait for the model
			// to show up before asking for it.
			if (!(await this.awaitModelAvailable(options.modelId, providerId, token))) {
				if (!token.isCancellationRequested) {
					onEvent({ kind: 'error', message: vscode.l10n.t('The model "{0}" is not available to the engine. Pick another model.', options.modelId) });
				}
				return;
			}

			// ModelRef needs both halves; the id alone is rejected. The variant is
			// the reasoning tier, defined for every model by the engine
			// environment (see engineProcess.ts).
			try {
				await this.request(`/api/session/${session.id}/model`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						model: {
							id: options.modelId,
							providerID: providerId,
							...(options.variant ? { variant: options.variant } : {})
						}
					})
				});
			} catch (error) {
				// A model the engine will not take cannot produce a turn; stopping
				// here is what turns a silent empty answer into a visible reason.
				onEvent({ kind: 'error', message: vscode.l10n.t('The model "{0}" could not be selected. {1}', options.modelId, error instanceof Error ? error.message : String(error)) });
				return;
			}
		}

		// Subscribe before prompting. Starting the stream afterwards would race
		// the first tokens, which arrive immediately for a fast model.
		const streaming = new AbortController();
		const cancellation = token.onCancellationRequested(() => {
			streaming.abort();
			void this.interrupt(session);
		});

		// A turn that ends without a single visible event is a turn the engine
		// failed to run at all -- an unavailable model or variant, say -- and it
		// reports that only in its own storage, never on the stream.
		let produced = false;
		// The BBF server keeps issued tokens in memory, so a server restart
		// invalidates the token this engine was started with. That surfaces as
		// a 401 from the proxy; it is renewed below rather than shown.
		let tokenRejected = false;
		// Not every model knows the reasoning parameter a variant sets. A 400
		// that names it is retried once with the plain model instead of shown.
		let variantRejected = false;
		const observe = (event: EngineEvent) => {
			if (event.kind === 'error' && /\bHTTP 401\b/.test(event.message)) {
				tokenRejected = true;
				return;
			}
			if (event.kind === 'error' && options.variant && !retried && /\bHTTP 400\b/.test(event.message) && /reason/i.test(event.message)) {
				variantRejected = true;
				return;
			}
			if (event.kind !== 'reasoning') {
				produced = true;
			}
			onEvent(event);
		};
		const consumed = this.consumeEvents(session, observe, streaming.signal);

		try {
			await this.request(`/api/session/${session.id}/prompt`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: { text } })
			});
			await this.awaitCompletion(session, token);
		} finally {
			streaming.abort();
			cancellation.dispose();
			await consumed.catch(() => { /* aborting the stream is the normal exit */ });
		}

		if (token.isCancellationRequested) {
			return;
		}

		if (tokenRejected) {
			if (retried) {
				onEvent({ kind: 'error', message: vscode.l10n.t('The BBF server no longer accepts this session. Sign out of BBF Code and sign in again.') });
				return;
			}
			// The engine session itself lives in the engine's storage and survives
			// the restart, so the same turn can simply be sent again.
			this.output.info('the BBF server rejected the engine token; renewing it and retrying the turn');
			this.access.invalidate();
			this.restart();
			await this.prompt(session, text, options, onEvent, token, true);
			return;
		}

		if (variantRejected) {
			this.output.warn(`the model rejected the "${options.variant}" reasoning variant; retrying the turn without it`);
			await this.prompt(session, text, { ...options, variant: undefined }, onEvent, token, true);
			return;
		}

		if (!produced) {
			onEvent({ kind: 'error', message: await this.explainSilentTurn(session) });
		}
	}

	/**
	 * Waits for the engine's catalogue to list a model, up to a short deadline.
	 * False when it never appears: the model is unknown or disabled.
	 */
	private async awaitModelAvailable(modelId: string, providerId: string, token: vscode.CancellationToken): Promise<boolean> {
		const deadline = Date.now() + MODEL_READY_TIMEOUT_MS;
		while (!token.isCancellationRequested && Date.now() < deadline) {
			try {
				const response = await this.request('/api/model');
				const payload = await response.json() as { data?: Array<{ id?: string; providerID?: string; enabled?: boolean }> };
				if ((payload.data ?? []).some(model => model.id === modelId && model.providerID === providerId && model.enabled !== false)) {
					return true;
				}
			} catch (error) {
				this.output.warn(`could not read the model catalogue: ${error}`);
			}
			await delay(COMPLETION_POLL_MS);
		}
		return false;
	}

	/**
	 * Reads back why a turn produced nothing.
	 *
	 * The engine records the failure on the assistant message it created for the
	 * turn, so that is where the reason lives.
	 */
	private async explainSilentTurn(session: IEngineSession): Promise<string> {
		const fallback = vscode.l10n.t('BBF AI Coder produced no response. See the "BBF AI Coder" output log for details.');
		try {
			const response = await this.request(`/api/session/${session.id}/message`);
			const payload = await response.json() as { data?: Array<{ info?: Record<string, unknown> } & Record<string, unknown>> };
			const messages = payload.data ?? [];
			for (let i = messages.length - 1; i >= 0; i--) {
				const info = (messages[i].info ?? messages[i]) as { role?: unknown; error?: unknown };
				if (info.role === 'assistant' && info.error) {
					const reason = describeEngineError(info.error);
					return reason ? vscode.l10n.t('BBF AI Coder could not answer: {0}', reason) : fallback;
				}
			}
		} catch (error) {
			this.output.warn(`could not read back the failed turn: ${error}`);
		}
		return fallback;
	}

	/**
	 * Reads the server-wide event stream, keeping only this session's frames.
	 *
	 * The per-session endpoint would be the obvious choice and is the wrong one:
	 * it serves the durable union and drops `session.next.text.delta` and its
	 * siblings, so a response would arrive in one lump at the end.
	 */
	private async consumeEvents(
		session: IEngineSession,
		onEvent: (event: EngineEvent) => void,
		signal: AbortSignal
	): Promise<void> {
		const response = await fetch(`${this.baseUrl}/api/event`, this.withAuth({
			headers: { 'Accept': 'text/event-stream' },
			signal
		}));
		if (!response.body) {
			return;
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffered = '';

		while (!signal.aborted) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}
			buffered += decoder.decode(value, { stream: true });

			// SSE frames are separated by a blank line; a frame may arrive split
			// across reads, so only whole frames are taken.
			let boundary = buffered.indexOf('\n\n');
			while (boundary !== -1) {
				const frame = buffered.slice(0, boundary);
				buffered = buffered.slice(boundary + 2);
				this.dispatchFrame(frame, session, onEvent);
				boundary = buffered.indexOf('\n\n');
			}
		}
	}

	private dispatchFrame(frame: string, session: IEngineSession, onEvent: (event: EngineEvent) => void): void {
		const dataLines = frame
			.split('\n')
			.filter(line => line.startsWith('data:'))
			.map(line => line.slice(5).trim());
		if (!dataLines.length) {
			return;
		}

		let envelope: { type?: string; data?: Record<string, unknown> };
		try {
			envelope = JSON.parse(dataLines.join('\n'));
		} catch {
			return;
		}

		const data = envelope.data ?? {};
		if (data['sessionID'] && data['sessionID'] !== session.id) {
			return;
		}

		const translated = translate(envelope.type ?? '', data);
		if (translated) {
			onEvent(translated);
		}
	}

	/**
	 * Waits for the turn to end by watching the active-session set.
	 *
	 * Polling is not the preferred shape, but the engine publishes no
	 * turn-complete event and its `/wait` endpoint is a stub that always fails.
	 */
	private async awaitCompletion(session: IEngineSession, token: vscode.CancellationToken): Promise<void> {
		// The engine needs a moment to register the session as active; returning
		// before it does would read as "already finished".
		await delay(COMPLETION_POLL_MS);

		while (!token.isCancellationRequested) {
			let stillActive: boolean;
			try {
				const response = await this.request('/api/session/active');
				// `data` is keyed by session id, not a list of them. Reading it as an
				// array leaves `includes` undefined and throws mid-turn.
				const payload = await response.json() as { data?: Record<string, unknown> };
				stillActive = Object.hasOwn(payload.data ?? {}, session.id);
			} catch (error) {
				this.output.warn(`could not read active sessions: ${error}`);
				return;
			}
			if (!stillActive) {
				return;
			}
			await delay(COMPLETION_POLL_MS);
		}
	}

	async replyPermission(session: IEngineSession, requestId: string, allow: boolean): Promise<void> {
		await this.request(`/api/session/${session.id}/permission/${requestId}/reply`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			// PermissionV2Reply is once | always | reject. "once" deliberately:
			// "always" would silently widen consent beyond what was asked.
			body: JSON.stringify({ reply: allow ? 'once' : 'reject' })
		});
	}

	private async interrupt(session: IEngineSession): Promise<void> {
		try {
			await this.request(`/api/session/${session.id}/interrupt`, { method: 'POST' });
		} catch (error) {
			// Cancelling a turn that already finished is not worth surfacing.
			this.output.trace(`interrupt failed: ${error}`);
		}
	}

	dispose(): void {
		this.engineExitListener.dispose();
		this.baseUrl = undefined;
		this.authHeader = undefined;
	}
}

/**
 * Maps an engine event onto the subset the chat UI knows how to render.
 *
 * Every type and field below is spelled as the engine emits it. Deltas carry
 * their fragment in `delta`, not `text`; tools report through the
 * `called`/`success`/`failed` trio rather than a started/completed pair; and a
 * turn that dies reports `session.error` or `session.next.step.failed`. Getting
 * any of these wrong is silent -- the frame simply falls through to `default`.
 */
function translate(type: string, data: Record<string, unknown>): EngineEvent | undefined {
	const delta = typeof data['delta'] === 'string' ? data['delta'] : '';

	switch (type) {
		case 'session.next.text.delta':
			return delta ? { kind: 'text', text: delta } : undefined;
		case 'session.next.reasoning.delta':
			return delta ? { kind: 'reasoning', text: delta } : undefined;
		case 'permission.v2.asked':
			return { kind: 'permission', request: toPermission(data) };
		case 'session.next.tool.called': {
			const input = data['input'];
			return {
				kind: 'toolStart',
				callId: String(data['callID'] ?? ''),
				name: String(data['tool'] ?? 'tool'),
				input: input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
			};
		}
		case 'session.next.tool.success':
			return { kind: 'toolEnd', callId: String(data['callID'] ?? ''), ok: true };
		case 'session.next.tool.failed':
			return {
				kind: 'toolEnd',
				callId: String(data['callID'] ?? ''),
				ok: false,
				detail: describeEngineError(data['error'])
			};
		case 'session.error':
		case 'session.next.step.failed':
			return { kind: 'error', message: describeEngineError(data['error']) ?? 'The engine reported an error.' };
		case 'session.diff':
			return { kind: 'diff', files: toFileChanges(data['diff']) };
		default:
			return undefined;
	}
}

function toFileChanges(value: unknown): IEngineFileChange[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((item: Record<string, unknown>) => {
		const status = item['status'];
		return {
			path: typeof item['file'] === 'string' ? item['file'] : '',
			status: status === 'added' || status === 'deleted' || status === 'modified' ? status : undefined,
			additions: typeof item['additions'] === 'number' ? item['additions'] : 0,
			deletions: typeof item['deletions'] === 'number' ? item['deletions'] : 0,
			patch: typeof item['patch'] === 'string' ? item['patch'] : undefined
		};
	});
}

/**
 * Pulls a readable message out of an engine error.
 *
 * The engine has two shapes for these: `{name, data: {message}}` from its HTTP
 * layer and `{type, message}` on stream events. Both are read before falling
 * back to whatever name the error carries.
 */
function describeEngineError(error: unknown): string | undefined {
	if (typeof error === 'string') {
		return error;
	}
	if (!error || typeof error !== 'object') {
		return undefined;
	}
	const shape = error as { name?: unknown; message?: unknown; data?: { message?: unknown } };
	if (typeof shape.data?.message === 'string') {
		return shape.data.message;
	}
	if (typeof shape.message === 'string') {
		return shape.message;
	}
	return typeof shape.name === 'string' ? shape.name : undefined;
}

function toPermission(data: Record<string, unknown>): IEnginePermission {
	const resources = Array.isArray(data['resources']) ? data['resources'].filter((item): item is string => typeof item === 'string') : [];
	return {
		requestId: String(data['id'] ?? ''),
		action: String(data['action'] ?? 'act'),
		resources
	};
}

/** Pulls a human-readable message out of an engine error body. */
function summarise(body: string): string {
	if (!body) {
		return '';
	}
	try {
		const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
		for (const candidate of [parsed.message, parsed.error]) {
			if (typeof candidate === 'string' && candidate) {
				return candidate;
			}
		}
	} catch {
		// Not JSON; the raw text is still better than nothing.
	}
	return body.slice(0, 300);
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
