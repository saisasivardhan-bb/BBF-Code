/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** A model the signed-in Zen account can use. */
export interface IEngineModel {
	readonly id: string;
	readonly providerId: string;
	readonly name: string;
}

/** A running conversation in the engine. */
export interface IEngineSession {
	readonly id: string;
}

/**
 * Something the engine wants to do that needs the user's consent, such as
 * writing a file or running a command.
 *
 * Agent mode is only safe because these exist: the engine asks, the user
 * answers, and nothing runs before that. In auto mode the extension answers on
 * the user's behalf, but still one request at a time, and still on record.
 */
export interface IEnginePermission {
	readonly requestId: string;
	/** The engine's permission action, e.g. `edit`, `bash`, `read`. */
	readonly action: string;
	/** What the action is aimed at: file paths, a shell command, a URL. */
	readonly resources: readonly string[];
}

/** One file the engine has changed during a session. */
export interface IEngineFileChange {
	/** Path as the engine reports it: absolute, or relative to the session directory. */
	readonly path: string;
	readonly status: 'added' | 'deleted' | 'modified' | undefined;
	readonly additions: number;
	readonly deletions: number;
	/** Unified diff of the change, when the engine supplies one. */
	readonly patch?: string;
}

/** One step of a response, as it happens. */
export type EngineEvent =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'reasoning'; readonly text: string }
	/** A tool call began; `input` is the tool's own argument object, e.g. `{ path }` or `{ command }`. */
	| { readonly kind: 'toolStart'; readonly callId: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> }
	| { readonly kind: 'toolEnd'; readonly callId: string; readonly ok: boolean; readonly detail?: string }
	| { readonly kind: 'permission'; readonly request: IEnginePermission }
	/** The engine's cumulative view of what this session has changed on disk. */
	| { readonly kind: 'diff'; readonly files: readonly IEngineFileChange[] }
	| { readonly kind: 'error'; readonly message: string };

export interface IPromptOptions {
	/** Model id to answer with, or undefined to leave the session's model alone. */
	readonly modelId?: string;
	/** Engine provider the model belongs to; defaults to the BBF-proxied one. */
	readonly providerId?: string;
	/** Model variant (reasoning-effort tier) to answer with, or undefined for the engine's default. */
	readonly variant?: string;
}

/**
 * How the extension talks to the OpenCode engine.
 *
 * Everything above this interface -- the chat participant, the control bar,
 * effort and permission modes -- is transport-agnostic. Only the implementation
 * knows that the engine is a local `opencode serve` process reached over HTTP
 * and SSE, which is what lets that decision be revisited without touching the UI.
 */
export interface IEngineTransport extends vscode.Disposable {

	/** Brings the engine up if it is not already running. Idempotent. */
	start(): Promise<void>;

	/** Models available to the signed-in account. */
	listModels(): Promise<IEngineModel[]>;

	createSession(workspaceFolder: vscode.Uri | undefined): Promise<IEngineSession>;

	/**
	 * Finds a session created earlier, so a reopened chat continues where it
	 * left off. Undefined when the engine no longer knows it.
	 */
	resumeSession(id: string): Promise<IEngineSession | undefined>;

	/**
	 * Sends a prompt and reports progress through `onEvent` until the turn ends.
	 *
	 * Cancelling `token` must interrupt the engine, not just stop listening: a
	 * turn that keeps running after the user cancels can still edit files.
	 */
	prompt(
		session: IEngineSession,
		text: string,
		options: IPromptOptions,
		onEvent: (event: EngineEvent) => void,
		token: vscode.CancellationToken
	): Promise<void>;

	/** Answers a permission request raised during `prompt`. */
	replyPermission(session: IEngineSession, requestId: string, allow: boolean): Promise<void>;
}
