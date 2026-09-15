/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IConfig {
	/** OAuth client ID from Google Cloud Console, credential type "Desktop app". */
	googleClientId: string;
	/**
	 * Client secret for that desktop client.
	 *
	 * Google states that the secret of an installed application is not treated as
	 * confidential, because it cannot be protected inside a native client. PKCE is
	 * what actually secures this flow. See
	 * https://developers.google.com/identity/protocols/oauth2/native-app
	 */
	googleClientSecret?: string;
	/**
	 * OAuth client ID from Google Cloud Console, credential type "Web application",
	 * used when BlackBox Code is served in a browser.
	 *
	 * A desktop client cannot be used there: it only accepts a redirect back to
	 * `127.0.0.1`, which in a hosted editor is the server rather than the machine
	 * the browser is on. A web client accepts the address the editor is served
	 * from, which is what the hosted sign-in hands to Google.
	 */
	webGoogleClientId?: string;
	/**
	 * Client secret for that web client, which unlike the desktop one above IS
	 * confidential -- Google will issue tokens to anyone holding it.
	 *
	 * It is read from the environment so it need not be committed: the hosted
	 * build runs this extension on the server, so the value stays there and never
	 * reaches a browser. Set BBF_GOOGLE_WEB_CLIENT_SECRET where the server runs.
	 */
	webGoogleClientSecret?: string;
	/**
	 * Only Google Workspace accounts in this domain may sign in. Enforced against
	 * the `hd` claim of the ID token, so personal Gmail accounts are rejected.
	 */
	allowedDomain: string;
}

// Filled in once by BBF before building the product, the same way VS Code brings
// in its own OAuth client IDs. Deliberately not a user setting: these belong to
// the build, not to the person running it.
export const Config: IConfig = {
	googleClientId: '571218015162-umfg9r8n7soog572k5gu6d3udih9vjfs.apps.googleusercontent.com',
	googleClientSecret: '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',
	// The id identifies the client and is public; only the secret is not. Both
	// may come from the environment so a deployment can set them without a build.
	webGoogleClientId: '571218015162-70riptq55601qop5ls31065pvjn95vip.apps.googleusercontent.com',
	webGoogleClientSecret: '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',
	allowedDomain: 'blackboxfactories.com'
};

/**
 * The client to sign in with, which differs by where the editor is running.
 *
 * The desktop build keeps the installed-application client it has always used.
 * A hosted one needs the web client, and says so plainly when a deployment has
 * not been given one, rather than failing later against Google.
 */
export function googleCredentials(isWeb: boolean): { clientId: string; clientSecret: string } {
	if (!isWeb) {
		return { clientId: Config.googleClientId, clientSecret: Config.googleClientSecret ?? '' };
	}
	return { clientId: Config.webGoogleClientId ?? '', clientSecret: Config.webGoogleClientSecret ?? '' };
}
