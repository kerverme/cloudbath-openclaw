import { stringEnum } from "openclaw/plugin-sdk/core";
import { Type, type Static } from "typebox";
import { STORYBOARD_ASPECT_RATIOS } from "./storyboard-types.js";

const text = () => Type.String({ minLength: 1, maxLength: 4000 });
export const storyboardToolSchema = Type.Object(
  {
    action: stringEnum(["read", "save", "render"] as const),
    baseVersionNumber: Type.Optional(Type.Integer({ minimum: 1 })),
    newStoryboard: Type.Optional(Type.Boolean()),
    brief: Type.Optional(text()),
    aspectRatio: Type.Optional(stringEnum(STORYBOARD_ASPECT_RATIOS)),
    columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    panels: Type.Optional(
      Type.Array(
        Type.Object(
          {
            framing: text(),
            action: text(),
            caption: Type.String({ maxLength: 160 }),
            dialogue: Type.Optional(Type.String({ maxLength: 1000 })),
            camera: Type.Optional(text()),
            environmentNote: Type.Optional(Type.String({ maxLength: 4000 })),
            soundDesign: Type.Optional(Type.String({ maxLength: 4000 })),
            characterIds: Type.Array(Type.String()),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 24 },
      ),
    ),
    references: Type.Optional(
      Type.Array(
        Type.Object(
          {
            image: text(),
            role: stringEnum(["identity", "style"] as const),
          },
          { additionalProperties: false },
        ),
        { maxItems: 8 },
      ),
    ),
  },
  { additionalProperties: false },
);

export type StoryboardToolInput = Static<typeof storyboardToolSchema>;
