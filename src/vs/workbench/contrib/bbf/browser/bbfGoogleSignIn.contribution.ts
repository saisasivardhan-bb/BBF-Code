/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';

const BBF_GOOGLE_PROVIDER_ID = 'bbf-google';
const SCOPES = ['openid', 'email', 'profile'];

/** Asked for by the sign-in extension when it cannot open a tab itself. */
const BBF_OPEN_IN_NEW_TAB_COMMAND = 'bbf.signIn.openInNewTab';
/** Asked for by the sign-in extension to learn the address the user reached us on. */
const BBF_ORIGIN_COMMAND = 'bbf.signIn.origin';

/**
 * Puts "Sign in with Google" in the Accounts menu.
 *
 * The menu is otherwise demand-driven: it lists accounts that already exist, or
 * providers an extension has asked for a session from. A provider nobody has
 * requested yet is invisible, so without this there is no way to start the BBF
 * Google sign-in from the UI.
 */
class BBFGoogleSignInAction extends Action2 {

	static readonly ID = 'bbf.accounts.signInWithGoogle';

	constructor() {
		super({
			id: BBFGoogleSignInAction.ID,
			title: localize2('bbfSignInWithGoogle', 'Sign in with Google'),
			menu: [{
				id: MenuId.AccountsContext,
				group: '1_bbf',
				order: 1
			}],
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const authenticationService = accessor.get(IAuthenticationService);
		const notificationService = accessor.get(INotificationService);

		try {
			const session = await authenticationService.createSession(BBF_GOOGLE_PROVIDER_ID, SCOPES);
			notificationService.info(localize('bbfSignedIn', "Signed in to BlackBox Code as {0}.", session.account.label));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Covers the two expected refusals: an account outside the allowed
			// domain, and a build with no OAuth client configured.
			notificationService.error(localize('bbfSignInFailed', "Google sign-in failed. {0}", message));
		}
	}
}

registerAction2(BBFGoogleSignInAction);

/**
 * Opens a URL in a new browser tab, for the sign-in extension.
 *
 * In the hosted build that extension runs in the remote extension host, where
 * `env.openExternal` resolves on the server and the consent page never reaches
 * the person sitting in front of the browser: no tab opens, and sign-in waits
 * on a redirect that cannot arrive. This command runs in the window itself, so
 * the tab opens where the user actually is. The desktop build keeps using
 * `openExternal` and never calls this.
 */
CommandsRegistry.registerCommand(BBF_OPEN_IN_NEW_TAB_COMMAND, (_accessor: ServicesAccessor, url: unknown) => {
	if (typeof url !== 'string') {
		throw new Error('A URL is required.');
	}
	// `noopener` keeps the opened page from reaching back into the workbench.
	mainWindow.open(url, '_blank', 'noopener');
});

/**
 * Reports the address this window was loaded from.
 *
 * Google sends a finished sign-in to an address registered for the client, and
 * the extension has to name that address when it starts one. It runs on the
 * server and cannot know what the browser typed to get here -- a tunnel, a
 * domain, a port -- so the window, which does know, is asked.
 */
CommandsRegistry.registerCommand(BBF_ORIGIN_COMMAND, () => mainWindow.location.origin);
