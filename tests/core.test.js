/* QuizClash core tests — node tests/core.test.js */
const assert = require('assert');
const Q = require('../assets/core.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('FAIL  ' + name + '\n      ' + err.message);
    process.exitCode = 1;
  }
}

console.log('QuizClash core');

test('room code is 6 chars from the safe alphabet', function () {
  for (let i = 0; i < 200; i++) {
    const c = Q.makeCode(6);
    assert.strictEqual(c.length, 6);
    assert.ok(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(c), c);
  }
});

test('normalizeCode strips junk and upcases', function () {
  assert.strictEqual(Q.normalizeCode(' ab-c12 3 '), 'ABC123');
  assert.strictEqual(Q.normalizeCode(null), '');
});

test('topics are namespaced per room', function () {
  const t = Q.topics('abc123');
  assert.strictEqual(t.state, 'quizclash/v1/ABC123/state');
  assert.strictEqual(t.q, 'quizclash/v1/ABC123/q');
  assert.strictEqual(t.ev, 'quizclash/v1/ABC123/ev');
});

test('question normalisation clamps limits and keeps 4 options', function () {
  const q = Q.normalizeQuestion({ text: '  hi  ', options: ['a'], correct: 9, limit: 999 });
  assert.strictEqual(q.text, 'hi');
  assert.strictEqual(q.options.length, 4);
  assert.strictEqual(q.correct, 3);
  assert.strictEqual(q.limit, 120);
});

test('validateQuiz catches missing text / options / answer', function () {
  const errors = Q.validateQuiz({ questions: [Q.normalizeQuestion({ text: '', options: ['a', 'b', 'c', 'd'], correct: 0 })] });
  assert.ok(errors.some(function (e) { return e.indexOf('未填題目') >= 0; }));
  const ok = Q.validateQuiz({ questions: [Q.normalizeQuestion({ text: 'Q', options: ['a', 'b', 'c', 'd'], correct: 2 })] });
  assert.deepStrictEqual(ok, []);
});

test('speed scoring: instant answer beats a late one', function () {
  const fast = Q.scoreFor(true, 0, 20, 0);
  const slow = Q.scoreFor(true, 19000, 20, 0);
  assert.strictEqual(fast.gained, 1000);
  assert.ok(slow.gained < fast.gained);
  assert.ok(slow.gained >= 600);
});

test('streak adds a capped bonus and resets when wrong', function () {
  const s1 = Q.scoreFor(true, 0, 20, 0);
  const s3 = Q.scoreFor(true, 0, 20, 3);
  const s9 = Q.scoreFor(true, 0, 20, 9);
  assert.strictEqual(s1.gained, 1000);
  assert.strictEqual(s3.gained, 1150);
  assert.strictEqual(s9.gained, 1200);
  assert.strictEqual(Q.scoreFor(false, 1000, 20, 4).gained, 0);
  assert.strictEqual(Q.scoreFor(false, 1000, 20, 4).streak, 0);
});

test('answers score once, duplicates and late answers are rejected', function () {
  const state = Q.emptyState('AAA111');
  const p = Q.addPlayer(state, 'p1', '小明');
  assert.ok(p);
  Q.beginQuestion(state, 0);
  Q.startTimer(state, 1000, 20);

  const first = Q.applyAnswer(state, 2, 'p1', 2, 3000);
  assert.ok(first.ok);
  assert.ok(first.player.score > 0);
  assert.strictEqual(first.player.correct, 1);

  assert.strictEqual(Q.applyAnswer(state, 2, 'p1', 2, 4000).reason, 'duplicate');
  assert.strictEqual(Q.applyAnswer(state, 2, 'ghost', 2, 4000).reason, 'no_player');
  Q.addPlayer(state, 'p3', '阿強');
  assert.strictEqual(Q.applyAnswer(state, 2, 'p3', 9, 4000).reason, 'bad_choice');
  assert.strictEqual(Q.applyAnswer(state, 2, 'p3', 2, 4000).ok, true, 'a bad choice must not lock the player out');

  const state2 = Q.emptyState('AAA111');
  Q.addPlayer(state2, 'p2', '阿珍');
  Q.beginQuestion(state2, 0);
  Q.startTimer(state2, 1000, 20);
  assert.strictEqual(Q.applyAnswer(state2, 0, 'p2', 0, 24000).reason, 'late');
});

test('wrong answer resets streak and is counted', function () {
  const state = Q.emptyState('AAA111');
  Q.addPlayer(state, 'p1', 'A');
  Q.beginQuestion(state, 0);
  Q.startTimer(state, 0, 20);
  Q.applyAnswer(state, 0, 'p1', 3, 1000);
  const p = Q.findPlayer(state, 'p1');
  assert.strictEqual(p.wrong, 1);
  assert.strictEqual(p.score, 0);
  assert.strictEqual(p.streak, 0);
});

