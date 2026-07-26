# Cloudbath LINE Image Archive

This additive OpenClaw plugin archives images accepted by the official LINE channel integration.
Original bytes go to a private Cloudflare R2 bucket. Searchable workflow metadata goes to a
Notion database. Optional image analysis uses the model selected for the inbound OpenClaw
session and cannot prevent R2 or Notion archiving.

The plugin targets OpenClaw `2026.7.2` and uses the supported
`message_received` plugin hook. It does not replace or patch `extensions/line`.

## Processing flow

1. The official LINE plugin verifies the webhook signature and downloads the image with LINE's
   `MessagingApiBlobClient`.
2. OpenClaw writes the unchanged response stream beneath
   `$OPENCLAW_STATE_DIR/media/inbound`.
3. `message_received` supplies this plugin with the managed local media path, detected MIME type,
   LINE message ID, sender ID, account, and `line:group:<group-id>` conversation address.
4. The plugin checks `LINE_ALLOWED_GROUP_IDS` and atomically registers the message in OpenClaw's
   persistent SQLite-backed plugin state.
5. It enforces `IMAGE_MAX_MB`, calculates SHA-256, and uploads the unchanged file to R2 with
   conditional creation. It never sends an ACL, so the object remains private.
6. When enabled, the current session/default OpenClaw model is asked for a description, category,
   tags, vendor, and amount. Analysis failure changes the status to `NEED_REVIEW`; it does not
   roll back the archive.
7. The plugin checks Notion for an existing LINE message ID or SHA-256 before creating a page.
8. A short acknowledgement is sent through OpenClaw's supported LINE outbound adapter.

R2 keys use:

```text
[R2_KEY_PREFIX/]line/YYYY/MM/DD/<group-id>/<message-id>-original.<extension>
```

## Required environment variables

Copy `.env.example` as a reference only. Set real values in the deployment secret manager, never
in the repository.

| Variable                           | Required | Purpose                                                      |
| ---------------------------------- | -------- | ------------------------------------------------------------ |
| `CLOUDBATH_IMAGE_ARCHIVE_ENABLED`  | Yes      | Master switch. Defaults to `false`.                          |
| `CLOUDBATH_IMAGE_ANALYSIS_ENABLED` | No       | Enables current-model image analysis. Defaults to `false`.   |
| `LINE_ALLOWED_GROUP_IDS`           | Yes      | Comma-separated exact LINE group IDs.                        |
| `IMAGE_MAX_MB`                     | No       | Plugin archive limit, default `10`, maximum `100`.           |
| `R2_ACCOUNT_ID`                    | Yes      | Cloudflare account ID.                                       |
| `R2_ACCESS_KEY_ID`                 | Yes      | Bucket-scoped S3 access key ID.                              |
| `R2_SECRET_ACCESS_KEY`             | Yes      | Bucket-scoped S3 secret access key.                          |
| `R2_BUCKET_NAME`                   | Yes      | Existing private bucket name.                                |
| `R2_ENDPOINT`                      | No       | HTTPS S3 endpoint; derived from the account ID when omitted. |
| `R2_KEY_PREFIX`                    | No       | Optional sanitized prefix before `line/`.                    |
| `NOTION_API_KEY`                   | Yes      | Existing Notion integration token.                           |
| `NOTION_DATABASE_ID`               | Yes      | Database ID returned or validated by the one-time setup.     |

Enable the plugin in OpenClaw configuration:

```json5
{
  plugins: {
    entries: {
      "cloudbath-line-image-archive": {
        enabled: true,
      },
    },
  },
}
```

## One-time Notion setup

The setup script is an operator command. OpenClaw does not import or run it during gateway startup,
Railway deployment, or normal image processing.

1. In Notion, open **Settings → Connections → Develop or manage integrations** and create an
   internal integration for Cloudbath. Give it read-content and insert-content capabilities.
2. Create or choose the Notion page that should contain the archive database. Open **Share** on
   that page, select **Connections**, and add the new integration.
3. Store the integration token in a local shell or secret manager as `NOTION_API_KEY`. Store the
   shared parent page ID as `NOTION_PARENT_PAGE_ID`. Never add either value to the repository.
4. From the OpenClaw repository root, run:

   ```bash
   NOTION_API_KEY="$NOTION_API_KEY" \
   NOTION_PARENT_PAGE_ID="$NOTION_PARENT_PAGE_ID" \
   pnpm exec tsx scripts/cloudbath/setup-notion-image-archive.ts
   ```

The command looks beneath the shared parent page for an existing child database named exactly
`Cloudbath LINE Image Archive`. It validates and reuses one matching database. It creates one
database with the required schema only when no match exists, then prints the database ID and data
source ID without printing the integration token.

