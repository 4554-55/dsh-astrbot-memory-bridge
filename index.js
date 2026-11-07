import { createHash } from 'node:crypto';

const DEFAULTS = {
  enabled: true,
  ingestPath: '/api/astrbot-memory/ingest',
  recallPath: '/api/astrbot-memory/recall',
  maxBodyBytes: 1024 * 1024,
  defaultRecallLimit: 5,
  saveAssistantMessages: true,
  autoExtract: true,
  crossPlatformIdentity: false,
  engine: {
    mode: 'http',
    baseUrl: 'http://127.0.0.1:8787',
    ingestPath: '/memory/ingest',
    recallPath: '/memory/recall',
    apiKeyEnv: 'DSH_MEMORY_ENGINE_API_KEY'
  }
};

function mergeConfig(base, extra = {}) {
  return {
    ...base,
    ...extra,
    engine: { ...base.engine, ...(extra.engine || {}) }
  };
}

function normalizeIdentity(input = {}, crossPlatform = false) {
  const platform = String(input.platform || 'unknown');
  const type = input.conversation_type === 'group' ? 'group' : 'private';
  const conversationId = String(input.conversation_id || '');
  const contactId = input.contact_id == null ? null : String(input.contact_id);

  // Default isolation:
  // platform -> conversation type -> conversation -> contact.
  // Cross-platform identity is opt-in and must be supplied by the caller.
  const personId = crossPlatform && input.person_id
    ? String(input.person_id)
    : null;

  const scope = type === 'group'
    ? `group:${platform}:${conversationId}`
    : `contact:${platform}:${conversationId || contactId}`;

  const memberScope = type === 'group' && contactId
    ? `member:${platform}:${conversationId}:${contactId}`
    : null;

  return {
    platform,
    conversation_type: type,
    conversation_id: conversationId,
    contact_id: contactId,
    person_id: personId,
    scope,
    member_scope: memberScope
  };
}

function makeMemoryId(memory) {
  const raw = [
    memory.platform,
    memory.conversation_type,
    memory.conversation_id,
    memory.contact_id || '',
    memory.category || 'conversation',
    memory.content || ''
  ].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function sanitizeMemory(memory, config) {
  const identity = normalizeIdentity(memory, config.crossPlatformIdentity);
  const result = {
    memory_id: memory.memory_id || makeMemoryId({
      ...identity,
      category: memory.category,
      content: memory.content
    }),
    ...identity,
    memory_scope: memory.memory_scope || (
      identity.conversation_type === 'group'
        ? (identity.contact_id ? 'member' : 'group')
        : 'contact'
    ),
    category: memory.category || 'conversation',
    content: String(memory.content || '').trim(),
    importance: Number.isFinite(Number(memory.importance))
      ? Math.max(0, Math.min(1, Number(memory.importance)))
      : 0.5,
    confidence: Number.isFinite(Number(memory.confidence))
      ? Math.max(0, Math.min(1, Number(memory.confidence)))
      : 0.8,
    source_message_id: memory.source_message_id
      ? String(memory.source_message_id)
      : undefined,
    created_at: memory.created_at || new Date().toISOString()
  };

  if (!result.content) {
    throw new Error('memory.content is required');
  }
  return result;
}

class HttpMemoryEngine {
  constructor(config) {
    this.config = config;
  }

  async request(path, payload) {
    const url = new URL(path, this.config.baseUrl).toString();
    const headers = { 'content-type': 'application/json' };
    const key = process.env[this.config.apiKeyEnv];
    if (key) headers.authorization = `Bearer ${key}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { raw: text }; }

    if (!response.ok) {
      throw new Error(`Memory engine HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return data;
  }

  async ingest(memory) {
    return this.request(this.config.ingestPath, { memory });
  }

  async recall(query) {
    return this.request(this.config.recallPath, query);
  }
}

export function apply(ctx, config = {}) {
  const cfg = mergeConfig(DEFAULTS, config);
  if (!cfg.enabled) return;

  const engine = new HttpMemoryEngine(cfg.engine);

  const httpServer = ctx.get?.('httpServer');
  if (!httpServer?.register) {
    ctx.logger?.warn?.('[astrbot-memory-bridge] httpServer service unavailable; plugin loaded without HTTP routes.');
    return;
  }

  // AstrBot -> DSH:
  // POST /api/astrbot-memory/ingest
  // {
  //   platform, conversation_type, conversation_id, contact_id,
  //   role, content, message_id, timestamp
  // }
  httpServer.register({
    kind: 'prefix',
    path: cfg.ingestPath,
    handler: async (request) => {
      try {
        const body = await request.json();
        if (!body.content) {
          return { status: 400, body: { ok: false, error: 'content is required' } };
        }

        const memory = sanitizeMemory({
          platform: body.platform,
          conversation_type: body.conversation_type,
          conversation_id: body.conversation_id,
          contact_id: body.contact_id,
          person_id: body.person_id,
          memory_scope: body.memory_scope,
          category: body.category || (body.role === 'user' ? 'conversation' : 'assistant'),
          content: body.content,
          source_message_id: body.message_id,
          importance: body.importance,
          confidence: body.confidence
        }, cfg);

        const result = await engine.ingest(memory);
        return { status: 200, body: { ok: true, memory, result } };
      } catch (error) {
        ctx.logger?.error?.(`[astrbot-memory-bridge] ingest failed: ${error.message}`);
        return { status: 500, body: { ok: false, error: error.message } };
      }
    }
  });

  // AstrBot -> DSH:
  // POST /api/astrbot-memory/recall
  // {
  //   platform, conversation_type, conversation_id, contact_id,
  //   query, limit
  // }
  httpServer.register({
    kind: 'prefix',
    path: cfg.recallPath,
    handler: async (request) => {
      try {
        const body = await request.json();
        if (!body.query) {
          return { status: 400, body: { ok: false, error: 'query is required' } };
        }

        const identity = normalizeIdentity(body, cfg.crossPlatformIdentity);
        const payload = {
          query: String(body.query),
          limit: Math.max(
            1,
            Math.min(20, Number(body.limit || cfg.defaultRecallLimit))
          ),
          filters: {
            platform: identity.platform,
            conversation_type: identity.conversation_type,
            conversation_id: identity.conversation_id,
            contact_id: identity.contact_id,
            person_id: identity.person_id,
            scopes: identity.conversation_type === 'group'
              ? [identity.scope, identity.member_scope].filter(Boolean)
              : [identity.scope]
          }
        };

        const result = await engine.recall(payload);
        return { status: 200, body: { ok: true, identity, result } };
      } catch (error) {
        ctx.logger?.error?.(`[astrbot-memory-bridge] recall failed: ${error.message}`);
        return { status: 500, body: { ok: false, error: error.message } };
      }
    }
  });

  ctx.logger?.info?.(
    `[astrbot-memory-bridge] loaded; ingest=${cfg.ingestPath}, recall=${cfg.recallPath}`
  );
}

export const name = 'dsh-astrbot-memory-bridge';
export const version = '0.1.0';
