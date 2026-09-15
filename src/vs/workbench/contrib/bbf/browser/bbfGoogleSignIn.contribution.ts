/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';

const BBF_GOOGLE_PROVIDER_ID = 'bbf-google';
const SCOPES = ['openid', 'email', 'profile'];

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
