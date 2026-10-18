import { describe, it, expect } from 'vitest';
import { dailyLogLabels, dailyLogText, dailyLogToastText, engineerTodayLabels, type Lang } from '@vitan/shared';

/**
 * #482 F-C1.3 — check-in records the tap time only (#940, D13). It takes no location and no selfie (a real
 * presence check is D4, after Stage 1), so no check-in words may promise either, in any language.
 */
const LANGS: Lang[] = ['en', 'hi', 'gu'];
const PROMISES = /selfie|GPS|60 ?m\b|60 मी|60 મી|सेल्फ़ी|સેલ્ફી|location|जगह|સ્થાન|proof|सबूत|પુરાવા/i;

describe('#482 F-C1.3 — check-in says only what it records', () => {
  for (const lang of LANGS) {
    it(`${lang}: the action line, the proof line, the checked-in line and the toast promise no location or selfie`, () => {
      const words = [
        engineerTodayLabels.actionDetail.checkIn[lang],
        dailyLogLabels.proof[lang],
        dailyLogText.checkedInWhere('Villa Bodakdev', lang),
        dailyLogToastText.checkedIn('Villa Bodakdev', lang),
      ];
      for (const w of words) expect(w, w).not.toMatch(PROMISES);
    });
  }

  it('English names the time as what is recorded', () => {
    expect(engineerTodayLabels.actionDetail.checkIn.en).toBe('Records the time you tap.');
    expect(dailyLogLabels.proof.en).toBe('Records the time you check in');
    expect(dailyLogText.checkedInWhere('Villa Bodakdev', 'en')).toBe('Villa Bodakdev · check-in time recorded');
    expect(dailyLogToastText.checkedIn('Villa Bodakdev', 'en')).toBe('Checked in at Villa Bodakdev · time recorded.');
  });
});
