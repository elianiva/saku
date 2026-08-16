import { describe, expect, it } from "vitest";
import { $createParagraphNode, $getRoot, createEditor } from "lexical";

import { FileMentionNode } from "./composer.ts";

describe("Lexical composer nodes", () => {
  it("renders file mentions as styled tokens without changing prompt text", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor({
      namespace: "saku-composer-test",
      nodes: [FileMentionNode],
    });
    editor.setRootElement(host);

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append(new FileMentionNode("@src/thread/view.ts"));
        $getRoot().append(paragraph);
      },
      { discrete: true },
    );

    expect(host.querySelector("[data-saku-file-mention]")?.textContent).toBe("@src/thread/view.ts");
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "@src/thread/view.ts",
    );

    editor.setRootElement(null);
    host.remove();
  });
});
