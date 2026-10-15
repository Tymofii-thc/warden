import * as blessed from "blessed";
import chalk from "chalk";

export interface WardenUi {
  screen: blessed.Widgets.Screen;
  feedBox: blessed.Widgets.Log;
  decisionBox: blessed.Widgets.Log;
  tallyBox: blessed.Widgets.BoxElement;
  headerBox: blessed.Widgets.BoxElement;
  footerBox: blessed.Widgets.BoxElement;
}

const BANNER = [
  " __      __  _____ __________________  ________ _______  ",
  "/  \\    /  \\/  _  \\\\______   \\______ \\ \\_   _  \\\\      \\ ",
  "\\   \\/\\/   /  /_\\  \\|       _/|    |  \\ |    __/\\\\  \\     ",
  " \\        /    |    \\    |   \\|    `   \\|       \\ \\  \\    ",
  "  \\__/\\  /\\____|__  /____|_  /_______  /_______  /\\__\\   ",
  "       \\/          \\/       \\/        \\/         \\/       ",
];

export function buildUi(): WardenUi {
  const screen = blessed.screen({
    smartCSR: true,
    title: "WARDEN // On-chain Risk Oracle",
    fullUnicode: true,
  });

  const headerBox = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: 8,
    tags: true,
    content: BANNER.map((line) => `{cyan-fg}{bold}${line}{/bold}{/cyan-fg}`).join("\n") +
      `\n{grey-fg}on-chain risk-screening oracle for Solana wallets{/grey-fg}`,
    style: { fg: "cyan" },
    border: { type: "line" },
  }) as blessed.Widgets.BoxElement;

  const feedBox = blessed.log({
    label: " incoming wallets ",
    top: 8,
    left: 0,
    width: "50%",
    height: "100%-11",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "cyan" }, label: { fg: "cyan" } },
    scrollback: 200,
  }) as blessed.Widgets.Log;

  const decisionBox = blessed.log({
    label: " screening decisions ",
    top: 8,
    left: "50%",
    width: "50%",
    height: "100%-11",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "magenta" }, label: { fg: "magenta" } },
    scrollback: 200,
  }) as blessed.Widgets.Log;

  const tallyBox = blessed.box({
    label: " tally ",
    bottom: 1,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "white" } },
  }) as blessed.Widgets.BoxElement;

  const footerBox = blessed.box({
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: { fg: "grey" },
  }) as blessed.Widgets.BoxElement;

  screen.append(headerBox);
  screen.append(feedBox);
  screen.append(decisionBox);
  screen.append(tallyBox);
  screen.append(footerBox);

  screen.key(["q", "C-c", "escape"], () => process.exit(0));

  return { screen, feedBox, decisionBox, tallyBox, headerBox, footerBox };
}

export function decisionColor(decision: string): string {
  switch (decision) {
    case "ALLOW":
      return "green";
    case "REVIEW":
      return "yellow";
    case "BLOCK":
      return "red";
    default:
      return "grey";
  }
}

export function colorizeTerminal(decision: string, text: string): string {
  switch (decision) {
    case "ALLOW":
      return chalk.green(text);
    case "REVIEW":
      return chalk.yellow(text);
    case "BLOCK":
      return chalk.red(text);
    default:
      return chalk.grey(text);
  }
}
