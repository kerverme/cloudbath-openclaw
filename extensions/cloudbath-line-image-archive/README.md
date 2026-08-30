# Cloudbath LINE Image Archive

This additive OpenClaw plugin separates permanent image assets from configurable business agents:

1. The official LINE plugin verifies and downloads an image unchanged.
2. This plugin calculates SHA-256 and stores the bytes once in private Cloudflare R2.
3. The exact LINE group selects one active Agent Profile.
4. The Agent Profile selects its Schema Profile and Notion database.
5. Optional model extraction produces fields defined by that schema.
6. A profile-scoped Notion record references the shared R2 object.

It targets OpenClaw `2026.7.2` and uses supported plugin hooks and SQLite-backed plugin state.

## LINE group workspace policies

The plugin also owns a durable, model-independent registry from native LINE group ID to one of two
initial workspace policies: `UGC` or `KEEP_WATCHING`. Bindings and one-time pairing grants use the
existing SQLite-backed plugin state under `OPENCLAW_STATE_DIR`; the model cannot infer or mutate
them.

Only the resolved LINE owner may request a code with the exact text `สร้าง pairing UGC` or
`สร้าง pairing KEEP_WATCHING`. The same owner redeems the short-lived code inside the target LINE
group. Codes are account-bound, owner-bound, single-use, and expire after ten minutes by default.
Changing policy requires a fresh code. `ยกเลิก pairing` or `unpair group` removes the binding only
when sent by the owner inside that group.

`KEEP_WATCHING` is silent: ordinary text is claimed without an assistant reply, and supported image
events are safely read from managed inbound media, content-addressed in the existing R2 bucket, and
written to the one configured Notion data source. Its Notion schema must contain these exact
properties: `Name` (title), `Captured At` (date), `Source` (rich text), `Sender` (rich text),
`Media Type` (rich text), `File Size` (number), `R2 Object Key` (rich text), `SHA-256` (rich text),
`Status` (select), and `Record ID` (rich text). Successful ingestion never replies to the watched
group; failures remain in durable job state and use sanitized diagnostics.

`UGC` exposes no unrestricted Notion tool. The verified owner prepares a product-review workflow
with `cloudbath_ugc_video_prepare`; the tool resolves Product and optional Character records only
inside the configured libraries, creates or reuses one UGC Project, creates an idempotent three-shot
plan, freezes references and targets, then hands the exact prompt/settings to the existing
owner-confirmed `line_video_draft` flow. Paid generation remains impossible until the exact owner
confirmation. All six capability targets must be explicitly configured:

- `PRODUCT_LIBRARY`: read
- `CHARACTER_LIBRARY`: read/write (owner-only latest-image character saves)
- `UGC_PROJECTS`: read/write
- `UGC_SHOTS`: read/write
- `AI_VIDEO_LIBRARY`: read/write
- `AI_IMAGE_LIBRARY`: read/write

Exact non-secret `OPENCLAW_CONFIG_PATH` patch shape (merge this entry without replacing unrelated
plugin configuration):

```json5
{
  plugins: {
    entries: {
      "cloudbath-line-image-archive": {
        enabled: true,
        config: {
          groupWorkspacePolicies: {
            pairingTtlMs: 600000,
            keepWatching: {
              notion: {
                databaseId: "22f2a9c709cb4baa8d41e5988e98f105",
                dataSourceId: "14b2be8ee32d49bb85098530d82b3de2",
              },
              r2Prefix: "workspace/keep-watching/construction",
            },
            ugc: {
              capabilities: {
                PRODUCT_LIBRARY: {
                  databaseId: "3338128fbb6345a9b2a92389ad070ac2",
                  dataSourceId: "7342057309e74999a5a3813afa27d396",
                },
                CHARACTER_LIBRARY: {
                  databaseId: "c9b716a9a305425d89c25254d837ac79",
                  dataSourceId: "e27e904b17bf4a349f11dd6eab57041c",
                },
                UGC_PROJECTS: {
                  databaseId: "4a583619ec254b61acd4c2b87812f95b",
                  dataSourceId: "27452a8424c5465193e48bdbf3772f53",
                },
                UGC_SHOTS: {
                  databaseId: "42d421b1258942b5aa26ef3093ce635e",
                  dataSourceId: "d35ccd4ba44b4ac798e9b3647b201b55",
                },
                AI_VIDEO_LIBRARY: {
                  databaseId: "3d309900f0a2466480b2a98fbae3e206",
                  dataSourceId: "9305e95bdc2d4ed9bd001cd661e3807d",
                },
                AI_IMAGE_LIBRARY: {
                  databaseId: "82d3bf66801a48f79482a71d18dce4e8",
                  dataSourceId: "5438e9ffd76f4d5e870df260a3940b3c",
                },
              },
            },
          },
        },
      },
    },
  },
}
```

