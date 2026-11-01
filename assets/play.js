/* QuizClash player: joins a room, answers, shows live score. Never owns state. */
(function () {
  'use strict';

  const Q = QuizCore;
  const el = Net.el;
  const LABELS = ['A', 'B', 'C', 'D'];

  let code = '';
  let pid = '';
  let name = '';
  let client = null;
  let state = null;
  let question = null;
  let myChoice = null;
  let clockOffset = 0;
  let ticker = null;
  let joinTimer = null;
  let joinAttempts = 0;
  let connected = false;

  const $ = function (id) { return document.getElementById(id); };

  function setConnected(ok, text) {
    connected = ok;
    Net.setStatus($('status'), ok ? 'live' : 'off', text || (ok ? '已連線' : '未連線'));
  }

  function topics() { return Q.topics(code); }

  function send(obj) {
    if (!client || !client.connected) return false;
    client.publish(topics().ev, JSON.stringify(obj), { qos: 0 });
    return true;
  }

  function sendJoin() {
    if (!pid) return;
    send({ t: 'join', pid: pid, name: name });
  }

  /* ---------- connection ---------- */

  function connect() {
    if (client) { try { client.end(true); } catch (e) {} }
    client = Net.createClient('play');
    setConnected(false, '連線中…');

    client.on('connect', function () {
      setConnected(true);
      client.subscribe(topics().state, { qos: 1 });
      client.subscribe(topics().q, { qos: 1 });
      sendJoin();
      startJoinLoop();
    });

    client.on('reconnect', function () { setConnected(false, '重新連線中…'); });
    client.on('close', function () { setConnected(false, '已斷線'); });
    client.on('error', function (err) {
      setConnected(false, '連線錯誤');
      console.warn('[quizclash] mqtt error', err && err.message);
    });

    client.on('message', function (topic, payload) {
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
      if (topic === topics().state) onState(msg);
      else if (topic === topics().q) onQuestion(msg);
    });
  }

  function startJoinLoop() {
    clearInterval(joinTimer);
    joinAttempts = 0;
    joinTimer = setInterval(function () {
      joinAttempts += 1;
      if (state && state.phase) { clearInterval(joinTimer); joinTimer = null; return; }
      if (joinAttempts > 12) {
        clearInterval(joinTimer);
        joinTimer = null;
        if (!state) $('joinMsg').innerHTML = '找不到這場遊戲，請確認房間碼是否正確，或請主持人重新開始。';
        return;
      }
      sendJoin();
    }, 2000);
  }

  /* ---------- incoming ---------- */

  function onState(next) {
    const prevQi = state ? state.qi : null;
    const prevPhase = state ? state.phase : null;
    state = next;
    if (typeof state.now === 'number' && state.now > 0) {
      clockOffset = state.now - Date.now();
    }
    if (state.qi !== prevQi) myChoice = null;

    // make sure the host knows about us
    if (!Q.findPlayer(state, pid) && joinAttempts < 30) {
      joinAttempts += 1;
      sendJoin();
    }
    if (state.phase !== prevPhase || state.qi !== prevQi) {
      if (state.phase === 'question') hideAll();
      if (state.phase === 'end') Net.toast('遊戲結束');
    }
    render();
  }

  function onQuestion(q) {
    question = q && typeof q === 'object' ? q : null;
    render();
  }

  /* ---------- rendering ---------- */

  function hideAll() {
    ['joinView', 'waitView', 'questionView', 'answerView', 'resultView', 'endView'].forEach(function (id) {
      const n = $(id);
      if (n) n.classList.add('hidden');
    });
  }

  function show(id) {
    const n = $(id);
    if (n) n.classList.remove('hidden');
  }

  function render() {
    if (!$('gameView')) return;
    $('joinView').classList.add('hidden');
    $('gameView').classList.remove('hidden');

    const me = state ? Q.findPlayer(state, pid) : null;
    if (me) {
      $('myScore').textContent = String(me.score);
      $('myCorrect').textContent = '答對 ' + me.correct + ' 題';
    }
    $('codePill').textContent = '房間 ' + code;

    if (!state) {
      hideAll(); show('waitView');
      $('waitText').textContent = connected ? '等待主持人開始…' : '連線中…';
      return;
    }

    if (state.phase === 'lobby') {
      hideAll(); show('waitView');
      $('waitText').textContent = '已加入！等待主持人開始（' + state.players.length + ' 人在線）';
      stopTicker();
      return;
    }

    if (state.phase === 'question') {
      const q = question && question.i === state.qi ? question : null;
      if (!q) {
        hideAll(); show('waitView');
        $('waitText').textContent = '載入題目中…';
        return;
      }
      if (myChoice != null) {
        hideAll(); show('answerView');
        const pick = q.options[myChoice] || LABELS[myChoice];
        $('ansBig').textContent = '已鎖定：' + LABELS[myChoice];
        $('ansSub').textContent = pick + ' · 等其他人作答…';
        stopTicker();
        return;
      }
      const left = state.endsAt - (Date.now() + clockOffset);
      if (left <= 0) {
        hideAll(); show('answerView');
        $('ansBig').textContent = '時間到';
        $('ansSub').textContent = '這一題沒有作答';
        return;
      }
      hideAll(); show('questionView');
      renderQuestion(q);
      startTicker();
      return;
    }

    if (state.phase === 'reveal') {
      stopTicker();
      hideAll(); show('resultView');
      renderResult();
      return;
    }

    if (state.phase === 'end') {
      stopTicker();
      hideAll(); show('endView');
      renderEnd();
    }
  }

  function renderQuestion(q) {
    $('qNo').textContent = String(state.qi + 1);
    $('qTotal').textContent = String(state.total);
    $('pText').textContent = q.text || '';
    const img = $('pImage');
    if (q.image) { img.src = q.image; img.classList.remove('hidden'); }
    else { img.removeAttribute('src'); img.classList.add('hidden'); }

    const box = $('answers');
    box.innerHTML = '';
    for (let c = 0; c < 4; c++) {
      const btn = el('button', 'pbtn');
      btn.type = 'button';
      btn.dataset.c = String(c);
      btn.appendChild(el('span', 'shape'));
      btn.appendChild(el('span', 'txt', q.options[c] || LABELS[c]));
      btn.appendChild(el('span', 'key', String(c + 1)));
      btn.addEventListener('click', function () { answer(c); });
      box.appendChild(btn);
    }
    updateTimer();
  }

  function renderResult() {
    const q = question && question.i === state.qi ? question : null;
    const box = $('fbBox');
    const correctIndex = state.correct;
    const isRight = myChoice != null && correctIndex != null && myChoice === correctIndex;
    const me = Q.findPlayer(state, pid);

    box.className = 'feedback ' + (myChoice == null ? 'wait' : isRight ? 'good' : 'bad');
    if (myChoice == null) {
      $('fbBig').textContent = '沒有作答';
      $('fbSub').textContent = '正確答案：' + LABELS[correctIndex] + ' · ' + ((q && q.options[correctIndex]) || '');
      $('fbGain').textContent = '';
    } else if (isRight) {
      $('fbBig').textContent = '答對了！';
      $('fbSub').textContent = '正確答案：' + LABELS[correctIndex] + ' · ' + ((q && q.options[correctIndex]) || '');
      $('fbGain').textContent = me && me.lastGained ? '+' + me.lastGained + ' 分' : '';
    } else {
      $('fbBig').textContent = '答錯了';
      $('fbSub').textContent = '你選了 ' + LABELS[myChoice] + '，正確答案是 ' + LABELS[correctIndex] + ' · ' + ((q && q.options[correctIndex]) || '');
      $('fbGain').textContent = '';
    }
  }

  function renderEnd() {
    const list = Q.ranking(state);
    const mine = list.findIndex(function (p) { return p.id === pid; });
    const me = mine >= 0 ? list[mine] : null;
    const mode = state.sortMode === 'correct' ? '答對最多' : '最高分';
    $('endBig').textContent = mine === 0 ? '🏆 冠軍！' : '遊戲結束';
    $('endSub').textContent = me
      ? '名次 #' + (mine + 1) + '／' + list.length + '（按' + mode + '）· ' + me.score + ' 分 · 答對 ' + me.correct + ' 題'
      : '按' + mode + '排名';

    const board = $('pBoard');
    board.innerHTML = '';
    list.slice(0, 5).forEach(function (p, i) {
      const row = el('div', 'board-row' + (i === 0 ? ' top1' : ''));
      if (p.id === pid) row.classList.add('me');
      row.appendChild(el('span', 'rk', '#' + (i + 1)));
      row.appendChild(el('span', 'nm', p.name + (p.id === pid ? '（你）' : '')));
      row.appendChild(el('span', 'sc', String(p.score)));
      row.appendChild(el('span', 'cr', '答對 ' + p.correct));
      board.appendChild(row);
    });
  }

  /* ---------- actions ---------- */

  function answer(choice) {
    if (myChoice != null || !state || state.phase !== 'question') return;
    myChoice = choice;
    send({ t: 'ans', pid: pid, c: choice });
    document.querySelectorAll('.pbtn').forEach(function (b) {
      b.disabled = true;
      b.classList.toggle('chosen', Number(b.dataset.c) === choice);
      b.classList.toggle('dim', Number(b.dataset.c) !== choice);
    });
    render();
  }

  function startTicker() {
    stopTicker();
    const loop = function () {
      if (!state || state.phase !== 'question' || myChoice != null) { stopTicker(); return; }
      updateTimer();
      ticker = requestAnimationFrame(loop);
    };
    ticker = requestAnimationFrame(loop);
  }

  function stopTicker() {
    if (ticker) cancelAnimationFrame(ticker);
    ticker = null;
  }

  function updateTimer() {
    const total = (state.limitSec || Q.DEFAULT_LIMIT) * 1000;
    const left = Math.max(0, state.endsAt - (Date.now() + clockOffset));
    const pct = Math.max(0, Math.min(100, (left / total) * 100));
    const fill = $('pFill');
    if (fill) fill.style.width = pct + '%';
    const bar = $('pBar');
    if (bar) bar.classList.toggle('low', left < total * 0.3);
    const sec = $('pTimer');
    if (sec) sec.textContent = (left / 1000).toFixed(1) + 's';
    if (left <= 0 && state.phase === 'question') render();
  }

  /* ---------- boot ---------- */

  function boot() {
    code = Q.normalizeCode(Net.param('code'));
    if (!code || code.length < 4) {
      location.replace('index.html');
      return;
    }
    $('joinCode').textContent = code;
    $('codePill').textContent = '房間 ' + code;

    pid = localStorage.getItem('qc.pid.' + code) || Q.makeId('p');
    localStorage.setItem('qc.pid.' + code, pid);
    const savedName = localStorage.getItem('qc.name') || '';
    if (savedName) $('nameInput').value = savedName;

    $('nameForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const value = Q.sanitizeText($('nameInput').value, 16);
      if (!value) { Net.toast('請輸入名字'); return; }
      name = value;
      localStorage.setItem('qc.name', name);
      joinAndPlay();
    });

    // keyboard shortcuts 1-4
    document.addEventListener('keydown', function (e) {
      if (state && state.phase === 'question' && myChoice == null && /^[1-4]$/.test(e.key)) {
        answer(Number(e.key) - 1);
      }
    });
  }

  function joinAndPlay() {
    $('joinView').classList.add('hidden');
    $('gameView').classList.remove('hidden');
    hideAll();
    show('waitView');
    $('waitText').textContent = '正在加入房間…';
    connect();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
