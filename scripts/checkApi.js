/**
 * 수업 전에 한 번 실행하는 점검: 실제 Anthropic API로 2턴 대화를 해 본다.
 *   npm run check:api        (1차시)
 *   npm run check:api -- 2   (2차시)
 *   npm run check:api -- 3   (3차시)
 * 확인하는 것: 키·모델·effort 설정, 스트리밍, 시스템 프롬프트 캐시, 그리고
 * 챗봇 응답(thinking 블록 포함)을 기록에 그대로 이어 붙였을 때 API가 받아들이는지.
 * 키 값은 출력하지 않는다.
 */
import Anthropic from '@anthropic-ai/sdk';
import { buildRequest, parseStage, textOf, withCard } from '../server/chat.js';
import { loadConfig } from '../server/config.js';
import { loadLessons } from '../server/lessons.js';

// 차시마다 시험할 대화. 2턴에서 머물러도 되는 단계까지 적는다(답이 막연하면 다음 단계로 넘어가지 않는다).
const SCRIPTS = {
  1: { card: '', first: '안녕하세요!', second: '태양광 발전이요', secondStages: [2] },
  2: {
    card: '정리 카드\n- 선택한 기술: 태양광 발전\n- 나만의 탐구 질문: 태양광 발전은 제조와 폐기까지 고려해도 탄소 저감 기술이라고 할 수 있을까?',
    first: '안녕하세요! 시작할게요.',
    second: '① 태양광 발전 ② 태양광 발전은 화석 연료 발전을 대신해 온실가스 배출을 줄일 수 있다 ③ 발전할 때 연료를 태우지 않기 때문이다',
    secondStages: [1, 2],
  },
  3: {
    card: '',
    first: '안녕하세요! 시작할게요.',
    second: '① 태양광 발전 ② 밤이나 흐린 날에는 발전량이 크게 줄어든다 ③ 전기가 필요한 시간에 발전을 못 하면 그 사이를 화석 연료 발전으로 채워야 해서 탄소 저감 효과가 줄어들기 때문이다',
    secondStages: [1, 2],
  },
};

const config = loadConfig();
const lessonId = Number(process.argv[2] || 1);
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '통과' : '실패'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

if (!config.anthropicApiKey) {
  console.error('ANTHROPIC_API_KEY가 없어요. .env 파일에 넣었는지 확인해 주세요.');
  process.exit(1);
}
const lesson = loadLessons().get(lessonId);
const script = SCRIPTS[lessonId];
if (!lesson || !script) {
  console.error(`${process.argv[2]}차시는 점검할 수 없어요. 1, 2, 3 중 하나를 적어 주세요.`);
  process.exit(1);
}

const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 1 });
console.log(`${lessonId}차시 모델=${config.model} effort=${config.effort} 프롬프트=${lesson.prompt.version}\n`);

async function turn(messages) {
  const request = buildRequest({ config, systemPrompt: lesson.prompt.text, messages });
  const stream = client.messages.stream(request);
  return stream.finalMessage();
}

try {
  const opening = { role: 'user', content: withCard(script.card, script.first) };
  const first = await turn([opening]);
  const text1 = textOf(first.content);
  check('1턴 호출', true, `정지=${first.stop_reason}`);
  check('1턴 응답에 글이 있음', text1.trim().length > 0, `${[...text1].length}자`);
  const stage1 = parseStage(text1, lesson.stages.length);
  check(`1턴 응답 첫 줄이 [단계 1/${lesson.stages.length} · …] 형식`, stage1?.stage === 1, stage1 ? `단계 ${stage1.stage}` : '형식이 다름(프롬프트나 모델 점검)');
  console.log(`\n--- 1턴 응답 ---\n${text1}\n----------------\n`);

  const second = await turn([opening, { role: 'assistant', content: first.content }, { role: 'user', content: script.second }]);
  const text2 = textOf(second.content);
  check('2턴 호출(1턴 응답을 그대로 이어 붙임)', true, `정지=${second.stop_reason}`);
  const stage2 = parseStage(text2, lesson.stages.length);
  check(`2턴 응답이 단계 ${script.secondStages.join(' 또는 ')}`, script.secondStages.includes(stage2?.stage), stage2 ? `단계 ${stage2.stage}` : '형식이 다름');
  console.log(`\n--- 2턴 응답 ---\n${text2}\n----------------\n`);
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
