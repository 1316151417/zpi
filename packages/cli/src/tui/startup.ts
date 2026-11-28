import { Container, isAppleTerminalSession, Spacer, Text } from "@earendil-works/pi-tui";
import { dim, resourceTitle, safeText } from "./theme.ts";

// Render the repository icon as two terminal rows. Each half block is one brand pixel.
const coral = "\x1b[38;2;240;144;129m";
const blue = "\x1b[38;2;80;159;197m";
const gold = "\x1b[38;2;242;190;87m";
const blueBg = "\x1b[48;2;80;159;197m";
const coralBg = "\x1b[48;2;240;144;129m";
const reset = "\x1b[0m";
const logo = [
  `${coral}▀▀${blueBg}▀${reset} ${coral}${blueBg}▀${reset}${coral}▀█${reset} ${gold}▀${reset}`,
  `${coral}▄${blue}${coralBg}▀${reset}${coral}▄${reset} ${blue}█▀${reset}  ${gold}█${reset}`,
];

export class Startup extends Container {
  private header = new Text("", 1, 1);
  private resources = new Text("", 0, 0);
  private expanded = false;
  private version: string;
  private skills: { name: string; description?: string }[] = [];
  constructor(version: string) {
    super();
    this.version = version;
    this.addChild(this.header);
    this.redraw();
  }
  setSkills(skills: typeof this.skills) {
    this.skills = skills;
    this.clear();
    this.addChild(this.header);
    if (skills.length) {
      this.addChild(this.resources);
      this.addChild(new Spacer(1));
    }
    this.redraw();
  }
  toggleDetails() {
    this.expanded = !this.expanded;
    this.redraw();
  }
  private redraw() {
    const plain = process.env.NO_COLOR !== undefined || isAppleTerminalSession();
    const compact = "escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ctrl+o more";
    const hints = this.expanded
      ? [
          compact,
          "ctrl+t toggle thinking · shift+tab cycle thinking level · ctrl+l select model",
          "ctrl+r search history · ctrl+s stash draft · ctrl+g edit externally · @ reference files",
        ].join("\n")
      : compact;
    const title = dim(`v${this.version}`);
    const header = plain ? `ZPI ${title}\n${dim(hints)}` : `${logo[0]} ${title}\n${logo[1]} ${dim(hints)}`;
    const more = this.expanded
      ? ""
      : `\n${dim("Press ctrl+o to show full startup help and loaded resources.")}`;
    this.header.setText(
      `${header}${more}\n\n${dim("ZPI can look up its CLI documentation. Ask how to use ZPI or open /help.")}`,
    );
    const items = this.skills.map(({ name, description }) =>
      safeText(this.expanded && description ? `${name}  ${description}` : name).replaceAll("\n", " "),
    );
    this.resources.setText(
      `${resourceTitle("[Skills]")}\n${dim(`  ${items.join(this.expanded ? "\n  " : ", ")}`)}`,
    );
  }
}
