/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IOnboardingService } from '../common/onboardingService.js';

/**
 * BBF: the upstream onboarding wizard is a Copilot/Google/Apple sign-in flow and
 * is not registered in BBF Code. Its service is still required by
 * StartupPageRunnerContribution, so provide an inert implementation rather than
 * leaving the dependency unresolved.
 *
 * show() does nothing, so no wizard appears. onDidDismiss never fires, which
 * only means the "onboarding completed" flag is never written — and nothing
 * reads it except the code that would have shown the wizard.
 */
class NullOnboardingService implements IOnboardingService {

	declare readonly _serviceBrand: undefined;

	readonly onDidDismiss = Event.None;

	show(): void {
		// no-op
	}
}

registerSingleton(IOnboardingService, NullOnboardingService, InstantiationType.Delayed);
