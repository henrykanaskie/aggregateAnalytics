import { IconWeight, PATHS } from "./icons.gen";

// Phosphor, one family drawn to one grid, so the set reads as designed rather
// than assembled. A lit tab takes the filled weight, the way native tab bars
// mark where you are; everything else is the regular line weight. The shapes
// come from icons.gen.ts (see scripts/icons.mjs), which keeps only the weights
// drawn here instead of all six the package ships per icon.
export type IconProps = { size?: number; active?: boolean; weight?: IconWeight };

export function Ph({ name, size = 22, active = false, weight }: IconProps & { name: string }) {
  const w = weight ?? (active ? "fill" : "regular");
  return <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: PATHS[name][w] }} />;
}
const make = (name: string) => (p: IconProps) => <Ph name={name} {...p} />;

export const ICONS: Record<string, (p: IconProps) => JSX.Element> = {
  "/research": make("UserFocus"),
  "/fantasy": make("Trophy"),
  "/board": make("Table"),
  "/matchups": make("Strategy"),
  "/games": make("Football"),
  "/teams": make("ShieldStar"),
  "/coaches": make("ClipboardText"),
  "/predictions": make("ChartLineUp"),
  "/results": make("SealCheck"),
  "/settings": make("GearSix"),
};

export const IconSearch = make("MagnifyingGlass");
export const IconMore = make("SquaresFour");
export const IconMenu = make("DotsThreeVertical");
export const IconSun = make("Sun");
export const IconMoon = make("Moon");
export const IconSliders = make("SlidersHorizontal");
export const IconHelp = make("Question");
export const IconClose = make("X");
export const IconChevron = make("CaretDown");
export const IconArrow = make("CaretRight");
export const IconSwap = make("ArrowsDownUp");
export const IconBolt = make("Lightning");
export const IconPlus = make("Plus");
export const IconShield = make("ShieldCheck");
export const IconTrash = make("Trash");
export const IconDown = make("TrendDown");
export const IconWarn = make("Warning");
export const IconStar = make("Star");
