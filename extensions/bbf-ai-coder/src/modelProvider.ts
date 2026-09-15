/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AiCoderAccess, assertSecureServiceUrl } from './auth.js';
import { localAiEnabled, serviceUrl } from './config.js';
import { ILocalModel, listLocalModels, localApiBaseUrl } from './localModels.js';

/** Vendor ids, matched by the `languageModelChatProviders` contribution. */
export const BBF_VENDOR = 'bbf-zen';
export const BBF_LOCAL_VENDOR = 'bbf-local';

/**
 * Conservative limits, used when the model list does not state its own.
 *
 * Claiming more than a model accepts produces a failure deep inside the request
 * rather than a clear one here, so these err small.
 */
const DEFAULT_MAX_INPUT_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

interface IZenModel {
	readonly id: string;
	readonly name?: string;
	readonly context_length?: number;
	readonly max_output_tokens?: number;
	/** Set by the BBF server: true when the model costs nothing to use. */
	readonly free?: boolean;
}

/**
 * Publishes the company's models to the workbench.
 *
 * This is what makes the chat usable at all: the chat widget resolves a model
 * before it will call a participant, so without a registered provider every
 * request fails with "Language model unavailable" and the participant handler
 * never runs.
 *
 * Requests go to the BBF proxy, never to Zen directly, so the company key stays
 * server-side and this file contains no endpoint of Zen's own.
 */
export class BbfModelProvider implements vscode.LanguageModelChatProvider {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor(
		private readonly access: AiCoderAccess,
		private readonly output: vscode.LogOutputChannel
	) {
		// Signing in or out changes which models exist.
		this.access.onDidChange(() => this._onDidChange.fire());
	}

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		// Deliberately not gated on being signed in.
		//
		// The workbench asks for this list silently, and `getSession` with
		// `silent: true` returns nothing until the user has already granted this
		// extension access. Returning an empty list there deadlocks the product:
		// no models means the chat refuses to run, and nothing running means the
		// consent prompt never appears. The catalogue is therefore public and
		// only *using* a model requires a session.
		let models: IZenModel[];
		try {
			models = await this.fetchModels();
		} catch (error) {
			this.output.warn(`could not list models: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}

		return models.map(model => ({
			id: model.id,
			name: model.name ?? model.id,
			family: familyOf(model.id),
			version: '1.0.0',
			maxInputTokens: model.context_length ?? DEFAULT_MAX_INPUT_TOKENS,
			maxOutputTokens: model.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
			tooltip: vscode.l10n.t('{0} via BBF AI Coder', model.name ?? model.id),
			capabilities: {
				toolCalling: true,
				imageInput: false
			}
		}));
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const credential = await this.access.acquire({ interactive: true });
		if (!credential) {
			throw new Error('Sign in to BlackBox Code with your Blackbox Factories Google account to use BBF AI Coder.');
		}

		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());

		try {
			const response = await fetch(`${credential.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${credential.token}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					model: model.id,
					messages: messages.map(toWireMessage),
					stream: true
				}),
				signal: controller.signal
			});

			if (!response.ok) {
				if (response.status === 401) {
					// The server restarted and forgot our token; the next attempt
					// mints a fresh one.
					this.access.invalidate();
				}
				throw new Error(await describeFailure(response));
			}

			await readCompletionStream(response, progress, controller.signal);
		} finally {
			cancellation.dispose();
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		const content = typeof text === 'string' ? text : textOf(text);
		// Zen exposes no tokenizer endpoint, so this is the usual four-characters
		// -per-token approximation. It is used for budgeting, not billing.
		return Math.ceil(content.length / 4);
	}

	/** Reads the catalogue from the BBF server's open model endpoint. */
	private async fetchModels(): Promise<IZenModel[]> {
		const base = serviceUrl();
		assertSecureServiceUrl(base);
		const response = await fetch(`${base}/ai-coder/models`);
		if (!response.ok) {
			throw new Error(`models request failed (${response.status})`);
		}
		const payload = await response.json() as { data?: IZenModel[] };
		const models = payload.data ?? [];
		// The server marks what costs nothing. Once it does, only those are
		// offered here as well, so a server that still lists paid models never
		// puts them in the picker; an older server without the flag is left as is.
		return models.some(model => model.free !== undefined) ? models.filter(model => model.free === true) : models;
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}

function toWireMessage(message: vscode.LanguageModelChatRequestMessage): { role: string; content: string } {
	return { role: roleOf(message.role), content: textOf(message) };
}

/**
 * Maps a workbench role onto the wire.
 *
 * The API models only User and Assistant -- there is no System role to map, so
 * system prompting arrives as a user message like any other.
 */
function roleOf(role: vscode.LanguageModelChatMessageRole): string {
	return role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
}

/** Flattens a message's parts to text; non-text parts are not sent upstream. */
function textOf(message: vscode.LanguageModelChatRequestMessage): string {
	const pieces: string[] = [];
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			pieces.push(part.value);
		}
	}
	return pieces.join('');
}

/** Groups related model ids so `selectChatModels({family})` behaves sensibly. */
function familyOf(id: string): string {
	const slash = id.indexOf('/');
	return slash === -1 ? id : id.slice(slash + 1);
}

