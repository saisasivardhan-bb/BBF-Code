import { existsSync, readFileSync } from 'node:fs';

/**
 * Configuration, read from the environment.
 *
 * The GitHub token never leaves this process: BBF Code talks to this server,
 * and this server is the only thing that talks to GitHub.
 */

function required(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
	}
	return value;
}

/**
 * Load a .env file if one exists, without pulling in a dependency.
 * Node 21+ ships process.loadEnvFile; older versions fall back to a tiny parser.
 */
export function loadDotEnv(path) {
	if (!existsSync(path)) {
		return;
	}
	if (typeof process.loadEnvFile === 'function') {
		process.loadEnvFile(path);
		return;
	}
	const lines = readFileSync(path, 'utf8').split(/\r?\n/);
	for (const line of lines) {
		if (!line || line.trim().startsWith('#')) {
			continue;
		}
		const match = /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(line);
		if (!match) {
			continue;
		}
		const value = (match[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
		if (process.env[match[1]] === undefined) {
			process.env[match[1]] = value;
		}
	}
}

export const config = {
	/** owner/repo holding the releases that carry the .vsix assets. */
	get repo() {
		const repo = required('GITHUB_REPO');
		if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
			throw new Error(`GITHUB_REPO must look like "owner/repo", got "${repo}".`);
		}
		return repo;
	},

	/** Fine-grained PAT with Contents: read on the repo above. */
	get githubToken() {
		return required('GITHUB_TOKEN');
	},

	/**
	 * Shared secret BBF Code sends as `Authorization: Bearer <token>`.
	 * Optional, but without it the feed is readable by anyone who can reach it.
	 */
	get apiToken() {
		return process.env.BBF_API_TOKEN || '';
	},

	/**
	 * The company OpenCode Zen key.
	 *
	 * This is the one credential that must never reach a client. BBF Code is
	 * given a short-lived session token instead and talks to the proxy below;
	 * only this process ever puts this value on the wire to Zen. It is read
	 * through a getter so it is never enumerable on the config object, and it
	 * is never logged.
	 */
	get zenApiKey() {
		return process.env.ZEN_API_KEY || '';
	},

	/** Only Google accounts in this domain may exchange a token for AI access. */
	get googleAllowedDomain() {
		return process.env.GOOGLE_ALLOWED_DOMAIN || 'blackboxfactories.com';
	},

	/** How long an issued AI session token stays valid. */
	get aiSessionTtlMs() {
		return Number(process.env.AI_SESSION_TTL_SECONDS || 43200) * 1000;
	},

	get port() {
		return Number(process.env.PORT || 4000);
	},

	/** How long release metadata is cached before GitHub is asked again. */
	get refreshMs() {
		return Number(process.env.REFRESH_SECONDS || 300) * 1000;
	},

	get publicUrl() {
		const fallback = `http://localhost:${Number(process.env.PORT || 4000)}`;
		return (process.env.PUBLIC_URL || fallback).replace(/\/$/, '');
	}
};
