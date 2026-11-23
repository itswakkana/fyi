import { OPENCODE_MANAGED_MARKER } from './hosts.mjs';
import { toPosix } from './util.mjs';

/** Render the zero-dependency OpenCode plugin that delegates to the shared hook engine. */
export function renderOpenCodePlugin(fallbackHooksAbs = '') {
  const fallbackLiteral = JSON.stringify(fallbackHooksAbs ? toPosix(fallbackHooksAbs) : '');
  return `${OPENCODE_MANAGED_MARKER} — project memory hooks for OpenCode.
// Update with \`fyi hook install --agents opencode\`; remove with \`fyi hook uninstall --agents opencode\`.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATE_MODULES = [
  ['.opencode', 'skills', 'fyi', 'scripts', 'lib', 'hooks.mjs'],
  ['.claude', 'skills', 'fyi', 'scripts', 'lib', 'hooks.mjs'],
  ['.agents', 'skills', 'fyi', 'scripts', 'lib', 'hooks.mjs'],
];
const FALLBACK_MODULE = ${fallbackLiteral};
const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'multiedit', 'apply_patch']);
const MAX_SESSIONS = 32;

async function loadHooksEngine(root) {
  for (const parts of CANDIDATE_MODULES) {
    const candidate = join(root, ...parts);
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  if (FALLBACK_MODULE && existsSync(FALLBACK_MODULE)) {
    return import(pathToFileURL(FALLBACK_MODULE).href);
  }
  return null;
}

function extractPromptText(input, output) {
  const parts = output?.parts || input?.parts;
  if (Array.isArray(parts)) {
    const text = parts
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string' && !part.synthetic)
      .map((part) => part.text)
      .join(' ')
      .trim();
    if (text) return text;
  }
  if (typeof input?.prompt === 'string') return input.prompt;
  if (typeof input?.text === 'string') return input.text;
  if (typeof output?.message?.content === 'string') return output.message.content;
  return '';
}

function boundedMap() {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    delete: (key) => map.delete(key),
    set(key, value) {
      if (!map.has(key) && map.size >= MAX_SESSIONS) map.delete(map.keys().next().value);
      map.set(key, value);
    },
  };
}

const sessionKey = (input) => input?.sessionID || input?.sessionId || '__default__';

export default async function fyiPlugin(ctx = {}) {
  const root = ctx.directory || ctx.worktree || process.cwd();
  let engine = null;
  try {
    engine = await loadHooksEngine(root);
  } catch {
    return {};
  }
  if (!engine || typeof engine.evaluateSessionStart !== 'function') return {};

  const fingerprint = () => {
    try {
      return typeof engine.storeFingerprint === 'function' ? engine.storeFingerprint(root) : String(Date.now());
    } catch {
      return String(Date.now());
    }
  };

  // Caches keyed by store fingerprint so per-step system transforms do not rescan .fyi/.
  let sessionCache = { key: null, value: null };
  const sessionContext = () => {
    const key = fingerprint();
    if (sessionCache.key !== key) {
      sessionCache = { key, value: engine.evaluateSessionStart(root, { host: 'opencode' }) };
    }
    return sessionCache.value;
  };

  const prompts = boundedMap();
  const matchCache = boundedMap();
  const pendingArgs = new Map();
  const toasted = boundedMap();

  const promptMatches = (session) => {
    const prompt = prompts.get(session);
    if (!prompt || typeof engine.evaluatePromptSubmit !== 'function') return null;
    const key = \`\${fingerprint()}\\u0000\${prompt}\`;
    const cached = matchCache.get(session);
    if (cached && cached.key === key) return cached.value;
    const value = engine.evaluatePromptSubmit(root, prompt, { host: 'opencode' });
    matchCache.set(session, { key, value });
    return value;
  };

  return {
    'chat.message': async (input, output) => {
      try {
        const text = extractPromptText(input, output);
        if (text) prompts.set(sessionKey(input), text);
      } catch {
        // Never disrupt chat flow.
      }
    },

    'experimental.chat.system.transform': async (input, output) => {
      try {
        if (!Array.isArray(output?.system)) return;
        const session = sessionContext();
        // Mutate output.system in-place (reassignment is ignored by OpenCode).
        if (session?.additionalContext) output.system.push(session.additionalContext);
        const matched = promptMatches(sessionKey(input));
        if (matched?.additionalContext) output.system.push(matched.additionalContext);
      } catch {
        // Fail open if the store cannot be read.
      }
    },

    'experimental.session.compacting': async (input, output) => {
      try {
        const session = sessionContext();
        if (session?.additionalContext && Array.isArray(output?.context)) {
          output.context.push(session.additionalContext);
        }
      } catch {
        // Fail open.
      }
    },

    'tool.execute.before': async (input, output) => {
      try {
        if (!EDIT_TOOLS.has(String(input?.tool || '').toLowerCase())) return;
        if (pendingArgs.size > 64) pendingArgs.clear();
        pendingArgs.set(input?.callID, output?.args || {});
      } catch {
        // Fail open.
      }
    },

    'tool.execute.after': async (input, output) => {
      try {
        if (!EDIT_TOOLS.has(String(input?.tool || '').toLowerCase())) return;
        const args = pendingArgs.get(input?.callID) || input?.args || {};
        pendingArgs.delete(input?.callID);
        if (typeof engine.evaluatePostToolUse !== 'function') return;
        const result = engine.evaluatePostToolUse(root, { tool_input: args, cwd: root }, { host: 'opencode' });
        if (result?.additionalContext && output && typeof output.output === 'string') {
          output.output = \`\${output.output}\\n\\n\${result.additionalContext}\`;
        }
      } catch {
        // Fail open.
      }
    },

    event: async (payload) => {
      try {
        const ev = payload?.event || payload;
        if (ev?.type === 'session.deleted') {
          const id = ev?.properties?.info?.id || ev?.sessionID;
          if (id) {
            prompts.delete(id);
            matchCache.delete(id);
            toasted.delete(id);
          }
          return;
        }
        if (ev?.type === 'session.idle' && typeof engine.evaluateIdle === 'function') {
          const result = engine.evaluateIdle(root);
          const message = result?.systemMessage;
          const id = ev?.properties?.sessionID || ev?.sessionID || '__default__';
          // One toast per session per distinct message.
          if (message && toasted.get(id) !== message && ctx?.client?.tui?.showToast) {
            toasted.set(id, message);
            await ctx.client.tui.showToast({ body: { message, variant: 'warning' } });
          }
        }
      } catch {
        // Fail open.
      }
    },
  };
}
`;
}
