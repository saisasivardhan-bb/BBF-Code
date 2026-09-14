/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IRequestService, asJson } from '../../../../platform/request/common/request.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

/** One entry of the feed served by /server. */
export interface IBBFFeedExtension {
	readonly id: string;
	readonly displayName: string;
	readonly description: string;
	readonly version: string;
	readonly downloadUrl: string;
	readonly prerelease?: boolean;
}

interface IBBFFeed {
	readonly updatedAt: string;
	readonly extensions: readonly IBBFFeedExtension[];
}

export const IBBFExtensionsService = createDecorator<IBBFExtensionsService>('bbfExtensionsService');

export interface IBBFExtensionsService {
	readonly _serviceBrand: undefined;

	/** Ids BBF Code considers proprietary: product.json plus whatever the feed advertises. */
	readonly extensionIds: readonly string[];

	readonly onDidChangeExtensionIds: Event<void>;

	/**
	 * Re-read the feed and install or update anything that is behind.
	 * Throttled unless forced, so it is safe to call whenever the view renders.
	 */
	refresh(options?: { force?: boolean }): Promise<void>;
}

/** Setting holding the feed's shared secret; not in product.json, which ships to everyone. */
export const BBF_EXTENSIONS_TOKEN_SETTING = 'bbf.extensions.accessToken';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Shortest gap between unforced polls, so rendering the view cannot spam the feed. */
const REFRESH_THROTTLE_MS = 60 * 1000;

export class BBFExtensionsService extends Disposable implements IBBFExtensionsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeExtensionIds = this._register(new Emitter<void>());
	readonly onDidChangeExtensionIds = this._onDidChangeExtensionIds.event;

	private feedIds: string[] = [];
	private lastRefresh = 0;

	constructor(
		@IProductService private readonly productService: IProductService,
		@IRequestService private readonly requestService: IRequestService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		if (!this.serviceUrl) {
			return;
		}

		// Fire and forget: a feed that is unreachable must never block startup.
		this.refresh().catch(error => this.logService.warn('[bbf] initial extension feed refresh failed', error));

		const timer = setInterval(() => {
			this.refresh().catch(error => this.logService.trace('[bbf] extension feed refresh failed', error));
		}, REFRESH_INTERVAL_MS);
		this._register(toDisposable(() => clearInterval(timer)));
	}

	get extensionIds(): readonly string[] {
		const configured = this.productService.bbfProprietaryExtensions ?? [];
		return [...new Set([...configured, ...this.feedIds])];
	}

	private get serviceUrl(): string | undefined {
		return this.productService.bbfExtensionsServiceUrl?.replace(/\/$/, '') || undefined;
	}

	private get headers(): { [key: string]: string } {
		const token = this.configurationService.getValue<string>(BBF_EXTENSIONS_TOKEN_SETTING);
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

	async refresh(options?: { force?: boolean }): Promise<void> {
		const serviceUrl = this.serviceUrl;
		if (!serviceUrl) {
			return;
		}

		if (!options?.force && Date.now() - this.lastRefresh < REFRESH_THROTTLE_MS) {
			return;
		}
		this.lastRefresh = Date.now();

		const context = await this.requestService.request({
			type: 'GET',
			url: `${serviceUrl}/api/extensions`,
			headers: this.headers,
			callSite: 'NO_FETCH_TELEMETRY'
		}, CancellationToken.None);

		if (context.res.statusCode !== 200) {
			throw new Error(`BBF extension feed returned ${context.res.statusCode}`);
		}

		const feed = await asJson<IBBFFeed>(context);
		const extensions = feed?.extensions ?? [];

		const ids = extensions.map(e => e.id);
		if (ids.join() !== this.feedIds.join()) {
			this.feedIds = ids;
			this._onDidChangeExtensionIds.fire();
		}

		// Deliberately no auto-install. BBF extensions are served by the gallery
		// proxy, so they are listed whether installed or not and the user owns the
		// install/uninstall decision; re-installing here would undo an uninstall.
	}
}

/**
 * Forces the feed service to exist at startup.
 *
 * Registering the service as an eager singleton is not enough: eager only means
 * "do not lazily proxy", so nothing is constructed until something asks for it,
 * and the view only asks when the Extensions viewlet is first opened. The feed
 * has to be polled whether or not the user ever looks at that view.
 */
export class BBFExtensionsContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.bbfExtensions';

	constructor(@IBBFExtensionsService _bbfExtensionsService: IBBFExtensionsService) { }
}
