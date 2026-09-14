/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AiCoderAccess, IEngineCredential } from './auth.js';
import { ENGINE_LOCAL_PROVIDER_ID, ENGINE_ZEN_PROVIDER_ID, Effort, PermissionMode, StorageKeys, deepReasoning, effort, permissionMode } from './config.js';
import { EngineEvent, IEngineFileChange, IEnginePermission, IEngineSession, IEngineTransport } from './engine.js';
import { EngineProcess } from './engineProcess.js';
import { HttpEngineTransport } from './httpTransport.js';
import { BBF_LOCAL_VENDOR, BBF_VENDOR, BbfLocalModelProvider, BbfModelProvider } from './modelProvider.js';

const PARTICIPANT_ID = 'bbf.aiCoder';

/** Longest patch shown inline per file; anything longer is cut with a note. */
const MAX_PATCH_LINES = 120;

interface IZenModel {
	readonly id: string;
	readonly name?: string;
}

/**
 * One chat conversation's state for the life of the window.
 */
interface IConversation {
	readonly session: IEngineSession;
	/**
	 * Patches already shown, by file. The engine reports the whole session's
	 * diff on every turn, so this is what keeps each turn to what it changed.
	 */
	readonly shownPatches: Map<string, string>;
}

/**
 * Lists the models the company account can use.
 *
 * Asked through the BBF proxy rather than Zen directly, so the answer reflects
 * what the company key actually has access to and the client keeps no knowledge
 * of where Zen lives.
 */
async function listZenModels(credential: IEngineCredential): Promise<IZenModel[]> {
	const response = await fetch(`${credential.baseUrl}/models`, {
		headers: { 'Authorization': `Bearer ${credential.token}` }
	});
	if (!response.ok) {
		throw new Error(`Could not list models (${response.status}).`);
	}
	const payload = await response.json() as { data?: IZenModel[] };
	return payload.data ?? [];
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('BBF AI Coder', { log: true });
	context.subscriptions.push(output);

	const access = new AiCoderAccess();
	const engine = new EngineProcess(context, output);
	const transport: IEngineTransport = new HttpEngineTransport(engine, access, output);
	context.subscriptions.push(access, engine, transport);

	// One engine session per chat conversation. The mapping is remembered in
	// workspace state, so reopening an earlier chat in this folder continues its
	// engine session -- and the engine's own memory of it -- instead of
	// starting over.
	const conversations = new Map<string, IConversation>();

	const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
		const credential = await access.acquire({ interactive: true });
		if (!credential) {
			stream.markdown(vscode.l10n.t(
				'Sign in to BBF Code with your Blackbox Factories Google account to use BBF AI Coder.'));
			return {};
		}

		if (request.command === 'models') {
			return runModelsCommand(credential, stream);
		}

		const conversation = await resolveConversation(request, conversations, transport, context, stream);

		// The chat widget has already resolved a model for this request. Using our
		// own stored preference instead left the engine with no model at all,
		// which it answers with a 500 on the prompt.
		const modelId = request.model?.id ?? context.globalState.get<string>(StorageKeys.model);
		// Which engine provider answers is decided by the vendor the chat widget
		// resolved: local models are served by the runtime on this machine, the
		// rest through the BBF proxy.
		const providerId = request.model?.vendor === BBF_LOCAL_VENDOR ? ENGINE_LOCAL_PROVIDER_ID : ENGINE_ZEN_PROVIDER_ID;
		const mode = permissionMode();
		let latestDiff: readonly IEngineFileChange[] | undefined;
		let thinkingShown = false;

		await transport.prompt(conversation.session, request.prompt, { modelId, providerId, variant: variantFor(deepReasoning(), effort()) }, event => {
			if (event.kind === 'diff') {
				latestDiff = event.files;
				return;
			}
			if (event.kind === 'reasoning' && !thinkingShown) {
				// The reasoning itself stays in the log; the transcript only needs
				// to show that the model is thinking rather than stalled.
				thinkingShown = true;
				stream.progress(vscode.l10n.t('Thinking…'));
			}
			renderEvent(event, stream, transport, conversation.session, mode, output);
		}, token);

		if (latestDiff && !token.isCancellationRequested) {
			renderChanges(latestDiff, conversation.shownPatches, stream);
		}
		return {};
	};

	// Register the models first. The chat widget resolves a model before it will
	// call a participant, so without this every request fails with "Language
	// model unavailable" and the handler above never runs.
	const modelProvider = new BbfModelProvider(access, output);
	context.subscriptions.push(modelProvider);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(BBF_VENDOR, modelProvider));

	// Models running on this machine, published under their own vendor so the
	// chat model picker groups them as "Local AI".
	const localModelProvider = new BbfLocalModelProvider(output);
	context.subscriptions.push(localModelProvider);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(BBF_LOCAL_VENDOR, localModelProvider));
	// The picker asks for a vendor's models only once told they changed, and a
	// local runtime has no sign-in moment to say so. Registration attached the
	// listener; this is the nudge.
	localModelProvider.announce();

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
	participant.iconPath = new vscode.ThemeIcon('sparkle');
	context.subscriptions.push(participant);

	context.subscriptions.push(vscode.commands.registerCommand('bbf.aiCoder.selectModel', async () => {
		const credential = await access.acquire({ interactive: true });
		if (!credential) {
			return;
		}
		const models = await listZenModels(credential);
		const picked = await vscode.window.showQuickPick(
			models.map(m => ({ label: m.id, description: m.name })),
			{ title: vscode.l10n.t('Select Model'), placeHolder: vscode.l10n.t('Model for BBF AI Coder') });
		if (picked) {
			await context.globalState.update(StorageKeys.model, picked.label);
		}
	}));
}

