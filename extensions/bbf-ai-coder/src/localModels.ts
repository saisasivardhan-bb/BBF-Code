/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localAiContextLength, localAiUrl } from './config.js';

/**
 * Models served from this machine.
 *
 * Ollama is the only local runtime BBF Code discovers today. It is reached in
 * two ways on purpose: `/api/tags` is asked for the catalogue because it is the
 * only endpoint that reports context length and whether a model can call tools,
 * and `/v1` is used for the requests themselves because it is OpenAI-compatible,
 * which is what both the chat provider here and the engine already speak.
 *
 * Requests do not go to the user's models directly but to a copy of each,
 * named `bbf/<model>` and created here through `/api/create`. Ollama serves a
 * model with a 4K-token window unless the model itself asks for more, and its
 * OpenAI-compatible endpoint has no way to raise that per request. The copy is
 * the same weights with one extra parameter, `num_ctx`, and exists only so
 * agent work fits: the tool definitions alone take a couple of thousand
 * tokens and one source file several more, and whatever does not fit is
 * dropped silently -- the model then never sees the file it just read.
 */

/** What the runtime serves a model with when nothing asks for more. */
const RUNTIME_DEFAULT_CONTEXT_LENGTH = 4_096;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
/** Namespace of the copies this file creates; the runtime lists them alongside the originals. */
const COPY_PREFIX = 'bbf/';

export interface ILocalModel {
	/** The runtime's own id, e.g. `qwen3:8b`. The picker and the engine know the model by this. */
	readonly id: string;
	readonly name: string;
	/**
	 * The model requests are addressed to: the copy that carries the wider
	 * window, or `id` itself when no copy could be made.
	 */
	readonly wireId: string;
	/** The window requests are actually served with, not the model's maximum. */
	readonly contextLength: number;
	readonly maxOutputTokens: number;
	/** Whether the model can call tools; agent mode is only useful when it can. */
	readonly tools: boolean;
}

interface IOllamaTag {
	readonly name?: string;
	readonly model?: string;
	readonly capabilities?: string[];
	readonly details?: { readonly context_length?: number; readonly parameter_size?: string };
}

/** The OpenAI-compatible base URL requests go to. */
export function localApiBaseUrl(): string {
	return `${localAiUrl()}/v1`;
}

/**
 * Lists what the local runtime is currently serving, with a wide-window copy
 * of each model in place.
 *
 * An unreachable runtime is not an error: it means the user is not running one,
 * and the Local AI section simply does not appear.
 */
export async function listLocalModels(log?: (message: string) => void): Promise<ILocalModel[]> {
	const tags = await listTags(log);
	const ids = new Set(tags.map(tag => tag.model ?? tag.name));
	const desired = localAiContextLength();

	const models: ILocalModel[] = [];
	for (const tag of tags) {
		const id = tag.model ?? tag.name;
		if (!id || id.startsWith(COPY_PREFIX)) {
			continue;
		}
		// A window wider than the model supports is refused by the runtime.
		const contextLength = Math.min(desired, tag.details?.context_length ?? desired);
		const copy = copyOf(id);
		const copied = await ensureCopy(id, copy, contextLength, ids.has(copy), log);
		models.push({
			id,
			name: displayName(id, tag.details?.parameter_size),
			wireId: copied ? copy : id,
			contextLength: copied ? contextLength : RUNTIME_DEFAULT_CONTEXT_LENGTH,
			// Output is not reported separately, so it is bounded by the window.
			maxOutputTokens: Math.min(DEFAULT_MAX_OUTPUT_TOKENS, contextLength),
			// Absent capabilities mean an older runtime that never reported them,
			// rather than a model that cannot call tools.
			tools: tag.capabilities ? tag.capabilities.includes('tools') : true
		});
	}
	return models;
}

async function listTags(log: ((message: string) => void) | undefined): Promise<IOllamaTag[]> {
	const endpoint = `${localAiUrl()}/api/tags`;
	let response: Response;
	try {
		// An absent runtime refuses the connection at once; the timeout is only
		// for a runtime that is busy, and a busy one deserves a few seconds.
		response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
	} catch (error) {
		log?.(`no local runtime at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
	if (!response.ok) {
		log?.(`local runtime at ${endpoint} answered ${response.status}`);
		return [];
	}
	const payload = await response.json().catch(() => undefined) as { models?: IOllamaTag[] } | undefined;
	return payload?.models ?? [];
}

/**
 * Name of the copy for a model.
 *
 * A model name holds at most one namespace, so any slash the original carries
 * (`hf.co/someone/model`) is flattened rather than nested under `bbf/`.
 */
function copyOf(id: string): string {
	return COPY_PREFIX + id.replaceAll('/', '-');
}

/**
 * Makes sure the copy exists with the wanted window. True when it does.
 *
 * Creating from a model that is already present is a manifest operation, not
 * a download, so it is quick; an existing copy is left alone unless its window
 * differs from what is wanted now.
 */
async function ensureCopy(id: string, copy: string, contextLength: number, exists: boolean, log: ((message: string) => void) | undefined): Promise<boolean> {
	try {
		if (exists && await servedContextLength(copy) === contextLength) {
			return true;
		}
		const response = await fetch(`${localAiUrl()}/api/create`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: copy, from: id, parameters: { num_ctx: contextLength }, stream: false }),
			signal: AbortSignal.timeout(60_000)
		});
		if (!response.ok) {
			log?.(`could not create ${copy} (${response.status}); ${id} keeps the runtime's default window`);
			return false;
		}
		log?.(`registered ${copy} with a ${contextLength}-token window`);
		return true;
	} catch (error) {
		log?.(`could not create ${copy}: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/** The `num_ctx` a model is configured with, if it declares one. */
async function servedContextLength(model: string): Promise<number | undefined> {
	const response = await fetch(`${localAiUrl()}/api/show`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model }),
		signal: AbortSignal.timeout(3_000)
	});
	if (!response.ok) {
		return undefined;
	}
	// `parameters` is the Modelfile text, one `name value` per line.
	const payload = await response.json().catch(() => undefined) as { parameters?: string } | undefined;
	const match = /^num_ctx\s+(?<value>\d+)\s*$/m.exec(payload?.parameters ?? '');
	return match?.groups?.value ? Number(match.groups.value) : undefined;
}

/** Turns `qwen3:8b` into `Qwen3 8B`, which is what the picker shows. */
function displayName(id: string, parameterSize: string | undefined): string {
	const [base, tag] = id.split(':');
	const name = base
		.split(/[-_.]/)
		.filter(Boolean)
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
	const suffix = tag && tag !== 'latest' ? tag.toUpperCase() : parameterSize?.toUpperCase();
	return suffix ? `${name} ${suffix}` : name;
}
