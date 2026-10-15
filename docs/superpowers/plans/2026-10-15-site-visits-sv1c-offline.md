# Site Visits SV1-c unit 2: acts made with no signal

**Work item:** #792 (F53, left for SV1-c by the SV1 visit-record plan), on the owner's per-role QA check of 14 Oct
2026 (#482, item 6). It also carries the screen's deferred review points #892 and #905.
**Builds on:** unit 1, the screen online (#874), and the `status=open` read (#889).

## What it is

A visit is usually walked where the signal is poor. Every act on the Site Visits screen is now kept on the phone
first and sent from there, as the Daily Log's acts are. The acts are start, add or remove a place or a person,
end, and close. An act made with no signal shows at once, marked "waiting to send", and goes when the screen next
hears the server. A line says how many changes are waiting and offers Send now. Nothing is lost on a reload. Every
word is in English, Hindi and Gujarati.

## Hard choices

1. **Write-ahead through the store's outbox, not a new queue.** Each act is a `siteVisit*` outbox op that carries
   its idempotency key and the exact body first sent: the id it minted, its claimed time and its location. The op
   is stored on the phone, scoped to the user and the project like every queued op, before anything is sent. A lost
   answer or a passing fault (no status, 401, 408, 429, 5xx) keeps the op, and the next send uses the same key and
   body, so the server runs it once. A definite refusal drops it. Unit 1's in-memory act map is gone. The outbox
   is what makes an act the same act, so a read that shows a row can no longer settle an act it should not
   (#905, retire).
2. **In order, so a remove waits for its add.** The outbox replays in the order the acts were made and stops at
   the first one that cannot be sent yet. So a remove queued after its add never reaches the server first (F53).
3. **A start refused because a visit is already open keeps its acts (F53).** The visitor may have started a visit
   on another device and forgotten it. When a queued start meets the server's one-open-visit refusal, the flush
   reads the visitor's own open visit. It moves the places, people and End queued for the refused visit onto that
   visit, and the screen says so. If that read fails, or finds no open visit (another device ended it after the
   refusal), the start and its acts wait for the next send, under the same key: the refused start changed
   nothing, so it can go again. Answers to the moved acts are shown on the open visit even before a read lists
   it. Start is offered once the open visits are read or that read has failed: with no signal the viewer's own
   open visit is not known, and a start queued then over an open visit is moved onto it by this rule (this
   replaces SV1-c unit 1's "only once the open visits are known", which had no queue behind it). Any other
   refused start takes its queued acts with it, and the screen gives the server's reason once. The starting place
   and location of a refused start are not carried over: the open visit already has its own.
4. **Shown at once, from the queue.** Until an act is answered, the screen applies the queued acts in order on top
   of what the server last read. A queued start shows as the viewer's open visit, so Start is not offered twice,
   and the viewer can add places and people to it and end it. Each waiting visit, place or person is marked. An act
   already reflected in a read changes nothing, so nothing shows twice. The server's answer to each act replaces
   the visit, and only a visit this screen shows or is waiting to start is replaced. So an answer that lands after
   a project switch or a new sign-in is not shown there.
5. **When it sends.** It sends right away on each act. It also sends on every realtime ping while the screen is
   open (this includes the socket's reconnect), when the browser says it is back online, when the screen opens, and
   on Send now. A site-visit answer is not counted in the outbox's "synced" line, and it fetches no snapshot,
   because the screen shows it. A refusal goes to the screen in the server's words (English, with the translated
   line in Hindi and Gujarati). When no screen is open, it joins the outbox's "discarded" count instead.
6. **The deferred review points.**
   - A person already on the visit is not offered again in another role, because the server refuses the same
     person twice (#892).
   - A failed team read offers Try again even with an older team on hand: `loadTeam` resolves false on failure
     (#892).
   - The close form goes away once the visit is no longer open (#892).
   - A refresh that fails after it overtook the first read offers Try again instead of loading forever (#905).
   - A time the server set in place of the one claimed is marked "time set by the server" (#905).