/**
 * Finds or creates the engine session for the conversation a request belongs to.
 *
 * A remembered session is resumed when the engine still has it; otherwise a
 * fresh one is created and remembered in its place.
 */
async function resolveConversation(
	request: vscode.ChatRequest,
	conversations: Map<string, IConversation>,
	transport: IEngineTransport,
	context: vscode.ExtensionContext,
	stream: vscode.ChatResponseStream
): Promise<IConversation> {
	const key = conversationKey(request);
	const existing = conversations.get(key);
	if (existing) {
		return existing;
	}

	stream.progress(vscode.l10n.t('Starting BBF AI Coder…'));
	const storageKey = StorageKeys.engineSession + key;
	const remembered = context.workspaceState.get<string>(storageKey);
	const session = (remembered ? await transport.resumeSession(remembered) : undefined)
		?? await transport.createSession(vscode.workspace.workspaceFolders?.[0]?.uri);
	if (session.id !== remembered) {
		await context.workspaceState.update(storageKey, session.id);
	}

	const conversation: IConversation = { session, shownPatches: new Map() };
	conversations.set(key, conversation);
	return conversation;
}

/**
 * The conversation identity the workbench attaches to every request. It is
 * part of the `chatParticipantPrivate` proposal, whose declaration file drags
 * in several others; typing the two fields here keeps the build to the one
 * proposal this extension actually needs.
 */
interface IChatRequestWithSession extends vscode.ChatRequest {
	readonly sessionResource?: vscode.Uri;
	readonly sessionId?: string;
}

/**
 * Identifies the chat conversation a request belongs to.
 *
 * `sessionResource` is the workbench's own identity for the conversation and
 * survives reloads, which is what lets the engine session be found again.
 */
function conversationKey(request: vscode.ChatRequest): string {
	const { sessionResource, sessionId } = request as IChatRequestWithSession;
	return sessionResource?.toString() ?? sessionId ?? 'default';
}

/**
 * Maps the Deep Reasoning toggle and the effort tier onto an engine model
 * variant. Off asks for a direct answer; on asks for reasoning at the chosen
 * tier. Both are variants the engine defines for every model (see
 * `EFFORT_VARIANTS` in `engineProcess.ts`).
 */
function variantFor(think: boolean, tier: Effort): string {
	return think ? tier : 'none';
}

/**
 * Says what a tool call is about to do, in the user's terms: the file being
 * read or edited, the command being run, the pattern being searched for.
 */
