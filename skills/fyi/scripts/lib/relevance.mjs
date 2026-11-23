/**
 * Prompt relevance for lifecycle hooks.
 *
 * Hooks inject context without being asked, so this module optimizes for
 * precision over recall: metadata-only fields, word-boundary matching with a
 * light stemmer, IDF weighting across the store, and a multi-term gate. A
 * prompt that only grazes one generic word stays silent.
 */

const SEGMENTER =
  typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ASCII_RE = /^[\x00-\x7f]+$/;

/** Words that carry no retrieval signal in coding prompts (checked before and after stemming). */
export const STOP_WORDS = new Set([
  // English function words
  'a', 'about', 'above', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as',
  'at', 'be', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'cannot',
  'could', 'did', 'do', 'does', 'doing', 'done', 'down', 'during', 'each', 'either', 'else', 'etc',
  'even', 'ever', 'every', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he',
  'her', 'here', 'hers', 'him', 'his', 'how', 'however', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'itself', 'just', 'least', 'less', 'many', 'may', 'me', 'might', 'mine', 'more', 'most', 'much',
  'must', 'my', 'myself', 'neither', 'no', 'nor', 'not', 'now', 'of', 'off', 'often', 'ok', 'okay',
  'on', 'once', 'one', 'only', 'or', 'other', 'our', 'ours', 'out', 'over', 'own', 'per', 'please',
  'pls', 'quite', 'rather', 'really', 'same', 'she', 'should', 'since', 'so', 'some', 'still',
  'such', 'than', 'thank', 'thanks', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'though', 'through', 'thus', 'to', 'too', 'under', 'until', 'up', 'upon',
  'us', 'very', 'via', 'was', 'way', 'we', 'well', 'were', 'what', 'whatever', 'when', 'where',
  'whether', 'which', 'while', 'who', 'whom', 'whose', 'why', 'will', 'with', 'within', 'without',
  'would', 'yes', 'yet', 'you', 'your', 'yours', 'yourself', 'eg', 'ie', 'oh', 'hi', 'vs', 're',
  // Generic request verbs and coding filler
  'add', 'allow', 'apply', 'ask', 'call', 'change', 'check', 'clean', 'code', 'create',
  'delete', 'describe', 'edit', 'ensure', 'explain', 'file', 'files', 'find', 'fix', 'get', 'give',
  'go', 'got', 'help', 'implement', 'improve', 'keep', 'know', 'let', 'like', 'line', 'look', 'make',
  'move', 'need', 'new', 'old', 'put', 'read', 'refactor', 'remove', 'rename', 'run', 'say', 'see',
  'set', 'show', 'start', 'stop', 'take', 'tell', 'thing', 'things', 'think', 'try',
  'turn', 'update', 'use', 'used', 'using', 'want', 'work', 'write', 'wrong',
  // Chinese function words and generic verbs
  '一下', '一个', '一些', '这个', '那个', '这里', '那里', '这些', '那些', '怎么', '怎样', '如何',
  '什么', '为什么', '为何', '哪里', '哪个', '哪些', '是否', '可以', '能否', '能不能', '需要',
  '应该', '帮我', '帮忙', '麻烦', '请问', '我们', '你们', '他们', '它们', '现在', '然后', '还是',
  '或者', '以及', '因为', '所以', '但是', '如果', '已经', '没有', '问题', '情况', '进行', '使用',
  '处理', '看看', '看下', '一直', '时候', '修复', '修改', '添加', '增加', '删除', '更新', '实现',
  '优化', '检查', '告诉', '知道', '解决', '出现', '东西', '代码', '文件',
]);

