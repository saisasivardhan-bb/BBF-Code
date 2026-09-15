/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createReadStream, promises } from 'fs';
import { homedir } from 'os';
import type * as http from 'http';
import * as cookie from 'cookie';
import * as crypto from 'crypto';
import { isEqualOrParent } from '../../base/common/extpath.js';
import { getMediaMime } from '../../base/common/mime.js';
import { isLinux } from '../../base/common/platform.js';
import { ILogService, LogLevel } from '../../platform/log/common/log.js';
import { IServerEnvironmentService } from './serverEnvironmentService.js';
import { extname, dirname, join, normalize, posix, resolve } from '../../base/common/path.js';
import { FileAccess, connectionTokenCookieName, connectionTokenQueryName, Schemas, builtinExtensionsPath } from '../../base/common/network.js';
import { generateUuid } from '../../base/common/uuid.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { ServerConnectionToken, ServerConnectionTokenType } from './serverConnectionToken.js';
import { asTextOrError, IRequestService } from '../../platform/request/common/request.js';
import { IHeaders } from '../../base/parts/request/common/request.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { URI } from '../../base/common/uri.js';
import { streamToBuffer } from '../../base/common/buffer.js';
import { IProductConfiguration } from '../../base/common/product.js';
import { isString, Mutable } from '../../base/common/types.js';
import { CharCode } from '../../base/common/charCode.js';
import { IExtensionManifest } from '../../platform/extensions/common/extensions.js';
import { ICSSDevelopmentService } from '../../platform/cssDev/node/cssDevService.js';
import { htmlAttributeEncodeValue } from '../../base/common/strings.js';

const textMimeType: { [ext: string]: string | undefined } = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
};

/**
 * Return an error to the client.
 */
export async function serveError(req: http.IncomingMessage, res: http.ServerResponse, errorCode: number, errorMessage: string): Promise<void> {
	res.writeHead(errorCode, { 'Content-Type': 'text/plain' });
	res.end(errorMessage);
}

export const enum CacheControl {
	NO_CACHING, ETAG, NO_EXPIRY
}

/**
 * Serve a file at a given path or 404 if the file is missing.
 */
export async function serveFile(filePath: string, cacheControl: CacheControl, logService: ILogService, req: http.IncomingMessage, res: http.ServerResponse, responseHeaders: Record<string, string>): Promise<void> {
	try {
		const stat = await promises.stat(filePath); // throws an error if file doesn't exist
		if (cacheControl === CacheControl.ETAG) {

			// Check if file modified since
			const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join('-')}"`; // weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
			responseHeaders['Etag'] = etag;
			if (req.headers['if-none-match'] === etag) {
				res.writeHead(304, responseHeaders);
				return void res.end();
			}
		} else if (cacheControl === CacheControl.NO_EXPIRY) {
			responseHeaders['Cache-Control'] = 'public, max-age=31536000';
		} else if (cacheControl === CacheControl.NO_CACHING) {
			responseHeaders['Cache-Control'] = 'no-store';
		}

		responseHeaders['Content-Type'] = textMimeType[extname(filePath)] || getMediaMime(filePath) || 'text/plain';

		// Create the stream first and wait for it to open before sending
		// headers so that errors (e.g. ENOENT race) can still produce a
		// proper 404 response instead of aborting a half-sent 200.
		const fileStream = createReadStream(filePath);
		await new Promise<void>((resolve, reject) => {
			fileStream.on('error', reject);
			fileStream.on('open', () => {
				// File opened successfully - send headers and pipe
				res.writeHead(200, responseHeaders);
				fileStream.pipe(res);
				// Destroy the read stream if the response is closed prematurely
				// (e.g. client disconnect) to avoid leaking the file descriptor.
				res.once('close', () => fileStream.destroy());
				fileStream.on('end', resolve);
				// Replace the initial error handler now that headers are sent
				fileStream.removeAllListeners('error');
				fileStream.on('error', error => {
					logService.error(error);
					console.error(error.toString());
					res.destroy();
				});
			});
		});
	} catch (error) {
		if (error.code !== 'ENOENT') {
			logService.error(error);
			console.error(error.toString());
		} else {
			console.error(`File not found: ${filePath}`);
		}

		res.writeHead(404, { 'Content-Type': 'text/plain' });
		return void res.end('Not found');
	}
}