Missing targets or runtime credentials fail closed. Every ingest job freezes its group, policy,
workflow type, source capabilities, Notion target, and R2 prefix before processing. UGC cannot use a
KEEP_WATCHING target and KEEP_WATCHING cannot resolve UGC capability slots.

Database IDs are deployment configuration, not Railway environment variables. The only Notion
write credential is `OPEN_CLAW_NOTION_WRITE_TOKEN`.

UGC schema validation requires the documented production fields but permits unrelated additional
properties. In particular, the live relations `Product`, `Character`, `Project`, and `UGC Project`
are validated against their configured data-source IDs and are never created, renamed, deleted, or
retargeted by runtime.

## Save the latest LINE image as a UGC character

In a LINE group already paired to `UGC`, the verified owner can send one supported image and then
use any of these deterministic commands:

- `เก็บรูปนี้เป็นตัวละครชื่อ Kerver`
- `บันทึกรูปล่าสุดเป็นตัวละครชื่อ Kerver`
- `ใช้รูปล่าสุดสร้างตัวละครชื่อ Kerver`
- `อัปเดตตัวละคร Kerver ด้วยรูปล่าสุด`
- `เปลี่ยนรูปตัวละคร Kerver เป็นรูปล่าสุด`

The command is handled before ordinary model dispatch. It fails closed for a non-owner, a group
that is not paired to UGC, or an image from another account/group/owner scope. The managed media
file is safely reopened and rehashed immediately before an immutable conditional R2 upload. No
image generation or other paid provider call is involved.

The object key is derived from the character slug and the actual image bytes:

```text
ugc/characters/<slug-name>/sha256/<first-two-hash-chars>/<sha256>.<detected-extension>
```

The Character Library writer uses the live production schema without mutating it. It writes exactly
one canonical identity locator to `Identity Reference R2 Keys` (rich text), plus `Name` and
`Status: Active` when creating a row. `Character ID` is Notion's generated unique ID and is read
back after creation; the plugin never writes it. `Identity Asset URL` is neither required nor
written. `Preview` is a files property used only for display and is left unchanged because a
private R2 object has no durable public file URL and signed query credentials must not be persisted.

Existing rows need no automatic migration. Runtime reads `Identity Reference R2 Keys` first and
falls back to `Canonical Reference Set` only for legacy rows. It never counts `Preview` as an
identity source and freezes exactly one canonical asset into an active project's character lock,
so updating a Character Library row cannot change already-frozen projects.

## Universal asset identity

R2 is the permanent, shared asset archive. Keys are content-addressed:

```text
[R2_KEY_PREFIX/]assets/sha256/<first-two-hash-chars>/<sha256>.<extension>
```

The extension is derived from file bytes rather than an inbound filename. `HeadObject` plus
conditional `PutObject` prevents overwrites and handles concurrent creation. An existing object
must have matching SHA-256 metadata and size.

The same bytes sent to construction and finance agents therefore produce one R2 object.

## Business-record identity

Notion records are owned by Agent Profiles, not by the global asset store. The default identity is:

```text
<agent-profile-id>:<sha256>
```

The same R2 object can have one construction record and one finance record. A Schema Profile may
instead define an ordered composite identity from extracted property IDs.

## Agent and Schema Profiles

Profiles are ordinary plugin configuration. Adding an agent role or schema does not require source
changes. Startup validation rejects duplicate IDs, missing schema versions, invalid system fields,
and a LINE group assigned to more than one active Agent Profile.

