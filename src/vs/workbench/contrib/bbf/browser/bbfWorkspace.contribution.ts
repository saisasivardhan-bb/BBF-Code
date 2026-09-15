/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isWeb } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IHostService } from '../../../services/host/browser/host.js';

const PROVIDER_ID = 'bbf-google';
const SCOPES = ['openid', 'email', 'profile'];

/** Asks the server for this account's folder; see `webClientServer.ts`. */
const WORKSPACE_ENDPOINT = 'bbf-workspace';

/** `?ew` is how the workbench is asked for a window with no folder at all. */
const EMPTY_WINDOW_PARAM = 'ew';

/**
 * Opens each signed-in person in a folder of their own.
 *
 * A hosted editor is one server on one machine, so everyone who follows the
 * link arrives in the same folder -- whatever the server was started on. Shared
 * between colleagues that means opening the editor and finding somebody else's
 * work, which is what this prevents: the account that is signed in decides the
 * folder, and the server creates it the first time it is asked for.
 *
 * Worth being exact about what this is not. It organises people, it does not
 * separate them: everyone still runs as the same account on the same machine,
 * and a terminal reaches the whole disk from anywhere. Separating people needs
 * one server each, not one folder each.
 *
 * Desktop is untouched -- there the machine already belongs to the person using
 * it, and choosing a folder for them would only be rude.
 */
class BBFUserWorkspace extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.bbfUserWorkspace';

	private opening = false;

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		if (!isWeb || !this.environmentService.remoteAuthority) {
			return;
		}
		// Someone who asked for an empty window meant it.
		if (new URL(mainWindow.location.href).searchParams.has(EMPTY_WINDOW_PARAM)) {
			return;
		}

		this.tryOpenUserFolder();

		// A first sign-in finishes after startup does, and the person doing it
		// is exactly the one with no folder yet.
		this._register(this.authenticationService.onDidChangeSessions(e => {
			if (e.providerId === PROVIDER_ID) {
				this.tryOpenUserFolder();
			}
		}));
	}

	private tryOpenUserFolder(): void {
		this.openUserFolder().catch(error => this.logService.error('[bbf] could not open the folder for this account', error));
	}

	private async openUserFolder(): Promise<void> {
		if (this.opening) {
			return;
		}
		if (this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			return; // a folder is already open, and it is not ours to change
		}

		const account = await this.currentAccount();
		if (!account) {
			return; // nobody is signed in; the sign-in gate has this
		}

		const base = mainWindow.location.pathname.replace(/[^/]*$/, '');
		const response = await fetch(`${base}${WORKSPACE_ENDPOINT}?account=${encodeURIComponent(account)}`, { credentials: 'include' });
		if (!response.ok) {
			throw new Error(`The server could not prepare a folder for ${account} (${response.status}).`);
		}

		const { path } = await response.json() as { path: string };
		if (!path) {
			throw new Error('The server named no folder.');
		}

		this.opening = true;
		// Reuse this window: a second one would leave the empty window behind.
		await this.hostService.openWindow([{
			folderUri: URI.from({ scheme: Schemas.vscodeRemote, authority: this.environmentService.remoteAuthority, path })
		}], { forceReuseWindow: true });
	}

	/** The account label of the signed-in user, if there is one yet. */
	private async currentAccount(): Promise<string | undefined> {
		try {
			// activateImmediate, for the same reason the sign-in gate uses it:
			// the provider is an extension, and it may not be awake yet.
			const sessions = await this.authenticationService.getSessions(PROVIDER_ID, SCOPES, undefined, true);
			return sessions.at(0)?.account.label;
		} catch (error) {
			this.logService.trace('[bbf] no account to choose a folder from', error);
			return undefined;
		}
	}
}

// AfterRestored: opening a folder reloads the window, so this must not race the
// parts of startup that would be thrown away anyway.
registerWorkbenchContribution2(BBFUserWorkspace.ID, BBFUserWorkspace, WorkbenchPhase.AfterRestored);