async function describeFailure(response: Response): Promise<string> {
	const body = await response.text().catch(() => '');
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		if (typeof parsed.error === 'string') {
			return parsed.error;
		}
	} catch {
		// Fall through to the status line.
	}
	return `BBF AI Coder request failed (${response.status}).`;
}

/**
 * Publishes the models this machine is running.
 *
 * Registered under its own vendor so the chat model picker groups them under
 * "Local AI" -- the picker takes a group's name from the vendor's `displayName`
 * in `package.json`. Nothing here reaches the network: the runtime is on
 * localhost, and no BBF credential is sent to it.
 */
export class BbfLocalModelProvider implements vscode.LanguageModelChatProvider {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
	private readonly configListener: vscode.Disposable;
	private readonly runtimeCheck: NodeJS.Timeout;
	/** The model set last reported, so a re-check announces only a real change. */
	private served: string | undefined;
	/** The last discovery, by id, for the wire id a request must use. */
	private readonly models = new Map<string, ILocalModel>();

	constructor(private readonly output: vscode.LogOutputChannel) {
		// Pointing at a different runtime, or turning local models off, changes
		// which models exist.
		this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('bbf.aiCoder.localAi')) {
				this._onDidChange.fire();
			}
		});
		// The runtime starts, stops and pulls models independently of BlackBox Code,
		// and the picker never asks twice on its own. A localhost check every so
		// often keeps the list honest without a restart.
		this.runtimeCheck = setInterval(() => void this.checkRuntime(), LOCAL_RUNTIME_CHECK_MS);
	}

	/**
	 * Has the workbench ask for the models now.
	 *
	 * The workbench queries a vendor only after being told its models changed.
	 * The Zen provider gets that moment from sign-in; a local runtime has none,
	 * so without this the Local AI section never appears. Call it after
	 * `registerLanguageModelChatProvider`, which is what attaches the listener.
	 */
	announce(): void {
		this._onDidChange.fire();
	}

	private async checkRuntime(): Promise<void> {
		if (!localAiEnabled()) {
			return;
		}
		const served = signature(await listLocalModels());
		if (served !== this.served) {
			this.served = served;
			this._onDidChange.fire();
		}
	}

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!localAiEnabled()) {
			this.output.info('local models are turned off by setting');
			this.served = signature([]);
			return [];
		}
		const models = await listLocalModels(message => this.output.info(message));
		this.served = signature(models);
		this.models.clear();
		for (const model of models) {
			this.models.set(model.id, model);
		}
		if (!models.length) {
			return [];
		}
		this.output.info(`local runtime is serving ${models.length} model(s): ${models.map(model => model.id).join(', ')}`);

		return models.map(model => ({
			id: model.id,
			name: model.name,
			family: 'local',
			version: '1.0.0',
			maxInputTokens: model.contextLength,
			maxOutputTokens: model.maxOutputTokens,
			tooltip: vscode.l10n.t('{0}, running on this machine', model.name),
			detail: vscode.l10n.t('Local'),
			capabilities: {
				toolCalling: model.tools,
				imageInput: false
			}
		}));
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());

		try {
			const response = await fetch(`${localApiBaseUrl()}/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					// The wide-window copy, when one exists (see localModels.ts).
					model: this.models.get(model.id)?.wireId ?? model.id,
					messages: messages.map(toWireMessage),
					stream: true
				}),
				signal: controller.signal
			});

			if (!response.ok) {
				throw new Error(await describeFailure(response));
			}

			await readCompletionStream(response, progress, controller.signal);
		} catch (error) {
			// A runtime that is not running is the common case, and the bare
			// fetch failure does not say which address was tried.
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(vscode.l10n.t('Could not reach the local model runtime at {0}. {1}', localApiBaseUrl(), message));
		} finally {
			cancellation.dispose();
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		const content = typeof text === 'string' ? text : textOf(text);
		return Math.ceil(content.length / 4);
	}

	dispose(): void {
		clearInterval(this.runtimeCheck);
		this.configListener.dispose();
		this._onDidChange.dispose();
	}
}

/** How often the local runtime is re-checked for models appearing or going away. */
const LOCAL_RUNTIME_CHECK_MS = 30_000;

/** Order-independent identity of a model set. */
function signature(models: ReadonlyArray<ILocalModel>): string {
	return models.map(model => model.id).sort().join('\n');
}

/**
 * Reads an OpenAI-style SSE completion stream and reports its text parts.
 *
 * Shared by both providers: the BBF proxy and the local runtime speak the same
 * wire format, so the only difference between them is the address and whether a
 * credential is attached.
 */
async function readCompletionStream(
	response: Response,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	signal: AbortSignal
): Promise<void> {
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

		let boundary = buffered.indexOf('\n\n');
		while (boundary !== -1) {
			const frame = buffered.slice(0, boundary);
			buffered = buffered.slice(boundary + 2);
			for (const line of frame.split('\n')) {
				if (!line.startsWith('data:')) {
					continue;
				}
				const payload = line.slice(5).trim();
				if (payload === '[DONE]') {
					return;
				}
				try {
					const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
					const text = chunk.choices?.[0]?.delta?.content;
					if (text) {
						progress.report(new vscode.LanguageModelTextPart(text));
					}
				} catch {
					// A partial or non-JSON frame is not worth failing the turn over.
				}
			}
			boundary = buffered.indexOf('\n\n');
		}
	}
}