const APP_ROOT = dirname(FileAccess.asFileUri('').fsPath);

/**
 * Where per-account folders live. `BBF_WORKSPACES_ROOT` overrides it so a
 * deployment can put them on a data disk rather than beside the server.
 */
function workspacesRoot(): string {
	return process.env['BBF_WORKSPACES_ROOT'] || join(homedir(), 'BlackBox Code', 'workspaces');
}

/**
 * Turns an account label into one folder name, or nothing if it cannot.
 *
 * Everything outside a small safe set becomes a dash, so no separator, drive
 * letter or `..` survives: whatever the workbench sends, the result is a single
 * segment that can only land inside {@link workspacesRoot}.
 */
function workspaceFolderName(account: string): string | undefined {
	const name = account
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._@-]+/g, '-')
		.replace(/^[-.]+/, '')
		.slice(0, MAX_WORKSPACE_NAME);
	return name.length > 0 ? name : undefined;
}


const STATIC_PATH = `/static`;
const CALLBACK_PATH = `/callback`;
const WEB_EXTENSION_PATH = `/web-extension-resource`;
/**
 * Where Google returns a BBF sign-in.
 *
 * It has to be one fixed address: Google compares a redirect against the ones
 * registered for the client character for character, so the callback the
 * editor generates per request -- `/callback` with its own query -- cannot be
 * registered. This path never varies, and the request is handed on from here.
 */
const BBF_AUTH_CALLBACK_PATH = `/bbf-auth/callback`;
/**
 * Where the browser fetches the server's half of the key its secrets are sealed with.
 *
 * Without this the workbench finds no encryption in a browser and keeps secrets
 * in memory, so a signed-in session lasts exactly until the page is reloaded.
 * The client seals each value with a random key of its own combined with this
 * one, and keeps the result in local storage: the stored data is useless to
 * anyone who cannot also ask this server.
 */
export const SECRET_KEY_PATH = `/secret-key`;
/** AES-256, the length the workbench expects back from {@link SECRET_KEY_PATH}. */
const SECRET_KEY_BYTES = 32;
/** The name the workbench reads that path under; see `ServerKeyedAESCrypto`. */
const secretStorageKeyPathCookieName = 'vscode-secret-key-path';
/**
 * Where the workbench asks for the folder belonging to the person using it.
 *
 * A hosted editor serves one machine, so without this everyone who opens the
 * link lands in whatever folder the server was last pointed at -- someone
 * else's work. Each signed-in account gets a folder of its own here instead.
 *
 * This organises people; it does not separate them. Everyone still runs as the
 * same account on the same machine, and a terminal reaches the whole disk. Real
 * separation needs one server per person, not one folder per person.
 */
const BBF_WORKSPACE_PATH = `/bbf-workspace`;
/** Keeps a pathological account name from becoming a pathological folder name. */
const MAX_WORKSPACE_NAME = 64;
const webWorkerExtensionHostIframeScriptSHA = 'sha256-daEgfo2VIXpx2Np71KqCCbkeQwv+68vPrx54XRcbdcs=';

/**
 * Substitutes the `{{...}}` placeholders of a workbench template. Placeholders must only ever
 * appear as quoted HTML attribute values, which is what makes attribute encoding sufficient.
 */
export function renderWorkbenchTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => htmlAttributeEncodeValue(values[key] ?? 'undefined'));
}

/**
 * Returns whether a reverse proxy supplied prefix is a plain absolute path. Values that could
 * change the origin of a redirect or smuggle a query, fragment or control character are rejected.
 */