```json5
{
  plugins: {
    entries: {
      "cloudbath-line-image-archive": {
        enabled: true,
        config: {
          version: 1,
          schemaProfiles: [
            {
              id: "property-maintenance",
              name: "Property Maintenance",
              description: "Maintenance evidence and follow-up work",
              version: 1,
              databaseTitle: "Cloudbath Property Maintenance",
              recordIdentityRule: {
                kind: "agent-profile-plus-sha256",
              },
              suggestedViews: [],
              exampleQuestions: ["Which maintenance issues still need action?"],
              properties: [
                {
                  id: "name",
                  name: "Name",
                  notionType: "title",
                  required: false,
                  validationRules: [],
                  searchable: true,
                  aggregatable: false,
                  displayOrder: 1,
                },
                {
                  id: "assetId",
                  name: "Asset ID",
                  notionType: "rich_text",
                  required: true,
                  validationRules: [],
                  searchable: true,
                  aggregatable: false,
                  displayOrder: 2,
                  systemFieldRole: "recordIdentity",
                },
                {
                  id: "sha256",
                  name: "SHA-256",
                  notionType: "rich_text",
                  required: true,
                  validationRules: [],
                  searchable: true,
                  aggregatable: false,
                  displayOrder: 3,
                  systemFieldRole: "sha256",
                },
                {
                  id: "r2ObjectKey",
                  name: "R2 Object Key",
                  notionType: "rich_text",
                  required: true,
                  validationRules: [],
                  searchable: true,
                  aggregatable: false,
                  displayOrder: 4,
                  systemFieldRole: "r2ObjectKey",
                },
                {
                  id: "receivedAt",
                  name: "Received At",
                  notionType: "date",
                  required: true,
                  validationRules: [],
                  searchable: true,
                  aggregatable: true,
                  displayOrder: 5,
                  systemFieldRole: "receivedAt",
                },
                {
                  id: "issueType",
                  name: "Issue Type",
                  notionType: "select",
                  required: false,
                  options: ["PLUMBING", "ELECTRICAL", "STRUCTURAL", "OTHER"],
                  extractionDescription: "Visible maintenance issue category",
                  validationRules: [],
                  searchable: true,
                  aggregatable: false,
                  displayOrder: 6,
                },
              ],
            },
          ],
          agentProfiles: [
            {
              id: "maintenance-bangkok",
              name: "Bangkok Maintenance Agent",
              active: true,
              persona: "Property maintenance coordinator",
              instructions: "Archive authorized evidence and record visible facts.",
              authorizedLineGroupIds: ["<EXACT_LINE_GROUP_ID>"],
              adminLineUserIds: ["<EXACT_ADMIN_USER_ID>"],
              notionDatabaseId: "<NOTION_DATABASE_ID>",
              schemaProfileId: "property-maintenance",
              schemaVersion: 1,
              extractionInstructions: "Never infer facts that are not visible or supplied.",
              allowedTools: ["archive-image", "extract-schema-fields", "write-notion-record"],
              defaultModelAlias: "vision-default",
              allowedModelAliases: ["vision-default"],
              silentToggleCode: "reserved-for-follow-up",
              archiveAcknowledgementsEnabled: true,
            },
          ],
        },
      },
    },
  },
}
```

Every ingestible Schema Profile must have exactly one `title` property and exactly one property for
each required semantic role:

- `recordIdentity` as `rich_text`
- `sha256` as `rich_text`
- `r2ObjectKey` as `rich_text`
- `receivedAt` as `date`

Visible property names remain entirely profile-specific.

## Construction example

`profiles/construction-site-progress.v1.json` is an example Schema Profile only. Its
`agentProfiles` array is empty, so it cannot activate itself or become a global default. It
demonstrates progress, project, zone, floor, discipline, work package, issue, action, due date,
verification, and tag fields.

Copy or adapt the profile into explicit plugin configuration and provide an Agent Profile binding
before runtime use.

## One-time Notion workflow

Create a Notion internal integration in **Settings → Connections**, grant it permission to read
and insert content, and keep its token outside the repository. Create or choose a parent page,
open **Share**, and invite that integration. When binding an existing database, share that
database with the same integration as well.

The manual setup script supports:

- `plan`: render an immutable `SchemaPlanProposal`; no Notion API call.
- `create`: create or safely reuse a database only with the exact proposal approval ID.
- `bind`: validate a database and return the IDs needed by an Agent Profile.
- `validate`: read-only schema validation.
- `migration-plan`: read-only version comparison with `automaticActions: []`.

The script has no `PATCH`, `PUT`, or `DELETE` path. It never runs during gateway startup.

Set a reusable profile path:

```bash
PROFILE_CONFIG=extensions/cloudbath-line-image-archive/profiles/construction-site-progress.v1.json
```

Generate the proposal:

```bash
pnpm exec tsx scripts/cloudbath/setup-notion-image-archive.ts \
  --mode plan \
  --profile-config "$PROFILE_CONFIG" \
  --schema-profile construction-site-progress \
  --schema-version 1
```

