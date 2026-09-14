/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * OpenCode Zen is the only backend, and this file deliberately does not name it.
 *
 * There is no Zen key here, and no Zen URL either: the client only ever talks to
 * the BBF server, which holds the company key and proxies onward. Keeping even
 * the upstream address out of the client means there is no path a shipped build
 * could take to Zen directly, by accident or by patch.
 *
 * There is likewise no local-model path, not even a dormant one.
 */

/** The Google provider contributed by `bbf-google-auth`. */
export const GOOGLE_PROVIDER_ID = 'bbf-google';
export const GOOGLE_SCOPES = ['openid', 'email', 'profile'] as const;

/**
 * Provider ids the engine knows models by.
 *
 * `opencode` is the engine's own provider, pointed at the BBF proxy; `local` is
 * registered by the engine from `OPENCODE_LOCAL_*` and serves whatever this
 * machine is running. A turn is routed to one or the other by the vendor of the
 * model the chat widget resolved.
 */
export const ENGINE_ZEN_PROVIDER_ID = 'opencode';
export const ENGINE_LOCAL_PROVIDER_ID = 'local';

/** Whether local models are offered at all. */
export function localAiEnabled(): boolean {
	return configuration().get<boolean>('localAi.enabled', true) !== false;
}

/** Root URL of the local model runtime, without a trailing slash. */
export function localAiUrl(): string {
	const configured = configuration().get<string>('localAi.url', '').trim();
	return (configured || 'http://localhost:11434').replace(/\/+$/, '');
}

/**
 * Context window, in tokens, that local models are served with.
 *
 * Bounded below because anything smaller cannot even hold the tool definitions
 * the engine sends; the runtime's own default is 4K, which is where local
 * models silently lose the files they just read.
 */
export function localAiContextLength(): number {
	const configured = configuration().get<number>('localAi.contextLength', DEFAULT_LOCAL_CONTEXT_LENGTH);
	if (!Number.isFinite(configured) || configured < MIN_LOCAL_CONTEXT_LENGTH) {
		return DEFAULT_LOCAL_CONTEXT_LENGTH;
	}
	return Math.floor(configured);
}

const DEFAULT_LOCAL_CONTEXT_LENGTH = 32_768;
const MIN_LOCAL_CONTEXT_LENGTH = 4_096;

const configuration = () => vscode.workspace.getConfiguration('bbf.aiCoder');

/**
 * Base URL of the BBF server that gates AI access and proxies to Zen.
 *
 * Read at call time rather than captured once, so changing the setting takes
 * effect without a reload.
 */
export function serviceUrl(): string {
	const configured = configuration().get<string>('serviceUrl', '').trim();
	return (configured || 'https://bbf-server-code.onrender.com').replace(/\/+$/, '');
}

/**
 * Reasoning-effort tiers offered in the chat input bar while Deep Reasoning is
 * on. Each selects the model variant of the same name, which the engine
 * defines for every model from `OPENCODE_ZEN_VARIANTS` (see `engineProcess.ts`).
 */
export const enum Effort {
	Low = 'low',
	Medium = 'medium',
	Max = 'max'
}

/**
 * Whether the model is asked to think before it answers.
 *
 * Off selects the `none` variant, which asks for a direct answer with no
 * reasoning; on selects the variant for the chosen {@link Effort}. Checked
 * against Zen: `high` produces reasoning before the answer, `none` produces
 * the answer alone.
 */
export function deepReasoning(): boolean {
	return configuration().get<boolean>('deepReasoning', true) !== false;
}

/**
 * Who answers the engine's permission requests.
 *
 * `Manual` asks before every side-effecting tool call. `Auto` lets the agent
 * proceed on its own -- each request is still answered explicitly, per call,
 * so nothing runs without a reply and the transcript records what ran.
 */
export const enum PermissionMode {
	Manual = 'manual',
	Auto = 'auto'
}

/** The effort tier chosen in the chat input bar, read at call time. */
export function effort(): Effort {
	const value = configuration().get<string>('effort', Effort.Medium);
	return value === Effort.Low || value === Effort.Max ? value : Effort.Medium;
}

/** The permission mode chosen in the chat input bar, read at call time. */
export function permissionMode(): PermissionMode {
	return configuration().get<string>('permissionMode', PermissionMode.Manual) === PermissionMode.Auto
		? PermissionMode.Auto
		: PermissionMode.Manual;
}

/** Keys for values that persist across sessions. */
export const StorageKeys = {
	/** Preferred model when the chat widget does not supply one. Global. */
	model: 'bbf.aiCoder.model',
	/**
	 * Prefix for the chat-conversation -> engine-session mapping. Kept in
	 * workspace state, so it is naturally scoped to the folder the chat belongs to.
	 */
	engineSession: 'bbf.aiCoder.engineSession:'
} as const;
