/* BBF extension feed — browse UI. Read-only; publishing happens via GitHub releases. */

const $ = (id) => document.getElementById(id);

// A token can be supplied as ?token=... so the page works against a locked-down feed.
const token = new URLSearchParams(location.search).get('token') || '';
const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
const withToken = (url) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url);

function setStatus(text, kind) {
	const el = $('status');
	el.textContent = text;
	el.className = `status${kind ? ` ${kind}` : ''}`;
}

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
	));
}

function card(ext) {
	const icon = ext.iconUrl
		? `<img src="${escapeHtml(withToken(ext.iconUrl))}" alt="">`
		: `<div class="fallback">${escapeHtml((ext.displayName || '?').charAt(0).toUpperCase())}</div>`;

	const tags = [
		`<span class="tag version">v${escapeHtml(ext.version)}</span>`,
		ext.prerelease ? '<span class="tag pre">pre-release</span>' : '',
		ext.releaseTag ? `<span class="tag">${escapeHtml(ext.releaseTag)}</span>` : '',
		ext.versions && ext.versions.length > 1 ? `<span class="tag">${ext.versions.length} versions</span>` : ''
	].join('');

	return `
	<article class="card">
		${icon}
		<div class="card-body">
			<h3>${escapeHtml(ext.displayName)}</h3>
			<div class="pub">${escapeHtml(ext.id)}</div>
			<p class="desc">${escapeHtml(ext.description)}</p>
			<div class="meta">${tags}</div>
			<a class="btn" href="${escapeHtml(withToken(ext.downloadUrl))}">Download .vsix</a>
			<div class="cmd"><code>bbf-code --install-extension ${escapeHtml(ext.id)}-${escapeHtml(ext.version)}.vsix</code></div>
		</div>
	</article>`;
}

async function load() {
	$('snippet').innerHTML = `<code>"bbfExtensionsServiceUrl": "${escapeHtml(location.origin)}"</code>`;

	try {
		const response = await fetch('/api/extensions', { headers: authHeaders });
		if (response.status === 401) {
			throw new Error('Unauthorized. Append ?token=<BBF_API_TOKEN> to this page URL.');
		}
		if (!response.ok) {
			throw new Error((await response.json().catch(() => ({}))).error || `Feed returned ${response.status}.`);
		}

		const data = await response.json();
		const extensions = data.extensions || [];

		$('count').textContent = `(${extensions.length})`;
		$('list').innerHTML = extensions.map(card).join('');
		$('empty').hidden = extensions.length > 0;
		setStatus(`${extensions.length} published`, 'ok');

		const problems = data.problems || [];
		$('problems').hidden = problems.length === 0;
		$('problem-list').innerHTML = problems
			.map((p) => `<li><strong>${escapeHtml(p.asset)}</strong> (${escapeHtml(p.release)}) — ${escapeHtml(p.error)}</li>`)
			.join('');
	} catch (error) {
		setStatus('unavailable', 'bad');
		const box = $('error');
		box.hidden = false;
		box.innerHTML = `<h2>/// FEED UNAVAILABLE</h2><p>${escapeHtml(error.message)}</p>`;
	}
}

load();
