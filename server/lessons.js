import { fileURLToPath } from 'node:url';
import { loadSystemPrompt } from './prompt.js';

/**
 * 차시 목록. 프롬프트 경로는 고정된 문자열로 적어야 Vercel이 배포 묶음에 파일을 넣는다.
 * stages는 프롬프트의 [단계 n/6 · 이름] 머리글과 같은 순서·이름이어야 한다.
 * intro는 학생 화면의 시작 안내(**굵게**만 쓸 수 있다).
 */
const LESSONS = [
  {
    id: 1,
    title: '탄소 저감 기술 탐구',
    subtitle: '기술 하나를 골라 문제와 원리를 알아봐요',
    promptFile: new URL('../prompts/lesson1_system_prompt.md', import.meta.url),
    stages: ['기술 고르기', '해결하려는 문제', '과학적 원리', '배출이 줄어드는 이유', '가장 큰 문제점', '나만의 탐구 질문'],
    intro: [
      '이 챗봇은 **정답을 알려 주지 않아요.** 질문에 내 말로 답하면서 스스로 알아가요.',
      '탄소 저감 기술 하나를 골라 **어떤 문제를 풀고 어떻게 작동하는지** 알아보고, 마지막에 나만의 탐구 질문을 만들어요.',
      '내 생각은 기후에너지환경부, IPCC, IEA 같은 **기관 자료**에서 직접 확인해요.',
    ],
    makesCard: true,
  },
  {
    id: 2,
    title: '탄소 저감 기술 비판적 토론',
    subtitle: '내 주장의 근거와 반론을 검토해요',
    promptFile: new URL('../prompts/lesson2_system_prompt.md', import.meta.url),
    stages: ['주장 확인', '근거 확인', '주장-근거 연결 검토', '반론 제시', '반론 평가', '최종 판단과 성찰'],
    intro: [
      '이 챗봇은 **대신 결론을 내리거나 답안을 써 주지 않아요.** 질문으로 내 주장의 빈틈을 함께 찾아요.',
      '내 주장과 **근거 두 가지**를 세우고, AI의 반론을 **내가 직접 평가**한 뒤 최종 판단을 정리해요.',
      '근거는 기후에너지환경부, IPCC, IEA 같은 **기관 자료**에서 찾아 와요.',
    ],
    usesCard: true,
  },
  {
    id: 3,
    title: '준비 중',
    subtitle: '아직 열리지 않았어요',
    available: false,
  },
];

/** 쓸 수 있는 차시의 프롬프트를 읽어 id → 차시 정보로 돌려준다. */
export function loadLessons() {
  const map = new Map();
  for (const lesson of LESSONS) {
    if (lesson.available === false) continue;
    map.set(lesson.id, { ...lesson, prompt: loadSystemPrompt(fileURLToPath(lesson.promptFile)) });
  }
  return map;
}

/** 학생 화면에 보내는 차시 목록(프롬프트는 빼고). */
export function publicLessons() {
  return LESSONS.map(({ id, title, subtitle, stages = [], intro = [], available = true, makesCard = false, usesCard = false }) => ({
    id, title, subtitle, stages, intro, available, makesCard, usesCard,
  }));
}
