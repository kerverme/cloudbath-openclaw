import { describe, expect, it, vi } from "vitest";
import {
  CREATE_MESSAGE,
  expectNothingBillable,
  harness,
  NAMES,
  resolver,
} from "./storyboard-router.test-support.js";

describe("E. a generic confirmation can never pay", () => {
  it("leaves bare agreements to the normal flow and drafts nothing", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });

    for (const message of ["ยืนยัน", "โอเค", "ทำเลย", "เอาเลย", "สร้างเลย", "yes", "confirm", "go"]) {
      const result = await h.dispatch(message, { messageId: `m-${message}` });
      expect(result.source, message).toBe("model");
      expect(result.handled, message).toBe(false);
    }
    expect((await h.drafts.entries()).length).toBe(0);
    await expectNothingBillable(h);
  });
});

describe("F. the exact VIDEO confirmation gate is untouched", () => {
  it("never claims a message shaped like the paid confirmation", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    for (const code of ["1234", "4827", "0001"]) {
      const result = await h.dispatch(`ยืนยัน VIDEO ${code}`, { messageId: `c-${code}` });
      expect(result.source, code).toBe("model");
    }
  });

  it("keeps the shipped gate pattern intact", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("extensions/line/src/video-confirmation.ts", "utf8");
    expect(source).toContain(String.raw`/^ยืนยัน\s+VIDEO\s+(\d{4})$/iu`);
  });
});

describe("G. previs stays reachable for explicit legacy requests", () => {
  it("routes a natural request to storyboard, not previs", async () => {
    const h = harness();
    expect((await h.dispatch(CREATE_MESSAGE, { messageId: "m1" })).source).toBe("storyboard");
    expect((await h.previsVersions.entries()).length).toBe(0);
  });

  it("routes an explicit PREVIS request to the previs flow", async () => {
    const h = harness();
    const result = await h.dispatch(`PREVIS ${CREATE_MESSAGE}`, { messageId: "p1" });
    expect(result.source).toBe("previs");
    expect(result.text).toContain("Previs v1");
    expect((await h.previsVersions.entries()).length).toBe(1);
    expect(h.previsEngineCalls).toHaveBeenCalledTimes(1);
  });

  it("routes an explicit previs approval to the previs flow", async () => {
    const h = harness();
    await h.dispatch(`PREVIS ${CREATE_MESSAGE}`, { messageId: "p1" });
    const result = await h.dispatch("APPROVE PREVIS", { messageId: "p2" });
    expect(result.source).toBe("previs");
    expect(result.text).toContain("อนุมัติ Previs");
  });
});

describe("H. inbound retries are idempotent", () => {
  it("replays the first reply instead of creating a second version or draft", async () => {
    const h = harness();
    const first = await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const replay = await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    expect(replay.text).toBe(first.text);
    expect((await h.storyboardVersions.entries()).length).toBe(1);

    await h.dispatch("วิ 10-14 ให้ Twong หันกลับมามอง Twong2", { messageId: "m2" });
    await h.dispatch("วิ 10-14 ให้ Twong หันกลับมามอง Twong2", { messageId: "m2" });
    expect((await h.storyboardVersions.entries()).length).toBe(2);

    const draft = await h.dispatch("สร้างวิดีโอ", { messageId: "m3" });
    const draftReplay = await h.dispatch("สร้างวิดีโอ", { messageId: "m3" });
    expect(draftReplay.text).toBe(draft.text);
    expect((await h.drafts.entries()).length).toBe(1);
  });
});

