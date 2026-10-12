import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import { loadConfig } from '../server/config.js';
import { SECRET, startHarness } from './helpers.js';

/** 코드 검토에서 나온 공격을 그대로 재현해, 막혔는지 확인한다. */
describe('남용 방지(코드 검토에서 지적된 공격 재현)', () => {
  it('상태 없이 계속 보내 새 대화를 만들어도 주소별로 막히고, 진행 중인 다른 대화는 영향이 없다', async () => {
    const h = await startHarness({ NEW_CONVERSATIONS_PER_IP_PER_MIN: '5', RATE_PER_IP_PER_MIN: '1000' });
    try {
      // 진행 중인 학생(같은 주소)의 대화
      const mine = await h.chat({ message: '내 대화' });
      let state = h.doneOf(mine).state;

      // 장난치는 학생: 상태 없이 20번
      const results = [];
      for (let i = 0; i < 20; i++) results.push((await h.chat({ message: `스팸 ${i}` })).status);
      const ok = results.filter((s) => s === 200).length;
      const blocked = results.filter((s) => s === 429).length;
      assert.equal(ok, 4, '남은 새 대화 한도(5-1)까지만 통과');
      assert.equal(blocked, 16);

      // 막힌 요청은 Anthropic까지 가지 않았다: 내 첫 요청 1 + 통과한 스팸 4
      assert.equal(h.mock.requests.length, 5);

      // 진행 중이던 내 대화는 계속 된다
      const next = await h.chat({ message: '다음 말', state });
      assert.equal(next.status, 200);
    } finally { await h.close(); }
  });

  it('같은 상태를 반복해서 보내도, 거절된 요청은 반 전체의 주소 한도를 쓰지 않는다', async () => {
    const h = await startHarness({ RATE_PER_IP_PER_MIN: '12', RATE_PER_SESSION_PER_MIN: '8' });
    try {
      const first = await h.chat({ message: '안녕' });
      const state = h.doneOf(first).state;
      const codes = [];
      for (let i = 0; i < 40; i++) codes.push((await h.chat({ message: `반복 ${i}`, state })).status);
      assert.ok(codes.filter((c) => c === 429).length >= 30, '대화별 한도(8/분)로 대부분 거절');
      // 거절된 요청은 주소 한도(12/분)를 쓰지 않았으므로 같은 주소의 새 학생이 들어올 수 있다
      assert.equal((await h.chat({ message: '친구 첫 대화' })).status, 200);
    } finally { await h.close(); }
  });

  it('수업 코드를 틀린 횟수가 한도를 넘으면 맞는 코드도 잠시 받지 않고, Anthropic은 호출되지 않는다', async () => {
    const h = await startHarness({ ACCESS_CODE: 'sun-48217x', BAD_CODE_PER_IP_PER_MIN: '5' });
    try {
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await h.chat({ message: 'x', accessCode: `guess-${i}` })).status);
      assert.deepEqual(statuses, [401, 401, 401, 401, 401]);
      const locked = await h.chat({ message: 'x', accessCode: 'guess-6' });
      assert.equal(locked.status, 429);
      assert.equal(locked.json.error, 'rate_code');
      // 맞는 코드도 잠긴 동안은 받지 않는다(응답 차이로 코드를 알아내지 못하게)
      const rightButLocked = await h.chat({ message: 'x', accessCode: 'sun-48217x' });
      assert.equal(rightButLocked.status, 429);
      assert.equal(h.mock.requests.length, 0);
    } finally { await h.close(); }
  });

  it('대량의 틀린 코드 대입도 한도 이후에는 전부 거절된다', async () => {
    const h = await startHarness({ ACCESS_CODE: 'sun-48217x' });
    try {
      let found = false;
      let ok401 = 0;
      let locked = 0;
      for (let n = 0; n < 300; n++) {
        const r = await h.chat({ message: 'x', accessCode: `sun-${String(n).padStart(5, '0')}` });
        if (r.status === 200) found = true;
        else if (r.status === 401) ok401++;
        else if (r.status === 429) locked++;
      }
      assert.equal(found, false);
      assert.equal(ok401, h.config.badCodePerIpPerMinute, '기본 한도(30)까지만 틀린 코드를 평가');
      assert.equal(locked, 300 - h.config.badCodePerIpPerMinute);
    } finally { await h.close(); }
  });

  it('동시에 만들 수 있는 스트림 수에 상한이 있다', async () => {
    const h = await startHarness({ MAX_CONCURRENT_STREAMS: '2', RATE_PER_IP_PER_MIN: '1000', NEW_CONVERSATIONS_PER_IP_PER_MIN: '1000' });
    try {
      const slow = [h.chat({ message: 'SLOW 하나' }), h.chat({ message: 'SLOW 둘' })];
      await new Promise((r) => setTimeout(r, 120));
      const third = await h.chat({ message: '셋째' });
      assert.equal(third.status, 429);
      assert.equal(third.json.error, 'busy');
      const done = await Promise.all(slow);
      assert.ok(done.every((r) => h.doneOf(r)));
      // 끝난 뒤에는 다시 받는다
      assert.equal((await h.chat({ message: '넷째' })).status, 200);
    } finally { await h.close(); }
  });

  it('Anthropic이 실패한 요청은 하루 상한에서 되돌린다', async () => {
    const h = await startHarness({ DAILY_REQUEST_CAP: '1' });
    try {
      const failed = await h.chat({ message: 'ERR500 실패' });
      assert.ok(failed.events.some((e) => e.event === 'error'));
      const ok = await h.chat({ message: '정상' });
      assert.equal(ok.status, 200, '실패한 요청 때문에 상한이 소진되면 안 돼요');
      assert.equal((await h.chat({ message: '초과' })).json.error, 'daily_cap');
    } finally { await h.close(); }
  });
});

