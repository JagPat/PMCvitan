import { Injectable } from '@nestjs/common';

/** Injection token for the clock — services receive a deterministic fake in tests. */
export const CLOCK = 'CLOCK';

/** The one source of "today" — always evaluated in the PROJECT's time zone, so a
 *  site log started at 00:30 IST lands on the right civil day regardless of the
 *  server's zone. Never call new Date() for a civil date anywhere else. */
export interface Clock {
  today(timeZone: string): string;
}

@Injectable()
export class SystemClock implements Clock {
  today(timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit', timeZone,
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  }
}
