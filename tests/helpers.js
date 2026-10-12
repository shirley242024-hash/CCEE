import Anthropic from '@anthropic-ai/sdk';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { loadSystemPrompt } from '../server/prompt.js';
import { startMockAnthropic } from './mockAnthropic.js';

export const SECRET = 'x'.repeat(40);

export function parseSse(text) {
  return text
    .split('\n\n')
    .map((block) => {
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      return data ? { event, data: JSON.parse(data) } : null;
    })
    .filter(Boolean);
}

/** 모의 Anthropic 서버 + 실제 앱을 함께 띄운다. */
export async function startHarness(envOverrides = {}) {
  const mock = await startMockAnthropic();
  const config = loadConfig({ SESSION_SECRET: SECRET, ANTHROPIC_API_KEY: 'test-key', ...envOverrides });
  const logs = [];
  const logger = { enabled: true, async log(entry) { logs.push(entry); } };
  const client = new Anthropic({ apiKey: 'test-key', baseURL: mock.url, maxRetries: 0 });
  const systemPrompt = loadSystemPrompt('prompts/lesson1_system_prompt.md');
  const app = createApp({ config, client, logger, systemPrompt });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function chat(body) {
    const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const type = res.headers.get('content-type') || '';
    const raw = await res.text();
    if (type.includes('text/event-stream')) return { status: res.status, events: parseSse(raw), raw };
    return { status: res.status, json: raw ? JSON.parse(raw) : null, raw };
  }
  const doneOf = (r) => r.events.find((e) => e.event === 'done')?.data;

  return {
    base, mock, config, logs, systemPrompt, chat, doneOf,
    async close() {
      app.close();
      await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
      await mock.close();
    },
  };
}
