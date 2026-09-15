/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Config, googleCredentials } from './config.js';
import { assertAllowedDomain, authorize, identityFromIdToken, refreshToken } from './googleAuth.js';

const PROVIDER_ID = 'bbf-google';
const PROVIDER_LABEL = 'Google';
const SECRET_KEY = 'bbf.google.sessions';

interface IStoredSession {
	readonly id: string;
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly idToken: string;
	readonly expiresAt: number;
	readonly account: { readonly id: string; readonly label: string };
	readonly scopes: string[];
}

class GoogleAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {

	private readonly _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	constructor(private readonly secrets: vscode.SecretStorage) { }

	async getSessions(scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
		const stored = await this.read();
		const usable: vscode.AuthenticationSession[] = [];

		for (const session of stored) {
			try {
				usable.push(await this.toSession(session));
			} catch {
				// A session we can no longer refresh is worse than no session:
				// drop it so the user is offered a clean sign-in.
				await this.write(stored.filter(s => s.id !== session.id));
			}
		}

		if (!scopes?.length) {
			return usable;
		}
		return usable.filter(s => scopes.every(scope => s.scopes.includes(scope)));
	}

	async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		const isWeb = vscode.env.uiKind === vscode.UIKind.Web;
		const { clientId, clientSecret } = googleCredentials(isWeb);
		const { allowedDomain } = Config;

		if (!clientId) {
			// Misconfigured build rather than user error, so say so plainly, and
			// name the client that is missing: a hosted editor needs its own.
			await vscode.window.showErrorMessage(isWeb
				? vscode.l10n.t('This deployment of BlackBox Code has no Google OAuth client for the browser. Set BBF_GOOGLE_WEB_CLIENT_ID and BBF_GOOGLE_WEB_CLIENT_SECRET where the server runs, from a credential of type "Web application".')
				: vscode.l10n.t('This build of BlackBox Code has no Google OAuth client configured. Set googleClientId in extensions/bbf-google-auth/src/config.ts and rebuild.'));
			throw new Error(`No Google OAuth client configured for the ${isWeb ? 'hosted' : 'desktop'} build.`);
		}

		const tokens = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Signing in to Google…') },
			() => authorize(clientId, clientSecret, allowedDomain));

		const identity = identityFromIdToken(tokens.id_token);
		// Throws for anyone outside the domain, before the session is stored.
		assertAllowedDomain(identity, allowedDomain);

		const session: IStoredSession = {
			id: `${PROVIDER_ID}-${identity.subject}`,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			idToken: tokens.id_token,
			expiresAt: Date.now() + (tokens.expires_in * 1000),
			account: { id: identity.subject, label: identity.email },
			scopes: [...scopes]
		};

		const existing = (await this.read()).filter(s => s.id !== session.id);
		await this.write([...existing, session]);

		const created = await this.toSession(session);
		this._onDidChangeSessions.fire({ added: [created], removed: [], changed: [] });
		return created;
	}

	async removeSession(sessionId: string): Promise<void> {
		const stored = await this.read();
		const removed = stored.find(s => s.id === sessionId);
		await this.write(stored.filter(s => s.id !== sessionId));
		if (removed) {
			this._onDidChangeSessions.fire({ added: [], removed: [await this.toSession(removed, true)], changed: [] });
		}
	}

	/** Refreshes the access token when it is close to expiring. */
	private async toSession(stored: IStoredSession, skipRefresh = false): Promise<vscode.AuthenticationSession> {
		let current = stored;
		const nearlyExpired = stored.expiresAt - Date.now() < 60_000;

		if (!skipRefresh && nearlyExpired) {
			if (!stored.refreshToken) {
				throw new Error('Session expired and no refresh token is available.');
			}
			// The same client that issued the refresh token has to renew it, so
			// this follows where the editor is running just as sign-in does.
			const refreshWith = googleCredentials(vscode.env.uiKind === vscode.UIKind.Web);
			const tokens = await refreshToken(stored.refreshToken, refreshWith.clientId, refreshWith.clientSecret);
			const identity = identityFromIdToken(tokens.id_token ?? stored.idToken);
			// Re-check on every refresh: the account may have left the domain.
			assertAllowedDomain(identity, Config.allowedDomain);

			current = {
				...stored,
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token ?? stored.refreshToken,
				idToken: tokens.id_token ?? stored.idToken,
				expiresAt: Date.now() + (tokens.expires_in * 1000)
			};
			const others = (await this.read()).filter(s => s.id !== current.id);
			await this.write([...others, current]);
		}

		return {
			id: current.id,
			accessToken: current.accessToken,
			account: current.account,
			scopes: current.scopes
		};
	}

	private async read(): Promise<IStoredSession[]> {
		const raw = await this.secrets.get(SECRET_KEY);
		if (!raw) {
			return [];
		}
		try {
			return JSON.parse(raw) as IStoredSession[];
		} catch {
			return [];
		}
	}

	private async write(sessions: IStoredSession[]): Promise<void> {
		await this.secrets.store(SECRET_KEY, JSON.stringify(sessions));
	}

	dispose(): void {
		this._onDidChangeSessions.dispose();
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new GoogleAuthenticationProvider(context.secrets);
	context.subscriptions.push(provider);
	context.subscriptions.push(vscode.authentication.registerAuthenticationProvider(
		PROVIDER_ID, PROVIDER_LABEL, provider, { supportsMultipleAccounts: false }));
}

export function deactivate(): void { }
