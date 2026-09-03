---
summary: "LINE Messaging API plugin setup, config, and usage"
read_when:
  - You want to connect OpenClaw to LINE
  - You need LINE webhook + credential setup
  - You want LINE-specific message options
title: LINE
---

LINE connects to OpenClaw via the LINE Messaging API. The plugin runs as a webhook
receiver on the Gateway and uses your channel access token + channel secret for
authentication.

Status: official plugin, installed separately. Direct messages, group chats, media,
locations, Flex messages, template messages, and quick replies are supported.
Reactions and threads are not supported.

## Install

Install LINE before configuring the channel:

```bash
openclaw plugins install @openclaw/line
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./path/to/local/line-plugin
```

## Setup

1. Create a LINE Developers account and open the Console:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Create (or pick) a Provider and add a **Messaging API** channel.
3. Copy the **Channel access token** and **Channel secret** from the channel settings.
4. Enable **Use webhook** in the Messaging API settings.
5. Set the webhook URL to your gateway endpoint (HTTPS required):

```text
https://gateway-host/line/webhook
```

The Gateway answers LINE's webhook verification (GET) and acknowledges signed
inbound events (POST) immediately after signature and payload validation; agent
processing continues asynchronously.
If you need a custom path, set `channels.line.webhookPath` or
`channels.line.accounts.<id>.webhookPath` and update the URL accordingly.

Security notes:

- LINE signature verification is body-dependent (HMAC over the raw body), so OpenClaw applies a strict pre-auth body limit (64 KB) and read timeout before verification.
- OpenClaw processes webhook events from the verified raw request bytes. Upstream middleware-transformed `req.body` values are ignored for signature-integrity safety.

## Configure

Minimal config:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Public DM config:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "open",
      allowFrom: ["*"],
    },
  },
}
```

Env vars (default account only):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Token/secret files:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

`tokenFile` and `secretFile` must point to regular files. Symlinks are rejected.
Inline config values win over files; env vars are the last fallback for the default account.

Multiple accounts:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Access control

Direct messages default to pairing. Unknown senders get a pairing code and their
messages are ignored until approved:

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Allowlists and policies:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled` (default `pairing`)
- `channels.line.allowFrom`: allowlisted LINE user IDs for DMs; `dmPolicy: "open"` requires `["*"]`
- `channels.line.groupPolicy`: `allowlist | open | disabled` (default `allowlist`)
- `channels.line.groupAllowFrom`: allowlisted LINE user IDs for groups
- Per-group overrides: `channels.line.groups.<groupId>.allowFrom` (plus `enabled`, `requireMention`, `systemPrompt`, `skills`)
- Static sender access groups can be referenced from `allowFrom`, `groupAllowFrom`, and per-group `allowFrom` with `accessGroup:<name>`; see [Access groups](/channels/access-groups).
- Runtime note: if `channels.line` is completely missing, runtime falls back to `groupPolicy="allowlist"` for group checks (even if `channels.defaults.groupPolicy` is set).

LINE IDs are case-sensitive. Valid IDs look like:

- User: `U` + 32 hex chars
- Group: `C` + 32 hex chars
- Room: `R` + 32 hex chars

## Message behavior

- Text is chunked at 5000 characters.
- Markdown formatting is stripped; code blocks and tables are converted into Flex
  cards when possible.
- Streaming responses are buffered; LINE receives full chunks with a loading
  animation while the agent works.
- Media downloads are capped by `channels.line.mediaMaxMb` (default 10).
- Inbound media is saved under `~/.openclaw/media/inbound/` before it is passed
  to the agent, matching the shared media store used by other channel plugins.

## Channel data (rich messages)

Use `channelData.line` to send quick replies, locations, Flex cards, or template
messages.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {/* Flex payload */},
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

The LINE plugin also ships a `/card` command for Flex message presets:

```text
/card info "Welcome" "Thanks for joining!"
```

## ACP support

LINE supports ACP (Agent Communication Protocol) conversation bindings:

- `/acp spawn <agent> --bind here` binds the current LINE chat to an ACP session without creating a child thread.
- Configured ACP bindings and active conversation-bound ACP sessions work on LINE like other conversation channels.

See [ACP agents](/tools/acp-agents) for details.

## Outbound media

The LINE plugin sends images, videos, and audio through the agent message tool:

- **Images**: sent as LINE image messages; the preview image defaults to the media URL.
- **Videos**: require a preview image; set `channelData.line.previewImageUrl` to an image URL.
- **Audio**: sent as LINE audio messages; duration defaults to 60 seconds unless `channelData.line.durationMs` is set.

The media kind is taken from `channelData.line.mediaKind` when set, otherwise inferred
from the other LINE options or the URL file suffix, with image as the fallback.

Outbound media URLs must be public HTTPS URLs of at most 2000 characters. OpenClaw
validates the target hostname before handing the URL to LINE and rejects loopback,
link-local, and private-network targets.

Generic media sends without LINE-specific options use the image route.

## Paid video generation

Video for this flow is generated on **fal.ai only**. OpenRouter is no longer
used to generate video here (it remains available for chat and other uses).

The owner conversation runs in this order, and money enters at the very end:

1. Describe the scene naturally.
2. The bot asks the length (15 or 30 seconds) **before** building anything.
3. It renders a storyboard — time windows, action, camera, characters,
   environment, and beat-level sound design when audio was asked for.
4. `ยืนยัน Storyboard` freezes the scene. This costs nothing and mints no code;
   revisions before it are free and unlimited.
5. Only then does model selection begin: the bot offers a **capability-aware
   default**, or `เปลี่ยนโมเดล` opens a family picker and then a version picker.
