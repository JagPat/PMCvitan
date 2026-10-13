import type { Lang } from '../domain/types';

/**
 * #827 (Top 10 #5, the bell) — a notification in the viewer's language.
 *
 * The server and the demo write each notice ONCE, in English, from a small fixed set of templates
 * (`apps/api/src/domain/notifications.ts`, the inspection, daily-log and activity writers, and the
 * store's local writers). The stored text stays the record: the bell's links and the server's
 * audience filters read it. This function only changes what is SHOWN, and only the template's own
 * words: every name, title, reason, material, id and date the notice quotes is passed through as
 * written, in its original order, so nothing a person typed is reworded or split in a new place.
 * A text no template matches — a new server phrasing, or a notice an older release wrote — is shown
 * as it is, never guessed at.
 */

type Words = Record<Lang, string>;

/** "PREFIX: rest" notices: the label is translated, the rest kept verbatim. */
const PREFIXED: readonly { en: string; hi: string; gu: string }[] = [
  { en: 'Decision awaiting approval: ', hi: 'मंज़ूरी बाकी: ', gu: 'મંજૂરી બાકી: ' },
  { en: 'New decision issued for approval: ', hi: 'मंज़ूरी के लिए नया निर्णय: ', gu: 'મંજૂરી માટે નવો નિર્ણય: ' },
  { en: 'Decision withdrawn: ', hi: 'निर्णय वापस लिया गया: ', gu: 'નિર્ણય પાછો ખેંચાયો: ' },
  { en: 'Issue recorded: ', hi: 'निर्णय दर्ज हुआ: ', gu: 'નિર્ણય નોંધાયો: ' },
  { en: 'Change requested: ', hi: 'बदलाव माँगा गया: ', gu: 'ફેરફાર માગ્યો: ' },
  { en: 'New checklist issued: ', hi: 'नई चेकलिस्ट दी गई: ', gu: 'નવી ચેકલિસ્ટ અપાઈ: ' },
  { en: 'Re-inspection due: ', hi: 'दोबारा निरीक्षण बाकी: ', gu: 'ફરી નિરીક્ષણ બાકી: ' },
  { en: 'Mismatch resolved: ', hi: 'बेमेल सुलझाया गया: ', gu: 'મેળ ન ખાતું ઉકેલાયું: ' },
  { en: 'Drawing issued: ', hi: 'ड्रॉइंग जारी: ', gu: 'ડ્રોઇંગ જારી: ' },
  { en: 'New location added: ', hi: 'नई जगह जोड़ी गई: ', gu: 'નવી જગ્યા ઉમેરાઈ: ' },
];

/** The fixed endings some notices carry after the quoted part. */
const SIGNOFF_AWAITING: Words = { en: " — awaiting the PMC's closing inspection", hi: ' — PMC के अंतिम निरीक्षण की राह', gu: ' — PMC ના અંતિમ નિરીક્ષણની રાહ' };
const COUNTERSIGN_AWAITING: Words = { en: " — awaiting the architect's countersign", hi: ' — आर्किटेक्ट के प्रति-हस्ताक्षर की राह', gu: ' — આર્કિટેક્ટની પ્રતિ-સહીની રાહ' };

/** A forward's target when it is a role (a named member's name is data). */
const FORWARD_TO: Record<string, Words> = {
  'the client': { en: 'the client', hi: 'क्लाइंट', gu: 'ક્લાયન્ટ' },
  'the PMC': { en: 'the PMC', hi: 'PMC', gu: 'PMC' },
  'the architect': { en: 'the architect', hi: 'आर्किटेक्ट', gu: 'આર્કિટેક્ટ' },
};

/** Whom a PMC recorded consent on behalf of. */
const ON_BEHALF: Record<string, Words> = {
  client: { en: 'client', hi: 'क्लाइंट', gu: 'ક્લાયન્ટ' },
  'named decider': { en: 'named decider', hi: 'तय करने वाले व्यक्ति', gu: 'નક્કી કરનાર વ્યક્તિ' },
  architect: { en: 'architect', hi: 'आर्किटेक्ट', gu: 'આર્કિટેક્ટ' },
  pmc: { en: 'pmc', hi: 'PMC', gu: 'PMC' },
};

const APPROVED: Words = { en: '', hi: 'ने मंज़ूरी दी', gu: 'એ મંજૂરી આપી' };

