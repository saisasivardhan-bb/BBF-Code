/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as vscode from 'vscode';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPES = ['openid', 'email', 'profile'];

interface ITokenResponse {
	readonly access_token: string;
	readonly refresh_token?: string;
	readonly expires_in: number;
	readonly id_token: string;
}

export interface IGoogleIdentity {
	readonly email: string;
	readonly name: string;
	readonly domain?: string;
	readonly subject: string;
}

/** Decode a JWT payload. Signature is not checked here — see verifyIdentity(). */
function decodeIdToken(idToken: string): Record<string, unknown> {
	const payload = idToken.split('.')[1];
	if (!payload) {
		throw new Error('Malformed ID token.');
	}
	const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
	return JSON.parse(json);
}

export function identityFromIdToken(idToken: string): IGoogleIdentity {
	const claims = decodeIdToken(idToken);
	const email = typeof claims.email === 'string' ? claims.email : '';
	if (!email) {
		throw new Error('Google did not return an email address.');
	}
	return {
		email,
		name: typeof claims.name === 'string' ? claims.name : email,
		// `hd` is only present for Google Workspace accounts, never for personal Gmail.
		domain: typeof claims.hd === 'string' ? claims.hd : undefined,
		subject: String(claims.sub ?? email)
	};
}

/**
 * Reject anyone outside the allowed Workspace domain.
 *
 * The `hd` parameter on the authorization request is only a hint — a user can
 * edit it out of the URL — so the decision has to be made from the `hd` claim
 * that Google signs into the ID token.
 */
export function assertAllowedDomain(identity: IGoogleIdentity, allowedDomain: string): void {
	if (!allowedDomain) {
		return;
	}
	const domain = identity.domain ?? identity.email.split('@')[1];
	if (domain?.toLowerCase() !== allowedDomain.toLowerCase()) {
		throw new Error(`${identity.email} is not a ${allowedDomain} account.`);
	}
}

function base64url(buffer: Buffer): string {
	return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Runs Google's installed-application flow: a loopback redirect on 127.0.0.1.
 * Google does not permit custom URI schemes for desktop clients, so a short-lived
 * local server catches the redirect instead.
 */
export async function authorize(clientId: string, clientSecret: string, allowedDomain: string): Promise<ITokenResponse> {
	const verifier = base64url(crypto.randomBytes(32));
	const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
	const state = base64url(crypto.randomBytes(16));

	const { server, loopbackUri, state: routedState, codePromise } = await startLoopbackServer(state);
	// Where Google is told to send the answer. On the desktop that is the
	// loopback listener itself; hosted, it is this server's fixed callback,
	// which passes the answer on to that listener (see webClientServer.ts).
	const redirectUri = await resolveRedirect(loopbackUri);

	const url = new URL(AUTH_ENDPOINT);
	url.searchParams.set('client_id', clientId);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', SCOPES.join(' '));
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', routedState);
	url.searchParams.set('access_type', 'offline');
	url.searchParams.set('prompt', 'consent select_account');
	if (allowedDomain) {
		// A hint so the picker defaults to work accounts; not a security control.
		url.searchParams.set('hd', allowedDomain);
	}

	try {
		await openConsentPage(url.toString());
		const code = await codePromise;
		return await exchangeCode(code, verifier, redirectUri, clientId, clientSecret);
	} finally {
		server.close();
	}
}

function startLoopbackServer(baseState: string): Promise<{
	server: http.Server;
	/** Where this listener can be reached from the machine it runs on. */
	loopbackUri: string;
	/** `baseState` with the listening port appended, which is what Google echoes back. */
	state: string;
	codePromise: Promise<string>;
}> {
	return new Promise((resolveServer, rejectServer) => {
		// Set once the port is known; the handler below reads it at request time.
		let expectedState = baseState;
		let settle: { resolve(code: string): void; reject(error: Error): void };
		const codePromise = new Promise<string>((resolve, reject) => {
			settle = { resolve, reject };
		});

		const timeout = setTimeout(() => settle.reject(new Error('Timed out waiting for Google sign-in.')), 5 * 60 * 1000);
		codePromise.finally(() => clearTimeout(timeout)).catch(() => { /* handled by caller */ });

		const server = http.createServer((req, res) => {
			const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
			const code = requestUrl.searchParams.get('code');
			const error = requestUrl.searchParams.get('error');
			const state = requestUrl.searchParams.get('state');

			const reply = (message: string) => {
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(`<!doctype html><meta charset="utf-8"><title>BlackBox Code</title>
<body style="font-family:system-ui;background:#fff;color:#5D5D5D;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-weight:900;color:#000;letter-spacing:.02em">BBF CODE</div>
<p>${message}</p><p style="font-style:italic;font-size:13px">You can close this tab.</p></div>`);
			};

			if (error) {
				reply('Sign-in failed.');
				settle.reject(new Error(`Google returned "${error}".`));
				return;
			}
			// Guards against a stray request landing on the loopback port mid-flow.
			if (state !== expectedState) {
				reply('Sign-in failed.');
				settle.reject(new Error('State mismatch; the sign-in was not completed.'));
				return;
			}
			if (!code) {
				reply('Sign-in failed.');
				settle.reject(new Error('Google did not return an authorization code.'));
				return;
			}
			reply('Signed in. Return to BlackBox Code.');
			settle.resolve(code);
		});

		server.on('error', rejectServer);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			// The port is only known now, and the hosted callback needs it to
			// find this listener again, so it travels inside the state.
			expectedState = `${baseState}.${port}`;
			resolveServer({ server, loopbackUri: `http://127.0.0.1:${port}`, state: expectedState, codePromise });
		});
	});
}