/** Light English stemmer: folds plural, gerund, past, and -ment forms; never touches non-ASCII. */
export function stem(word) {
  let w = String(word);
  if (!ASCII_RE.test(w) || w.length <= 3) return w;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (/(?:ss|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  if (w.length > 7 && w.endsWith('ment')) w = w.slice(0, -4);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  if (w.length > 4 && /([b-df-hj-np-tv-z])\1$/.test(w)) w = w.slice(0, -1);
  return w;
}

function segments(text) {
  const normalized = String(text || '').normalize('NFKC').toLowerCase();
  if (SEGMENTER) {
    const out = [];
    for (const part of SEGMENTER.segment(normalized)) {
      if (part.isWordLike) out.push(part.segment);
    }
    return out;
  }
  return normalized.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

/** Split text into lowercase word tokens; CJK text is segmented with Intl.Segmenter. */
export function tokenize(text) {
  const out = [];
  for (const raw of segments(text)) {
    const token = raw.replace(/^[_-]+|[_-]+$/g, '');
    if (!token) continue;
    out.push(token);
    // Keep snake_case compounds and their parts so `pg_stat` matches `stat`.
    if (token.includes('_')) out.push(...token.split('_').filter(Boolean));
  }
  return out;
}

function isSignalToken(token) {
  if (!token || STOP_WORDS.has(token)) return false;
  if (/^\d+$/.test(token)) return false;
  // Single CJK characters and single ASCII letters are too ambiguous to match on.
  return token.length >= 2;
}

/** Unique stemmed terms that carry retrieval signal. */
export function signalTerms(text, max = Infinity) {
  const seen = new Set();
  const out = [];
  for (const token of tokenize(text)) {
    if (!isSignalToken(token)) continue;
    const s = stem(token);
    if (STOP_WORDS.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

const MAX_PROMPT_CHARS = 1500;
const MAX_PROMPT_TERMS = 16;

/** Extract clean, high-signal search terms from a natural-language user prompt. */
export function extractPromptTerms(prompt) {
  return signalTerms(String(prompt || '').slice(0, MAX_PROMPT_CHARS), MAX_PROMPT_TERMS);
}

/** Prompts that should never trigger automatic retrieval. */
export function shouldSkipPrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return 'empty';
  if (/^[/!]/.test(text)) return 'command';
  if (/(^|[^\p{L}\p{N}_-])fyi([^\p{L}\p{N}_-]|$)/iu.test(text)) return 'explicit';
  return '';
}

const FIELD_WEIGHTS = { tag: 3, title: 3, description: 1.5, app: 1 };
const INELIGIBLE_STATUS = new Set(['deprecated']);

function artifactFields(artifact) {
  const tagTerms = new Set();
  for (const tag of artifact.tags || []) {
    for (const term of signalTerms(tag)) tagTerms.add(term);
    const whole = stem(String(tag).toLowerCase().trim());
    if (whole) tagTerms.add(whole);
  }
  const appTerms = new Set();
  for (const app of artifact.apps || []) {
    const whole = String(app).toLowerCase().trim();
    if (whole) appTerms.add(stem(whole));
    for (const term of signalTerms(app)) appTerms.add(term);
  }
  return {
    tag: tagTerms,
    title: new Set(signalTerms(artifact.title)),
    description: new Set(signalTerms(artifact.description)),
    app: appTerms,
  };
}

/** True when an artifact is eligible for automatic injection. */
export function isEligible(artifact) {
  return !artifact.archived && !INELIGIBLE_STATUS.has(String(artifact.status || '').toLowerCase());
}

/**
 * Rank artifacts for a prompt. Returns [] unless the gate is met:
 * at least two distinct prompt terms hit strong fields (title, tags,
 * description) covering a meaningful share of the prompt, or a short prompt
 * hits a tag exactly.
 */
export function rankForPrompt(prompt, artifacts, options = {}) {
  const limit = options.limit ?? 3;
  const terms = Array.isArray(prompt) ? prompt : extractPromptTerms(prompt);
  if (!terms.length) return [];

  const pool = artifacts.filter(isEligible).map((artifact) => ({ artifact, fields: artifactFields(artifact) }));
  if (!pool.length) return [];

  const df = new Map();
  for (const { fields } of pool) {
    const all = new Set([...fields.tag, ...fields.title, ...fields.description, ...fields.app]);
    for (const term of terms) if (all.has(term)) df.set(term, (df.get(term) || 0) + 1);
  }
  const n = pool.length;
  const norm = Math.log(1 + n);
  const idf = (term) => Math.log(1 + n / (df.get(term) || n)) / norm;

  const results = [];
  for (const { artifact, fields } of pool) {
    let score = 0;
    let strong = 0;
    let tagHits = 0;
    const matched = [];
    for (const term of terms) {
      let best = 0;
      let bestField = '';
      for (const field of ['tag', 'title', 'description', 'app']) {
        if (fields[field].has(term) && FIELD_WEIGHTS[field] > best) {
          best = FIELD_WEIGHTS[field];
          bestField = field;
        }
      }
      if (!best) continue;
      score += best * idf(term);
      matched.push(term);
      if (bestField !== 'app') strong++;
      if (bestField === 'tag') tagHits++;
    }
    if (!matched.length) continue;

    const coverage = strong / terms.length;
    const multiTerm = strong >= 2 && (coverage >= 0.25 || strong >= 3);
    const exactTag = strong === 1 && tagHits === 1 && terms.length <= 2;
    if (!multiTerm && !exactTag) continue;

    results.push({ artifact, score: Math.round(score * 100) / 100, matched, coverage });
  }

  results.sort((a, b) => b.score - a.score || a.artifact.title.localeCompare(b.artifact.title));
  if (!results.length) return [];
  const floor = results[0].score * 0.5;
  return results.filter((entry) => entry.score >= floor).slice(0, limit);
}
