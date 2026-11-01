/* QuizClash core — pure logic (no DOM). Runs in browser and Node (for tests). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QuizCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const TOPIC_PREFIX = 'quizclash/v1';
  const MAX_QUESTIONS = 100;
  const DEFAULT_LIMIT = 20;
  const MAX_IMAGE_CHARS = 600000; // ~450KB base64, under the broker's 1MB packet limit

  /* ---------- primitives ---------- */

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) n = lo;
    return Math.min(hi, Math.max(lo, n));
  }

  function randomInts(n) {
    const buf = new Uint32Array(n);
    const c = typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : null;
    if (c) c.getRandomValues(buf);
    else for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 4294967296);
    return buf;
  }

  function makeCode(len) {
    const n = len || 6;
    const rnd = randomInts(n);
    let out = '';
    for (let i = 0; i < n; i++) out += ALPHABET[rnd[i] % ALPHABET.length];
    return out;
  }

  function normalizeCode(raw) {
    return String(raw == null ? '' : raw)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
  }

  function makeId(prefix) {
    const r = randomInts(2);
    return (prefix || 'p') + Date.now().toString(36) + r[0].toString(36) + r[1].toString(36);
  }

  function topics(code) {
    const c = normalizeCode(code);
    return {
      base: TOPIC_PREFIX + '/' + c,
      quiz: TOPIC_PREFIX + '/' + c + '/quiz',
      q: TOPIC_PREFIX + '/' + c + '/q',
      state: TOPIC_PREFIX + '/' + c + '/state',
      ev: TOPIC_PREFIX + '/' + c + '/ev',
    };
  }

  function sanitizeText(value, max) {
    const limit = max || 200;
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit);
  }

  function isImageRef(v) {
    return typeof v === 'string' && /^(https?:\/\/|data:image\/)/i.test(v.trim()) && v.length <= MAX_IMAGE_CHARS;
  }

  /* ---------- quiz model ---------- */

  function normalizeQuestion(raw) {
    const q = raw && typeof raw === 'object' ? raw : {};
    let options = Array.isArray(q.options) ? q.options.map(function (o) { return sanitizeText(o, 120); }) : [];
    while (options.length < 4) options.push('');
    options = options.slice(0, 4);
    const correct = Math.round(clamp(Number.isInteger(q.correct) ? q.correct : 0, 0, 3));
    const limit = Math.round(clamp(q.limit || DEFAULT_LIMIT, 5, 120));
    const image = isImageRef(q.image) ? String(q.image).trim() : '';
    return { text: sanitizeText(q.text, 300), options: options, correct: correct, limit: limit, image: image };
  }

  function emptyQuiz() {
    return { title: '', questions: [normalizeQuestion({ text: '', options: ['', '', '', ''], correct: 0, limit: DEFAULT_LIMIT })] };
  }

  function normalizeQuiz(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    let list = Array.isArray(r.questions) ? r.questions.slice(0, MAX_QUESTIONS) : [];
    if (!list.length) list = [{}];
    return {
      title: sanitizeText(r.title, 80),
      questions: list.map(normalizeQuestion),
    };
  }

  /** Blocking validation errors for a quiz (empty array = playable). */
  function validateQuiz(quiz) {
    const errors = [];
    const q = quiz || { questions: [] };
    if (!q.questions || !q.questions.length) errors.push('至少需要一條題目');
    (q.questions || []).forEach(function (item, i) {
      const n = i + 1;
      if (!item.text) errors.push('第 ' + n + ' 題：未填題目');
      const filled = item.options.filter(function (o) { return o; }).length;
      if (filled < 4) errors.push('第 ' + n + ' 題：四個選項都要填寫');
      if (!Number.isInteger(item.correct) || item.correct < 0 || item.correct > 3) errors.push('第 ' + n + ' 題：未指定正確答案');
    });
    return errors;
  }

  /* ---------- scoring ---------- */

  /**
   * Kahoot-style score.
   * correct  -> 600 base + up to 400 for speed + streak bonus (0/50/100/150/200)
   * wrong    -> 0, streak resets
   */
  function scoreFor(isCorrect, elapsedMs, limitSec, streakBefore) {
    if (!isCorrect) return { gained: 0, streak: 0, base: 0, speed: 0, streakBonus: 0 };
    const limit = clamp(limitSec || DEFAULT_LIMIT, 1, 300) * 1000;
    const t = clamp(elapsedMs, 0, limit);
    const speed = Math.round(400 * (1 - t / limit));
    const base = 600;
    const streakBonus = 50 * Math.min(clamp(streakBefore, 0, 4), 4);
    return { gained: base + speed + streakBonus, streak: streakBefore + 1, base: base, speed: speed, streakBonus: streakBonus };
  }

  /* ---------- live game state ---------- */

  function emptyState(code) {
    return {
      v: 1,
      code: normalizeCode(code),
      title: '',
      phase: 'lobby', // lobby | question | reveal | end
      qi: -1,
      total: 0,
      limitSec: DEFAULT_LIMIT,
      startedAt: 0,
      endsAt: 0,
      counts: null,
      correct: null,
      players: [],
      sortMode: 'score',
      now: 0,
    };
  }

  function newPlayer(id, name) {
    return {
      id: String(id).slice(0, 32),
      name: sanitizeText(name, 16) || '玩家',
      score: 0,
      correct: 0,
      wrong: 0,
      streak: 0,
      best: 0,
      lastChoice: null,
      lastGained: 0,
      totalMs: 0,
    };
  }

  function findPlayer(state, id) {
    for (let i = 0; i < state.players.length; i++) if (state.players[i].id === id) return state.players[i];
    return null;
  }

  /** Add a player (or rename an existing one). Returns the player record. */
  function addPlayer(state, id, name) {
    let p = findPlayer(state, id);
    if (p) {
      const clean = sanitizeText(name, 16);
      if (clean) p.name = clean;
      return p;
    }
    if (state.players.length >= 500) return null;
    p = newPlayer(id, name);
    state.players.push(p);
    return p;
  }

  function removePlayer(state, id) {
    const before = state.players.length;
    state.players = state.players.filter(function (p) { return p.id !== id; });
    return state.players.length !== before;
  }

  function beginQuestion(state, qi) {
    state.phase = 'question';
    state.qi = qi;
    state.startedAt = 0;
    state.endsAt = 0;
    state.counts = null;
    state.correct = null;
    state.players.forEach(function (p) {
      p.lastChoice = null;
      p.lastGained = 0;
      p.lastCorrect = null;
    });
    return state;
  }

  function startTimer(state, now, limitSec) {
    state.limitSec = Math.round(clamp(limitSec || DEFAULT_LIMIT, 5, 120));
    state.startedAt = now;
    state.endsAt = now + state.limitSec * 1000;
    return state;
  }

  /**
   * Record one answer. First answer wins (no changing).
   * `now` is the host clock; elapsed time is measured on arrival.
   * Returns { ok, reason, player, result }.
   */
  function applyAnswer(state, answerKey, pid, choice, now) {
    if (state.phase !== 'question') return { ok: false, reason: 'not_open' };
    const p = findPlayer(state, pid);
    if (!p) return { ok: false, reason: 'no_player' };
    if (p.lastChoice != null) return { ok: false, reason: 'duplicate' };
    const c = Number(choice);
    if (!Number.isInteger(c) || c < 0 || c > 3) return { ok: false, reason: 'bad_choice' };
    if (state.endsAt && now > state.endsAt + 1200) return { ok: false, reason: 'late' };

    const elapsed = Math.max(0, now - state.startedAt);
    const isCorrect = c === answerKey;
    const s = scoreFor(isCorrect, elapsed, state.limitSec, p.streak);
    p.lastChoice = c;
    p.lastCorrect = isCorrect;
    p.lastGained = s.gained;
    p.score += s.gained;
    p.streak = s.streak;
    p.best = Math.max(p.best, s.streak);
    p.totalMs += elapsed;
    if (isCorrect) p.correct += 1;
    else p.wrong += 1;
    return { ok: true, player: p, result: s, elapsed: elapsed };
  }

  function reveal(state, answerKey) {
    const counts = [0, 0, 0, 0];
    state.players.forEach(function (p) { if (p.lastChoice != null) counts[p.lastChoice] += 1; });
    state.counts = counts;
    state.correct = answerKey;
    state.phase = 'reveal';
    return state;
  }

  function ranking(state, mode) {
    const m = mode || state.sortMode || 'score';
    return state.players.slice().sort(function (a, b) {
      if (m === 'correct') {
        if (b.correct !== a.correct) return b.correct - a.correct;
        if (b.score !== a.score) return b.score - a.score;
      } else {
        if (b.score !== a.score) return b.score - a.score;
        if (b.correct !== a.correct) return b.correct - a.correct;
      }
      return a.name.localeCompare(b.name, 'zh-Hant');
    });
  }

  /** Compact copy of the state that is safe to broadcast (never leaks the answer or picks early). */
  function publicState(state, now) {
    const showPicks = state.phase !== 'question';
    return {
      v: 1,
      code: state.code,
      title: state.title,
      phase: state.phase,
      qi: state.qi,
      total: state.total,
      limitSec: state.limitSec,
      startedAt: state.startedAt,
      endsAt: state.endsAt,
      counts: state.counts,
      correct: state.phase === 'reveal' || state.phase === 'end' ? state.correct : null,
      players: state.players.map(function (p) {
        return {
          id: p.id,
          name: p.name,
          score: p.score,
          correct: p.correct,
          wrong: p.wrong,
          streak: p.streak,
          best: p.best,
          lastChoice: showPicks ? p.lastChoice : null,
          lastGained: showPicks ? p.lastGained : 0,
        };
      }),
      sortMode: state.sortMode,
      now: now || 0,
    };
  }

  /* ---------- CSV ---------- */

  function parseCSV(text, delimiter) {
    const d = delimiter || ',';
    const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i += 1; continue;
        }
        field += ch; i += 1; continue;
      }
      if (ch === '"' && field === '') { inQuotes = true; i += 1; continue; }
      if (ch === d) { row.push(field); field = ''; i += 1; continue; }
      if (ch === '\r') { i += 1; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
      field += ch; i += 1;
    }
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(rows) {
    return '\uFEFF' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  const QUIZ_HEADER = ['題目', '選項A', '選項B', '選項C', '選項D', '正確答案', '時限秒', '圖片URL'];

  function quizToCSV(quiz) {
    const rows = [QUIZ_HEADER];
    (quiz.questions || []).forEach(function (q) {
      rows.push([
        q.text,
        q.options[0], q.options[1], q.options[2], q.options[3],
        'ABCD'[q.correct] || 'A',
        q.limit,
        q.image || '',
      ]);
    });
    return toCSV(rows);
  }

  function parseAnswerCell(cell, options) {
    const raw = String(cell == null ? '' : cell).trim();
    if (!raw) return -1;
    const m = raw.match(/^[（(\[]?\s*([A-Da-d])\s*[)）\].、:：]?/);
    if (m) return 'ABCD'.indexOf(m[1].toUpperCase());
    if (/^[1-4]$/.test(raw)) return Number(raw) - 1;
    const idx = options.findIndex(function (o) { return o && o.toLowerCase() === raw.toLowerCase(); });
    return idx;
  }

  /** Parse quiz CSV. Returns { quiz, warnings }. Throws on unusable input. */
  function csvToQuiz(text, defaultTitle) {
    const rows = parseCSV(text);
    if (!rows.length) throw new Error('CSV 是空的');
    let start = 0;
    const head = rows[0].map(function (c) { return String(c).toLowerCase(); });
    if (head.some(function (c) { return /題目|question|問題/.test(c); })) start = 1;

    const warnings = [];
    const questions = [];
    for (let r = start; r < rows.length; r++) {
      const row = rows[r];
      const text2 = sanitizeText(row[0], 300);
      if (!text2) continue;
      const options = [1, 2, 3, 4].map(function (c) { return sanitizeText(row[c], 120); });
      if (options.filter(Boolean).length < 2) {
        warnings.push('第 ' + (r + 1) + ' 行：選項不足，已略過');
        continue;
      }
      let correct = parseAnswerCell(row[5], options);
      if (correct < 0 || correct > 3) {
        warnings.push('第 ' + (r + 1) + ' 行：正確答案無法辨識，預設為 A');
        correct = 0;
      }
      const limit = row[6] ? clamp(parseFloat(row[6]) || DEFAULT_LIMIT, 5, 120) : DEFAULT_LIMIT;
      const image = isImageRef(row[7]) ? String(row[7]).trim() : '';
      if (row[7] && !image) warnings.push('第 ' + (r + 1) + ' 行：圖片連結無效，已忽略');
      questions.push(normalizeQuestion({ text: text2, options: options, correct: correct, limit: limit, image: image }));
      if (questions.length >= MAX_QUESTIONS) break;
    }
    if (!questions.length) throw new Error('找不到可用的題目列');
    return { quiz: { title: sanitizeText(defaultTitle, 80), questions: questions }, warnings: warnings };
  }

  function resultsToCSV(state) {
    const rows = [['名次', '名字', '分數', '答對', '答錯', '最長連對', '平均反應秒']];
    ranking(state).forEach(function (p, i) {
      const answered = p.correct + p.wrong;
      rows.push([
        i + 1, p.name, p.score, p.correct, p.wrong, p.best,
        answered ? Math.round((p.totalMs / answered) / 100) / 10 : '',
      ]);
    });
    return toCSV(rows);
  }

  /* ---------- misc ---------- */

  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    return m ? m + ':' + String(s % 60).padStart(2, '0') : String(s);
  }

  return {
    ALPHABET: ALPHABET,
    TOPIC_PREFIX: TOPIC_PREFIX,
    MAX_QUESTIONS: MAX_QUESTIONS,
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    MAX_IMAGE_CHARS: MAX_IMAGE_CHARS,
    QUIZ_HEADER: QUIZ_HEADER,
    clamp: clamp,
    makeCode: makeCode,
    normalizeCode: normalizeCode,
    makeId: makeId,
    topics: topics,
    sanitizeText: sanitizeText,
    isImageRef: isImageRef,
    normalizeQuestion: normalizeQuestion,
    normalizeQuiz: normalizeQuiz,
    emptyQuiz: emptyQuiz,
    validateQuiz: validateQuiz,
    scoreFor: scoreFor,
    emptyState: emptyState,
    newPlayer: newPlayer,
    findPlayer: findPlayer,
    addPlayer: addPlayer,
    removePlayer: removePlayer,
    beginQuestion: beginQuestion,
    startTimer: startTimer,
    applyAnswer: applyAnswer,
    reveal: reveal,
    ranking: ranking,
    publicState: publicState,
    parseCSV: parseCSV,
    toCSV: toCSV,
    quizToCSV: quizToCSV,
    csvToQuiz: csvToQuiz,
    resultsToCSV: resultsToCSV,
    fmtClock: fmtClock,
  };
});