/**
 * Decides the address Google returns the sign-in to.
 *
 * On the desktop the loopback listener is on the same machine as the browser,
 * so Google can reach it directly. Hosted, it is not: the browser would be
 * asked to open a port on its own machine, where nothing is listening, which
 * is the "site cannot be reached" a hosted sign-in ends at. There the answer
 * goes to this server's own callback, one address that never varies and can
 * therefore be registered with Google, and the server hands it on.
 */
async function resolveRedirect(loopbackUri: string): Promise<string> {
	if (vscode.env.uiKind !== vscode.UIKind.Web) {
		return loopbackUri;
	}
	const origin = await vscode.commands.executeCommand<string>('bbf.signIn.origin');
	if (!origin) {
		throw new Error('Could not determine the address this editor is served from.');
	}
	return `${origin.replace(/\/+$/, '')}/bbf-auth/callback`;
}

/**
 * Sends the user to Google's consent page.
 *
 * On the desktop the editor hands the URL to the operating system. In the
 * hosted build this extension runs in the remote extension host, where that
 * same call resolves on the server: no tab opens where the user is, and
 * sign-in waits for a redirect that never comes. There the window opens the
 * tab itself, through a command the workbench registers for exactly this.
 */
async function openConsentPage(url: string): Promise<void> {
	if (vscode.env.uiKind === vscode.UIKind.Web) {
		await vscode.commands.executeCommand('bbf.signIn.openInNewTab', url);
		return;
	}
	await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function exchangeCode(code: string, verifier: string, redirectUri: string, clientId: string, clientSecret: string): Promise<ITokenResponse> {
	return postToken({
		client_id: clientId,
		client_secret: clientSecret,
		code,
		code_verifier: verifier,
		grant_type: 'authorization_code',
		redirect_uri: redirectUri
	});
}

export async function refreshToken(refresh: string, clientId: string, clientSecret: string): Promise<ITokenResponse> {
	const response = await postToken({
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: refresh,
		grant_type: 'refresh_token'
	});
	// A refresh response omits refresh_token; keep the one we already hold.
	return { ...response, refresh_token: response.refresh_token ?? refresh };
}

async function postToken(fields: Record<string, string>): Promise<ITokenResponse> {
	const body = new URLSearchParams(
		Object.entries(fields).filter(([, value]) => !!value)
	).toString();

	const response = await fetch(TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		throw new Error(`Google token request failed (${response.status}). ${detail.slice(0, 200)}`);
	}
	return await response.json() as ITokenResponse;
}
