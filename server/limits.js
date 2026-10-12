/**
 * 메모리 기반 요청 제한. 서버가 한 대일 때 정확하고, 여러 대면 대수만큼 느슨해진다.
 * 실제 비용 상한은 Anthropic 콘솔의 사용 한도로 반드시 따로 걸어 두어야 한다.
 */

export class SlidingWindowLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), windowMs);
    this.timer.unref?.();
  }

  /** @returns {boolean} 허용되면 true */
  take(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  /** 창 안에 쌓인 횟수(기록하지 않고 읽기만). */
  count(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    return (this.hits.get(key) || []).filter((t) => t > cutoff).length;
  }

  sweep(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.hits) {
      const fresh = list.filter((t) => t > cutoff);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
  }

  close() {
    clearInterval(this.timer);
  }
}

/** 하루(한국 시간 기준) 총 요청 수 상한. */
export class DailyCap {
  constructor(max) {
    this.max = max;
    this.day = '';
    this.count = 0;
  }

  static today(now = new Date()) {
    return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  }

  take(now = new Date()) {
    const day = DailyCap.today(now);
    if (day !== this.day) {
      this.day = day;
      this.count = 0;
    }
    if (this.count >= this.max) return false;
    this.count += 1;
    return true;
  }

  /** Anthropic 쪽 실패로 응답을 못 만든 요청은 상한에서 되돌린다. */
  refund(now = new Date()) {
    if (DailyCap.today(now) === this.day && this.count > 0) this.count -= 1;
  }
}

/** 같은 대화에서 응답이 끝나기 전에 다시 보내는 것을 막는다(기록이 갈라지는 것 방지). */
export class InFlight {
  constructor() {
    this.set = new Set();
  }

  acquire(sid) {
    if (this.set.has(sid)) return false;
    this.set.add(sid);
    return true;
  }

  release(sid) {
    this.set.delete(sid);
  }
}