/** "… approved T — M", with the finality endings the approve, provisional and finalizer writers add. */
function approvalNotice(text: string, lang: Exclude<Lang, 'en'>): string | null {
  let core = text;
  let tail = '';
  if (core.endsWith(COUNTERSIGN_AWAITING.en)) {
    core = core.slice(0, -COUNTERSIGN_AWAITING.en.length);
    tail = COUNTERSIGN_AWAITING[lang];
  } else {
    const finalized = / — finalized by (.+) with no active architect$/.exec(core);
    const countersigned = / — countersigned by (.+)$/.exec(core);
    if (finalized) {
      core = core.slice(0, finalized.index);
      tail = lang === 'hi' ? ` — ${finalized[1]} ने पूरा किया, कोई सक्रिय आर्किटेक्ट नहीं` : ` — ${finalized[1]} એ પૂરું કર્યું, કોઈ સક્રિય આર્કિટેક્ટ નથી`;
    } else if (countersigned) {
      core = core.slice(0, countersigned.index);
      tail = lang === 'hi' ? ` — ${countersigned[1]} के प्रति-हस्ताक्षर` : ` — ${countersigned[1]} ની પ્રતિ-સહી`;
    }
  }
  if (core.startsWith('Client approved ') && core.includes(' — ')) {
    return `${FORWARD_TO['the client'][lang]} ${APPROVED[lang]}: ${core.slice('Client approved '.length)}${tail}`;
  }
  const behalf = /^(.+?) approved (.+) on behalf of the (client|named decider|architect|pmc) — (.+)$/.exec(core);
  if (behalf) {
    const whom = ON_BEHALF[behalf[3]][lang];
    const verb = lang === 'hi' ? `ने ${whom} की ओर से मंज़ूरी दी` : `એ ${whom} વતી મંજૂરી આપી`;
    return `${behalf[1]} ${verb}: ${behalf[2]} — ${behalf[4]}${tail}`;
  }
  const actor = /^(.+?) approved (.+ — .+)$/.exec(core);
  if (actor) return `${actor[1]} ${APPROVED[lang]}: ${actor[2]}${tail}`;
  return null;
}

/**
 * `decision`: the notice is stamped with the decision it is about (`AppNotification.decisionId`). The
 * approval notices ("<who> approved <title> — <material>") have no fixed prefix, so they are read as
 * approvals ONLY on a stamped notice: every approval writer stamps one (the server's approve,
 * provisional and finalizer writers, and the demo store's), and an unstamped text that happens to say
 * "approved" is shown as stored (Codex 4264170661).
 */
export function noticeText(text: string, lang: Lang, opts: { decision?: boolean } = {}): string {
  if (lang === 'en') return text;
  for (const p of PREFIXED) {
    if (!text.startsWith(p.en) || text.length === p.en.length) continue;
    return p[lang] + text.slice(p.en.length);
  }
  if (text.startsWith('Decision forwarded: ')) {
    const rest = text.slice('Decision forwarded: '.length);
    const arrow = rest.lastIndexOf(' → ');
    if (arrow > 0) {
      const to = rest.slice(arrow + 3);
      const label = lang === 'hi' ? 'निर्णय आगे भेजा गया' : 'નિર્ણય આગળ મોકલાયો';
      return `${label}: ${rest.slice(0, arrow)} → ${FORWARD_TO[to]?.[lang] ?? to}`;
    }
  }
  if (text.startsWith('Sign-off requested: ')) {
    let rest = text.slice('Sign-off requested: '.length);
    let tail = '';
    if (rest.endsWith(SIGNOFF_AWAITING.en)) {
      rest = rest.slice(0, -SIGNOFF_AWAITING.en.length);
      tail = SIGNOFF_AWAITING[lang];
    }
    if (rest) return `${lang === 'hi' ? 'काम पूरा होने की पुष्टि माँगी गई' : 'કામ પૂરું થયાની પુષ્ટિ માગી'}: ${rest}${tail}`;
  }
  const signed = /^Signed off: (.+) is complete\.$/.exec(text);
  if (signed) return lang === 'hi' ? `पूरा हुआ: ${signed[1]}।` : `પૂરું થયું: ${signed[1]}.`;
  const mismatch = /^Material mismatch: (.+) ≠ approved (\S+)$/.exec(text);
  if (mismatch) {
    return lang === 'hi'
      ? `सामग्री मेल नहीं खाती: ${mismatch[1]} ≠ मंज़ूर ${mismatch[2]}`
      : `સામગ્રી મેળ ખાતી નથી: ${mismatch[1]} ≠ મંજૂર ${mismatch[2]}`;
  }
  const inspection = /^Inspection (\S+) approved\. Contractor and client notified\.$/.exec(text);
  if (inspection) {
    return lang === 'hi'
      ? `निरीक्षण ${inspection[1]} मंज़ूर। ठेकेदार और क्लाइंट को सूचना दी गई।`
      : `નિરીક્ષણ ${inspection[1]} મંજૂર. કોન્ટ્રાક્ટર અને ક્લાયન્ટને જાણ કરી.`;
  }
  const reinspection = /^Re-inspection (\S+) created for (\d+) item\(s\) — due (.+)\.$/.exec(text);
  if (reinspection) {
    return lang === 'hi'
      ? `दोबारा निरीक्षण ${reinspection[1]}: ${reinspection[2]} आइटम — अंतिम तारीख ${reinspection[3]}।`
      : `ફરી નિરીક્ષણ ${reinspection[1]}: ${reinspection[2]} આઇટમ — છેલ્લી તારીખ ${reinspection[3]}.`;
  }
  // the drawing acknowledgement's own shape: "<who> is building to <number> Rev <rev>"
  const building = /^(.+?) is building to (\S+ Rev \S+)$/.exec(text);
  if (building) return lang === 'hi' ? `${building[1]} इस पर काम कर रहे हैं: ${building[2]}` : `${building[1]} આ પ્રમાણે કામ કરી રહ્યા છે: ${building[2]}`;
  return (opts.decision ? approvalNotice(text, lang) : null) ?? text;
}

