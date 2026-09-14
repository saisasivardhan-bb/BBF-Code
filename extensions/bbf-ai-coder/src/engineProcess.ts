/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { IEngineCredential } from './auth.js';
import { ILocalModel } from './localModels.js';

/** The one line the engine prints once it is listening. There is no port file. */
const LISTENING = /opencode server listening on https?:\/\/([^\s:]+):(\d+)/i;

const STARTUP_TIMEOUT_MS = 60_000;

export interface IEngineEndpoint {
	readonly baseUrl: string;
	/** Sent on every engine request; see `serverPassword`. */
	readonly password: string;
}

/** A model runtime on this machine, handed to the engine at launch. */
export interface ILocalRuntime {
	/** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1`. */
	readonly baseUrl: string;
	readonly models: ReadonlyArray<ILocalModel>;
}

/**
 * The local OpenCode engine, run as a managed child process.
 *
 * Bound to 127.0.0.1 so it is never reachable from the network, and given its
 * own XDG directories so a BBF session neither reads nor clobbers a developer's
 * personal `~/.config/opencode`.
 *
 * The Zen credential is passed through `OPENCODE_CONFIG_CONTENT`, an env var
 * the engine parses as inline JSON. Nothing is written to disk, so there is no
 * config file for a backup, a screen share, or a stray `cat` to leak.
 */
export class EngineProcess implements vscode.Disposable {

	private child: ChildProcess | undefined;
	private starting: Promise<IEngineEndpoint> | undefined;
	private endpoint: IEngineEndpoint | undefined;

	/**
	 * Shared secret for this engine instance.
	 *
	 * Loopback keeps the engine off the network, but every other process on the
	 * machine can still reach 127.0.0.1 -- and the engine warns as much on
	 * startup when this is unset. Generated per launch and never persisted.
	 */
	private readonly serverPassword = randomBytes(32).toString('hex');

	private readonly _onDidExit = new vscode.EventEmitter<void>();
	/** Fires when the engine process ends, for whatever reason. */
	readonly onDidExit = this._onDidExit.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.LogOutputChannel
	) { }

	/** Starts the engine if it is not already running. Idempotent. */
	async start(credential: IEngineCredential, local?: ILocalRuntime): Promise<IEngineEndpoint> {
		if (this.endpoint) {
			return this.endpoint;
		}
		this.starting ??= this.spawnEngine(credential, local).finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async spawnEngine(credential: IEngineCredential, local: ILocalRuntime | undefined): Promise<IEngineEndpoint> {
		const binary = this.resolveBinary();
		const port = vscode.workspace.getConfiguration('bbf.aiCoder').get<number>('engine.port', 0);

		const child = spawn(binary, [
			'serve',
			'--hostname', '127.0.0.1',
			'--port', String(port)
		], {
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
			env: this.buildEnvironment(credential, local),
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		this.child = child;

		child.on('exit', code => {
			this.output.warn(`engine exited with code ${code}`);
			// `stop` may already have launched a replacement by the time the old
			// process reports its exit; only the current one clears the endpoint.
			if (this.child === child) {
				this.child = undefined;
				this.endpoint = undefined;
				this._onDidExit.fire();
			}
		});

		const endpoint = await this.awaitListening(child, binary);
		this.endpoint = endpoint;
		this.output.info(`engine listening on ${endpoint.baseUrl}`);
		return endpoint;
	}

	/**
	 * Resolves stdout's single "listening on" line into an endpoint.
	 *
	 * The engine offers no port file and no JSON handshake, so parsing that line
	 * is the only way to learn the port when it was allowed to pick one.
	 */
	private awaitListening(child: ChildProcess, binary: string): Promise<IEngineEndpoint> {
		return new Promise<IEngineEndpoint>((resolve, reject) => {
			let settled = false;
			let buffered = '';

			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					child.kill();
					reject(new Error('The BBF AI Coder engine did not start within 60 seconds.'));
				}
			}, STARTUP_TIMEOUT_MS);

			const finish = (error: Error | undefined, endpoint?: IEngineEndpoint) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				if (error) {
					reject(error);
				} else {
					resolve(endpoint!);
				}
			};

			child.stdout?.on('data', (chunk: Buffer) => {
				const text = chunk.toString('utf8');
				buffered += text;
				// The engine logs to stdout; forward it, but never the environment
				// it was started with.
				this.output.trace(text.trimEnd());
				const match = LISTENING.exec(buffered);
				if (match) {
					finish(undefined, { baseUrl: `http://${match[1]}:${match[2]}`, password: this.serverPassword });
				}
			});

			child.stderr?.on('data', (chunk: Buffer) => this.output.warn(chunk.toString('utf8').trimEnd()));
			child.on('error', error => {
				// A missing binary is by far the likeliest spawn failure, and Node's
				// bare ENOENT says nothing about which file or what to do about it.
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					finish(new Error(`The BBF AI Coder engine was not found at ${binary}. Set "bbf.aiCoder.engine.path" to the opencode binary.`));
					return;
				}
				finish(error);
			});
			child.on('exit', code => finish(new Error(`The engine exited during startup (code ${code}).`)));
		});
	}

	/**
	 * Builds the child environment.
	 *
	 * `OPENCODE_CONFIG_DIR` alone is additive and would still read the user's own
	 * config, so the XDG variables are what actually isolate this instance.
	 */
	private buildEnvironment(credential: IEngineCredential, local: ILocalRuntime | undefined): NodeJS.ProcessEnv {
		const storage = this.context.globalStorageUri.fsPath;
		return {
			...process.env,
			// Models served from this machine, registered by the engine as their
			// own provider. Absent when no local runtime is reachable, in which
			// case the engine registers no local provider at all.
			...(local ? {
				OPENCODE_LOCAL_BASE_URL: local.baseUrl,
				OPENCODE_LOCAL_MODELS: JSON.stringify(local.models)
			} : {}),
			OPENCODE_CONFIG_CONTENT: JSON.stringify(buildEngineConfig()),
			// The credential and the proxy URL travel as environment variables,
			// not inside the config document: the engine decodes that document
			// as a v1 config, and its v2 model catalogue -- the one that actually
			// builds requests -- only ever reads these from the environment. A
			// `provider` block in the config is accepted and then ignored.
			OPENCODE_API_KEY: credential.token,
			OPENCODE_ZEN_BASE_URL: credential.baseUrl,
			// Registered on every model the engine offers, proxied and local alike.
			OPENCODE_MODEL_VARIANTS: JSON.stringify(EFFORT_VARIANTS),
			OPENCODE_SERVER_PASSWORD: this.serverPassword,
			XDG_CONFIG_HOME: path.join(storage, 'engine', 'config'),
			XDG_DATA_HOME: path.join(storage, 'engine', 'data'),
			XDG_STATE_HOME: path.join(storage, 'engine', 'state'),
			XDG_CACHE_HOME: path.join(storage, 'engine', 'cache')
		};
	}

	private resolveBinary(): string {
		const configured = vscode.workspace.getConfiguration('bbf.aiCoder').get<string>('engine.path', '').trim();
		if (configured) {
			return configured;
		}
		const name = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
		return path.join(vscode.env.appRoot, 'bin', name);
	}

	/**
	 * Ends the running engine so the next `start` brings up a fresh one.
	 *
	 * The credential is baked into the process environment at spawn, so this is
	 * the only way to hand the engine a renewed token.
	 */
	stop(): void {
		const child = this.child;
		this.child = undefined;
		this.endpoint = undefined;
		if (child) {
			child.kill();
			this._onDidExit.fire();
		}
	}

	dispose(): void {
		this.stop();
		this._onDidExit.dispose();
	}
}