describe("I. concurrent edits never silently overwrite", () => {
  it("lets exactly one edit win and tells the other to retry", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });

    const [left, right] = await Promise.all([
      h.dispatch("วิ 3-6 ให้ Twong หยุดมอง Twong2", { messageId: "edit-a" }),
      h.dispatch("วิ 8-11 ให้ Twong2 เดินออกไป", { messageId: "edit-b" }),
    ]);

    const outcomes = [left.text, right.text];
    const winners = outcomes.filter((text) => text?.includes("Storyboard v2"));
    const rejected = outcomes.filter((text) => text?.includes("พร้อมกัน"));
    expect(winners.length).toBe(1);
    expect(rejected.length).toBe(1);
    // Exactly two versions exist: v1 and the single winning v2.
    expect((await h.storyboardVersions.entries()).length).toBe(2);
    expect((await h.latest()).versionNumber).toBe(2);
  });
});

describe("J. canonical character identity never regresses", () => {
  it("stores canonical ids while display names stay presentation only", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const version = await h.latest();

    expect(version.characterLocks.map((entry) => entry.code)).toEqual(["CHAR-6", "CHAR-7"]);
    for (const member of version.document.cast) {
      expect(member.characterId).toMatch(/^CHAR-\d+$/u);
      expect(member.characterId).not.toBe(member.displayName);
    }
    for (const beat of version.document.beats) {
      for (const id of beat.characterIds) {
        expect(NAMES).not.toContain(id);
        expect(id).toMatch(/^CHAR-\d+$/u);
      }
    }
  });

  it("fails closed when a named character is not in the library", async () => {
    const h = harness();
    const result = await h.dispatch("ใช้ Twong กับ Nobody ให้เดินคุยกัน 10 วิ แนวตั้ง", { messageId: "m1" });
    expect(result.source).toBe("storyboard");
    expect(result.text).toContain("Nobody");
    expect((await h.storyboardVersions.entries()).length).toBe(0);
  });

  it("fails closed when the resolver cannot produce a canonical id", async () => {
    const h = harness({
      resolver: resolver({
        resolveProject: async () => {
          throw new Error('Character "Twong" has no generated Character ID');
        },
      }),
    });
    const result = await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    expect(result.text).toContain("ไม่สำเร็จ");
    expect((await h.storyboardVersions.entries()).length).toBe(0);
  });
});

describe("classifier breadth (regression)", () => {
  it("does not mint a storyboard for conversation that merely names a character", async () => {
    const h = harness();
    for (const message of [
      "Twong ยืนอยู่ไหน",
      "Twong2 นั่งกินข้าวหรือยัง",
      "Twong พูดว่าอะไรนะ",
      "Twong looks at the menu",
      // Storyboard previously claimed these too: a bare "วิ" inside "วิธี" or
      // "วิทยาลัย", and any "\d:\d". The previs classifier still matches them,
      // which is pre-existing behaviour on main and out of scope here — what
      // this PR owns is that STORYBOARD declines and writes nothing.
      "Twong คิดว่าวิธีนี้ดีไหม",
      "Twong มาถึงตอน 10:30 นะ",
      "Twong2 อยู่วิทยาลัยหรือเปล่า",
    ]) {
      const result = await h.dispatch(message, { messageId: `q-${message}` });
      expect(result.source, message).not.toBe("storyboard");
    }
    expect((await h.storyboardVersions.entries()).length).toBe(0);
  });

  it("leaves plain conversation to the model entirely", async () => {
    const h = harness();
    for (const message of ["สวัสดีครับ", "Twong ยืนอยู่ไหน", "Twong looks at the menu"]) {
      expect((await h.dispatch(message, { messageId: `p-${message}` })).source, message).toBe(
        "model",
      );
    }
  });

  it("still claims a duration-only request written in Thai", async () => {
    // JS word boundaries are ASCII-only, so a "วิ\\b" pattern silently matched
    // nothing; this request must reach the storyboard flow.
    const h = harness();
    const result = await h.dispatch("ใช้ Twong กับ Twong2 อยู่ในร้านกาแฟ 12 วิ", {
      messageId: "d1",
    });
    expect(result.source).toBe("storyboard");
    expect((await h.latest()).document.durationSeconds).toBe(12);
  });
});

