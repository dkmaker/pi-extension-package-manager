import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";


const IS_DEVMODE = process.env.PI_DEVMODE_ENABLED === "1";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (IS_DEVMODE) {
      // Static spacer widget above the banner
      ctx.ui.setWidget("devmode-spacer", (_tui: any, _theme: any) => ({
        render(_width: number): string[] {
          return [""];
        },
        invalidate() {},
      }));

      // Static banner widget
      ctx.ui.setWidget("devmode-banner", (_tui: any, _theme: any) => ({
        render(width: number): string[] {
          const text = "🔴🔧🔴🔧🔴 DEVMODE ACTIVE 🔴🔧🔴🔧🔴";
          const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
          const line = " ".repeat(pad) + text;
          return [
            `\x1b[43m\x1b[30m${truncateToWidth(line + " ".repeat(Math.max(0, width - visibleWidth(line))), width)}\x1b[0m`,
          ];
        },
        invalidate() {},
      }));
    } else {
      // Not in dev mode — warn the user
      const lines = [
        "",
        "⚠️  WARNING: You are running the package-manager extension from source",
        "   but NOT in dev mode. Changes may conflict with the installed version.",
        "",
        "   To enable dev mode, run:",
        "",
        "     ./run_pi_dev_mode.sh",
        "",
        "   This starts pi with an isolated home directory and only the local extension.",
        "",
      ];

      pi.sendMessage(
        {
          customType: "devmode-warning",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    }
  });
}