/** When a notice happened, in the viewer's language: the parts `noticeTime` builds, or the stored label. */
export const noticeTimeText = {
  justNow: { en: 'just now', hi: 'अभी', gu: 'હમણાં' } satisfies Words,
  ago: (n: number, unit: 'm' | 'h' | 'd', lang: Lang): string => {
    if (lang === 'en') return `${n}${unit} ago`;
    const words = lang === 'hi' ? { m: 'मिनट', h: 'घंटे', d: 'दिन' } : { m: 'મિનિટ', h: 'કલાક', d: 'દિવસ' };
    return lang === 'hi' ? `${n} ${words[unit]} पहले` : `${n} ${words[unit]} પહેલાં`;
  },
};

/** The bell's own words. */
export const notificationPanelLabels = {
  title: { en: 'NOTIFICATIONS', hi: 'सूचनाएँ', gu: 'સૂચનાઓ' },
  dialog: { en: 'Notifications', hi: 'सूचनाएँ', gu: 'સૂચનાઓ' },
  loadFailed: { en: "Couldn't load notifications", hi: 'सूचनाएँ नहीं खुल सकीं', gu: 'સૂચનાઓ ખૂલી શકી નહીં' },
  loading: { en: 'Loading notifications…', hi: 'सूचनाएँ खुल रही हैं…', gu: 'સૂચનાઓ ખૂલી રહી છે…' },
  checkConnection: { en: 'Check your connection and try again.', hi: 'नेटवर्क जाँचें और फिर कोशिश करें।', gu: 'નેટવર્ક તપાસો અને ફરી પ્રયાસ કરો.' },
  caughtUp: { en: "You're all caught up", hi: 'कोई नई सूचना नहीं', gu: 'કોઈ નવી સૂચના નથી' },
  caughtUpDetail: {
    en: 'Approvals, inspections and drawings you need to know about will appear here.',
    hi: 'जिन मंज़ूरियों, निरीक्षणों और ड्रॉइंग की आपको जानकारी चाहिए, वे यहाँ दिखेंगी।',
    gu: 'જે મંજૂરીઓ, નિરીક્ષણો અને ડ્રોઇંગની તમને જાણ જોઈએ, તે અહીં દેખાશે.',
  },
  missing: {
    en: "The record this notification refers to isn't available. It may have been completed or removed.",
    hi: 'जिस रिकॉर्ड की यह सूचना है, वह उपलब्ध नहीं है। हो सकता है वह पूरा हो गया हो या हटा दिया गया हो।',
    gu: 'આ સૂચના જે રેકોર્ડની છે તે ઉપલબ્ધ નથી. કદાચ તે પૂરો થયો હોય અથવા કાઢી નખાયો હોય.',
  },
  notLoaded: {
    en: "This notification's record can't be checked yet — its list hasn't loaded. Try again in a moment.",
    hi: 'इस सूचना का रिकॉर्ड अभी जाँचा नहीं जा सकता — उसकी सूची नहीं खुली है। थोड़ी देर में फिर कोशिश करें।',
    gu: 'આ સૂચનાનો રેકોર્ડ હજી તપાસી શકાતો નથી — તેની યાદી ખૂલી નથી. થોડી વારમાં ફરી પ્રયાસ કરો.',
  },
  open: { en: 'Open', hi: 'खोलें', gu: 'ખોલો' },
} satisfies Record<string, Words>;
