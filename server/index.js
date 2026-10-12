import Anthropic from '@anthropic-ai/sdk';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { loadSystemPrompt } from './prompt.js';

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

const systemPrompt = loadSystemPrompt(config.systemPromptPath);
const client = new Anthropic({ apiKey: config.anthropicApiKey || undefined, maxRetries: 2 });
const logger = createLogger(config);
const app = createApp({ config, client, logger, systemPrompt });

const server = app.listen(config.port, () => {
  console.log(`챗봇 서버를 시작했어요: http://localhost:${config.port}`);
  console.log(`  모델=${config.model} effort=${config.effort} 프롬프트=${systemPrompt.version} 수업코드=${config.accessCode ? '사용' : '없음'} 대화기록=${logger.enabled ? '저장' : '저장 안 함'}`);
});

function shutdown() {
  app.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
