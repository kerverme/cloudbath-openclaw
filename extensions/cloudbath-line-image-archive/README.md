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
- `CHARACTER_LIBRARY`: read
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
write credential is `OPENCLAW_NOTION_WRITE_TOKEN`.

UGC schema validation requires the documented production fields but permits unrelated additional
properties. In particular, the live relations `Product`, `Character`, `Project`, and `UGC Project`
are validated against their configured data-source IDs and are never created, renamed, deleted, or
retargeted by runtime.

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
OPENCLAW_NOTION_WRITE_TOKEN="$OPENCLAW_NOTION_WRITE_TOKEN" \
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
OPENCLAW_NOTION_WRITE_TOKEN="$OPENCLAW_NOTION_WRITE_TOKEN" \
NOTION_DATABASE_ID="$NOTION_DATABASE_ID" \
pnpm exec tsx scripts/cloudbath/setup-notion-image-archive.ts \
  --mode bind \
  --profile-config "$PROFILE_CONFIG" \
  --schema-profile construction-site-progress \
  --schema-version 1
```

Create a migration proposal:

```bash
OPENCLAW_NOTION_WRITE_TOKEN="$OPENCLAW_NOTION_WRITE_TOKEN" \
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
`OPENCLAW_NOTION_WRITE_TOKEN`; each runtime database ID comes from its Agent Profile. After setup, copy the
reported database ID into that Agent Profile's `notionDatabaseId` configuration field. Add only
`OPENCLAW_NOTION_WRITE_TOKEN` to Railway for Notion runtime write access; do not create a global
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
| `OPENCLAW_NOTION_WRITE_TOKEN`      | Canonical credential for allowlisted OpenClaw Notion writes. |
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
`NOTION_WELLNESS_READ_TOKEN`; Construction writes use only `OPENCLAW_NOTION_WRITE_TOKEN`. The Wellness
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

Identity references, in order:

- `Identity Reference R2 Keys`
- `Canonical Reference Set`
- `Preview`

Style references: `Style Reference R2 Keys`.

Only these live names are read. Values are still validated as R2 keys or HTTPS
URLs exactly as before; nothing about that check was relaxed.

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

### Optional schema additions (not applied automatically)

The scene ledger currently writes only fields PR #32 already provisions
(`Name`, `Record ID`, `Status`, `Project`, `Shot Number`, `Prompt`). To have the
ledger also carry per-scene execution data, add these to `UGC_SHOTS` manually —
this plugin never mutates live schema:

| Property             | Type                         | Purpose                     |
| -------------------- | ---------------------------- | --------------------------- |
| `Duration Seconds`   | number                       | Scene duration as confirmed |
| `Characters`         | relation → Character Library | Cast actually submitted     |
| `Model`              | rich_text                    | Provider model id used      |
| `Estimated Cost USD` | number                       | Shown at confirmation       |
| `Actual Cost USD`    | number                       | Reported after generation   |
| `Output R2 Key`      | rich_text                    | Archived result object key  |
| `Previous Scene`     | relation → UGC_SHOTS         | Continuity link             |

Until they exist the workflow keeps working; the data lives in the frozen scope
rather than the ledger.
