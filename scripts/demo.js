/**
 * 데모 모드: API 키 없이 화면과 흐름만 미리 본다.   npm run demo
 * 진짜 챗봇이 아니라 정해진 문장으로 답하는 모의 서버를 쓴다(비용 없음).
 * 학생에게 쓰는 서버는 npm start 이다.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { loadLessons } from '../server/lessons.js';
import { startMockAnthropic } from '../tests/mockAnthropic.js';

const mock = await startMockAnthropic();

/** 데모용 학번 카드 저장소(메모리에만 두고, 데모를 끄면 사라진다). */
function demoCardStore() {
  const cards = new Map();
  return {
    async save({ studentId, card }) { cards.set(studentId, { card, savedAt: new Date().toISOString() }); },
    async load(studentId) { return cards.get(studentId) || null; },
  };
}
const config = loadConfig({ ...process.env, NODE_ENV: 'development', ANTHROPIC_API_KEY: 'demo', LOG_CHATS: 'false', ACCESS_CODE: process.env.ACCESS_CODE || '' });
const client = new Anthropic({ apiKey: 'demo', baseURL: mock.url, maxRetries: 0 });
const app = createApp({
  config,
  client,
  logger: { enabled: false, async log() {} },
  lessons: loadLessons(),
  cardStore: demoCardStore(),
});
const server = app.listen(config.port);
server.once('listening', () => {
  console.log(`데모 모드: http://localhost:${config.port}`);
  console.log('정해진 문장으로 답하는 모의 응답이에요. 실제 챗봇이 아니에요.');
  console.log('테스트용 낱말: SLOW(느리게) / REFUSE(거절) / ERR429(오류) / EMPTY(빈 응답) / CARD(1차시 정리 카드)');
  console.log('학번 카드 저장·불러오기는 메모리에만 저장돼요(데모를 끄면 사라져요).');
});
server.once('error', (err) => {
  console.error(`데모를 시작하지 못했어요: ${err.code === 'EADDRINUSE' ? `포트 ${config.port}가 이미 쓰이고 있어요. PORT=3001 처럼 다른 번호로 실행해 보세요.` : err.message}`);
  process.exit(1);
});
