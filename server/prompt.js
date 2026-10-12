import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 시스템 프롬프트를 시작할 때 한 번 읽는다. 브라우저로는 절대 보내지 않는다. */
export function loadSystemPrompt(path, baseDir = process.cwd()) {
  const full = resolve(baseDir, path);
  const text = readFileSync(full, 'utf8').trim();
  if (text.length < 200) throw new Error(`시스템 프롬프트가 너무 짧아요: ${full}`);
  const version = createHash('sha256').update(text).digest('hex').slice(0, 8);
  return { text, version, path: full };
}