To validate a known database without changing it, share the database with the integration and run:

```bash
NOTION_API_KEY="$NOTION_API_KEY" \
NOTION_DATABASE_ID="$NOTION_DATABASE_ID" \
pnpm exec tsx scripts/cloudbath/setup-notion-image-archive.ts
```

After successful setup, copy the reported database ID into the existing Railway service as
`NOTION_DATABASE_ID`. Store the same integration token as `NOTION_API_KEY`. Do not add
`NOTION_PARENT_PAGE_ID` to the OpenClaw runtime unless it is also needed for a separate manual
setup operation.

## Notion data source requirements

The plugin uses Notion API version `2026-03-11`. `NOTION_DATABASE_ID` must reference a database
with exactly one data source. The setup script creates, or validation requires, these properties
with the exact names and types:

| Property                | Type         |
| ----------------------- | ------------ |
| `Name`                  | Title        |
| `Received At`           | Date         |
| `LINE Message ID`       | Text         |
| `LINE Webhook Event ID` | Text         |
| `LINE Group ID`         | Text         |
| `LINE User ID`          | Text         |
| `Sender Name`           | Text         |
| `Original Filename`     | Text         |
| `MIME Type`             | Text         |
| `File Size`             | Number       |
| `SHA-256`               | Text         |
| `R2 Object Key`         | Text         |
| `AI Description`        | Text         |
| `Category`              | Select       |
| `Tags`                  | Multi-select |
| `Vendor`                | Text         |
| `Amount`                | Number       |
| `Status`                | Select       |
| `Error`                 | Text         |

Create these `Status` select options:

- `NEW`
- `PROCESSED`
- `NEED_REVIEW`
- `DUPLICATE`
- `ERROR`

The integration needs read-content and insert-content capability for this database.

## Manual LINE setup

Keep the existing official OpenClaw LINE webhook URL and credentials. Do not add a second webhook.

1. In LINE Developers Console, verify the existing Messaging API webhook is enabled and webhook
   verification succeeds.
2. Invite the existing bot to each intended group.
3. Record each exact LINE group ID in `LINE_ALLOWED_GROUP_IDS`.
4. Configure the official LINE group entry with `requireMention: false` for each archive-enabled
   group. The official LINE plugin applies mention policy before `message_received`; an
   unmentioned image cannot reach this plugin otherwise.
5. Ensure the official LINE `mediaMaxMb` is greater than or equal to `IMAGE_MAX_MB`.

Example group policy:

```json5
{
  channels: {
    line: {
      groups: {
        C0123456789abcdef0123456789abcdef: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Manual Cloudflare R2 setup

1. Use an existing R2 bucket or manually create one.
2. Keep public development URLs and custom public domains disabled.
3. Create a token limited to Object Read & Write for this bucket only.
4. Store the access key ID and secret access key in the deployment secret manager.
5. Set the account endpoint in the form
   `https://<account-id>.r2.cloudflarestorage.com`.

The plugin performs `HeadObject` before `PutObject`, sends `If-None-Match: *`, and records SHA-256
in object metadata. It refuses to overwrite an existing key whose size or hash conflicts.

## Reliability and privacy

- The message/account/group tuple is registered atomically in persistent OpenClaw plugin state.
- Incomplete `NEW` and pre-Notion `NEED_REVIEW` jobs are queued again at plugin startup.
- R2 and Notion use four bounded attempts with exponential delays capped at eight seconds.
- Notion is queried by LINE message ID and SHA-256 before page creation.
- Logs contain identifiers, status, object key, size, and sanitized errors only. They never include
  image contents, API keys, access tokens, or private credentials.
- Original bytes are streamed from the official LINE media file to R2 without recompression.
- R2 is the permanent original archive. Notion and model memory are not used as file storage.

## Version limitations

- LINE returns HTTP 200 before asynchronous message processing. A plugin failure cannot ask LINE
  to redeliver the webhook; persistent plugin state and bounded retries provide recovery instead.
- OpenClaw `2026.7.2` does not expose the raw LINE `webhookEventId` or original `replyToken` through
  `message_received`. Those fields remain empty, and acknowledgements use LINE push delivery.
- LINE image messages have no original filename. The stored name is synthesized from the message
  ID and detected MIME extension.
- Sender display name is recorded only if a future or customized LINE context supplies it.
- A currently selected model without image capability produces `NEED_REVIEW`, while R2 and Notion
  archiving continue.

## Validation

All automated tests use local temporary files and mocked R2, Notion, LINE hook, outbound, and model
interfaces. They do not connect to LINE, Cloudflare, Notion, Railway, or any production service.
