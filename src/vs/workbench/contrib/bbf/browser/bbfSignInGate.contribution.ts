/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../base/common/async.js';
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
/**
 * How long the provider gets to appear before the gate stops waiting for it.
 *
 * Generous on purpose: this only runs when nothing answers at all. Someone who
 * is genuinely signed out gets a straight answer in a second or two and never
 * waits this long, whereas a cold server opening a folder for the first time
 * can take most of a minute to bring its extension host up.
 */
const PROVIDER_WAIT = 60_000;

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
	private mode: 'checking' | 'signIn' | undefined;
	/** Identifies the newest question asked, so older answers can be dropped. */
	private generation = 0;
	/** Whether anything has ever given a straight yes or no. */
	private answered = false;

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

		// The first question above is asked while the window is still starting,
		// and it is answered by an extension in a host that may not be up yet:
		// `getSessions` gives that host five seconds and then reports no session.
		// Hosted, a cold page load routinely needs longer, and the answer never
		// changed afterwards -- a signed-in user was shown the sign-in screen on
		// every reload, and opening a folder, which restarts that host, made it
		// near certain. Asking again the moment the provider arrives costs
		// nothing and is the only answer worth trusting.
		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(e => {
			if (e.id === PROVIDER_ID) {
				this.evaluate().catch(error => this.logService.error('[bbf] sign-in gate failed', error));
			}
		}));

		// Should nothing ever answer -- an extension host that fails to start, a
		// build shipped without the sign-in extension -- offer the sign-in anyway
		// rather than leave a screen that says only that it is checking.
		this._register(disposableTimeout(() => {
			if (this.mode === 'checking') {
				this.showSignIn();
			}
		}, PROVIDER_WAIT));
	}

	private async evaluate(): Promise<void> {
		// Several of these run at once -- one from startup, one from the provider
		// arriving -- and they do not finish in the order they began: the startup
		// one spends five seconds waiting for a provider that a later one already
		// has. Without this, that stale answer landed last and put the gate back
		// over a window that was already unlocked, where nothing would ever ask
		// again. Only the newest question may answer.
		const generation = ++this.generation;
		const session = await this.hasSession();
		if (generation !== this.generation) {
			return;
		}

		if (session === true) {
			this.answered = true;
			this.hide();
		} else if (session === false) {
			this.answered = true;
			this.showSignIn();
		} else if (!this.answered) {
			// Nobody has answered yet. Keep the workbench covered, but do not ask
			// for a sign-in we may not need: the listeners above bring us back
			// here as soon as there is a real answer. Once something has answered
			// properly, a later silence is no reason to doubt it.
			this.showChecking();
		}
	}

	/** `undefined` when nothing could answer, which is not the same as signed out. */
	private async hasSession(): Promise<boolean | undefined> {
		try {
			// activateImmediate: the provider lives in an extension that has no
			// activation events, so it must be woken before it can answer.
			const sessions = await this.authenticationService.getSessions(PROVIDER_ID, SCOPES, undefined, true);
			return sessions.length > 0;
		} catch (error) {
			// The provider is missing or still starting. Treating that as signed
			// out is what put the sign-in screen in front of users who were
			// already signed in.
			this.logService.trace('[bbf] no answer yet from the Google provider', error);
			return undefined;
		}
	}

	private showChecking(): void {
		this.render('checking');
	}

	private showSignIn(): void {
		this.render('signIn');
	}

	private render(mode: 'checking' | 'signIn'): void {
		if (this.mode === mode) {
			return;
		}
		this.mode = mode;

		const overlay = this.overlay ?? this.createOverlay();
		clearNode(overlay);
		overlay.appendChild(createMark());

		const title = append(overlay, $('h1.bbf-gate-title'));
		title.textContent = this.productService.nameLong;

		const subtitle = append(overlay, $('p.bbf-gate-subtitle'));

		if (mode === 'checking') {
			subtitle.textContent = localize('bbf.gate.checking',
				"Checking your Blackbox Factories account…");
		} else {
			subtitle.textContent = localize('bbf.gate.subtitle',
				"Sign in with your Blackbox Factories Google account to continue.");

			const button = append(overlay, $('button.bbf-gate-button')) as HTMLButtonElement;
			button.textContent = localize('bbf.gate.signIn', "Sign in with Google");

			const error = append(overlay, $('p.bbf-gate-error'));

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

			button.focus();
		}

		const footer = append(overlay, $('p.bbf-gate-footer'));
		footer.textContent = localize('bbf.gate.footer', "Blackbox Factories");
	}

	private createOverlay(): HTMLElement {
		const overlay = $('.bbf-signin-gate');
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');

		this._register({
			dispose: () => overlay.remove()
		});

		this.layoutService.mainContainer.appendChild(overlay);
		this.overlay = overlay;
		return overlay;
	}

	private hide(): void {
		this.mode = undefined;
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
