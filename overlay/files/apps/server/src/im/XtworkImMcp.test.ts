import { describe, expect, it } from "vite-plus/test";
import { imToolAllowed } from "./XtworkImMcp.ts";

describe("XtworkImMcp policy exposure", () => {
  it("exposes controlled IM tools only inside IM threads", () => {
    expect(imToolAllowed("xtwork-im-dm-thread", "im__reply", true)).toBe(true);
    expect(imToolAllowed("xtwork-im-dm-thread", "im__native_policy", true)).toBe(false);
    expect(imToolAllowed("local-thread", "im__reply", true)).toBe(false);
  });

  it("keeps todo tools available for scoped records", () => {
    expect(imToolAllowed("xtwork-im-group-thread", "todo__list", true)).toBe(true);
  });
});
