(function () {
  'use strict';

  const QUIZZES_KEY = 'qc.quizzes';

  function savedQuizzes() {
    const list = Net.load(QUIZZES_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function relative(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '剛剛';
    if (min < 60) return min + ' 分鐘前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小時前';
    const d = Math.floor(hr / 24);
    if (d < 30) return d + ' 日前';
    return new Date(ts).toLocaleDateString('zh-Hant');
  }

  function render() {
    const box = document.getElementById('quizList');
    if (!box) return;
    const list = savedQuizzes().sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
    box.innerHTML = '';

    if (!list.length) {
      const empty = Net.el('div', 'empty-note', '尚未有題庫。按上方按鈕開始建立第一份題目。');
      box.appendChild(empty);
      return;
    }

    list.forEach(function (quiz) {
      const row = Net.el('div', 'quiz-row');
      const meta = Net.el('div', 'meta');
      meta.appendChild(Net.el('div', 'nm', quiz.title || '未命名題目'));
      meta.appendChild(Net.el('div', 'sub', (quiz.questions || []).length + ' 題 · ' + relative(quiz.savedAt)));
      row.appendChild(meta);

      const edit = Net.el('a', 'btn small ghost', '編輯');
      edit.href = 'host.html?id=' + encodeURIComponent(quiz.id);
      row.appendChild(edit);

      const go = Net.el('a', 'btn small', '開房間');
      go.href = 'host.html?id=' + encodeURIComponent(quiz.id) + '&go=1';
      row.appendChild(go);

      const del = Net.el('button', 'icon-btn del', '✕');
      del.type = 'button';
      del.title = '刪除';
      del.addEventListener('click', function () {
        if (!confirm('刪除「' + (quiz.title || '未命名題目') + '」？')) return;
        Net.save(QUIZZES_KEY, savedQuizzes().filter(function (q) { return q.id !== quiz.id; }));
        render();
        Net.toast('已刪除');
      });
      row.appendChild(del);

      box.appendChild(row);
    });
  }

  function initJoin() {
    const form = document.getElementById('joinForm');
    const input = document.getElementById('code');
    const prefill = Net.param('code');
    if (prefill && input) input.value = QuizCore.normalizeCode(prefill);

    if (!form || !input) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const code = QuizCore.normalizeCode(input.value);
      if (code.length < 4) {
        Net.toast('請輸入房間碼');
        input.focus();
        return;
      }
      location.href = 'play.html?code=' + encodeURIComponent(code);
    });
    input.addEventListener('input', function () {
      input.value = QuizCore.normalizeCode(input.value);
    });
  }

  render();
  initJoin();
})();
