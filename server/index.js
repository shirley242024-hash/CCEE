import Anthropic from '@anthropic-ai/sdk';
import { createApp } from './app.js';
import { createCardStore } from './cards.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { loadLessons } from './lessons.js';
import { createTeacherStore } from './teacher.js';

const config = loadConfig();

if (config.errors.length > 0) {
  console.error('설정 오류로 서버를 시작하지 않아요:');
  config.errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}
config.warnings.forEach((w) => console.warn(`[주의] ${w}`));
if (!config.anthropicApiKey) {
  console.warn('[주의] ANTHROPIC_API_KEY가 없어요. 화면은 열리지만 대화 요청은 실패해요.');
}

const lessons = loadLessons();
const client = new Anthropic({ apiKey: config.anthropicApiKey || undefined, maxRetries: 2 });
const logger = createLogger(config);
const app = createApp({ config, client, logger, lessons, cardStore: createCardStore(config), teacherStore: createTeacherStore(config) });

const server = app.listen(config.port);
server.once('listening', () => {
  console.log(`챗봇 서버를 시작했어요: http://localhost:${config.port}`);
  console.log(`  모델=${config.model} effort=${config.effort} 프롬프트=${[...lessons].map(([id, l]) => `${id}차시:${l.prompt.version}`).join(',')} 수업코드=${config.accessCode ? '사용' : '없음'} 대화기록=${logger.enabled ? '저장' : '저장 안 함'} 학번카드=${config.saveCards ? '사용' : '안 씀'} 교사용화면=${config.teacherCode ? '켜짐(/teacher.html)' : '꺼짐'}`);
});
server.once('error', (err) => {
  const reason = err.code === 'EADDRINUSE'
    ? `포트 ${config.port}를 다른 프로그램이 쓰고 있어요. 이미 켜 둔 서버가 있는지 확인하거나 .env에 PORT=3001처럼 다른 번호를 적어 보세요.`
    : err.message;
  console.error(`서버를 시작하지 못했어요: ${reason}`);
  process.exit(1);
});

function shutdown() {
  app.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