function describeTool(name: string, input: Readonly<Record<string, unknown>>): string {
	const text = (key: string) => typeof input[key] === 'string' && input[key] ? input[key] as string : undefined;
	const target = text('path') ?? text('filePath') ?? text('file');
	const file = target ? `\`${relativePath(target)}\`` : undefined;

	switch (name) {
		case 'read':
			return file ? vscode.l10n.t('Reading {0}', file) : vscode.l10n.t('Reading a file');
		case 'edit':
			return file ? vscode.l10n.t('Editing {0}', file) : vscode.l10n.t('Editing a file');
		case 'write':
			return file ? vscode.l10n.t('Writing {0}', file) : vscode.l10n.t('Writing a file');
		case 'bash': {
			const command = text('command');
			const purpose = text('description');
			if (!command) {
				return vscode.l10n.t('Running a command');
			}
			return purpose
				? vscode.l10n.t('Running `{0}` — {1}', firstLine(command), purpose)
				: vscode.l10n.t('Running `{0}`', firstLine(command));
		}
		case 'glob':
			return text('pattern') ? vscode.l10n.t('Finding files matching `{0}`', text('pattern')!) : vscode.l10n.t('Finding files');
		case 'grep':
			return text('pattern') ? vscode.l10n.t('Searching for `{0}`', text('pattern')!) : vscode.l10n.t('Searching files');
		case 'list':
			return file ? vscode.l10n.t('Listing {0}', file) : vscode.l10n.t('Listing files');
		case 'webfetch':
			return text('url') ? vscode.l10n.t('Fetching {0}', text('url')!) : vscode.l10n.t('Fetching a page');
		case 'websearch':
			return text('query') ? vscode.l10n.t('Searching the web for "{0}"', text('query')!) : vscode.l10n.t('Searching the web');
		case 'task':
			return text('description') ? vscode.l10n.t('Delegating: {0}', text('description')!) : vscode.l10n.t('Delegating a task');
		default:
			return vscode.l10n.t('Running {0}', name);
	}
}

/** Phrases a permission request as what the agent wants to do, e.g. "edit `script.js`". */
function describePermission(action: string, resources: readonly string[]): string {
	const targets = resources.map(resource => `\`${action === 'bash' ? firstLine(resource) : relativePath(resource)}\``).join(', ');
	switch (action) {
		case 'edit':
			return targets ? vscode.l10n.t('edit {0}', targets) : vscode.l10n.t('edit files');
		case 'bash':
			return targets ? vscode.l10n.t('run {0}', targets) : vscode.l10n.t('run a command');
		case 'read':
			return targets ? vscode.l10n.t('read {0}', targets) : vscode.l10n.t('read files');
		case 'glob':
		case 'grep':
			return targets ? vscode.l10n.t('search {0}', targets) : vscode.l10n.t('search the workspace');
		case 'external_directory':
			return targets ? vscode.l10n.t('access {0} outside the workspace', targets) : vscode.l10n.t('access files outside the workspace');
		case 'webfetch':
			return targets ? vscode.l10n.t('fetch {0}', targets) : vscode.l10n.t('fetch a page');
		default:
			return targets ? vscode.l10n.t('{0} {1}', action, targets) : action;
	}
}

/** The workspace-relative form of a path the engine reported, when it is inside the workspace. */
function relativePath(filePath: string): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	return root ? vscode.workspace.asRelativePath(toUri(filePath, root), false) : filePath;
}