describe('상태 토큰의 프롬프트·모델 버전', () => {
  it('모델이 바뀐 서버는 이전 상태를 받지 않고 새로 시작하라고 안내한다', async () => {
    const a = await startHarness();
    const b = await startHarness({ CHATBOT_MODEL: 'claude-sonnet-5-5' });
    try {
      const first = await a.chat({ message: '안녕' });
      const state = a.doneOf(first).state;
      const r = await b.chat({ message: '이어서', state });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, 'bad_state');
      assert.match(r.json.message, /업데이트/);
      assert.equal(b.mock.requests.length, 0, 'Anthropic을 호출하면 안 돼요');
    } finally { await a.close(); await b.close(); }
  });
});

describe('Anthropic 응답 처리', () => {
  it('결제·한도 오류(402)는 따로 분류한다', async () => {
    const h = await startHarness();
    try {
      const r = await h.chat({ message: 'ERR402 한도' });
      const err = r.events.find((e) => e.event === 'error');
      assert.equal(err.data.code, 'billing');
      assert.ok(!r.raw.includes('credit balance'));
    } finally { await h.close(); }
  });

  it('max_tokens로 잘린 답변은 기록에 남기지 않고 다시 보내게 한다', async () => {
    const h = await startHarness();
    try {
      const r = await h.chat({ message: 'TRUNC 길게' });
      const err = r.events.find((e) => e.event === 'error');
      assert.equal(err.data.code, 'truncated');
      assert.ok(!r.events.some((e) => e.event === 'done'));
      assert.equal(h.logs.length, 0, '잘린 답변은 대화 기록에도 남기지 않아요');
    } finally { await h.close(); }
  });
});

describe('정적 파일 경로 이탈', () => {
  it('원시 경로로 상위 폴더를 요청해도 프롬프트·소스가 열리지 않는다', async () => {
    const h = await startHarness();
    try {
      const port = new URL(h.base).port;
      const paths = [
        '/..%2fprompts/lesson1_system_prompt.md',
        '/%2e%2e/prompts/lesson1_system_prompt.md',
        '/..%2f..%2fserver/config.js',
        '/public/../prompts/lesson1_system_prompt.md',
        '/%2e%2e%2f%2e%2e%2f.env',
      ];
      for (const path of paths) {
        const { status, body } = await new Promise((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
          });
          req.on('error', reject);
          req.end();
        });
        assert.ok(!body.includes('소크라테스식 대화 상대'), `${path}에서 프롬프트가 보이면 안 돼요`);
        assert.ok(!body.includes('sessionSecret'), `${path}에서 소스가 보이면 안 돼요`);
        assert.notEqual(status, 200, `${path}가 열리면 안 돼요 (${status})`);
      }
    } finally { await h.close(); }
  });
});

describe('시작과 설정', () => {
  it('포트가 이미 쓰이고 있으면 성공 메시지 없이 종료 코드 1로 끝난다', async () => {
    const blocker = createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const port = blocker.address().port;
    try {
      const child = spawn(process.execPath, ['server/index.js'], {
        env: { ...process.env, PORT: String(port), SESSION_SECRET: SECRET, ANTHROPIC_API_KEY: 'k' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      const code = await new Promise((resolve) => child.on('exit', resolve));
      assert.equal(code, 1);
      assert.ok(out.includes('다른 프로그램이 쓰고 있어요'));
      assert.ok(!out.includes('시작했어요'));
    } finally { blocker.close(); }
  });

  it('수업 코드가 없거나 짧으면 운영이 아니어도 경고한다', () => {
    const open = loadConfig({ SESSION_SECRET: SECRET, ANTHROPIC_API_KEY: 'k' });
    assert.ok(open.warnings.some((w) => w.includes('ACCESS_CODE가 없어요')));
    const short = loadConfig({ SESSION_SECRET: SECRET, ANTHROPIC_API_KEY: 'k', ACCESS_CODE: '1234' });
    assert.ok(short.warnings.some((w) => w.includes('8자보다 짧아요')));
    const good = loadConfig({ SESSION_SECRET: SECRET, ANTHROPIC_API_KEY: 'k', ACCESS_CODE: 'sun-48217x' });
    assert.equal(good.warnings.length, 0);
  });
});