Review the proposal, then explicitly approve its exact `proposalId`:

```bash
OPEN_CLAW_NOTION_WRITE_TOKEN="$OPEN_CLAW_NOTION_WRITE_TOKEN" \
NOTION_PARENT_PAGE_ID="$NOTION_PARENT_PAGE_ID" \
pnpm exec tsx scripts/cloudbath/setup-notion-image-archive.ts \
  --mode create \
  --profile-config "$PROFILE_CONFIG" \
  --schema-profile construction-site-progress \
  --schema-version 1 \
  --approve "<EXACT_PROPOSAL_ID>"
```

Bind or validate an existing database without changing it:

```bash
OPEN_CLAW_NOTION_WRITE_TOKEN="$OPEN_CLAW_NOTION_WRITE_TOKEN" \
NOTION_DATABASE_ID="$NOTION_DATABASE_ID" \
pnpm exec tsx scripts/cloudbath/setup-notion-image-archive.ts \
  --mode bind \
  --profile-config "$PROFILE_CONFIG" \
  --schema-profile construction-site-progress \
  --schema-version 1
```

Create a migration proposal:

```bash
OPEN_CLAW_NOTION_WRITE_TOKEN="$OPEN_CLAW_NOTION_WRITE_TOKEN" \
NOTION_DATABASE_ID="$NOTION_DATABASE_ID" \
pnpm exec tsx scripts/cloudbath/setup-notion-image-archive.ts \
  --mode migration-plan \
  --profile-config "$PROFILE_CONFIG" \
  --schema-profile construction-site-progress \
  --schema-version 1 \
  --from-version 0
```

A migration proposal reports missing, incompatible, possible-rename, and unrelated properties.
It never applies them. Administrators must review and make any schema changes separately.

`NOTION_PARENT_PAGE_ID` and `NOTION_DATABASE_ID` are setup inputs. Runtime reads only
`OPEN_CLAW_NOTION_WRITE_TOKEN`; each runtime database ID comes from its Agent Profile. After setup, copy the
reported database ID into that Agent Profile's `notionDatabaseId` configuration field. Add only
`OPEN_CLAW_NOTION_WRITE_TOKEN` to Railway for Notion runtime write access; do not create a global
`NOTION_DATABASE_ID` runtime variable.

## Environment variables

| Variable                           | Runtime purpose                                              |
| ---------------------------------- | ------------------------------------------------------------ |
| `CLOUDBATH_IMAGE_ARCHIVE_ENABLED`  | Master switch; defaults to `false`.                          |
| `CLOUDBATH_IMAGE_ANALYSIS_ENABLED` | Enables schema-based extraction; defaults to `false`.        |
| `IMAGE_MAX_MB`                     | Archive limit, default `10`, maximum `100`.                  |
| `R2_ACCOUNT_ID`                    | Cloudflare account ID.                                       |
| `R2_ACCESS_KEY_ID`                 | Bucket-scoped S3 access key ID.                              |
| `R2_SECRET_ACCESS_KEY`             | Bucket-scoped S3 secret.                                     |
| `R2_BUCKET_NAME`                   | Existing private bucket.                                     |
| `R2_ENDPOINT`                      | Optional HTTPS S3 endpoint.                                  |
| `R2_KEY_PREFIX`                    | Optional prefix before `assets/`.                            |
| `OPEN_CLAW_NOTION_WRITE_TOKEN`     | Canonical credential for allowlisted OpenClaw Notion writes. |
| `NOTION_WELLNESS_READ_TOKEN`       | Read-only Wellness tool credential.                          |

LINE group allowlists and Notion database IDs are no longer global environment variables.

## Scoped Wellness and Construction tools

The plugin also registers scoped optional agent tools. They are unavailable to agents until each
tool is explicitly allowlisted:

- `wellness_notion_query`, `wellness_notion_get_record`, and `wellness_notion_search` are
  read-only and fixed to the Wellness project root page. They discover only direct
  `child_database` blocks beneath that root, query those databases' data sources, and never use
  Notion's workspace-wide search endpoint.
- `construction_upload_create` and `construction_upload_update` write only allowlisted
  properties in the Construction Upload Inbox. Creation always uses the fixed data source, and
  updates resolve a page by its `Record ID` inside that data source rather than accepting a page
  or database target from the model.
- `cloudbath_ugc_video_prepare` exists only for a verified owner in a LINE group paired to UGC. It
  reads/writes only the six configured capability targets and never calls a paid provider.