describe("a time range alone is not an edit", () => {
  it("ignores chat that merely contains a range", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    for (const message of ["วิธีนี้ 3-6 ดีไหม", "ช่วง 10-14 ว่างไหม", "Twong 3-6 นะ"]) {
      const result = await h.dispatch(message, { messageId: `r-${message}` });
      expect(result.source, message).not.toBe("storyboard");
    }
    // Still only v1: no chat message appended a version.
    expect((await h.latest()).versionNumber).toBe(1);
  });

  it("still accepts a real edit instruction", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const result = await h.dispatch("วิ 10-14 ให้ Twong หันกลับมามอง Twong2", {
      messageId: "m2",
    });
    expect(result.source).toBe("storyboard");
    expect((await h.latest()).versionNumber).toBe(2);
  });

  it("treats direction words after ให้ as direction, not a missing character", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const result = await h.dispatch("วิ 3-6 ให้ zoom in", { messageId: "m2" });
    expect(result.text).not.toMatch(/ไม่พบตัวละคร/u);
    expect((await h.latest()).versionNumber).toBe(2);
  });

  it("prints an edit hint the router will accept", async () => {
    const h = harness();
    const created = await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const hint = /วิ (\d+)-(\d+)/u.exec(created.text ?? "");
    expect(hint).not.toBeNull();
    const [, from, to] = hint!;
    expect(Number(to)).toBeGreaterThan(Number(from));
    const applied = await h.dispatch(`วิ ${from}-${to} ให้เปลี่ยนเป็น close-up`, {
      messageId: "m2",
    });
    expect(applied.text).toContain("Storyboard v2");
  });
});

describe("previs is legacy: only an explicit request reaches it", () => {
  it("never renders a previs for a message storyboard declines", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    // Each of these is declined by storyboard; none may reach the previs engine.
    for (const message of [
      "เอาแบบ 16:9 นะ Twong",
      "วิธีนี้ 3-6 เอาไหม",
      "Twong ยืนอยู่ไหน",
      "Twong คิดว่าวิธีนี้ดีไหม",
    ]) {
      const result = await h.dispatch(message, { messageId: `d-${message}` });
      expect(result.source, message).not.toBe("previs");
    }
    await expectNothingBillable(h);
  });

  it("keeps the shipped previs edit path when no storyboard is active", async () => {
    // Backward compatibility: after an explicit previs create, the documented
    // bare "วิ 10-14 ..." edit must still reach previs.
    const h = harness();
    await h.dispatch(`PREVIS ${CREATE_MESSAGE}`, { messageId: "p1" });
    const edited = await h.dispatch("วิ 10-14 ให้ Twong หันกลับมามอง Twong2", {
      messageId: "p2",
    });
    expect(edited.source).toBe("previs");
    expect(edited.text).toContain("อัปเดต Previs");
  });

  it("stops sending declined messages to previs once a storyboard is active", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    for (const message of ["เอาแบบ 16:9 นะ Twong", "Twong ยืนอยู่ไหน", "วิธีนี้ 3-6 เอาไหม"]) {
      const result = await h.dispatch(message, { messageId: `s-${message}` });
      expect(result.source, message).not.toBe("previs");
    }
    await expectNothingBillable(h);
  });

  it("still routes an explicit PREVIS request to previs", async () => {
    const h = harness();
    const result = await h.dispatch(`PREVIS ${CREATE_MESSAGE}`, { messageId: "p1" });
    expect(result.source).toBe("previs");
    expect(result.text).toContain("Previs v1");
  });
});

