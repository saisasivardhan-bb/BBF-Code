/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';

/**
 * Chat setup, for a product that has no Copilot to set up.
 *
 * Upstream registers `workbench.action.chat.triggerSetup` inside the chat setup
 * contribution, which returns early unless `product.json` names a
 * `defaultChatAgent`. BBF deliberately names none, so that whole contribution
 * bails and the command is never registered -- while roughly eight call sites
 * across the chat UI still invoke it. Each of those failed with
 * "command 'workbench.action.chat.triggerSetup' not found", which is what a
 * user saw instead of an answer.
 *
 * Registering it here keeps those call sites working and gives them the only
 * setup BBF actually has: signing in with a Blackbox Factories Google account.
 *
 * The action ids are duplicated as literals rather than imported from
 * `contrib/chat`, so this file does not pull the chat setup module -- and its
 * Copilot entitlement machinery -- back into the graph.
 */

const CHAT_SETUP_ACTION_ID = 'workbench.action.chat.triggerSetup';
const CHAT_SETUP_ANONYMOUS_ACTION_ID = 'workbench.action.chat.triggerSetupSupportAnonymousAction';

const PROVIDER_ID = 'bbf-google';
const SCOPES = ['openid', 'email', 'profile'];

/**
 * Returns `true` for done, `false` for failed, `undefined` for cancelled.
 *
 * Deliberately not the `IChatSetupResult` object upstream returns. Live callers
 * read this as a boolean -- `chatTipContentPart` does
 * `executeCommand<boolean | undefined>(...)` and then `if (!setupSucceeded)` --
 * and an object is always truthy, so returning one would report a declined
 * sign-in as a success and carry on as though the user had agreed.
 */
async function runBbfSetup(accessor: ServicesAccessor): Promise<boolean | undefined> {
	const authenticationService = accessor.get(IAuthenticationService);
	const notificationService = accessor.get(INotificationService);

	try {
		const existing = await authenticationService.getSessions(PROVIDER_ID, SCOPES, undefined, true);
		if (existing.length > 0) {
			// Already signed in: there is nothing to set up, and saying so beats
			// opening a sign-in the user does not need.
			return true;
		}

		const session = await authenticationService.createSession(PROVIDER_ID, SCOPES);
		notificationService.info(localize2('bbfChatSetupDone', "BBF AI Coder is ready. Signed in as {0}.", session.account.label).value);
		return true;
	} catch (error) {
		// A declined sign-in is a cancellation, not a failure worth reporting.
		const message = error instanceof Error ? error.message : String(error);
		if (/cancel/i.test(message)) {
			return undefined;
		}
		notificationService.error(localize2('bbfChatSetupFailed', "Could not set up BBF AI Coder. {0}", message).value);
		return false;
	}
}

class BbfChatSetupAction extends Action2 {
	constructor() {
		super({
			id: CHAT_SETUP_ACTION_ID,
			title: localize2('bbfChatSetup', "Set Up BBF AI Coder"),
			f1: false
		});
	}

	override run(accessor: ServicesAccessor): Promise<boolean | undefined> {
		return runBbfSetup(accessor);
	}
}

/**
 * Upstream's anonymous variant starts chat without an account. BBF has no
 * anonymous tier -- access is the Google account -- so it runs the same flow.
 */
class BbfChatSetupAnonymousAction extends Action2 {
	constructor() {
		super({
			id: CHAT_SETUP_ANONYMOUS_ACTION_ID,
			title: localize2('bbfChatSetup', "Set Up BBF AI Coder"),
			f1: false
		});
	}

	override run(accessor: ServicesAccessor): Promise<boolean | undefined> {
		return runBbfSetup(accessor);
	}
}

registerAction2(BbfChatSetupAction);
registerAction2(BbfChatSetupAnonymousAction);