Read and write access remain independently authenticated. Wellness tools use only
`NOTION_WELLNESS_READ_TOKEN`; Construction writes use only `OPEN_CLAW_NOTION_WRITE_TOKEN`. The Wellness
integration should have read-content capability only and must be shared with the configured
Wellness root page so its direct child databases are visible. The Construction integration needs read,
insert, and update-content capabilities on the Upload Inbox so the plugin can validate its schema,
prevent duplicate Record IDs, and update an existing row. Neither integration needs schema-update,
comment, or delete capabilities.

All tools are registered as optional. Enable only the intended tools on the LINE agent, for
example:

```json5
{
  agents: {
    list: [
      {
        id: "<LINE_AGENT_ID>",
        tools: {
          allow: [
            "wellness_notion_query",
            "wellness_notion_get_record",
            "wellness_notion_search",
            "construction_upload_create",
            "construction_upload_update",
            "cloudbath_ugc_video_prepare",
          ],
        },
      },
    ],
  },
}
```

This tool allowlist does not replace the official LINE channel's group and sender authorization.
The plugin does not register a generic Notion request tool and does not expose credentials or
environment variables in tool results.

## Runtime safety

- Production assumes exactly one Railway gateway replica while the plugin uses its process-local
  serial worker.
- Use a dedicated private R2 bucket or credentials restricted to an exclusive plugin prefix.
- Official LINE `allowFrom` controls remain responsible for sender authorization; Agent Profile
  group routing is an additional scope boundary, not a replacement for `allowFrom`.
- Keep `CLOUDBATH_IMAGE_ANALYSIS_ENABLED=false` for the first production pilot.
- The official LINE integration continues to own webhook verification and media download.
- Original bytes are read into a bounded `IMAGE_MAX_MB` buffer and uploaded to R2 without
  recompression.
- Persistent job state uses OpenClaw's shared SQLite-backed plugin store namespace
  `archive-jobs-v2`.
- R2 and Notion use bounded retries.
- Runtime validates Notion schemas but never creates or modifies database properties.
- An unknown group is ignored.
- Ambiguous active group routing prevents startup.
- Optional extraction failure leaves the asset archived and marks the business record for review.
- Acknowledgements are controlled independently by each Agent Profile.
- Logs never include image contents, API tokens, access keys, or credentials.

## Deferred capabilities

This PR defines model aliases, allowed tools, and `SchemaPlanProposal`, but deliberately does not
implement:

- Notion aggregate/statistics tools for the model
- chat-driven model switching
- persistent `7272` silent mode
- advanced multi-agent routing
- LLM-generated schema planning

## OpenClaw 2026.7.2 limitations

- `message_received` does not expose raw LINE `webhookEventId` or the original `replyToken`.
- LINE image events do not contain an original filename.
- The current session model is used for optional extraction; profile-driven model switching is
  deferred.
- Notion databases must contain exactly one data source.

All automated tests mock R2, Notion, LINE, and model boundaries. They do not access production
services or secrets.

## Multi-character identity lock and scenes

A UGC project may cast several characters by name (`characterNames: ["F1", "F2"]`;
the older single `characterName` still works). Every requested code must resolve
to exactly one Character Library row before anything is created — a partial cast
never reaches a scene.

### Character Library properties this reads

Identity references, in order (the first usable property wins):

- `Identity Reference R2 Keys`
- `Canonical Reference Set` (legacy-read fallback only)

Style references: `Style Reference R2 Keys`.

`Preview` is display-only and is never submitted as another identity reference. Values in the
primary fields are still validated as R2 keys or HTTPS URLs. A canonical queryless URL for the
configured private R2 endpoint and bucket is converted back into an authenticated R2 object-key
reference before generation; signed URL query credentials are neither required nor persisted.

A character with no usable identity reference fails closed rather than being
cast invisibly.

### What the lock guarantees

The first preparation for a project freezes each character's references into a
durable project lock (`ugc-project-character-lock-v1`, no TTL). Later scenes in
that project reuse the stored lock verbatim — the Character Library is never
re-queried for them, so editing a library row cannot change an in-flight
project's references. Asking for a different cast on a locked project is
rejected; start a new project instead.

This guarantees the same reference assets are **submitted** for every scene. It
does not mean the generative model renders identical subjects across scenes, and
nothing here should be described as preventing visual drift.

### Reference allocation