describe("edit versus new scene", () => {
  it("ignores plain chat that carries a range and a weak verb", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    for (const message of ["ช่วง 3-6 เอาไหม", "วิธีนี้ 3-6 เอาไหม"]) {
      const result = await h.dispatch(message, { messageId: `w-${message}` });
      expect(result.source, message).not.toBe("storyboard");
    }
    expect((await h.latest()).versionNumber).toBe(1);
  });

  it("treats a clip request naming a duration range as a new scene", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const result = await h.dispatch("ทำคลิป ให้ Twong เดิน 10-15 วิ", { messageId: "m2" });
    expect(result.source).toBe("storyboard");
    // A new storyboard, not a rewrite of beats 10-15.
    expect(result.text).toContain("Storyboard v1");
  });

  it("accepts a self-contained second request without an explicit cast list", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const result = await h.dispatch("ทำคลิป Twong2 วิ่งในสวน 20 วิ", { messageId: "m2" });
    expect(result.source).toBe("storyboard");
    expect(result.text).toContain("Storyboard v1");
  });
});

describe("create-path validation", () => {
  it("does not read a direction word as a missing character", async () => {
    const h = harness();
    const result = await h.dispatch("ใช้ Twong กับ Twong2 ให้ zoom in ตอนท้าย 12 วิ แนวตั้ง", {
      messageId: "z1",
    });
    expect(result.text).not.toMatch(/ไม่พบตัวละคร/u);
    expect(result.text).toContain("Storyboard v1");
  });

  it("refuses an over-long request instead of silently making 15 วิ", async () => {
    const h = harness();
    const result = await h.dispatch("ใช้ Twong กับ Twong2 ให้เดินคุยกัน 90 วิ แนวตั้ง", {
      messageId: "l1",
    });
    expect(result.text).toContain("90");
    expect(result.text).toContain("60");
    expect((await h.storyboardVersions.entries()).length).toBe(0);
  });

  it("names a reversed range as reversed, not as out of bounds", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const result = await h.dispatch("วิ 14-10 ให้ Twong หันกลับ", { messageId: "m2" });
    expect(result.text).toContain("กลับด้าน");
    expect((await h.latest()).versionNumber).toBe(1);
  });
});

describe("turn-claiming under duplicates and follow-ups", () => {
  it("creates one storyboard for two simultaneous deliveries of one message", async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.dispatch(CREATE_MESSAGE, { messageId: "dup-1" }),
      h.dispatch(CREATE_MESSAGE, { messageId: "dup-1" }),
    ]);
    expect(a.text).toBe(b.text);
    // One version total: the duplicate delivery minted no second Notion scene.
    expect((await h.storyboardVersions.entries()).length).toBe(1);
  });

  it("does not start a second storyboard for a follow-up tweak", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const before = (await h.latest()).storyboardId;
    const follow = await h.dispatch("เอาแบบ 16:9 นะ Twong", { messageId: "m2" });
    expect(follow.source).not.toBe("storyboard");
    expect((await h.latest()).storyboardId).toBe(before);
    expect((await h.storyboardVersions.entries()).length).toBe(1);
  });

  it("still starts a new storyboard for an explicit new casting instruction", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const second = await h.dispatch("ใช้ Twong กับ Twong2 ให้ Twong2 นั่งคุยกับ Twong 10 วิ แนวนอน", {
      messageId: "m2",
    });
    expect(second.source).toBe("storyboard");
    expect(second.text).toContain("Storyboard v1");
  });

  it("treats an explicit new-scene request as a create, not an edit", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const result = await h.dispatch("ทำฉากใหม่ 10-15 วิ ให้ Twong เดิน", { messageId: "m2" });
    expect(result.source).toBe("storyboard");
    // A new storyboard, not a rewrite of beat 10-15.
    expect(result.text).toContain("Storyboard v1");
  });

  it("ignores chat containing a range plus a common word", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    for (const message of ["วิธีนี้ 3-6 เอาไหม", "วิทยาลัย 3-6 ให้ไหม", "วิธีนี้ 3-6 ดีไหม"]) {
      const result = await h.dispatch(message, { messageId: `c-${message}` });
      expect(result.source, message).not.toBe("storyboard");
    }
    expect((await h.latest()).versionNumber).toBe(1);
  });
});

