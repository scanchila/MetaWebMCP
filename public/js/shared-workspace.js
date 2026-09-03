const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{43}$/;

function requireId(value) {
  const id = String(value || '').toLowerCase();
  if (!WORKSPACE_ID_PATTERN.test(id)) throw new Error('Invalid shared workspace identifier.');
  return id;
}

function requireToken(value) {
  const token = String(value || '');
  if (!TOKEN_PATTERN.test(token)) throw new Error('Invalid shared workspace token.');
  return token;
}

function requireRole(value) {
  const role = String(value || '');
  if (!['author', 'viewer'].includes(role)) throw new Error('Invalid shared workspace role.');
  return role;
}

export function parseSharedWorkspaceLocation(location = globalThis.location) {
  const hash = String(location?.hash || '');
  if (!hash.startsWith('#workspace?')) return null;
  const parameters = new URLSearchParams(hash.slice('#workspace?'.length));
  if (!parameters.has('shared') && !parameters.has('role') && !parameters.has('token')) return null;
  return {
    id: requireId(parameters.get('shared')),
    role: requireRole(parameters.get('role')),
    token: requireToken(parameters.get('token')),
  };
}

export function sharedWorkspaceLinks({ baseUrl, id, writeToken, readToken }) {
  const root = new URL('/', baseUrl);
  root.search = '';
  const workspaceId = requireId(id);
  const author = new URL(root);
  author.hash = `workspace?shared=${workspaceId}&role=author&token=${requireToken(writeToken)}`;
  const viewer = new URL(root);
  viewer.hash = `workspace?shared=${workspaceId}&role=viewer&token=${requireToken(readToken)}`;
  return { authorUrl: author.href, viewerUrl: viewer.href };
}

export class SharedWorkspaceClient {
  constructor(options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? globalThis.document?.baseURI ?? globalThis.location?.href ?? 'http://localhost/';
    this.ensureCapability = options.ensureCapability ?? (async () => {});
  }

  url(path) {
    return new URL(path, this.baseUrl).href;
  }

  async responseJson(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `Shared workspace request failed with HTTP ${response.status}.`);
    }
    return payload;
  }

  async create() {
    await this.ensureCapability();
    const response = await this.fetch(this.url('/api/shared-workspaces'), {
      method: 'POST',
      credentials: 'same-origin',
    });
    const payload = await this.responseJson(response);
    return {
      ...payload,
      links: sharedWorkspaceLinks({
        baseUrl: this.baseUrl,
        id: payload.id,
        writeToken: payload.writeToken,
        readToken: payload.readToken,
      }),
    };
  }

  async load({ id, token, afterRevision = -1 }) {
    const workspaceId = requireId(id);
    const capability = requireToken(token);
    const suffix = afterRevision >= 0 ? `?after=${encodeURIComponent(afterRevision)}` : '';
    const response = await this.fetch(this.url(`/api/shared-workspaces/${workspaceId}${suffix}`), {
      credentials: 'same-origin',
      headers: { authorization: `Bearer ${capability}` },
    });
    if (response.status === 204) return { changed: false };
    return { changed: true, ...await this.responseJson(response) };
  }

  async save({ id, token, workspace }) {
    const workspaceId = requireId(id);
    const capability = requireToken(token);
    const response = await this.fetch(this.url(`/api/shared-workspaces/${workspaceId}`), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        authorization: `Bearer ${capability}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ workspace }),
    });
    return this.responseJson(response);
  }
}