Each scene gets at most `MAX_REFERENCE_ASSETS` (8) references. Allocation gives
every cast member one identity slot first, then distributes the remainder
round-robin, then product, then style. If the cast is larger than the budget the
request fails closed — a character is never silently dropped to fit.

### Scenes

Scenes are rows in `UGC_SHOTS`, one per scene, keyed by project + scene number so
a replayed preparation reuses the row. Omitting `sceneNumber` prepares the next
scene in the project. This replaces PR #32's fixed three-shot Hook/Product/Close
plan.

Each prepared scene carries continuity metadata: scene number, previous scene
page id, participating character page ids and codes, prompt, and duration.

### Scene result ledger (live UGC_SHOTS columns)

Writes use the **actual production column names**. There is no `Shot Number`,
`Duration Seconds` or `Output R2 Key`, and neither UGC database has a
`Record ID`.

| Workflow value      | Live UGC_SHOTS column     |
| ------------------- | ------------------------- |
| scene order         | `Shot Order`              |
| scene duration      | `Duration`                |
| archived object key | `Generated R2 Object Key` |
| hosted result URL   | `Generated Asset URL`     |
| provider model      | `Model`                   |
| cost                | `Actual Cost USD`         |
| completion time     | `Completed At`            |
| sanitized failure   | `Failure Reason`          |

After a confirmed generation only the **confirmed scene** is written —
completing scene 1 never marks scene 2 completed. Optional columns are written
only when the live data source has them; Notion rejects a PATCH naming an
unknown property, so an absent column would otherwise lose the Status write too.

### Status values

Both UGC databases expose exactly `Draft`, `Ready`, `Generating`, `Completed`,
`Failed`. Nothing writes `Processing` or `Awaiting Confirmation`. The mapping:

| Workflow state                        | Status       |
| ------------------------------------- | ------------ |
| new project / scene                   | `Draft`      |
| prepared, awaiting owner confirmation | `Ready`      |
| paid execution started                | `Generating` |
| success                               | `Completed`  |
| failure                               | `Failed`     |

Startup schema validation checks these options exist, so a drifted database
fails closed at validation instead of when a paid scene tries to report.

### Project identity

A project is a **piece of work**, not a product/cast combination. The same
product with the same characters can be three unrelated stories, each needing
its own scenes, character lock, costs and outputs.

Identity is therefore an application-owned **project instance id** held in
durable state and bound to the created Notion page. Notion's own `Project ID` is
Notion-managed and cannot be chosen by us, and neither UGC database has a
`Record ID` — **no new property is required**.

Each conversation has an **active project**, persisted restart-safely and scoped
to the trusted LINE account + native group + owner triple. Nothing the model
emits can retarget it.

- `cloudbath_ugc_video_prepare` **continues** the active project by default.
- `startNewProject: true` mints a new instance, a new Notion row and a new
  character lock — even when product and cast are identical.
- Replaying a scene preparation on the active project is idempotent: scenes
  resolve by `Project` relation plus `Shot Order`.

### Product is optional

A project may be **character-only**: F1 + F2 with no product at all. No
placeholder product row is invented, and the Notion `Product` relation is simply
left empty. `productName` is optional; only `prompt` is required.

### Product and character identity both freeze at project creation

A project with a product freezes its product page id **and its generation
reference assets** alongside the character lock. Editing the Product Library
afterwards cannot reach that project; a deliberately new project is free to
freeze the updated references.

### Continuation runs on frozen identity

`ต่อ Scene 2 ...` reuses the active project's frozen product and cast. Neither
the Product Library nor the Character Library is re-resolved as authoritative
identity, so:

- the owner does not need to repeat `productName` when continuing;
- renaming or editing a library row cannot retarget an in-flight project;
- naming a **different** product while the active project is locked to another
  fails closed — start a new project to change it.

The same rule already applied to the cast: requesting a different set of
characters on a locked project is rejected.

### Project lifecycle

| State                                              | Status       |
| -------------------------------------------------- | ------------ |
| project created                                    | `Draft`      |
| scenes prepared, awaiting owner                    | `Ready`      |
| scenes generating or generated, project still open | `Generating` |
| explicit owner finalization                        | `Completed`  |
| fatal failure                                      | `Failed`     |

**A finished scene never completes the project.** Absence of a scene 2 row is not
evidence the film is done — the owner may say "ต่อ Scene 2" next. Only
`cloudbath_ugc_project_finalize` moves a project to `Completed`. It is
owner-only, bound to the active project, and performs **no provider call**, so
finalization can never incur cost.

