import { describe, expect, it } from "vitest";

import { composerSuggestions } from "./options.ts";

describe("composer suggestions", () => {
  it("turns an @ path into a file mention candidate", () => {
    expect(composerSuggestions("file", "src/thread/view.ts", false)).toEqual([
      {
        action: "mention",
        detail: "mention this file",
        icon: "fileStack",
        label: "@src/thread/view.ts",
        value: "src/thread/view.ts",
      },
    ]);
  });

  it("filters slash commands and hides thread actions on the welcome", () => {
    expect(composerSuggestions("command", "mo", false)).toEqual([]);
    expect(composerSuggestions("command", "mo", true)[0]).toMatchObject({
      action: "model",
      label: "/model",
      value: "model",
    });
    expect(composerSuggestions("command", "", false)).toEqual([
      expect.objectContaining({ action: "clear", value: "clear" }),
    ]);
  });

  it("leaves an unknown slash command to ordinary prompt text", () => {
    expect(composerSuggestions("command", "unknown", true)).toEqual([]);
  });
});