test('reveal counts picks and publishes the key only after reveal', function () {
  const state = Q.emptyState('AAA111');
  ['a', 'b', 'c'].forEach(function (id) { Q.addPlayer(state, id, id); });
  Q.beginQuestion(state, 0);
  Q.startTimer(state, 0, 20);
  Q.applyAnswer(state, 1, 'a', 1, 500);
  Q.applyAnswer(state, 1, 'b', 1, 900);
  Q.applyAnswer(state, 1, 'c', 3, 1200);

  const hidden = Q.publicState(state, 0);
  assert.strictEqual(hidden.correct, null);
  assert.strictEqual(hidden.players[0].lastChoice, null, 'must not leak picks during the question');

  Q.reveal(state, 1);
  const shown = Q.publicState(state, 0);
  assert.deepStrictEqual(shown.counts, [0, 2, 0, 1]);
  assert.strictEqual(shown.correct, 1);
  assert.strictEqual(shown.players[0].lastChoice, 1);
});

test('ranking switches between score and correct-count', function () {
  const state = Q.emptyState('AAA111');
  const a = Q.addPlayer(state, 'a', 'Alice');
  const b = Q.addPlayer(state, 'b', 'Bob');
  a.score = 900; a.correct = 1;
  b.score = 700; b.correct = 3;

  assert.strictEqual(Q.ranking(state, 'score')[0].name, 'Alice');
  assert.strictEqual(Q.ranking(state, 'correct')[0].name, 'Bob');
});

test('CSV parser handles quotes, commas and CRLF', function () {
  const rows = Q.parseCSV('a,b\r\n"x,1","y ""q"""\r\n\r\nz,');
  assert.deepStrictEqual(rows[0], ['a', 'b']);
  assert.deepStrictEqual(rows[1], ['x,1', 'y "q"']);
  assert.deepStrictEqual(rows[2], ['z', '']);
});

test('CSV import accepts A-D, 1-4 and full option text', function () {
  const csv = [
    '題目,選項A,選項B,選項C,選項D,正確答案,時限秒,圖片URL',
    'Q1,甲,乙,丙,丁,A,15,',
    'Q2,甲,乙,丙,丁,3,20,',
    '"Q3, 有逗號",甲,乙,丙,丁,丙,25,',
    'Q4,只有一個選項,,,,A,10,',
  ].join('\n');
  const res = Q.csvToQuiz(csv, '測試');
  assert.strictEqual(res.quiz.questions.length, 3);
  assert.strictEqual(res.quiz.questions[0].correct, 0);
  assert.strictEqual(res.quiz.questions[0].limit, 15);
  assert.strictEqual(res.quiz.questions[1].correct, 2);
  assert.strictEqual(res.quiz.questions[2].text, 'Q3, 有逗號');
  assert.strictEqual(res.quiz.questions[2].correct, 2);
  assert.ok(res.warnings.length >= 1);
});

test('quiz CSV export round-trips through import', function () {
  const quiz = Q.normalizeQuiz({
    title: 'T',
    questions: [
      { text: '一加一等於？', options: ['1', '2', '3', '4'], correct: 1, limit: 20 },
      { text: '含 "引號" 的題目', options: ['a,b', 'c', 'd', 'e'], correct: 3, limit: 30, image: 'https://x.test/a.png' },
    ],
  });
  const back = Q.csvToQuiz(Q.quizToCSV(quiz), 'T').quiz;
  assert.strictEqual(back.questions.length, 2);
  assert.strictEqual(back.questions[0].text, '一加一等於？');
  assert.strictEqual(back.questions[0].correct, 1);
  assert.strictEqual(back.questions[1].options[0], 'a,b');
  assert.strictEqual(back.questions[1].correct, 3);
  assert.strictEqual(back.questions[1].image, 'https://x.test/a.png');
});

test('results CSV lists rank, score and correct count', function () {
  const state = Q.emptyState('AAA111');
  const a = Q.addPlayer(state, 'a', 'Alice');
  a.score = 1500; a.correct = 2; a.wrong = 1; a.best = 2; a.totalMs = 6000;
  const csv = Q.resultsToCSV(state);
  assert.ok(csv.indexOf('名次,名字,分數,答對') === 0 || csv.indexOf('名次') === 1);
  assert.ok(csv.indexOf('Alice') > 0);
  assert.ok(csv.indexOf('1500') > 0);
});

test('fmtClock renders seconds and minutes', function () {
  assert.strictEqual(Q.fmtClock(9000), '9');
  assert.strictEqual(Q.fmtClock(65000), '1:05');
  assert.strictEqual(Q.fmtClock(-5), '0');
});

test('players can be renamed but not duplicated', function () {
  const state = Q.emptyState('AAA111');
  Q.addPlayer(state, 'p1', '舊名');
  Q.addPlayer(state, 'p1', '新名');
  assert.strictEqual(state.players.length, 1);
  assert.strictEqual(state.players[0].name, '新名');
  assert.strictEqual(state.players[0].score, 0, 'rename must not reset score');
});

console.log('\n' + passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
