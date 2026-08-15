import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleStop,
  CircleX,
  FileStack,
  GitBranch,
  Laptop,
  Layers,
  LoaderCircle,
  Minus,
  Pencil,
  Pi,
  Plus,
  RefreshCw,
  Shuffle,
  Box,
  Square,
  SquareCheck,
  Trash2,
  Wrench,
  X,
} from "lucide";
import type { HtmlBuilder } from "foldkit/html";
import type { IconNode } from "lucide";

const iconNodes = {
  archive: Archive,
  archiveRestore: ArchiveRestore,
  arrowDown: ArrowDown,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  arrowUp: ArrowUp,
  brain: Brain,
  check: Check,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  circle: Circle,
  circleAlert: CircleAlert,
  circleCheck: CircleCheck,
  circleDashed: CircleDashed,
  circleDot: CircleDot,
  circleStop: CircleStop,
  circleX: CircleX,
  fileStack: FileStack,
  gitBranch: GitBranch,
  laptop: Laptop,
  layers: Layers,
  loaderCircle: LoaderCircle,
  minus: Minus,
  pencil: Pencil,
  pi: Pi,
  plus: Plus,
  refreshCw: RefreshCw,
  shuffle: Shuffle,
  box: Box,
  square: Square,
  squareCheck: SquareCheck,
  trash2: Trash2,
  wrench: Wrench,
  x: X,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof iconNodes;

export interface IconOptions {
  readonly className?: string;
  readonly size?: string;
}

const renderIconNode = <Message>(h: HtmlBuilder<Message>, [tag, sourceAttrs]: IconNode[number]) => {
  const attrs = Object.entries(sourceAttrs).map(([key, value]) => h.Attribute(key, String(value)));
  switch (tag) {
    case "circle":
      return h.circle(attrs, []);
    case "line":
      return h.line(attrs, []);
    case "path":
      return h.path(attrs, []);
    case "rect":
      return h.rect(attrs, []);
    default:
      throw new Error(`Unsupported Lucide SVG element: ${tag}`);
  }
};

export const icon = <Message>(h: HtmlBuilder<Message>, name: IconName, options: IconOptions = {}) =>
  h.svg(
    [
      h.Class(`saku-icon${options.className === undefined ? "" : ` ${options.className}`}`),
      h.Width(options.size ?? "1em"),
      h.Height(options.size ?? "1em"),
      h.ViewBox("0 0 24 24"),
      h.Fill("none"),
      h.Stroke("currentColor"),
      h.StrokeWidth("2"),
      h.StrokeLinecap("round"),
      h.StrokeLinejoin("round"),
      h.Xmlns("http://www.w3.org/2000/svg"),
      h.Attribute("aria-hidden", "true"),
      h.Attribute("focusable", "false"),
    ],
    iconNodes[name].map((node) => renderIconNode(h, node)),
  );
