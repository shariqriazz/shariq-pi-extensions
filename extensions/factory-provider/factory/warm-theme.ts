import type { Theme } from "@earendil-works/pi-coding-agent";

type Rgb = readonly [number, number, number];

/**
 * Warm, high-contrast Factory-only experiment.
 *
 * The palette uses distinct page, surface, and focus levels while replacing
 * blue/cyan with amber, cream, terracotta, olive, and warm charcoal. It never
 * changes Pi's global theme.
 */
export const FACTORY_WARM_PALETTE = {
  accent: [242, 169, 86],
  text: [248, 234, 211],
  muted: [207, 177, 145],
  dim: [158, 128, 103],
  success: [216, 194, 122],
  warning: [239, 145, 87],
  error: [239, 112, 96],
  border: [139, 96, 68],
  borderMuted: [82, 59, 48],
  borderAccent: [220, 132, 64],
  selectedBg: [72, 46, 35],
} satisfies Record<string, Rgb>;

function foreground(color: Rgb, text: string) {
  return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${text}\x1b[39m`;
}

function background(color: Rgb, text: string) {
  return `\x1b[48;2;${color[0]};${color[1]};${color[2]}m${text}\x1b[49m`;
}

export function factoryWarmTheme(theme: Theme): Theme {
  return new Proxy(theme, {
    get(target, property, receiver) {
      if (property === "fg") {
        return (color: Parameters<Theme["fg"]>[0], text: string) => {
          const rgb = FACTORY_WARM_PALETTE[color as keyof typeof FACTORY_WARM_PALETTE];
          return rgb ? foreground(rgb, text) : target.fg(color, text);
        };
      }
      if (property === "bg") {
        return (color: Parameters<Theme["bg"]>[0], text: string) => {
          const rgb = FACTORY_WARM_PALETTE[color as keyof typeof FACTORY_WARM_PALETTE];
          return rgb ? background(rgb, text) : target.bg(color, text);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