/**
 * The engine configuration handed over on stdin-equivalent (an env var).
 *
 * Only the permission policy lives here. The proxy URL and the credential are
 * environment variables instead (see `buildEnvironment`): the engine decodes
 * this document as a v1 config, and a `provider` block in it is accepted and
 * then never consulted by the v2 catalogue that builds the actual requests.
 *
 * `permission` maps a tool name to `ask`, `allow` or `deny`. It is an object,
 * never a list: the v1 schema types it as `PermissionActionConfig | object`,
 * and a rule array fails the whole document with `ConfigInvalidError`.
 */
export function buildEngineConfig(): object {
	return {
		permission: ASK_FOR_EVERYTHING
	};
}

/**
 * Reasoning variants defined for every model.
 *
 * The chat input bar selects one of these by id on the session model: the
 * Effort picker chooses `low`/`medium`/`max` while Deep Reasoning is on, and
 * Deep Reasoning off chooses `none`, which asks for a direct answer.
 * `reasoningEffort` is the key the engine's own option vocabulary uses; it is
 * lowered to `reasoning_effort` on the wire by the engine.
 */
const EFFORT_VARIANTS = [
	{ id: 'low', body: { reasoningEffort: 'low' } },
	{ id: 'medium', body: { reasoningEffort: 'medium' } },
	{ id: 'max', body: { reasoningEffort: 'high' } },
	{ id: 'none', body: { reasoningEffort: 'none' } }
];

/**
 * Every side-effecting action asks first.
 *
 * `edit` covers the edit, write and apply-patch tools, which all assert that one
 * action. `bash` is shell execution. `glob` and `grep` are workspace search, and
 * they are here because BBF draws no line between "safe" and "risky" tools --
 * note that this does make search prompt, which is deliberate rather than an
 * oversight.
 *
 * `question` is the engine's tool for putting a multiple-choice question to the
 * user mid-turn. The chat UI has nothing to answer it with, so a turn that
 * called it would wait forever. The engine build shipped with BBF Code already
 * leaves the tool denied for its agents (see `plugin/agent.ts` there); this
 * entry keeps the two in agreement should the agent defaults ever change.
 *
 * Key order is meaningful -- the engine parses this object with
 * `propertyOrder: "original"` to preserve precedence -- so keep the most
 * general entries last if a catch-all is ever added.
 */
const ASK_FOR_EVERYTHING = {
	edit: 'ask',
	bash: 'ask',
	glob: 'ask',
	grep: 'ask',
	external_directory: 'ask',
	question: 'deny'
};
