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
	allowedDomain: 'blackboxfactories.com'
};
