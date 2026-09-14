/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import './media/bbfSignInGate.css';

const PROVIDER_ID = 'bbf-google';
const SCOPES = ['openid', 'email', 'profile'];

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The BBF chevron, built with DOM calls rather than innerHTML: the workbench
 * enforces Trusted Types, so assigning markup throws.
 */
function createMark(): SVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'bbf-gate-mark');
	svg.setAttribute('viewBox', '0 0 240 170');
	svg.setAttribute('aria-hidden', 'true');

	const chevron = (fill: string, points: string) => {
		const polygon = document.createElementNS(SVG_NS, 'polygon');
		polygon.setAttribute('fill', fill);
		polygon.setAttribute('points', points);
		svg.appendChild(polygon);
	};
	chevron('#B5BC38', '0 81.92 81.96 163.87 152.05 163.87 70.1 81.92 152.05 0 81.96 0 0 81.92');
	chevron('#DC6621', '141.6 81.92 223.56 163.87 234.36 163.87 152.4 81.92 234.36 0 223.56 0 141.6 81.92');
	return svg;
}

/**
 * Blocks the workbench until a Blackbox Factories Google account is signed in.
 *
 * This is a deterrent, not an entitlement check: anyone who can run the build
 * can also modify it. It exists so the product opens on a sign-in screen and
 * carries an identity, not to make the editor uncopyable.
 *
 * Gated on `product.json`'s `bbfRequireSignIn` so a build that ships without a
 * working OAuth client can be released without locking every user out.
 */
class BBFSignInGate extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.bbfSignInGate';

	private overlay: HTMLElement | undefined;

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		if (!this.productService.bbfRequireSignIn) {
			return;
		}

		this.evaluate().catch(error => this.logService.error('[bbf] sign-in gate failed', error));

		this._register(this.authenticationService.onDidChangeSessions(e => {
			if (e.providerId === PROVIDER_ID) {
				this.evaluate().catch(error => this.logService.error('[bbf] sign-in gate failed', error));
			}
		}));
	}

	private async evaluate(): Promise<void> {
		if (await this.hasSession()) {
			this.hide();
		} else {
			this.show();
		}
	}

	private async hasSession(): Promise<boolean> {
		try {
			// activateImmediate: the provider lives in an extension that has no
			// activation events, so it must be woken before it can answer.
			const sessions = await this.authenticationService.getSessions(PROVIDER_ID, SCOPES, undefined, true);
			return sessions.length > 0;
		} catch (error) {
			// A provider that cannot be reached is not a signed-in user.
			this.logService.trace('[bbf] no Google session available', error);
			return false;
		}
	}

	private show(): void {
		if (this.overlay) {
			return;
		}

		const overlay = $('.bbf-signin-gate');
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.appendChild(createMark());

		const title = append(overlay, $('h1.bbf-gate-title'));
		title.textContent = this.productService.nameLong;

		const subtitle = append(overlay, $('p.bbf-gate-subtitle'));
		subtitle.textContent = localize('bbf.gate.subtitle',
			"Sign in with your Blackbox Factories Google account to continue.");

		const button = append(overlay, $('button.bbf-gate-button')) as HTMLButtonElement;
		button.textContent = localize('bbf.gate.signIn', "Sign in with Google");

		const error = append(overlay, $('p.bbf-gate-error'));

		const footer = append(overlay, $('p.bbf-gate-footer'));
		footer.textContent = localize('bbf.gate.footer', "Blackbox Factories");

		this._register({
			dispose: () => overlay.remove()
		});

		button.onclick = async () => {
			button.disabled = true;
			error.textContent = '';
			try {
				await this.authenticationService.createSession(PROVIDER_ID, SCOPES);
				// onDidChangeSessions re-evaluates and hides the gate.
			} catch (e) {
				error.textContent = e instanceof Error ? e.message : String(e);
			} finally {
				button.disabled = false;
			}
		};

		this.layoutService.mainContainer.appendChild(overlay);
		this.overlay = overlay;
		button.focus();
	}

	private hide(): void {
		if (!this.overlay) {
			return;
		}
		clearNode(this.overlay);
		this.overlay.remove();
		this.overlay = undefined;
	}
}

// BlockRestore: the gate must paint before editors restore, so the workbench is
// never briefly usable behind it.
registerWorkbenchContribution2(BBFSignInGate.ID, BBFSignInGate, WorkbenchPhase.BlockRestore);
