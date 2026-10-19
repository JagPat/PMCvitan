# Site Visits SV2: media on a visit

Work item: #792 (SV2 Observations). Owner direction, 19 Oct 2026 (Jagrut, Site Visits thread): a visit records only
times today and "feels empty"; it should hold photos, sketches, video and other media. Media comes first, menus later.

## Units

1. **Database (this unit, shipped alone).** A new table `SiteVisitMedia`: one row per file the visitor adds on a visit,
   pointing at an existing `Media` row, with an optional note (at most 500 characters, never blank), an optional
   rating (Fine, Concern, Action needed), the place the file showed when it was added, who added it and when.
2. **Server.** The media upload takes an optional visit. The site-visits module writes the link as the upload's
   workflow participant, in the upload's transaction and under the visit's row lock. The visit read returns its files.
3. **Screen.** "Add photo" on an open or ended visit, reusing the Dashboard "Add site photo" button (#978) and its
   offline path (the photo's `clientKey`, #925). The visit lists its photos with their notes.
4. **Later, the same way.** Marked-up copies (sketches), voice notes and video from the Stage 1 media plan are `Media`
   rows, so each attaches to a visit through this table with no further schema change here.

## Hard choices

1. **A link table on an existing file, not new columns on `Media` or a new observation record.**
   - `Media` already holds the file, its place, its uploader, its camera time and location, and its offline key.
   - The Stage 1 media plan extends `Media`, so a link from the visit side lets every new kind attach unchanged.
   - Columns on `Media` were tried first. A foreign key from `Media` into `SiteVisit` makes the seed's reset statement
     (which truncates `SiteVisit`) name `Media`, and with it every table that references `Media`. The link table
     references both, so only it joins that statement.
2. **No new event type.** The upload keeps its `media.uploaded` event. A new `sitevisit.*` type would move the sealed
   effect catalog and need an operator reseal at deploy, which this change does not need.
3. **The row is a record; the "who may add" rule is the server's.** The database stamps when a file was added, copies
   its place at that moment, refuses a blank note, and freezes the row (round-1 review). Who may add (Jagrut, 19 Oct:
   the visitor and anyone recorded as present on the visit, not after it is closed) is checked by the site-visits
   module under the visit's row lock, as an inspection checks its evidence. The triggers, the CHECK and the place key's
   column-list `SET NULL` are not modelled by `prisma db push`, so the file is on `scripts/migrate.sh`'s ALWAYS_EXECUTE.
4. **Deletes follow the file.** Removing the file removes its link (`ON DELETE CASCADE`), so the existing photo delete
   rules are unchanged. A visit is never deleted outside a project cascade.
5. **One visit per file.** The file id is the key. A photo of a crack belongs to the visit it was taken on.
6. **The rating (Fine, Concern, Action needed) is stored now, used later.** It is a nullable Prisma enum on the link, so
   it ships in this migration instead of a second migration-alone PR. "Action needed" raising an item is SV3's.
7. **The place is the one at the visit.** `Media.nodeId` can be refiled or unfiled later, so the insert copies it
   (and the place's published name) onto the link. Removing the place clears only the reference, as SV1-a's places do;
   the name stays. A file with no place, or on an unpublished draft, records none.