6. The Final Video Draft shows the actual fal endpoint that will be billed, and
   its price, with the exact `ยืนยัน VIDEO ####` code.
7. That exact phrase is the only paid trigger, and it is consumed once.

### Model registry

Every selectable endpoint, and its capabilities, lives in one place
(`extensions/line/src/fal-video-registry.ts`). Nothing is fetched or scraped at
runtime.

Each capability records **where it came from**, and that order is a precedence
order — strongest first:

| Provenance          | Source                                                | Notes                                                                                               |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `fal_api_page`      | fal's current official API reference for the endpoint | The deployed contract; wins over everything below.                                                  |
| `fal_model_page`    | fal's current official model page                     | Product-level limits the API reference does not spell out.                                          |
| `fal_client_schema` | generated types in `@fal-ai/client`                   | **Lags fal's live catalog**, so never sufficient on its own and never overrides a current API page. |
| `operator_declared` | your config (`falModels`)                             | For facts none of the above establish.                                                              |

**An unproven capability is never treated as permission** — a model that cannot
be shown to execute the confirmed storyboard is never offered, defaulted to, or
given a payable code.

Endpoints, all reference-to-video (this flow always casts Character Library
identities, so a text-to-video or first-frame endpoint cannot execute its
storyboard):

| Endpoint                                                       | Duration | Resolutions | Audio            | Reference field        | Prompt marker |
| -------------------------------------------------------------- | -------- | ----------- | ---------------- | ---------------------- | ------------- |
| `minimax/h3/reference-to-video`                                | 5–15s    | 768P, 1080P | always on        | `reference_image_urls` | `Image 1`     |
| `minimax/h3-max/reference-to-video`                            | 5–15s    | 480P, 768P  | always on        | `reference_image_urls` | `Image 1`     |
| `bytedance/seedance-2.5/reference-to-video`                    | 4–30s    | 480p, 720p  | `generate_audio` | `image_urls`           | `[Image1]`    |
| `bytedance/seedance-2.0/reference-to-video` (+ `fast`, `mini`) | 4–15s    | up to 4k    | `generate_audio` | `image_urls`           | `@Image1`     |
| `fal-ai/veo3.1/reference-to-video`                             | 8s       | 720p–4k     | `generate_audio` | `image_urls`           | none          |

Consequences worth knowing:

- **H3 and H3 Max are distinct models**, never aliases of each other: different
  endpoints and different output sizes. Naming one when you meant the other
  would bill something you did not choose, so an ambiguous name asks rather
  than picking.
- **Seedance 2.5 is not Seedance 2.0.** Same vendor, different endpoint,
  different marker dialect, and different duration ceiling. A prompt written in
  the wrong dialect does not error — the references are simply ignored and you
  pay for a video without your character in it.
- **A 30-second scene resolves to Seedance 2.5.** H3 tops out at 15 seconds, so
  it is displaced with an explanation rather than the flow dead-ending on "no
  compatible endpoint".
- **Audio is a capability, not a preference.** The H3 endpoints produce native
  synchronized audio on every generation and publish no proven off switch, so
  they can serve a scene that wants sound and are filtered out of one that must
  be silent.

### Configuration

Rates are per endpoint. There is no blended fallback rate, and an endpoint with
no usable rate is simply not payable.

Seedance 2.5 needs no operator rate: fal publishes a token price of
**$0.0214 / 1000 tokens** at both 480p and 720p, and tokens are estimated from
the output pixel area, the duration and 24 FPS. That estimate covers the proven
image-reference case; a shape it cannot prove (reference video or audio inputs)
falls back to your endpoint rate, and without one the endpoint is not offered.

`falModels` supplies only what fal's own pages leave open — H3's duration range
and audio behaviour are read from fal's model page and need no declaration.

```jsonc
{
  "line": {
    "videoGeneration": {
      "maxEstimatedCostUsd": 5,
      "falPricing": {
        "models": {
          "minimax/h3/reference-to-video": {
            "usdPerSecond": 0.1,
            "source": "https://fal.ai/pricing",
          },
          "bytedance/seedance-2.0/reference-to-video": {
            "usdPerSecond": 0.05,
            "byResolution": { "1080p": 0.09 },
            "source": "https://fal.ai/pricing",
          },
        },
      },
    },
  },
}
```

An operator rate always wins over the published token price, so you can pin a
negotiated rate without editing code.

Credentials come from the standard `fal` provider (`FAL_KEY`) and are verified
**before** a payable code is minted, so a code is never handed out that cannot
be spent.

### Delivery and recovery

Generated video is always archived in your R2 bucket and delivered from a signed
R2 URL; a transient provider artifact URL is never sent to LINE. Reference images
are published to fal as short-lived signed R2 URLs, so the bucket stays private.

The job records each stage separately — `provider_submission`,
`provider_generation_completed`, `artifact_retrieval`, `r2_archive`,
`line_delivery` — and only the first spends money. Once generation has
completed, **no failure afterwards re-generates**: the owner can type
`ส่งวิดีโออีกครั้ง` and delivery resumes from the furthest stage that
succeeded, re-signing the archived object or re-fetching fal's own existing
result. That command is scoped to the same account, group and owner.

## Troubleshooting

- **Webhook verification fails:** ensure the webhook URL is HTTPS and the
  `channelSecret` matches the LINE console.
- **No inbound events:** confirm the webhook path matches `channels.line.webhookPath`
  and that the gateway is reachable from LINE.
- **Media download errors:** raise `channels.line.mediaMaxMb` if media exceeds the
  default limit.

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
