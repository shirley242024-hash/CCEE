/**
 * 수업 전에 한 번 실행하는 점검: 실제 Anthropic API로 2턴 대화를 해 본다.
 *   npm run check:api
 * 확인하는 것: 키·모델·effort 설정, 스트리밍, 시스템 프롬프트 캐시, 그리고
 * 챗봇 응답(thinking 블록 포함)을 기록에 그대로 이어 붙였을 때 API가 받아들이는지.
 * 키 값은 출력하지 않는다.
 */
import Anthropic from '@anthropic-ai/sdk';
import { buildRequest, parseStage, textOf } from '../server/chat.js';
import { loadConfig } from '../server/config.js';
import { loadSystemPrompt } from '../server/prompt.js';

const config = loadConfig();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

if (!config.anthropicApiKey) {
  console.error('ANTHROPIC_API_KEY가 없어요. .env 파일에 넣었는지 확인해 주세요.');
  process.exit(1);
}

const prompt = loadSystemPrompt(config.systemPromptPath);
const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 1 });
console.log(`모델=${config.model} effort=${config.effort} 프롬프트=${prompt.version}\n`);

async function turn(messages) {
  const request = buildRequest({ config, systemPrompt: prompt.text, messages });
  const stream = client.messages.stream(request);
  return stream.finalMessage();
}

try {
  const first = await turn([{ role: 'user', content: '안녕하세요!' }]);
  const text1 = textOf(first.content);
  check('1턴 호출', true, `정지=${first.stop_reason}`);
  check('1턴 응답에 글이 있음', text1.trim().length > 0, `${[...text1].length}자`);
  const stage1 = parseStage(text1);
  check('1턴 응답 첫 줄이 [단계 1/6 · …] 형식', stage1?.stage === 1, stage1 ? `단계 ${stage1.stage}` : '형식이 다름(프롬프트나 모델 점검)');
  console.log(`\n--- 1턴 응답 ---\n${text1}\n----------------\n`);

  const second = await turn([
    { role: 'user', content: '안녕하세요!' },
    { role: 'assistant', content: first.content },
    { role: 'user', content: '태양광 발전이요' },
  ]);
  const text2 = textOf(second.content);
  check('2턴 호출(1턴 응답을 그대로 이어 붙임)', true, `정지=${second.stop_reason}`);
  const stage2 = parseStage(text2);
  check('2턴 응답이 [단계 2/6 · …]로 진행', stage2?.stage === 2, stage2 ? `단계 ${stage2.stage}` : '형식이 다름');
  const read = second.usage?.cache_read_input_tokens ?? 0;
  const wrote = (first.usage?.cache_creation_input_tokens ?? 0) + (second.usage?.cache_creation_input_tokens ?? 0);
  check('시스템 프롬프트 캐시', read > 0, `읽기=${read} 쓰기=${wrote} (0이면 캐시가 안 되는 것이며 동작에는 문제 없고 비용만 늘어요)`);
  console.log(`\n사용량: 1턴 입력=${first.usage?.input_tokens} 출력=${first.usage?.output_tokens} / 2턴 입력=${second.usage?.input_tokens} 출력=${second.usage?.output_tokens}`);
} catch (err) {
  check('API 호출', false, `${err?.status ?? ''} ${err?.name ?? ''}: ${err?.message ?? err}`);
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? '모두 통과했어요.' : `${failed}개 항목이 실패했어요. 위 내용을 확인해 주세요.`}`);
process.exit(failed === 0 ? 0 : 1);
