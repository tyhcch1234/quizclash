/* QuizClash host: quiz editor + live game controller (single source of truth). */
(function () {
  'use strict';

  const Q = QuizCore;
  const el = Net.el;
  const QUIZZES_KEY = 'qc.quizzes';
  const LABELS = ['A', 'B', 'C', 'D'];

  let quiz = Q.emptyQuiz();
  let quizId = null;

  let game = null; // { state, answerKey, quiz }
  let client = null;
  let code = '';
  let joinUrl = '';
  let publishThrottle = null;
  let publishQueued = false;
  let tickerId = null;
  let autoRevealId = null;
  let clockSkew = 0;

  /* =========================================================
     EDITOR
     ========================================================= */

  const $ = function (id) { return document.getElementById(id); };

  function showErrors(list, title) {
    const box = $('errors');
    if (!box) return;
    box.innerHTML = '';
    if (!list || !list.length) return;
    const wrap = el('div', 'err-box');
    const head = el('strong', null, title || '未能開始遊戲，請先修正：');
    wrap.appendChild(head);
    const ul = el('ul');
    list.slice(0, 12).forEach(function (msg) { ul.appendChild(el('li', null, msg)); });
    if (list.length > 12) ul.appendChild(el('li', null, '…還有 ' + (list.length - 12) + ' 項'));
    wrap.appendChild(ul);
    box.appendChild(wrap);
  }

  function note(text) {
    const box = $('errors');
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(el('div', 'ok-box', text));
  }

  function buildQuestionCard(q, i, total) {
    const card = el('div', 'qcard');
    card.dataset.i = String(i);

    const head = el('div', 'qcard-head');
    head.appendChild(el('span', 'qno', String(i + 1)));
    head.appendChild(el('span', 'opt-hint', '四選一 · 點選 A/B/C/D 圓標設定正確答案'));
    head.appendChild(el('span', 'spacer'));

    const up = el('button', 'icon-btn', '↑'); up.type = 'button'; up.dataset.act = 'up'; up.title = '上移';
    const down = el('button', 'icon-btn', '↓'); down.type = 'button'; down.dataset.act = 'down'; down.title = '下移';
    const del = el('button', 'icon-btn del', '✕'); del.type = 'button'; del.dataset.act = 'del'; del.title = '刪除這題';
    if (i === 0) up.disabled = true;
    if (i === total - 1) down.disabled = true;
    head.appendChild(up); head.appendChild(down); head.appendChild(del);
    card.appendChild(head);

    const ta = el('textarea', 'q-text');
    ta.rows = 2;
    ta.maxLength = 300;
    ta.placeholder = '題目文字，例如：以下哪一個是 2x + 4 的因式分解？';
    ta.value = q.text;
    card.appendChild(ta);

    const opts = el('div', 'opts');
    for (let c = 0; c < 4; c++) {
      const row = el('div', 'opt-row');
      row.dataset.c = String(c);
      if (q.correct === c) row.classList.add('is-correct');
      const tag = el('button', 'opt-tag', LABELS[c]);
      tag.type = 'button';
      tag.dataset.act = 'correct';
      tag.title = '設為正確答案';
      const input = el('input', 'opt-input');
      input.type = 'text';
      input.maxLength = 120;
      input.placeholder = '選項 ' + LABELS[c];
      input.value = q.options[c] || '';
      row.appendChild(tag); row.appendChild(input);
      opts.appendChild(row);
    }
    card.appendChild(opts);

    const foot = el('div', 'qfoot');
    const limitLabel = el('label');
    limitLabel.appendChild(document.createTextNode('時限 '));
    const limitInput = el('input', 'q-limit');
    limitInput.type = 'number';
    limitInput.min = '5'; limitInput.max = '120'; limitInput.step = '5';
    limitInput.value = String(q.limit || Q.DEFAULT_LIMIT);
    limitLabel.appendChild(limitInput);
    limitLabel.appendChild(document.createTextNode(' 秒'));
    foot.appendChild(limitLabel);

    const imgLabel = el('label');
    imgLabel.style.cursor = 'pointer';
    const file = el('input', 'q-file');
    file.type = 'file'; file.accept = 'image/*'; file.hidden = true;
    imgLabel.appendChild(file);
    imgLabel.appendChild(document.createTextNode('＋ 加入圖片'));
    foot.appendChild(imgLabel);

    const imgDel = el('button', 'icon-btn', '🖼✕');
    imgDel.type = 'button';
    imgDel.dataset.act = 'imgdel';
    imgDel.title = '移除圖片';
    if (!q.image) imgDel.style.display = 'none';
    foot.appendChild(imgDel);
    card.appendChild(foot);

    if (q.image) {
      const img = el('img', 'thumb');
      img.src = q.image;
      img.alt = '題目圖片';
      card.appendChild(img);
    }
    return card;
  }

  function renderEditor() {
    const box = $('qlist');
    if (!box) return;
    box.innerHTML = '';
    quiz.questions.forEach(function (q, i) {
      box.appendChild(buildQuestionCard(q, i, quiz.questions.length));
    });
  }

  function updateCorrectMark(qi) {
    const card = document.querySelector('#qlist .qcard[data-i="' + qi + '"]');
    if (!card) return;
    const target = quiz.questions[qi].correct;
    card.querySelectorAll('.opt-row').forEach(function (row) {
      row.classList.toggle('is-correct', Number(row.dataset.c) === target);
    });
  }

  function bindEditor() {
    const list = $('qlist');
    if (!list) return;

    list.addEventListener('input', function (e) {
      const card = e.target.closest('.qcard');
      if (!card) return;
      const i = Number(card.dataset.i);
      const q = quiz.questions[i];
      if (!q) return;
      if (e.target.classList.contains('q-text')) q.text = e.target.value;
      else if (e.target.classList.contains('opt-input')) {
        q.options[Number(e.target.closest('.opt-row').dataset.c)] = e.target.value;
      } else if (e.target.classList.contains('q-limit')) {
        q.limit = Q.clamp(parseInt(e.target.value, 10) || Q.DEFAULT_LIMIT, 5, 120);
      }
    });

    list.addEventListener('change', function (e) {
      if (!e.target.classList.contains('q-file')) return;
      const card = e.target.closest('.qcard');
      const i = Number(card.dataset.i);
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 12 * 1024 * 1024) { Net.toast('圖片太大（上限 12MB）'); return; }
      Net.compressImage(file, 900, 0.72).then(function (dataUrl) {
        if (dataUrl.length > Q.MAX_IMAGE_CHARS) { Net.toast('壓縮後仍然過大，請改用較小圖片'); return; }
        quiz.questions[i].image = dataUrl;
        renderEditor();
        Net.toast('已加入圖片');
      }).catch(function (err) { Net.toast(err.message || '圖片處理失敗'); });
    });

    list.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const card = e.target.closest('.qcard');
      const i = Number(card.dataset.i);
      const act = btn.dataset.act;
      if (act === 'correct') {
        quiz.questions[i].correct = Number(btn.closest('.opt-row').dataset.c);
        updateCorrectMark(i);
      } else if (act === 'del') {
        if (quiz.questions.length === 1) { Net.toast('至少要保留一條題目'); return; }
        quiz.questions.splice(i, 1);
        renderEditor();
      } else if (act === 'up' && i > 0) {
        const tmp = quiz.questions[i - 1];
        quiz.questions[i - 1] = quiz.questions[i];
        quiz.questions[i] = tmp;
        renderEditor();
      } else if (act === 'down' && i < quiz.questions.length - 1) {
        const tmp = quiz.questions[i + 1];
        quiz.questions[i + 1] = quiz.questions[i];
        quiz.questions[i] = tmp;
        renderEditor();
      } else if (act === 'imgdel') {
        quiz.questions[i].image = '';
        renderEditor();
      }
    });

    $('btnAdd').addEventListener('click', function () {
      if (quiz.questions.length >= Q.MAX_QUESTIONS) { Net.toast('已達 ' + Q.MAX_QUESTIONS + ' 題上限'); return; }
      quiz.questions.push(Q.normalizeQuestion({ options: ['', '', '', ''], correct: 0, limit: Q.DEFAULT_LIMIT }));
      renderEditor();
      const cards = document.querySelectorAll('#qlist .qcard');
      const last = cards[cards.length - 1];
      if (last && last.scrollIntoView) last.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    $('btnDemo').addEventListener('click', function () {
      if (!confirm('載入示範題目會取代目前的題目，繼續？')) return;
      quiz = Q.normalizeQuiz({
        title: '示範題目 · 熱身 3 題',
        questions: [
          { text: '以下哪一個是 2x + 4 的因式分解？', options: ['2(x + 2)', '2(x + 4)', 'x(2 + 4)', '2x(x + 2)'], correct: 0, limit: 20 },
          { text: '香港特別行政區成立於哪一年？', options: ['1995 年', '1997 年', '1999 年', '2000 年'], correct: 1, limit: 20 },
          { text: '一個三角形內角之和是多少度？', options: ['90°', '180°', '270°', '360°'], correct: 1, limit: 15 },
        ],
      });
      $('quizTitle').value = quiz.title;
      renderEditor();
      Net.toast('已載入 3 條示範題目');
    });

    $('btnSave').addEventListener('click', function () { saveQuiz(); Net.toast('已儲存到題庫'); });

    const fileInput = $('csvFile');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = function () { importCSV(String(reader.result)); fileInput.value = ''; };
        reader.onerror = function () { Net.toast('讀取 CSV 失敗'); };
        reader.readAsText(f, 'utf-8');
      });
    }
    const importBtn = $('btnImportText');
    if (importBtn) {
      importBtn.addEventListener('click', function () {
        const txt = $('csvText').value;
        if (!txt.trim()) { Net.toast('請先貼上 CSV 內容'); return; }
        importCSV(txt);
      });
    }
    const exportBtn = $('btnExportQuiz');
    if (exportBtn) {
      exportBtn.addEventListener('click', function () {
        const name = (($('quizTitle').value || 'quizclash').trim().slice(0, 40) || 'quizclash').replace(/[\\/:*?"<>|]/g, '-');
        Net.download(name + '.csv', Q.quizToCSV(collectQuiz()));
        Net.toast('已匯出題目 CSV');
      });
    }

    $('quizTitle').addEventListener('input', function (e) { quiz.title = e.target.value; });
  }

  function importCSV(text) {
    try {
      const res = Q.csvToQuiz(text, $('quizTitle').value);
      quiz.questions = res.quiz.questions;
      renderEditor();
      const msg = '已匯入 ' + quiz.questions.length + ' 條題目';
      if (res.warnings.length) showErrors(res.warnings, msg + '，但有 ' + res.warnings.length + ' 項提醒：');
      else note(msg);
    } catch (err) {
      Net.toast(err.message || 'CSV 格式有誤');
    }
  }

  /** Read the live DOM back into the model (safety net for values typed but not yet fired). */
  function collectQuiz() {
    const cards = document.querySelectorAll('#qlist .qcard');
    cards.forEach(function (card) {
      const i = Number(card.dataset.i);
      const q = quiz.questions[i];
      if (!q) return;
      const ta = card.querySelector('.q-text');
      if (ta) q.text = ta.value;
      card.querySelectorAll('.opt-row').forEach(function (row) {
        const input = row.querySelector('.opt-input');
        if (input) q.options[Number(row.dataset.c)] = input.value;
      });
      const lim = card.querySelector('.q-limit');
      if (lim) q.limit = Q.clamp(parseInt(lim.value, 10) || Q.DEFAULT_LIMIT, 5, 120);
    });
    quiz.title = $('quizTitle').value;
    return { title: quiz.title, questions: quiz.questions.map(Q.normalizeQuestion) };
  }

  function saveQuiz() {
    const data = collectQuiz();
    const list = Net.load(QUIZZES_KEY, []);
    const arr = Array.isArray(list) ? list : [];
    if (!quizId) quizId = Q.makeId('q');
    const record = { id: quizId, title: data.title || '', questions: data.questions, savedAt: Date.now() };
    const idx = arr.findIndex(function (x) { return x.id === quizId; });
    if (idx >= 0) arr[idx] = record; else arr.unshift(record);
    Net.save(QUIZZES_KEY, arr.slice(0, 60));
  }

  function loadQuizFromStore(id) {
    const arr = Net.load(QUIZZES_KEY, []);
    const found = (Array.isArray(arr) ? arr : []).find(function (x) { return x.id === id; });
    if (!found) return false;
    quiz = Q.normalizeQuiz(found);
    quizId = found.id;
    $('quizTitle').value = quiz.title;
    renderEditor();
    return true;
  }

  /* =========================================================
     LIVE GAME
     ========================================================= */

  function joinUrlFor(c) {
    const u = new URL('play.html', location.href);
    u.search = '?code=' + encodeURIComponent(c);
    u.hash = '';
    return u.href;
  }

  function topics() { return Q.topics(code); }

  function publishState(force) {
    if (!client || !client.connected || !game) return;
    if (!force && publishThrottle) { publishQueued = true; return; }
    const payload = JSON.stringify(Q.publicState(game.state, Date.now()));
    client.publish(topics().state, payload, { qos: 1, retain: true });
    if (!force) {
      publishThrottle = setTimeout(function () {
        publishThrottle = null;
        if (publishQueued) { publishQueued = false; publishState(true); }
      }, 90);
    }
    persistSession();
  }

  function publishQuestion(q, index) {
    if (!client || !client.connected) return;
    const payload = JSON.stringify({
      i: index,
      text: q.text,
      image: q.image || '',
      options: q.options,
      limit: q.limit,
    });
    client.publish(topics().q, payload, { qos: 1, retain: true });
  }

  function persistSession() {
    if (!game || !code) return;
    Net.save('qc.session.' + code, {
      quiz: game.quiz,
      players: game.state.players,
      qi: game.state.qi,
      title: game.state.title,
      savedAt: Date.now(),
    });
  }

  function connect() {
    if (client) { try { client.end(true); } catch (e) {} }
    client = Net.createClient('host');
    Net.setStatus($('status'), null, '連線中…');

    client.on('connect', function () {
      Net.setStatus($('status'), 'live', '已連線');
      client.subscribe(topics().ev, { qos: 1 });
      publishState(true);
    });
    client.on('reconnect', function () { Net.setStatus($('status'), null, '重新連線中…'); });
    client.on('close', function () { Net.setStatus($('status'), 'off', '連線中斷'); });
    client.on('error', function (err) {
      Net.setStatus($('status'), 'off', '連線錯誤');
      console.warn('[quizclash] mqtt error', err && err.message);
    });
    client.on('message', function (topic, payload) {
      if (topic !== topics().ev || !game) return;
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
      handleEvent(msg);
    });
  }

  function handleEvent(msg) {
    if (!msg || !msg.pid) return;
    const pid = String(msg.pid).slice(0, 32);

    if (msg.t === 'join') {
      const p = Q.addPlayer(game.state, pid, msg.name);
      if (p) {
        publishState();
        renderLive();
        if (game.state.phase === 'lobby') Net.toast(p.name + ' 加入了');
      }
      return;
    }

    if (msg.t === 'ans') {
      const res = Q.applyAnswer(game.state, game.answerKey, pid, msg.c, Date.now());
      if (res.ok) {
        publishState();
        updateAnswered();
      }
      return;
    }

    if (msg.t === 'bye') {
      if (Q.removePlayer(game.state, pid)) publishState();
    }
  }

  function startGame() {
    const data = collectQuiz();
    const errors = Q.validateQuiz(data);
    if (errors.length) {
      showErrors(errors);
      Net.toast('尚有 ' + errors.length + ' 項需要修正');
      return;
    }
    showErrors([]);

    const title = (data.title || '').trim() || 'QuizClash 遊戲';
    code = Q.makeCode(6);
    joinUrl = joinUrlFor(code);

    game = {
      quiz: { title: title, questions: data.questions },
      answerKey: data.questions[0].correct,
      state: Q.emptyState(code),
    };
    game.state.title = title;
    game.state.total = data.questions.length;
    game.state.sortMode = 'score';

    // restore players if the host page was reloaded mid-session
    const saved = Net.load('qc.session.' + code, null);

    $('viewEditor').classList.add('hidden');
    $('viewLive').classList.remove('hidden');
    $('modeTag').textContent = '主持中';
    $('codeText').textContent = code;
    $('joinUrl').textContent = joinUrl.replace(/^https?:\/\//, '');
    $('lobbyUrl').textContent = joinUrl.replace(/^https?:\/\//, '');
    Net.renderQR($('qr'), joinUrl);
    history.replaceState(null, '', '#' + code);

    renderLive();
    connect();
    if (saved && saved.players) console.info('[quizclash] session snapshot found for', code);
  }

  function startQuestion(index) {
    if (!game) return;
    const q = game.quiz.questions[index];
    if (!q) return;
    game.answerKey = q.correct;
    Q.beginQuestion(game.state, index);
    Q.startTimer(game.state, Date.now(), q.limit);
    publishQuestion(q, index);
    publishState(true);
    renderLive();

    clearTimeout(autoRevealId);
    autoRevealId = setTimeout(revealNow, game.state.limitSec * 1000 + 700);
    startTicker();
  }

  function revealNow() {
    if (!game || game.state.phase !== 'question') return;
    clearTimeout(autoRevealId);
    stopTicker();
    Q.reveal(game.state, game.answerKey);
    publishState(true);
    renderLive();
  }

  function nextQuestion() {
    if (!game) return;
    const next = game.state.qi + 1;
    if (next >= game.quiz.questions.length) { endGame(); return; }
    startQuestion(next);
  }

  function endGame() {
    if (!game) return;
    clearTimeout(autoRevealId);
    stopTicker();
    game.state.phase = 'end';
    publishState(true);
    if (client && client.connected) {
      client.publish(topics().q, JSON.stringify({ i: -1 }), { qos: 1, retain: true });
    }
    renderLive();
  }

  function restartGame() {
    if (!game) return;
    const keepNames = game.state.players.map(function (p) { return { id: p.id, name: p.name }; });
    game.state = Q.emptyState(code);
    game.state.title = game.quiz.title;
    game.state.total = game.quiz.questions.length;
    game.state.sortMode = 'score';
    keepNames.forEach(function (p) { Q.addPlayer(game.state, p.id, p.name); });
    game.state.phase = 'lobby';
    publishState(true);
    publishQuestion({ text: '', image: '', options: [], limit: Q.DEFAULT_LIMIT }, -1);
    renderLive();
  }

  /* ---------- rendering ---------- */

  function renderLive() {
    if (!game) return;
    const s = game.state;
    const L = {
      lobby: '等待玩家加入', question: '作答中', reveal: '答案揭曉', end: '最終結果',
    };
    $('phaseLabel').textContent = L[s.phase] || '';
    $('progressPill').textContent = (s.phase === 'lobby' ? 0 : Math.max(0, s.qi + 1)) + ' / ' + s.total;
    $('btnSort').textContent = '排名：' + (s.sortMode === 'correct' ? '答對最多' : '最高分');

    ['lobbyView', 'qView', 'revealView', 'endView'].forEach(function (id) {
      const node = $(id);
      if (node) node.classList.add('hidden');
    });

    if (s.phase === 'lobby') {
      $('lobbyView').classList.remove('hidden');
      renderLobby();
    } else if (s.phase === 'question') {
      $('qView').classList.remove('hidden');
      renderQuestion();
    } else if (s.phase === 'reveal') {
      $('revealView').classList.remove('hidden');
      renderReveal();
    } else {
      $('endView').classList.remove('hidden');
      renderFinal();
    }
    $('playerCount').textContent = String(s.players.length);
    updateAnswered();
  }

  function renderLobby() {
    const box = $('chips');
    if (!box) return;
    box.innerHTML = '';
    if (!game.state.players.length) {
      box.appendChild(el('div', 'empty-note', '尚未有玩家加入 — 讓學生掃描 QR code 或輸入房間碼。'));
      return;
    }
    game.state.players.forEach(function (p) {
      box.appendChild(el('span', 'chip', p.name));
    });
  }

  function tilesInto(container, options, correctIndex, counts) {
    container.innerHTML = '';
    for (let c = 0; c < 4; c++) {
      const tile = el('div', 'tile');
      tile.dataset.c = String(c);
      tile.appendChild(el('span', 'shape'));
      tile.appendChild(el('span', 'label', options[c] || LABELS[c]));
      if (correctIndex != null) tile.classList.toggle('correct', c === correctIndex);
      if (counts) {
        const n = counts[c] || 0;
        tile.appendChild(el('span', 'badge', String(n)));
      }
      container.appendChild(tile);
    }
  }

  function renderQuestion() {
    const q = game.quiz.questions[game.state.qi];
    $('qText').textContent = q.text;
    const img = $('qImage');
    if (q.image) { img.src = q.image; img.classList.remove('hidden'); }
    else { img.removeAttribute('src'); img.classList.add('hidden'); }
    tilesInto($('tiles'), q.options, null, null);
    updateTimer();
  }

  function renderReveal() {
    const q = game.quiz.questions[game.state.qi];
    $('qTextReveal').textContent = q.text;
    tilesInto($('tilesReveal'), q.options, game.state.correct, game.state.counts);

    const box = $('counts');
    box.innerHTML = '';
    const max = Math.max(1, Math.max.apply(null, game.state.counts || [0, 0, 0, 0]));
    for (let c = 0; c < 4; c++) {
      const row = el('div', 'count-row');
      row.dataset.c = String(c);
      if (c === game.state.correct) row.classList.add('answer');
      row.appendChild(el('span', 'tag', LABELS[c]));
      const bar = el('span', 'bar');
      const fill = el('i');
      fill.style.width = Math.round(((game.state.counts[c] || 0) / max) * 100) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el('span', 'num', String(game.state.counts[c] || 0) + ' 人'));
      box.appendChild(row);
    }
    renderMiniBoard();
  }

  function boardRows(state, limit, highlightId) {
    const frag = document.createDocumentFragment();
    const list = Q.ranking(state).slice(0, limit || 999);
    list.forEach(function (p, i) {
      const row = el('div', 'board-row');
      if (i === 0) row.classList.add('top1');
      else if (i === 1) row.classList.add('top2');
      else if (i === 2) row.classList.add('top3');
      row.appendChild(el('span', 'rk', '#' + (i + 1)));
      row.appendChild(el('span', 'nm', p.name));
      row.appendChild(el('span', 'sc', String(p.score)));
      row.appendChild(el('span', 'cr', '答對 ' + p.correct + ' · 連對 ' + p.best));
      frag.appendChild(row);
    });
    return frag;
  }

  function renderMiniBoard() {
    const box = $('miniBoard');
    if (!box) return;
    box.innerHTML = '';
    if (!game.state.players.length) return;
    const cap = el('div', 'stat-lbl', '目前領先（' + (game.state.sortMode === 'correct' ? '答對最多' : '最高分') + '）');
    box.appendChild(cap);
    box.appendChild(boardRows(game.state, 5));
  }

  function renderFinal() {
    const state = game.state;
    const top = Q.ranking(state).slice(0, 3);
    const box = $('podium');
    box.innerHTML = '';
    const order = [1, 0, 2];
    order.forEach(function (slot) {
      const p = top[slot];
      const pod = el('div', 'pod' + (slot === 0 ? ' p1' : ''));
      pod.appendChild(el('div', 'medal', slot === 0 ? '👑' : slot === 1 ? '🥈' : '🥉'));
      pod.appendChild(el('div', 'who', p ? p.name : '—'));
      pod.appendChild(el('div', 'pts', p ? String(p.score) : ''));
      pod.appendChild(el('div', 'stat-lbl', p ? '答對 ' + p.correct + ' 題' : ''));
      box.appendChild(pod);
    });
    const board = $('board');
    board.innerHTML = '';
    if (!state.players.length) {
      board.appendChild(el('div', 'empty-note', '沒有人參與這一場。'));
      return;
    }
    board.appendChild(boardRows(state, 999));
  }

  /* ---------- timer ---------- */

  function startTicker() {
    stopTicker();
    const loop = function () {
      updateTimer();
      if (game && game.state.phase === 'question') tickerId = requestAnimationFrame(loop);
    };
    tickerId = requestAnimationFrame(loop);
  }

  function stopTicker() {
    if (tickerId) cancelAnimationFrame(tickerId);
    tickerId = null;
  }

  function updateTimer() {
    if (!game || game.state.phase !== 'question') return;
    const total = game.state.limitSec * 1000;
    const left = Math.max(0, game.state.endsAt - (Date.now() - clockSkew));
    const pct = Math.max(0, Math.min(100, (left / total) * 100));
    const bar = $('timerBar');
    const fill = $('timerFill');
    if (fill) fill.style.width = pct + '%';
    if (bar) bar.classList.toggle('low', left < total * 0.3);
    const sec = $('timerSec');
    if (sec) sec.textContent = (left / 1000).toFixed(1) + 's';
  }

  function updateAnswered() {
    if (!game) return;
    const n = game.state.players.filter(function (p) { return p.lastChoice != null; }).length;
    const node = $('answeredCount');
    if (node) node.textContent = String(n);
  }

  /* ---------- controls ---------- */

  function bindLive() {
    const startBtn = $('btnStart');
    if (startBtn) startBtn.addEventListener('click', startGame);

    $('btnBegin').addEventListener('click', function () {
      if (!game) return;
      if (!game.state.players.length && !confirm('目前沒有玩家加入，仍要開始嗎？（可以先測試流程）')) return;
      startQuestion(0);
    });

    $('btnReveal').addEventListener('click', revealNow);
    $('btnNext').addEventListener('click', nextQuestion);

    $('btnSort').addEventListener('click', function () {
      if (!game) return;
      game.state.sortMode = game.state.sortMode === 'score' ? 'correct' : 'score';
      publishState(true);
      renderLive();
    });

    $('btnRestart').addEventListener('click', function () {
      if (!game) return;
      if (!confirm('重新開始會清除所有玩家分數（名單保留），確定？')) return;
      restartGame();
      Net.toast('已重新開始');
    });

    $('btnPlayAgain').addEventListener('click', function () {
      restartGame();
      startQuestion(0);
    });

    $('btnEditBack').addEventListener('click', backToEditor);
    $('btnBack').addEventListener('click', function () {
      if (game && !confirm('離開主持畫面？玩家會斷線。')) return;
      location.href = 'index.html';
    });

    $('btnCopyLink').addEventListener('click', function () { Net.copy(joinUrl); });

    $('btnExportResults').addEventListener('click', function () {
      if (!game) return;
      Net.download('quizclash-' + code + '.csv', Q.resultsToCSV(game.state));
      Net.toast('已匯出成績 CSV');
    });

    $('btnFull').addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    });
  }

  function backToEditor() {
    if (client) { try { client.end(true); } catch (e) {} client = null; }
    clearTimeout(autoRevealId);
    stopTicker();
    game = null;
    $('viewLive').classList.add('hidden');
    $('viewEditor').classList.remove('hidden');
    $('modeTag').textContent = '出題';
    Net.setStatus($('status'), 'off', '未連線');
    history.replaceState(null, '', location.pathname + location.search);
  }

  /* ---------- boot ---------- */

  function boot() {
    const id = Net.param('id');
    if (id) loadQuizFromStore(id);
    else renderEditor();
    bindEditor();
    bindLive();

    if (quiz.title) $('quizTitle').value = quiz.title;

    // resume a session after an accidental reload: host.html#CODE
    const hash = (location.hash || '').replace('#', '');
    const snapshot = hash ? Net.load('qc.session.' + Q.normalizeCode(hash), null) : null;
    if (snapshot && snapshot.quiz) {
      quiz = Q.normalizeQuiz(snapshot.quiz);
      $('quizTitle').value = quiz.title;
      renderEditor();
      code = Q.normalizeCode(hash);
      joinUrl = joinUrlFor(code);
      game = { quiz: quiz, answerKey: quiz.questions[0].correct, state: Q.emptyState(code) };
      game.state.title = quiz.title || 'QuizClash 遊戲';
      game.state.total = quiz.questions.length;
      (snapshot.players || []).forEach(function (p) {
        const np = Q.addPlayer(game.state, p.id, p.name);
        if (np) { np.score = p.score || 0; np.correct = p.correct || 0; np.wrong = p.wrong || 0; np.best = p.best || 0; }
      });
      $('viewEditor').classList.add('hidden');
      $('viewLive').classList.remove('hidden');
      $('modeTag').textContent = '主持中';
      $('codeText').textContent = code;
      $('joinUrl').textContent = joinUrl.replace(/^https?:\/\//, '');
      $('lobbyUrl').textContent = joinUrl.replace(/^https?:\/\//, '');
      Net.renderQR($('qr'), joinUrl);
      renderLive();
      connect();
      Net.toast('已恢復上一場的房間與名單');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
