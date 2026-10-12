# CCEE
기후변화와 환경생태

## 탄소 저감 기술 탐구 챗봇 (1차시)

「AI와 논쟁하며 탄소 저감 과학기술 제안하기」 3차시 수업 중 1차시용 챗봇입니다. 학생에게 정답을 알려 주지 않고, 소크라테스식 질문으로 기술 하나의 문제·원리·한계를 스스로 파악하게 한 뒤 나만의 탐구 질문을 만들게 합니다.

| 위치 | 내용 |
|---|---|
| `prompts/lesson1_system_prompt.md` | 챗봇의 시스템 프롬프트(6단계 진행 규칙, 힌트 사다리, 자료 확인 규칙) |
| `server/`, `public/` | 학생용 챗봇 서버와 채팅 화면 |
| `supabase/schema.sql` | (선택) 교사용 대화 기록 테이블 |
| `docs/DEPLOY.md` | **실행·배포·수업 전 점검표** |
| `tests/` | 모의 Anthropic 서버로 하는 자동 테스트 |

```
npm install
npm test            # 자동 테스트(API 키 불필요)
npm run demo        # 키 없이 화면만 미리 보기(모의 응답)
npm run check:api   # 실제 API 점검(.env에 ANTHROPIC_API_KEY 필요)
npm start           # 서버 실행 → http://localhost:3000
```

처음 설정은 [docs/DEPLOY.md](docs/DEPLOY.md)를 따라 주세요. `.env`(키가 들어 있는 파일)는 git에 올라가지 않으며, 키를 채팅이나 커밋에 붙여넣지 마세요.
