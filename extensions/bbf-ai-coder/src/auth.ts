/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GOOGLE_PROVIDER_ID, GOOGLE_SCOPES, serviceUrl } from './config.js';

/**
 * Access to BBF AI Coder.
 *
 * There is no separate sign-in. Whoever is already signed into BlackBox Code with
 * their Blackbox Factories Google account can use AI Coder, because that Google
 * identity is what the backend checks.
 *
 * The company OpenCode Zen key is deliberately absent from this file and from
 * everything else that ships to a machine. The extension holds only a
 * short-lived token minted by our own server for one user, and reaches Zen
 * through that server's proxy. A decompiled .vsix therefore yields nothing
 * worth stealing -- which matters far more for a shared key than a personal
 * one, since a single leak would affect everyone at once.
 */

export interface IEngineCredential {
	/** Short-lived, per-user, minted by the BBF server. Never the Zen key. */
	readonly token: string;
	/** The BBF proxy the engine should call instead of Zen directly. */
	readonly baseUrl: string;
	/** Google account the token was issued to, for display only. */
	readonly account: string;
}

interface ICachedCredential extends IEngineCredential {
	readonly expiresAt: number;
}

/**
 * Refuses to put a bearer token on a plaintext connection to anything but this
 * machine.
 *
 * Localhost is allowed so a developer can run the server without certificates;
 * anything else must be TLS, because otherwise every prompt and every piece of
 * source code the agent sends would cross the network in the clear.
 */
export function assertSecureServiceUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`BBF AI Coder service URL is not a valid URL: ${url}`);
	}

	if (parsed.protocol === 'https:') {
		return;
	}

	// The URL parser keeps the brackets on an IPv6 host.
	const isLoopback = parsed.hostname === 'localhost'
		|| parsed.hostname === '127.0.0.1'
		|| parsed.hostname === '[::1]';

	if (parsed.protocol === 'http:' && isLoopback) {
		return;
	}

	throw new Error(
		`BBF AI Coder refuses to send credentials to ${parsed.host} over plain HTTP. Serve the BBF server over HTTPS.`);
}

export class AiCoderAccess {

	private cached: ICachedCredential | undefined;
	private inFlight: Promise<IEngineCredential> | undefined;

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private readonly sessionListener: vscode.Disposable;

	constructor() {
		// Signing out of Google must revoke AI access in the same moment.
		this.sessionListener = vscode.authentication.onDidChangeSessions(e => {
			if (e.provider.id === GOOGLE_PROVIDER_ID) {
				this.cached = undefined;
				this._onDidChange.fire();
			}
		});
	}

	/** True when this user could use AI Coder right now without being prompted. */
	async isAvailable(): Promise<boolean> {
		return !!(await this.getGoogleSession(false));
	}

	/**
	 * Returns a usable engine credential, signing the user into Google first if
	 * they are not already.
	 *
	 * Undefined means the user declined to sign in; callers should stay quiet
	 * rather than reporting an error the user chose.
	 */
	async acquire(options: { interactive: boolean }): Promise<IEngineCredential | undefined> {
		if (this.cached && this.cached.expiresAt > Date.now() + 60_000) {
			return this.cached;
		}
		// Collapse concurrent callers onto one exchange; several chat requests can
		// start at once and each would otherwise mint a separate token.
		this.inFlight ??= this.exchange(options.interactive).finally(() => {
			this.inFlight = undefined;
		});

		try {
			return await this.inFlight;
		} catch (error) {
			if (error instanceof SignInDeclined) {
				return undefined;
			}
			throw error;
		}
	}

	/**
	 * Drops the cached token so the next request mints a fresh one.
	 * Called when the server answers 401, which happens after a restart or an
	 * expiry we did not predict.
	 */
	invalidate(): void {
		this.cached = undefined;
	}

	private async exchange(interactive: boolean): Promise<IEngineCredential> {
		const session = await this.getGoogleSession(interactive);
		if (!session) {
			throw new SignInDeclined();
		}

		const base = serviceUrl();
		assertSecureServiceUrl(base);

		let response: Response;
		try {
			response = await fetch(`${base}/ai-coder/session`, {
				method: 'POST',
				headers: {
					// The user's Google token, not a company secret. The server
					// verifies it with Google and mints a token of its own.
					'Authorization': `Bearer ${session.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: '{}'
			});
		} catch {
			throw new Error(`Could not reach the BBF server at ${base}. Is it running?`);
		}

		if (!response.ok) {
			// The server's message is written for a user ("AI Coder is limited to
			// @blackboxfactories.com accounts"), so pass it through rather than
			// inventing one. It never contains a credential.
			const detail = await response.text().catch(() => '');
			throw new Error(readServerError(detail) ?? `BBF server refused AI access (${response.status}).`);
		}

		const payload = await response.json() as { token: string; expiresAt: number; baseUrl: string; account: string };
		const credential: ICachedCredential = {
			token: payload.token,
			baseUrl: payload.baseUrl,
			account: payload.account,
			expiresAt: payload.expiresAt
		};
		this.cached = credential;
		this._onDidChange.fire();
		return credential;
	}

	private async getGoogleSession(interactive: boolean): Promise<vscode.AuthenticationSession | undefined> {
		try {
			return await vscode.authentication.getSession(
				GOOGLE_PROVIDER_ID,
				[...GOOGLE_SCOPES],
				interactive ? { createIfNone: true } : { silent: true });
		} catch {
			// The user dismissed the sign-in prompt, or the provider is missing.
			return undefined;
		}
	}

	dispose(): void {
		this.sessionListener.dispose();
		this._onDidChange.dispose();
	}
}

/** The user closed the sign-in prompt. Not an error worth reporting. */
class SignInDeclined extends Error {
	constructor() {
		super('Sign-in was declined.');
	}
}

function readServerError(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		return typeof parsed.error === 'string' ? parsed.error : undefined;
	} catch {
		return undefined;
	}
}
