import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { parseSse, SECRET } from './helpers.js';
import { startMockAnthropic } from './mockAnthropic.js';

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'SESSION_SECRET', 'ACCESS_CODE', 'TRUST_PROXY', 'NODE_ENV', 'LOG_CHATS'];
let loads = 0;

/** 환경 변수를 바꿔 진입점을 새로 불러온다. 주소 끝의 ?로 매번 새 모듈을 읽게 한다. */
async function loadEntry(env) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    loads += 1;
    return (await import(`../index.js?load=${loads}`)).default;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function serve(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

describe('Vercel 진입점(index.js)', () => {
  it('필수 환경 변수가 없으면 함수가 죽지 않고 설정 오류 안내를 돌려준다', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const app = await loadEntry({});
    assert.equal(errors.mock.callCount(), 1);
    assert.match(errors.mock.calls[0].arguments[0], /ANTHROPIC_API_KEY/);
    assert.match(errors.mock.calls[0].arguments[0], /SESSION_SECRET/);

    const s = await serve(app);
    try {
      for (const [path, init] of [['/api/config', {}], ['/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"안녕"}' }]]) {
        const res = await fetch(`${s.base}${path}`, init);
        assert.equal(res.status, 503, path);
        const body = await res.json();
        assert.equal(body.error, 'server_config');
        assert.match(body.message, /선생님께 알려 주세요/);
      }
    } finally {
      await s.close();
    }
  });

  describe('설정이 맞을 때', () => {
    let mock;
    let app;
    let s;
    before(async () => {
      mock = await startMockAnthropic();
      app = await loadEntry({ ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: mock.url, SESSION_SECRET: SECRET, ACCESS_CODE: 'testcode123' });
      s = await serve(app);
    });
    after(async () => {
      app.close?.();
      await s.close();
      await mock.close();
    });

    it('프롬프트 파일을 읽어 대화하고, 프록시 한 단계를 믿는다', async () => {
      assert.equal(app.get('trust proxy'), 1);
      const cfg = await (await fetch(`${s.base}/api/config`)).json();
      assert.equal(cfg.requiresAccessCode, true);

      const res = await fetch(`${s.base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '안녕하세요!', accessCode: 'testcode123' }),
      });
      assert.equal(res.status, 200);
      const done = parseSse(await res.text()).find((e) => e.event === 'done')?.data;
      assert.equal(done.stage, 1);

      const sent = mock.requests.at(-1).body.system[0].text;
      assert.equal(sent, readFileSync(new URL('../prompts/lesson1_system_prompt.md', import.meta.url), 'utf8').trim());
    });

    it('vercel.json의 보안 헤더가 서버가 붙이는 헤더와 같다', async () => {
      // 화면 파일은 Vercel이 직접 보내서 서버의 헤더가 붙지 않으므로 vercel.json에 같은 값을 적어 둔다.
      const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
      const all = vercel.headers.find((h) => h.source === '/(.*)');
      const res = await fetch(`${s.base}/api/health`);
      for (const { key, value } of all.headers) {
        assert.equal(res.headers.get(key), value, key);
      }
    });
  });
});
