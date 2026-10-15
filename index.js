/**
 * Vercel 배포용 진입점. Vercel은 루트의 index.js처럼 정해진 이름의 파일 가운데
 * express를 import하는 파일을 찾아, 내보낸 앱을 하나의 함수로 실행한다(listen 하지 않는다).
 * 화면 파일(public/)은 Vercel이 직접 보내고, 이 앱은 /api 요청만 받는다.
 * 내 PC에서 실행할 때는 이 파일이 아니라 server/index.js(npm start)를 쓴다.
 */
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import { createApp } from './server/app.js';
import { createCardStore } from './server/cards.js';
import { loadConfig } from './server/config.js';
import { loadLessons } from './server/lessons.js';
import { createLogger } from './server/logger.js';
import { createTeacherStore } from './server/teacher.js';

// 함수가 여러 개로 늘어나도 같은 키와 비밀 값을 써야 하므로 항상 운영 기준으로 검사한다.
// Vercel은 X-Forwarded-For를 실제 접속 주소로 덮어쓰므로 프록시 한 단계를 믿는다.
const config = loadConfig({ TRUST_PROXY: '1', ...process.env, NODE_ENV: 'production' });

/** 설정이 잘못되면 함수가 죽는 대신, 모든 요청에 원인을 알 수 있는 안내를 돌려준다. */
function configErrorApp() {
  const app = express();
  app.use((req, res) => {
    res.status(503).json({ error: 'server_config', message: '챗봇 서버 설정에 문제가 있어요. 선생님께 알려 주세요.' });
  });
  return app;
}

let app;
if (config.errors.length > 0) {
  console.error(`[설정 오류] Vercel 환경 변수를 확인해 주세요: ${config.errors.join(' / ')}`);
  app = configErrorApp();
} else {
  config.warnings.forEach((w) => console.warn(`[주의] ${w}`));
  // 차시별 프롬프트 경로는 server/lessons.js에 고정된 문자열로 적혀 있어 Vercel 배포 묶음에 들어간다.
  const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2 });
  app = createApp({
    config, client, logger: createLogger(config), lessons: loadLessons(), cardStore: createCardStore(config), teacherStore: createTeacherStore(config),
  });
}

export default app;
