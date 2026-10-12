/**
 * 데모 모드: API 키 없이 화면과 흐름만 미리 본다.   npm run demo
 * 진짜 챗봇이 아니라 정해진 문장으로 답하는 모의 서버를 쓴다(비용 없음).
 * 학생에게 쓰는 서버는 npm start 이다.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { loadSystemPrompt } from '../server/prompt.js';
import { startMockAnthropic } from '../tests/mockAnthropic.js';

const mock = await startMockAnthropic();
const config = loadConfig({ ...process.env, NODE_ENV: 'development', ANTHROPIC_API_KEY: 'demo', LOG_CHATS: 'false', ACCESS_CODE: process.env.ACCESS_CODE || '' });
const client = new Anthropic({ apiKey: 'demo', baseURL: mock.url, maxRetries: 0 });
const app = createApp({
  config,
  client,
  logger: { enabled: false, async log() {} },
  systemPrompt: loadSystemPrompt(config.systemPromptPath),
});
app.listen(config.port, () => {
  console.log(`데모 모드: http://localhost:${config.port}`);
  console.log('정해진 문장으로 답하는 모의 응답이에요. 실제 챗봇이 아니에요.');
  console.log('테스트용 낱말: SLOW(느리게) / REFUSE(거절) / ERR429(오류) / EMPTY(빈 응답)');
});
