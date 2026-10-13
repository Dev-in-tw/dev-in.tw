/** 可替換的時鐘，測試時用來快轉（session 期限、冷卻期、退避）。 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  #now: number;
  constructor(start: Date | string = "2026-10-14T00:00:00.000Z") {
    this.#now = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.#now);
  }
  advance(ms: number): void {
    this.#now += ms;
  }
  set(at: Date | string): void {
    this.#now = new Date(at).getTime();
  }
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const addMs = (date: Date, ms: number): Date => new Date(date.getTime() + ms);
