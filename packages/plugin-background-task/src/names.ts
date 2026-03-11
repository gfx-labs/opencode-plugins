import { randomBytes } from "node:crypto"

// 172 adjectives, 60 colors, 163 animals -- ~1.68M unique combos, deduped per process
const ADJECTIVES = [
  "able", "aged", "airy", "apt", "avid", "bare", "bold", "brave",
  "brief", "bright", "brisk", "broad", "busy", "calm", "civil", "clean",
  "clear", "close", "cold", "cool", "crisp", "crude", "damp", "dark",
  "dear", "deep", "deft", "dense", "dim", "dry", "dull", "eager",
  "early", "easy", "edgy", "even", "evil", "exact", "fair", "far",
  "fast", "fat", "fierce", "fine", "firm", "fit", "flat", "fond",
  "free", "fresh", "full", "glad", "glib", "glow", "good", "grand",
  "grave", "gruff", "grim", "half", "hard", "harsh", "high", "hollow",
  "hot", "huge", "idle", "ill", "keen", "kind", "lame", "large",
  "last", "late", "lazy", "lean", "light", "live", "long", "lost",
  "loud", "low", "lucky", "mad", "meek", "mild", "moist", "moral",
  "mute", "narrow", "neat", "next", "nice", "noble", "odd", "old",
  "open", "pale", "past", "peak", "plain", "plump", "polite", "poor",
  "prime", "proud", "pure", "quick", "quiet", "rare", "raw", "ready",
  "real", "rich", "rigid", "ripe", "rough", "round", "rude", "rustic",
  "safe", "sane", "sharp", "sheer", "short", "shrewd", "shy", "silent",
  "slim", "slow", "small", "smart", "smooth", "snug", "soft", "solid",
  "sore", "sour", "spare", "stark", "steady", "steep", "stiff", "still",
  "stout", "strict", "strong", "subtle", "sure", "sweet", "swift", "tall",
  "tame", "taut", "thick", "thin", "tidy", "tight", "tough", "vague",
  "vast", "vivid", "warm", "weak", "wet", "whole", "wide", "wild",
  "wise", "worn", "young", "zany",
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
  "ant", "ape", "asp", "auk", "axolotl", "bat", "bear", "bee", "bird",
  "bison", "boar", "bobcat", "bug", "bull", "bunny", "camel", "carp",
  "cat", "cheetah", "chimp", "clam", "cobra", "cod", "colt", "conch",
  "condor", "corgi", "cougar", "cow", "coyote", "crab", "crane", "crow",
  "cub", "deer", "dingo", "dog", "donkey", "dove", "drake", "duck",
  "eagle", "eel", "egret", "elk", "emu", "ermine", "falcon", "filly",
  "ferret", "finch", "fish", "flamingo", "fly", "foal", "fox", "frog",
  "gecko", "gibbon", "goat", "goose", "gopher", "grouse", "grub", "gull",
  "hare", "hawk", "hen", "heron", "horse", "hound", "hyena", "ibis",
  "iguana", "jackal", "jaguar", "jay", "kite", "koala", "koi", "lark",
  "lemur", "lion", "lizard", "llama", "loon", "louse", "lynx", "macaw",
  "magpie", "mamba", "mantis", "mare", "marten", "mink", "mole", "monkey",
  "moose", "moth", "mouse", "mule", "newt", "ocelot", "oriole", "oryx",
  "osprey", "otter", "owl", "ox", "panda", "parrot", "pelican", "perch",
  "pig", "pigeon", "pike", "pony", "puma", "quail", "rabbit", "ram",
  "raptor", "rat", "raven", "ray", "robin", "salmon", "seal", "shark",
  "sheep", "shrew", "shrimp", "skink", "sloth", "slug", "snail", "snake",
  "snipe", "sole", "squid", "stag", "stork", "sturgeon", "tapir",
  "tern", "tiger", "toad", "trout", "tuna", "turkey", "turtle", "viper",
  "vole", "vulture", "wasp", "weasel", "whale", "wolf", "wombat", "worm",
  "wren", "yak", "zebra",
]

function pickIndex(len: number): number {
  const buf = randomBytes(2)
  return ((buf[0] << 8) | buf[1]) % len
}

// pack three indices into a single integer for fast dedup
// max index per list is <256, so 8 bits each fits in 24 bits
function packKey(a: number, b: number, c: number): number {
  return (a << 16) | (b << 8) | c
}

const used = new Set<number>()

export function generateId(): string {
  for (let i = 0; i < 100; i++) {
    const a = pickIndex(ADJECTIVES.length)
    const b = pickIndex(COLORS.length)
    const c = pickIndex(ANIMALS.length)
    const key = packKey(a, b, c)
    if (!used.has(key)) {
      used.add(key)
      return `${ADJECTIVES[a]}-${COLORS[b]}-${ANIMALS[c]}`
    }
  }
  // fallback: append hex suffix if all retries collided
  const a = pickIndex(ADJECTIVES.length)
  const b = pickIndex(COLORS.length)
  const c = pickIndex(ANIMALS.length)
  return `${ADJECTIVES[a]}-${COLORS[b]}-${ANIMALS[c]}-${randomBytes(2).toString("hex")}`
}
