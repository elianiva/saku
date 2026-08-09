// The foldkit TEA counter — identical in shape to a foldkit web app.
// `init`, `update`, and `view` are pure and renderer-agnostic: the same
// main.ts drives a browser app via `foldkit` or a terminal app via `foldtui`.
import { Match as M, Schema as S } from "effect";
import { Command } from "foldkit";
import { m } from "foldkit/message";
import { evo } from "foldkit/struct";
import type { HtmlBuilder } from "foldkit/html";

export const Model = S.Struct({ count: S.Number });
export type Model = typeof Model.Type;

const ClickedDecrement = m("ClickedDecrement");
const ClickedIncrement = m("ClickedIncrement");
const ClickedReset = m("ClickedReset");

export const Message = S.Union([ClickedDecrement, ClickedIncrement, ClickedReset]);
export type Message = typeof Message.Type;

export const init = (): readonly [Model, ReadonlyArray<Command.Command<Message>>] => [
  Model.make({ count: 0 }),
  [],
];

export const update = (model: Model, message: Message) =>
  M.value(message).pipe(
    M.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
    M.tagsExhaustive({
      ClickedDecrement: () => [evo(model, { count: (count) => count - 1 }), []],
      ClickedIncrement: () => [evo(model, { count: (count) => count + 1 }), []],
      ClickedReset: () => [evo(model, { count: () => 0 }), []],
    }),
  );

const RosePineDawn = {
  base: "#faf4ed", // app background
  overlay: "#f2e9e1", // buttons
  text: "#575279", // button labels
  foam: "#56949f", // count
  iris: "#907aa9", // title
} as const;

const buttonStyle = {
  backgroundColor: RosePineDawn.overlay,
} as const;

const buttonLabel = (h: HtmlBuilder<Message>, label: string) =>
  h.span([h.Style({ color: RosePineDawn.text })], [label]);

export const view = (model: Model, h: HtmlBuilder<Message>) => ({
  title: `Counter: ${model.count}`,
  body: h.div(
    [
      h.Style({
        flexGrow: "1",
        flexDirection: "column",
        padding: "2",
        gap: "1",
        backgroundColor: RosePineDawn.base,
      }),
    ],
    [
      h.p([h.Style({ color: RosePineDawn.iris })], ["Foldkit × OpenTUI — TEA counter"]),
      h.p([h.Style({ color: RosePineDawn.foam })], [`Count: ${model.count}`]),
      h.div(
        [
          h.Style({
            flexDirection: "row",
            gap: "1",
            justifyContent: "center",
            width: "100%",
          }),
        ],
        [
          h.button([h.Style(buttonStyle), h.OnClick(ClickedDecrement())], [buttonLabel(h, " - ")]),
          h.button([h.Style(buttonStyle), h.OnClick(ClickedReset())], [buttonLabel(h, " Reset ")]),
          h.button([h.Style(buttonStyle), h.OnClick(ClickedIncrement())], [buttonLabel(h, " + ")]),
        ],
      ),
    ],
  ),
});