Finalization is **durable**: the project instance records `finalizedAt`, and a
finalized project is closed for good.

- continuing a finalized project fails closed;
- it never returns to `Ready` or `Generating`;
- finalizing again is idempotent, returning `already_finalized` with the
  original timestamp and writing nothing further;
- `startNewProject: true` begins a fresh project normally.

`Final R2 Object Key`, `Final Video URL` and project `Completed At` are written
**only at finalization**, from the highest-numbered completed scene. Nothing is
stitched, so that is the last scene's asset rather than a combined reel.

Scene-level `Generated R2 Object Key`, `Generated Asset URL` and `Completed At`
are written after each scene, as before.

### Project prompt

Live UGC_PROJECTS has no `Prompt` column. `Script` was considered and rejected —
it is a script field, not a generation prompt, and reusing it would misrepresent
its meaning. The prompt is preserved per scene in `Prompt` on UGC_SHOTS and in
the durable frozen scope.

### No automatic schema mutation

This plugin never provisions or alters Notion schema. Every column above already
exists in production; nothing further needs to be added for the current flow.
`Characters` and `Previous Scene` relations on UGC_SHOTS are **not** written —
cast and continuity live in the frozen scope, which is what execution reads.

## CozyClay previs (Phase 1)

Previs is a **staging** layer between a scene request and the existing paid
video pipeline. It produces reviewable blocking, camera and timeline intent so
an owner can iterate before any provider is billed. It is **not** a video
generator, and approving a previs does not generate anything.

### Boundary

Cloudbath owns identity and durability; CozyClay is only the previs engine.

| owner     | responsibility                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudbath | Character identity, frozen locks, project/scene identity, timeline metadata, aspect ratio, version chain, approval, stable review URL, private R2 storage |
| CozyClay  | stage geometry, cast placement, camera solve, film vocabulary, `.cclayproject` serialization                                                              |

Canonical Characters map onto **generic** CozyClay stand-ins by frozen cast
order — `CHAR-6 → A`, `CHAR-7 → B`. The stand-in letter is engine detail. The
stand-in's description is generic geometry (`previs stand-in A`), so no identity
reference reaches the engine, and the CozyClay actor never replaces the
canonical Character. Photoreal identity references stay Cloudbath's job in the
later video pipeline.

### Integration and licensing

CozyClay is **AGPL-3.0-or-later**. It is integrated as a **separate process**
over the Model Context Protocol: no CozyClay source is vendored into this
repository, and none of its code is linked into the Cloudbath process. The
boundary is CozyClay's own documented MCP tool surface, reached over stdio from
`previs-cozyclay-engine.ts`.

The server command is **configured, not discovered**. Resolving CozyClay through
`npx` at request time would let a fresh upstream release change previs output
underneath an in-flight project, so a deployment pins an installed version and
passes its `mcp/server.mjs` path explicitly.

This is an engineering note about the technical boundary, not legal advice.

### What works headlessly, and what does not

Verified against CozyClay 1.6.0. Its MCP server runs the scene, camera, prompt
and project-file tools with no browser, editor or GPU. Four tools refuse
without a connected editor tab, and motion additionally needs an SSH-reachable
NVIDIA host running Kimodo.

| capability                                                                  | Phase 1  | requires                       |
| --------------------------------------------------------------------------- | -------- | ------------------------------ |
| cast placement, camera solve, framing, film vocabulary, `.cclayproject` I/O | yes      | nothing                        |
| timeline Prompt Blocks (`set_prompt_blocks`)                                | deferred | live editor                    |
| preview frames (`capture_frame`)                                            | deferred | live editor                    |
| batched mutation (`apply_batch`)                                            | deferred | live editor                    |
| character motion (`generate_motion`)                                        | deferred | live editor **and** Kimodo GPU |

Deferrals are recorded on every previs version rather than silently omitted, so
a reviewer is never shown an empty timeline and told the previs is complete.
Because the timeline is editor-only upstream, Cloudbath holds timeline metadata
itself — which it needs for the later video pipeline regardless.

Aspect ratio is the one field written directly into the artifact:
`stage.shotAspect` accepts `9:16` in CozyClay's scene normaliser, but no MCP
tool sets it headlessly. CozyClay honours the written value on `open_project`.

### Production engine and provisioning (Phase 2A)

The engine is wired for real. At service start the plugin resolves a **pinned**
CozyClay install and verifies its version against that package's own
`package.json`; a wrong path or version disables previs and logs
`previs_engine_unavailable` rather than rendering with an unverified engine.
Nothing resolves CozyClay at request time — no `npx`, no `@latest`, no download.