/** A command's first line, cut to fit a progress line. */
function firstLine(command: string): string {
	const line = command.split('\n')[0].trim();
	return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

async function runModelsCommand(
	credential: IEngineCredential,
	stream: vscode.ChatResponseStream
): Promise<vscode.ChatResult> {
	const models = await listZenModels(credential);
	if (!models.length) {
		stream.markdown(vscode.l10n.t('No models are available to this account.'));
		return {};
	}
	stream.markdown(vscode.l10n.t('Models available to {0}:\n\n', credential.account));
	for (const model of models) {
		stream.markdown(`- \`${model.id}\`${model.name ? ` — ${model.name}` : ''}\n`);
	}
	return {};
}

/**
 * Renders one engine event into the chat response.
 *
 * Permission requests are the important case: the engine has blocked its own
 * execution waiting for an answer. In manual mode the user is asked; in auto
 * mode the request is granted, but still explicitly and still on record.
 */
function renderEvent(
	event: Exclude<EngineEvent, { kind: 'diff' }>,
	stream: vscode.ChatResponseStream,
	transport: IEngineTransport,
	session: IEngineSession,
	mode: PermissionMode,
	output: vscode.LogOutputChannel
): void {
	switch (event.kind) {
		case 'text':
			stream.markdown(event.text);
			return;
		case 'reasoning':
			// Reasoning is noise in the transcript; keep it in the log instead.
			output.trace(event.text);
			return;
		case 'toolStart':
			stream.progress(describeTool(event.name, event.input));
			return;
		case 'toolEnd':
			if (!event.ok && event.detail) {
				stream.markdown(vscode.l10n.t('\n\n> Tool failed: {0}\n\n', event.detail));
			}
			return;
		case 'permission':
			void answerPermission(event.request, stream, transport, session, mode);
			return;
		case 'error':
			stream.markdown(vscode.l10n.t('\n\n{0}\n\n', event.message));
			return;
	}
}

async function answerPermission(
	request: IEnginePermission,
	stream: vscode.ChatResponseStream,
	transport: IEngineTransport,
	session: IEngineSession,
	mode: PermissionMode
): Promise<void> {
	const what = describePermission(request.action, request.resources);
	if (mode === PermissionMode.Auto) {
		stream.progress(vscode.l10n.t('Auto: allowed to {0}', what));
		await transport.replyPermission(session, request.requestId, true);
		return;
	}

	const allow = vscode.l10n.t('Allow');
	const deny = vscode.l10n.t('Deny');
	const detail = request.resources.join('\n');

	stream.markdown(vscode.l10n.t('\n\nBBF AI Coder wants to {0}.\n\n', what));

	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t('BBF AI Coder wants to {0}.', what.replace(/`/g, '')),
		{ modal: true, detail },
		allow, deny);

	await transport.replyPermission(session, request.requestId, choice === allow);
}

/**
 * Lists what the engine has changed in this conversation, with the patch for
 * anything new since the previous turn.
 */
function renderChanges(
	files: readonly IEngineFileChange[],
	shownPatches: Map<string, string>,
	stream: vscode.ChatResponseStream
): void {
	const changed = files.filter(file => file.path);
	if (!changed.length) {
		return;
	}

	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	stream.markdown(vscode.l10n.t('\n\n**Files changed in this session**\n\n'));
	for (const file of changed) {
		const uri = toUri(file.path, root);
		const label = root ? vscode.workspace.asRelativePath(uri, false) : file.path;
		stream.markdown(`- [${label}](${uri.toString()}) — ${describeStatus(file.status)}, +${file.additions} −${file.deletions}\n`);

		if (file.patch && shownPatches.get(file.path) !== file.patch) {
			shownPatches.set(file.path, file.patch);
			stream.markdown(`\n\`\`\`diff\n${truncateLines(file.patch, MAX_PATCH_LINES)}\n\`\`\`\n`);
		}
	}
}

function describeStatus(status: IEngineFileChange['status']): string {
	switch (status) {
		case 'added':
			return vscode.l10n.t('added');
		case 'deleted':
			return vscode.l10n.t('deleted');
		default:
			return vscode.l10n.t('modified');
	}
}

/** Resolves an engine-reported path against the workspace when it is relative. */
function toUri(filePath: string, root: vscode.Uri | undefined): vscode.Uri {
	const absolute = /^(?:[a-zA-Z]:[\\/]|\/)/.test(filePath);
	if (absolute || !root) {
		return vscode.Uri.file(filePath);
	}
	return vscode.Uri.joinPath(root, filePath);
}

function truncateLines(text: string, limit: number): string {
	const lines = text.split('\n');
	if (lines.length <= limit) {
		return text;
	}
	return `${lines.slice(0, limit).join('\n')}\n… ${vscode.l10n.t('{0} more lines', lines.length - limit)}`;
}

export function deactivate(): void { }
