import { randomBytes } from "node:crypto"

// ~60 adjectives, ~60 colors, ~60 animals -- enough for ~216k unique combos
const ADJECTIVES = [
  "bold", "brave", "bright", "calm", "clear", "cool", "crisp", "deft",
  "eager", "fair", "fast", "firm", "fond", "free", "fresh", "glad",
  "grand", "keen", "kind", "late", "lean", "live", "long", "loud",
  "mild", "neat", "nice", "pale", "past", "peak", "pure", "rare",
  "rich", "ripe", "safe", "sharp", "shy", "slim", "slow", "smart",
  "soft", "sour", "still", "sure", "sweet", "tall", "thin", "warm",
  "wide", "wild", "wise", "young", "quick", "quiet", "ready", "round",
  "smooth", "solid", "steep", "swift",
]

const COLORS = [
  "amber", "aqua", "azure", "beige", "black", "blue", "brass", "bronze",
  "brown", "coral", "cream", "crimson", "cyan", "dusk", "ebony", "fawn",
  "flame", "flint", "frost", "gold", "gray", "green", "grey", "hazel",
  "indigo", "ivory", "jade", "lemon", "lilac", "lime", "linen", "maple",
  "mint", "navy", "olive", "onyx", "opal", "pearl", "peach", "pine",
  "plum", "red", "rose", "ruby", "rust", "sage", "sand", "scarlet",
  "silver", "slate", "snow", "steel", "stone", "tan", "teal", "topaz",
  "violet", "wheat", "white", "wine",
]

const ANIMALS = [
  "ant", "ape", "bat", "bear", "bee", "bird", "boar", "bull",
  "carp", "cat", "clam", "cod", "colt", "crab", "crow", "deer",
  "dog", "dove", "duck", "eagle", "eel", "elk", "emu", "fawn",
  "finch", "fish", "fly", "fox", "frog", "goat", "goose", "gull",
  "hare", "hawk", "hen", "horse", "ibis", "jay", "kite", "lark",
  "lion", "lynx", "mink", "mole", "moth", "mouse", "newt", "oryx",
  "otter", "owl", "ox", "panda", "perch", "pike", "pony", "quail",
  "ram", "raven", "seal", "shark",
]

function pick(list: readonly string[]): string {
  const byte = randomBytes(1)[0]
  return list[byte % list.length]
}

export function generateId(): string {
  return `${pick(ADJECTIVES)}-${pick(COLORS)}-${pick(ANIMALS)}`
}