describe("edit instructions carry no timestamps into the plan", () => {
  it("stores the action without the range span and keeps it out of the plan", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    await h.dispatch("วิ 10-14 ให้ Twong หันกลับมามอง Twong2", { messageId: "m2" });

    const edited = (await h.latest()).document.beats.find(
      (beat) => beat.startSeconds === 10 && beat.endSeconds === 14,
    );
    expect(edited?.action).toBe("ให้ Twong หันกลับมามอง Twong2");
    expect(edited?.action).not.toMatch(/10-14|วิ\s*10/u);

    await h.dispatch("สร้างวิดีโอ", { messageId: "m3" });
    const draft = (await h.drafts.entries())[0]!.value;
    for (const beat of draft.plan.beats) {
      expect(beat.action).not.toMatch(/\d{1,3}\s*(?:-|–|ถึง|to)\s*\d{1,3}/u);
    }
  });
});

describe("Final Video Draft never collides with the paid gate", () => {
  it("emits no ยืนยัน VIDEO phrase and no 4-digit code while binding is deferred", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const result = await h.dispatch("สร้างวิดีโอ", { messageId: "m2" });

    expect(result.text).not.toMatch(/ยืนยัน\s+VIDEO/u);
    const draft = (await h.drafts.entries())[0]!.value;
    expect(draft.confirmation).toEqual({ kind: "deferred" });
    // A 4-digit id would live in the LINE paid draft store's code space.
    expect(draft.draftId).not.toMatch(/^\d{4}$/u);
  });

  it("keeps an edited beat cast even when the edit names nobody in the cast", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    await h.dispatch("วิ 10-14 ให้กล้องซูมเข้า", { messageId: "m2" });
    const edited = (await h.latest()).document.beats.find(
      (beat) => beat.startSeconds === 10 && beat.endSeconds === 14,
    );
    // An empty id list must not survive as the beat's cast.
    expect(edited?.characterIds.length).toBeGreaterThan(0);
    for (const id of edited!.characterIds) {
      expect(id).toMatch(/^CHAR-\d+$/u);
    }
  });
});

describe("security and billing invariants", () => {
  it("keeps every storyboard runtime module free of provider calls", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = "extensions/cloudbath-line-image-archive/src";
    const files = (await readdir(dir)).filter(
      (name) => name.startsWith("storyboard") && name.endsWith(".ts") && !name.includes(".test"),
    );
    expect(files.length).toBeGreaterThan(4);
    for (const name of files) {
      const source = await readFile(`${dir}/${name}`, "utf8");
      expect(source, name).not.toMatch(/generateVideo|video-generation|openrouter|runway/iu);
      expect(source, name).not.toMatch(/https?:\/\//u);
      // "Seedance" may appear only as a display name, never as an api model id.
      expect(source, name).not.toMatch(/bytedance\/|seedance-\d|seedance_\d/iu);
    }
  });

  it("logs no credential material and leaks none to the owner", async () => {
    const warn = vi.fn();
    const h = harness({
      logger: { warn },
      resolver: resolver({
        resolveProject: async () => {
          throw new Error("notion 401 for token sk-live-abcdefgh12345678");
        },
      }),
    });
    const result = await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });

    // The owner-facing reply carries no internals at all.
    expect(result.text).toBe("สร้าง Storyboard ไม่สำเร็จ กรุณาลองอีกครั้ง");
    expect(result.text).not.toMatch(/token|secret|sk-/iu);

    // The failure IS logged, so the cause is diagnosable, and the logged
    // fields carry no secret beyond the upstream message itself.
    expect(warn).toHaveBeenCalledTimes(1);
    const [event, fields] = warn.mock.calls[0]!;
    expect(event).toBe("storyboard_create_failed");
    expect(Object.keys(fields ?? {})).toEqual(["reason"]);
  });
});