export function isSafeBasePath(basePath: string): boolean {
	return basePath.startsWith('/')
		&& !basePath.startsWith('//')
		&& !/[?#\\]|[\u0000-\u001F\u007F]/.test(basePath);
}

export function createScriptNonce(): string {
	return crypto.randomBytes(16).toString('base64url');
}

export function createNlsUrl(nlsBaseUrl: string, commit: string | undefined, version: string | undefined, locale: string): string {
	return `${nlsBaseUrl}${commit}/${version}/${encodeURIComponent(locale)}/nls.messages.js`;
}

export function createWorkbenchContentSecurityPolicy(scriptNonce: string, nlsBaseUrl: string | undefined, remoteAuthority: string, useTestResolver: boolean): string {
	return [
		'default-src \'self\';',
		'img-src \'self\' https: data: blob:;',
		'media-src \'self\';',
		`script-src 'self' 'unsafe-eval' ${nlsBaseUrl ?? ''} blob: 'nonce-${scriptNonce}' '${webWorkerExtensionHostIframeScriptSHA}' 'sha256-/r7rqQ+yrxt57sxLuQ6AMYcy/lUpvAIzHjIJt/OeLWU=' ${useTestResolver ? '' : `http://${remoteAuthority}`};`,  // the sha is the same as in src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html
		'child-src \'self\';',
		`frame-src 'self' https://*.vscode-cdn.net data:;`,
		'worker-src \'self\' data: blob:;',
		'style-src \'self\' \'unsafe-inline\';',
		'connect-src \'self\' ws: wss: https:;',
		'font-src \'self\' blob:;',
		'manifest-src \'self\';'
	].join(' ');
}

export class WebClientServer {

	private readonly _webExtensionResourceUrlTemplate: URI | undefined;

	constructor(
		private readonly _connectionToken: ServerConnectionToken,
		private readonly _basePath: string,
		private readonly _productPath: string,
		@IServerEnvironmentService private readonly _environmentService: IServerEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IRequestService private readonly _requestService: IRequestService,
		@IProductService private readonly _productService: IProductService,
		@ICSSDevelopmentService private readonly _cssDevService: ICSSDevelopmentService
	) {
		this._webExtensionResourceUrlTemplate = this._productService.extensionsGallery?.resourceUrlTemplate ? URI.parse(this._productService.extensionsGallery.resourceUrlTemplate) : undefined;
	}

	/**
	 * Handle web resources (i.e. only needed by the web client).
	 * **NOTE**: This method is only invoked when the server has web bits.
	 * **NOTE**: This method is only invoked after the connection token has been validated.
	 * @param parsedUrl The URL to handle, including base and product path
	 * @param pathname The pathname of the URL, without base and product path
	 */
	async handle(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: URL, pathname: string): Promise<void> {
		try {
			if (pathname.startsWith(STATIC_PATH) && pathname.charCodeAt(STATIC_PATH.length) === CharCode.Slash) {
				return this._handleStatic(req, res, pathname.substring(STATIC_PATH.length));
			}
			if (pathname === '/') {
				return this._handleRoot(req, res, parsedUrl);
			}
			if (pathname === CALLBACK_PATH) {
				// callback support
				return this._handleCallback(res);
			}
			if (pathname === BBF_AUTH_CALLBACK_PATH) {
				// BBF Google sign-in support
				return this._handleBBFAuthCallback(res, parsedUrl);
			}
			if (pathname === SECRET_KEY_PATH) {
				// secret storage support
				return this._handleSecretKey(res);
			}
			if (pathname === BBF_WORKSPACE_PATH) {
				// per-user folder support
				return this._handleBBFWorkspace(res, parsedUrl);
			}
			if (pathname.startsWith(WEB_EXTENSION_PATH) && pathname.charCodeAt(WEB_EXTENSION_PATH.length) === CharCode.Slash) {
				// extension resource support
				return this._handleWebExtensionResource(req, res, pathname.substring(WEB_EXTENSION_PATH.length));
			}

			return serveError(req, res, 404, 'Not found.');
		} catch (error) {
			this._logService.error(error);
			console.error(error.toString());

			return serveError(req, res, 500, 'Internal Server Error.');
		}
	}
	/**
	 * Handle HTTP requests for /static/*
	 * @param resourcePath The path after /static/
	 */
	private async _handleStatic(req: http.IncomingMessage, res: http.ServerResponse, resourcePath: string): Promise<void> {
		const headers: Record<string, string> = Object.create(null);

		// Strip the this._staticRoute from the path
		const normalizedPathname = decodeURIComponent(resourcePath); // support paths that are uri-encoded (e.g. spaces => %20)

		const filePath = join(APP_ROOT, normalizedPathname); // join also normalizes the path
		if (!isEqualOrParent(filePath, APP_ROOT, !isLinux)) {
			return serveError(req, res, 400, `Bad request.`);
		}

		return serveFile(filePath, this._environmentService.isBuilt ? CacheControl.NO_EXPIRY : CacheControl.ETAG, this._logService, req, res, headers);
	}

	private _getResourceURLTemplateAuthority(uri: URI): string | undefined {
		const index = uri.authority.indexOf('.');
		return index !== -1 ? uri.authority.substring(index + 1) : undefined;
	}

	/**
	 * Handle extension resources
	 * @param resourcePath The path after /web-extension-resource/
	 */
	private async _handleWebExtensionResource(req: http.IncomingMessage, res: http.ServerResponse, resourcePath: string): Promise<void> {
		if (!this._webExtensionResourceUrlTemplate) {
			return serveError(req, res, 500, 'No extension gallery service configured.');
		}

		const normalizedPathname = decodeURIComponent(resourcePath); // support paths that are uri-encoded (e.g. spaces => %20)
		const path = normalize(normalizedPathname);
		const uri = URI.parse(path).with({
			scheme: this._webExtensionResourceUrlTemplate.scheme,
			authority: path.substring(0, path.indexOf('/')),
			path: path.substring(path.indexOf('/') + 1)
		});

		if (this._getResourceURLTemplateAuthority(this._webExtensionResourceUrlTemplate) !== this._getResourceURLTemplateAuthority(uri)) {
			return serveError(req, res, 403, 'Request Forbidden');
		}

		const headers: IHeaders = {};
		const setRequestHeader = (header: string) => {
			const value = req.headers[header];
			if (value && (isString(value) || value[0])) {
				headers[header] = isString(value) ? value : value[0];
			} else if (header !== header.toLowerCase()) {
				setRequestHeader(header.toLowerCase());
			}
		};
		setRequestHeader('X-Client-Name');
		setRequestHeader('X-Client-Version');
		setRequestHeader('X-Machine-Id');
		setRequestHeader('X-Client-Commit');

		const context = await this._requestService.request({
			type: 'GET',
			url: uri.toString(true),
			headers,
			callSite: 'webClientServer.fetchAndWriteFile'
		}, CancellationToken.None);

		const status = context.res.statusCode || 500;
		if (status !== 200) {
			let text: string | null = null;
			try {
				text = await asTextOrError(context);
			} catch (error) {/* Ignore */ }
			return serveError(req, res, status, text || `Request failed with status ${status}`);
		}

		const responseHeaders: Record<string, string | string[]> = Object.create(null);
		const setResponseHeader = (header: string) => {
			const value = context.res.headers[header];
			if (value) {
				responseHeaders[header] = value;
			} else if (header !== header.toLowerCase()) {
				setResponseHeader(header.toLowerCase());
			}
		};
		setResponseHeader('Cache-Control');
		setResponseHeader('Content-Type');
		res.writeHead(200, responseHeaders);
		const buffer = await streamToBuffer(context.stream);
		return void res.end(buffer.buffer);
	}

	/**
	 * Handle HTTP requests for /
	 */
	private async _handleRoot(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: URL): Promise<void> {

		const getFirstHeader = (headerName: string) => {
			const val = req.headers[headerName];
			return Array.isArray(val) ? val[0] : val;
		};

		// Prefix routes with basePath for clients
		const forwardedPrefix = getFirstHeader('x-forwarded-prefix');
		const basePath = forwardedPrefix && isSafeBasePath(forwardedPrefix) ? forwardedPrefix : this._basePath;

		const queryConnectionTokens = parsedUrl.searchParams.getAll(connectionTokenQueryName);
		if (queryConnectionTokens.length === 1) {
			const queryConnectionToken = queryConnectionTokens[0];
			// We got a connection token as a query parameter.
			// We want to have a clean URL, so we strip it
			const responseHeaders: Record<string, string> = Object.create(null);
			responseHeaders['Set-Cookie'] = cookie.serialize(
				connectionTokenCookieName,
				queryConnectionToken,
				{
					sameSite: 'lax',
					maxAge: 60 * 60 * 24 * 7 /* 1 week */
				}
			);

			const newQuery = new URLSearchParams(parsedUrl.searchParams);
			newQuery.delete(connectionTokenQueryName);
			const queryString = newQuery.toString();
			const newLocation = queryString ? `${basePath}?${queryString}` : basePath;
			responseHeaders['Location'] = newLocation;

			res.writeHead(302, responseHeaders);
			return void res.end();
		}

		const replacePort = (host: string, port: string) => {
			const index = host?.indexOf(':');
			if (index !== -1) {
				host = host?.substring(0, index);
			}
			host += `:${port}`;
			return host;
		};

		const useTestResolver = (!this._environmentService.isBuilt && !!this._environmentService.args['use-test-resolver']);
		let remoteAuthority = (
			useTestResolver
				? 'test+test'
				: (getFirstHeader('x-original-host') || getFirstHeader('x-forwarded-host') || req.headers.host)
		);
		if (!remoteAuthority) {
			return serveError(req, res, 400, `Bad request.`);
		}
		const forwardedPort = getFirstHeader('x-forwarded-port');
		if (forwardedPort) {
			remoteAuthority = replacePort(remoteAuthority, forwardedPort);
		}

		function asJSON(value: unknown): string {
			return JSON.stringify(value);
		}

		let _wrapWebWorkerExtHostInIframe: undefined | false = undefined;
		if (this._environmentService.args['enable-smoke-test-driver']) {
			// integration tests run at a time when the built output is not yet published to the CDN
			// so we must disable the iframe wrapping because the iframe URL will give a 404
			_wrapWebWorkerExtHostInIframe = false;
		}

		if (this._logService.getLevel() === LogLevel.Trace) {
			['x-original-host', 'x-forwarded-host', 'x-forwarded-port', 'host'].forEach(header => {
				const value = getFirstHeader(header);
				if (value) {
					this._logService.trace(`[WebClientServer] ${header}: ${value}`);
				}
			});
			this._logService.trace(`[WebClientServer] Request URL: ${req.url}, basePath: ${basePath}, remoteAuthority: ${remoteAuthority}`);
		}

		const staticRoute = posix.join(basePath, this._productPath, STATIC_PATH);
		const callbackRoute = posix.join(basePath, this._productPath, CALLBACK_PATH);
		const webExtensionRoute = posix.join(basePath, this._productPath, WEB_EXTENSION_PATH);

		const resolveWorkspaceURI = (defaultLocation?: string) => defaultLocation && URI.file(resolve(defaultLocation)).with({ scheme: Schemas.vscodeRemote, authority: remoteAuthority });

		const filePath = FileAccess.asFileUri(`vs/code/browser/workbench/workbench${this._environmentService.isBuilt ? '' : '-dev'}.html`).fsPath;
		const authSessionInfo = !this._environmentService.isBuilt && this._environmentService.args['github-auth'] ? {
			id: generateUuid(),
			providerId: 'github',
			accessToken: this._environmentService.args['github-auth'],
			scopes: [['user:email'], ['repo']]
		} : undefined;

		const productConfiguration: Partial<Mutable<IProductConfiguration>> = {
			embedderIdentifier: 'server-distro',
			voiceWsUrl: this._productService.voiceWsUrl,
			extensionsGallery: this._webExtensionResourceUrlTemplate && this._productService.extensionsGallery ? {
				...this._productService.extensionsGallery,
				resourceUrlTemplate: this._webExtensionResourceUrlTemplate.with({
					scheme: 'http',
					authority: remoteAuthority,
					path: `${webExtensionRoute}/${this._webExtensionResourceUrlTemplate.authority}${this._webExtensionResourceUrlTemplate.path}`
				}).toString(true)
			} : undefined
		};

		if (!this._environmentService.isBuilt) {
			try {
				const productOverrides = JSON.parse((await promises.readFile(join(APP_ROOT, 'product.overrides.json'))).toString());
				Object.assign(productConfiguration, productOverrides);
			} catch (err) {/* Ignore Error */ }
		}

		const workbenchWebConfiguration = {
			remoteAuthority,
			serverBasePath: basePath,
			_wrapWebWorkerExtHostInIframe,
			developmentOptions: { enableSmokeTestDriver: this._environmentService.args['enable-smoke-test-driver'] ? true : undefined, logLevel: this._logService.getLevel() },
			settingsSyncOptions: !this._environmentService.isBuilt && this._environmentService.args['enable-sync'] ? { enabled: true } : undefined,
			enableWorkspaceTrust: !this._environmentService.args['disable-workspace-trust'],
			enabledExtensionProposedApi: this._environmentService.args['enable-proposed-api'],
			folderUri: resolveWorkspaceURI(this._environmentService.args['default-folder']),
			workspaceUri: resolveWorkspaceURI(this._environmentService.args['default-workspace']),
			productConfiguration,
			callbackRoute: callbackRoute
		};

		const cookies = cookie.parse(req.headers.cookie || '');
		const locale = cookies['vscode.nls.locale'] || req.headers['accept-language']?.split(',')[0]?.toLowerCase() || 'en';
		let WORKBENCH_NLS_BASE_URL: string | undefined;
		let WORKBENCH_NLS_URL: string;
		if (!locale.startsWith('en') && this._productService.nlsCoreBaseUrl) {
			WORKBENCH_NLS_BASE_URL = this._productService.nlsCoreBaseUrl;
			WORKBENCH_NLS_URL = createNlsUrl(WORKBENCH_NLS_BASE_URL, this._productService.commit, this._productService.version, locale);
		} else {
			WORKBENCH_NLS_URL = ''; // fallback will apply
		}

		const scriptNonce = createScriptNonce();
		const values: { [key: string]: string } = {
			WORKBENCH_WEB_CONFIGURATION: asJSON(workbenchWebConfiguration),
			WORKBENCH_AUTH_SESSION: authSessionInfo ? asJSON(authSessionInfo) : '',
			WORKBENCH_WEB_BASE_URL: staticRoute,
			WORKBENCH_NLS_URL,
			WORKBENCH_NLS_FALLBACK_URL: `${staticRoute}/out/nls.messages.js`,
			WORKBENCH_SCRIPT_NONCE: scriptNonce
		};

		// DEV ---------------------------------------------------------------------------------------
		// DEV: This is for development and enables loading CSS via import-statements via import-maps.
		// DEV: The server needs to send along all CSS modules so that the client can construct the
		// DEV: import-map.
		// DEV ---------------------------------------------------------------------------------------
		if (this._cssDevService.isEnabled) {
			const cssModules = await this._cssDevService.getCssModules();
			values['WORKBENCH_DEV_CSS_MODULES'] = JSON.stringify(cssModules);
		}

		if (useTestResolver) {
			const bundledExtensions: { extensionPath: string; packageJSON: IExtensionManifest }[] = [];
			for (const extensionPath of ['vscode-test-resolver', 'github-authentication']) {
				const packageJSON = JSON.parse((await promises.readFile(FileAccess.asFileUri(`${builtinExtensionsPath}/${extensionPath}/package.json`).fsPath)).toString());
				bundledExtensions.push({ extensionPath, packageJSON });
			}
			values['WORKBENCH_BUILTIN_EXTENSIONS'] = asJSON(bundledExtensions);
		}

		let data;
		try {
			const workbenchTemplate = (await promises.readFile(filePath)).toString();
			data = renderWorkbenchTemplate(workbenchTemplate, values);
		} catch (e) {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			return void res.end('Not found');
		}

		const cspDirectives = createWorkbenchContentSecurityPolicy(scriptNonce, WORKBENCH_NLS_BASE_URL, remoteAuthority, useTestResolver);

		const headers: http.OutgoingHttpHeaders = {
			'Content-Type': 'text/html',
			'Content-Security-Policy': cspDirectives
		};

		// Tells the workbench where to fetch the server's half of the key it
		// seals secrets with. Without it the browser finds no encryption, keeps
		// secrets in memory, and a signed-in session dies with the page. Read
		// from script, so deliberately not httpOnly.
		const setCookies = [cookie.serialize(
			secretStorageKeyPathCookieName,
			posix.join(basePath, this._productPath, SECRET_KEY_PATH),
			{
				sameSite: 'lax',
				maxAge: 60 * 60 * 24 * 7 /* 1 week */
			}
		)];

		if (this._connectionToken.type !== ServerConnectionTokenType.None) {
			// At this point we know the client has a valid cookie
			// and we want to set it prolong it to ensure that this
			// client is valid for another 1 week at least
			setCookies.push(cookie.serialize(
				connectionTokenCookieName,
				this._connectionToken.value,
				{
					sameSite: 'lax',
					maxAge: 60 * 60 * 24 * 7 /* 1 week */
				}
			));
		}
		headers['Set-Cookie'] = setCookies;

		res.writeHead(200, headers);
		return void res.end(data);
	}

	private _getScriptCspHashes(content: string): string[] {
		// Compute the CSP hashes for line scripts. Uses regex
		// which means it isn't 100% good.
		const regex = /<script>([\s\S]+?)<\/script>/img;
		const result: string[] = [];
		let match: RegExpExecArray | null;
		while (match = regex.exec(content)) {
			const hasher = crypto.createHash('sha256');
			// This only works on Windows if we strip `\r` from `\r\n`.
			const script = match[1].replace(/\r\n/g, '\n');
			const hash = hasher
				.update(Buffer.from(script))
				.digest().toString('base64');

			result.push(`'sha256-${hash}'`);
		}
		return result;
	}

	/**
	 * Handle HTTP requests for /callback
	 */
	/**
	 * Hands a finished Google sign-in to the extension waiting for it.
	 *
	 * That extension listens on a loopback port of the machine it runs on, which
	 * is the browser's own machine only on the desktop. Hosted, it is this
	 * server, so Google is sent here and the answer is carried the last hop from
	 * inside. The port travels in `state`, which the extension made: a request
	 * quoting a state it does not recognise is refused there, and one quoting no
	 * usable port is refused here.
	 */
	/**
	 * Returns the folder belonging to an account, creating it on first use.
	 *
	 * The name is derived from the account the workbench says is signed in, and
	 * is reduced to a single harmless path segment here: a name is a label, and
	 * a label must never be able to choose where on the disk it lands.
	 */
	private async _handleBBFWorkspace(res: http.ServerResponse, parsedUrl: URL): Promise<void> {
		const reply = (status: number, body: object) => {
			res.writeHead(status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(body));
		};

		const account = parsedUrl.searchParams.get('account') ?? '';
		const name = workspaceFolderName(account);
		if (!name) {
			return reply(400, { error: 'An account is required.' });
		}

		try {
			const folder = join(workspacesRoot(), name);
			await promises.mkdir(folder, { recursive: true });
			// A path, not an fsPath: the workbench turns this into a
			// `vscode-remote` URI, whose path is always posix-shaped.
			return reply(200, { path: URI.file(folder).path });
		} catch (error) {
			this._logService.error('[bbf-workspace] could not prepare a folder', error);
			return reply(500, { error: 'Could not prepare a folder for this account.' });
		}
	}

	/**
	 * Serves the server's half of the secret-storage key: 32 raw bytes.
	 *
	 * Kept on disk beside the server's other data so that a restart does not
	 * invalidate everything the browser has already sealed, which would sign
	 * every user out. It is created on first use with the same generator the
	 * connection token uses.
	 */
	private async _handleSecretKey(res: http.ServerResponse): Promise<void> {
		try {
			const keyPath = join(this._environmentService.userDataPath, 'secret-key');
			let key: Buffer;
			try {
				key = await promises.readFile(keyPath);
				if (key.length !== SECRET_KEY_BYTES) {
					throw new Error(`expected ${SECRET_KEY_BYTES} bytes, found ${key.length}`);
				}
			} catch {
				key = crypto.randomBytes(SECRET_KEY_BYTES);
				await promises.mkdir(dirname(keyPath), { recursive: true });
				// Readable only by this account: it is what protects every stored secret.
				await promises.writeFile(keyPath, key, { mode: 0o600 });
			}
			res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(key.length) });
			res.end(key);
		} catch (error) {
			this._logService.error('[secret-key] could not provide a key; secrets will not survive a reload', error);
			res.writeHead(500);
			res.end();
		}
	}

	private async _handleBBFAuthCallback(res: http.ServerResponse, parsedUrl: URL): Promise<void> {
		const reply = (status: number, message: string) => {
			res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(`<!doctype html><meta charset="utf-8"><title>BlackBox Code</title><p>${message}</p>`);
		};

		// The extension puts the port it is listening on at the end of the state
		// it generated, so a request carrying neither is not a sign-in of ours.
		const port = Number((parsedUrl.searchParams.get('state') ?? '').split('.').pop());
		if (!Number.isInteger(port) || port < 1024 || port > 65535) {
			return reply(400, 'This is not a BlackBox Code sign-in.');
		}

		// Loopback only: the last hop stays on this machine and never goes out.
		const target = new URL(`http://127.0.0.1:${port}/`);
		parsedUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));

		try {
			const response = await fetch(target, { signal: AbortSignal.timeout(10_000) });
			// The extension writes the page the user is left looking at.
			res.writeHead(response.status, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(await response.text());
		} catch (error) {
			this._logService.error(`[BBF sign-in] no listener on 127.0.0.1:${port}`, error);
			reply(502, 'The sign-in could not be completed. Start it again from the editor.');
		}
	}

	private async _handleCallback(res: http.ServerResponse): Promise<void> {
		const filePath = FileAccess.asFileUri('vs/code/browser/workbench/callback.html').fsPath;
		const data = (await promises.readFile(filePath)).toString();
		const cspDirectives = [
			'default-src \'self\';',
			'img-src \'self\' https: data: blob:;',
			'media-src \'none\';',
			`script-src 'self' ${this._getScriptCspHashes(data).join(' ')};`,
			'style-src \'self\' \'unsafe-inline\';',
			'font-src \'self\' blob:;'
		].join(' ');

		res.writeHead(200, {
			'Content-Type': 'text/html',
			'Content-Security-Policy': cspDirectives
		});
		return void res.end(data);
	}
}