The production image installs CozyClay 1.6.0 in its own build stage
(`FROM ... AS cozyclay`), verifies the version, installs the pinned MCP runtime
dependencies and boots the server once, so a missing dependency fails the build
instead of the first render. `CLOUDBATH_COZYCLAY_ROOT` and
`CLOUDBATH_COZYCLAY_VERSION` point the runtime at that install.

`CloudbathPrevisService` binds the engine and the private-R2 artifact sink once
and is the seam Phase 2B's LINE routing will call. It is deliberately **not**
registered as a model-facing tool yet.

**Concurrency and process safety.** CozyClay's stdio server always starts its
live hub and rejects port 0, so each render allocates its own ephemeral loopback
port and its own `mkdtemp` project root. Renders are bounded by a timeout, the
MCP client is closed on every path, and the temp root is removed on success,
failure and timeout — so a failed render leaves no orphan process and no
partial version.

### The review page

`/previs/<ID>/<TOKEN>` serves a **human 3D review page**: play, pause, scrub, a
playhead, current second and duration, the version and approved/draft state, the
cast, the current shot and the current action. `/previs/<ID>/<TOKEN>/v1` reviews
a historical version; the bare URL always follows latest. The JSON capability
endpoints keep their explicit segments and are unchanged.

The viewer is Cloudbath-owned and dependency-free. CozyClay's own studio is an
AGPL Vite application; serving it — or an adaptation of it — would ship AGPL
frontend code over a network and engage the section 13 source-offer obligation.
Rendering Cloudbath's own `PrevisDocument` with our own arithmetic keeps the
AGPL work confined to the separate MCP process and keeps the browser free of
third-party code. There are no external scripts, styles, fonts or images, so
nothing can leak the capability token in the URL; the page is served with a
closed CSP, `no-store` and `no-referrer`, and never renders the R2 object key.

The player's camera solve is a **review approximation** of the same film
vocabulary, not CozyClay's geometry. The authoritative solve stays in the
`.cclayproject` the engine produced.

### LINE create / edit / approve (Phase 2B)

A previs request is routed **deterministically**, not by hoping the model picks
the right tool. `CloudbathPrevisLineRouter.handleBeforeDispatch` classifies the
message and returns `{ handled: true }`, so the turn ends before the model runs.
That is the fix for the structural routing problem: a character-led scene
request could previously be understood semantically and then answered with a
generic `[[confirm:...]]` yes/no prompt instead of invoking the workflow. A
generic confirm can no longer substitute for a previs action, because the model
is never given the turn.

Three intents are recognised, and nothing else is claimed — every other message,
including the generic video path and the exact `ยืนยัน VIDEO ####` gate, passes
through untouched:

| intent  | trigger                                                        | effect                     |
| ------- | -------------------------------------------------------------- | -------------------------- |
| create  | named cast + scene wording (the word "previs" is not required) | previs v1 + stable URL     |
| edit    | a time range such as `10-14` after a seconds word              | a new immutable version    |
| approve | exactly `APPROVE PREVIS` or `อนุมัติ PREVIS`                   | freezes the latest version |

Character names are matched against the names the Character Library actually
holds, so an unknown name fails closed naming it rather than silently recasting
the scene. Ambiguous library entries fail closed too, via the same
`resolveNamedRecord` the video workflow uses. Cast order fixes the stand-in
letters for the life of the project: Twong stays A and Twong2 stays B across
v1/v2/v3. A Product is never required.

The **active previs** is keyed by the trusted account / LINE group / owner
triple — never a global "latest" — so a different group or a different owner
resolves nothing. LINE mutations authorise on that triple, never on the browser
capability token, which exists only for review.

Duplicate webhook delivery is absorbed by replaying the first reply for the same
inbound message id, so a retry cannot create a second previs or append a second
version. Concurrent edits still contend on the Phase 1 version slot: one wins,
the other is refused loudly rather than silently dropped.

Nothing here is paid. Creating, editing or approving a previs performs no
provider call, produces no video draft, and never consumes a `VIDEO ####` code.
`APPROVE PREVIS` only records that a previs version is approved.

### Still not wired (later phases)

- Turning an approved previs into a Final Video Draft.
- CozyClay's live editor: prompt blocks, frame capture and Kimodo motion stay
  recorded as deferrals on every version.
