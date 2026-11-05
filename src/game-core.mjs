import { randomBytes } from "node:crypto";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const SHIFT_LENGTH_MS = 180_000;
export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
// A player whose phone has not checked in for this long shows as "Away" in the lobby.
export const AWAY_AFTER_MS = 25_000;
// A player gone this long is dropped automatically when the host starts, so a closed tab never gets a role.
export const STALE_PLAYER_MS = 90_000;
export const ROLE_SETS = {
  2: ["guide", "cook"],
  3: ["tickets", "cook", "recipe_pantry"],
  4: ["tickets", "recipe", "pantry", "cook"],
  5: ["tickets", "recipe", "pantry", "cook", "inspector"],
  6: ["tickets", "recipe", "pantry", "cook_odd", "cook_even", "inspector"],
};
export const ROLE_NAMES = {
  guide: "Kitchen Guide",
  tickets: "Tickets",
  recipe: "Recipe Book",
  pantry: "Pantry",
  recipe_pantry: "Recipe Book + Pantry",
  cook: "Line Cook",
  cook_odd: "Line Cook · odd tables",
  cook_even: "Line Cook · even tables",
  inspector: "Health Inspector",
};
export const ROLE_JOBS = {
  guide: "You see the tickets, recipes, and pantry map. Read everything aloud; your partner does the cooking.",
  tickets: "You know what each table ordered. Call it out clearly.",
  recipe: "You know what goes into every dish. Read the recipe aloud.",
  pantry: "You know where every ingredient lives. Call out bin numbers.",
  recipe_pantry: "You have the recipes and pantry map. Guide the cook.",
  cook: "You alone can touch the food. Listen, build, and serve.",
  cook_odd: "You cook for odd-numbered tables. Listen, build, and serve.",
  cook_even: "You cook for even-numbered tables. Listen, build, and serve.",
  inspector: "You hold a secret kitchen rule. Announce it when your team is ready.",
};

const INGREDIENTS = [
  ["rice", [], "#f2c94c"], ["noodles", [], "#f2994a"], ["tortilla", [], "#d4a373"],
  ["cheese", ["dairy"], "#f2c94c"], ["chicken", ["meat"], "#d98b69"], ["tofu", [], "#f2e8cf"],
  ["chili", ["spicy"], "#e76f51"], ["peanuts", ["nuts"], "#bc8a5f"], ["scallion", [], "#6a994e"],
  ["egg", [], "#f4e285"], ["avocado", [], "#90be6d"], ["hot sauce", ["spicy"], "#e63946"],
  ["tomato", [], "#ef476f"], ["black beans", [], "#6d597a"], ["bacon", ["meat"], "#bc6c25"],
  ["yogurt", ["dairy"], "#e9ecef"], ["almonds", ["nuts"], "#b08968"], ["mushrooms", [], "#8d6e63"],
  ["corn", [], "#ffd166"], ["lime", [], "#a7c957"], ["shrimp", ["meat"], "#ff9f9c"],
  ["sour cream", ["dairy"], "#f8f9fa"], ["ginger", ["spicy"], "#e9c46a"], ["cucumber", [], "#90be6d"],
  ["cashews", ["nuts"], "#b08968"], ["sweet potato", [], "#e76f51"], ["spinach", [], "#588157"],
  ["salsa", ["spicy"], "#f28482"], ["cream", ["dairy"], "#fff3b0"], ["sausage", ["meat"], "#9d4edd"],
];
const ADJECTIVES = ["Volcano", "Midnight", "Thunder", "Golden", "Cosmic", "Lucky", "Crispy", "Sunset", "Secret", "Rocket", "Velvet", "Happy"];
const FOODS = ["Bowl", "Taco", "Toast", "Noodles", "Wrap", "Skillet", "Stack", "Salad", "Pocket", "Crunch", "Plate", "Roll"];
const BIN_COLORS = ["#f4a261", "#e76f51", "#e9c46a", "#2a9d8f", "#457b9d", "#9b5de5", "#f15bb5", "#84a59d", "#f6bd60", "#00bbf9", "#90be6d", "#577590"];
const RESTRICTED_TAGS = { "no dairy": "dairy", "no meat": "meat", "nut allergy": "nuts" };
const BLOCKED_TAGS = ["dairy", "meat", "nuts"];
function isSafeBin(bin) { return !bin.tags.some((tag) => BLOCKED_TAGS.includes(tag)); }
const INGREDIENT_INDEX = new Map(INGREDIENTS.map(([name, tags, color]) => [name, { name, tags, color }]));
function makeRandom(seed) {
  let value = seed >>> 0;
  const next = () => {
    value += 0x6D2B79F5;
    let n = value;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  Object.defineProperty(next, "state", { get: () => value >>> 0 });
  return next;
}

function randomItem(array, rng) { return array[Math.floor(rng() * array.length)]; }

function nextKitchenRandom(room) {
  const rng = makeRandom(room.kitchen.rngState);
  const value = rng();
  room.kitchen.rngState = rng.state;
  return value;
}

function kitchenRandomInt(room, min, max) {
  return min + Math.floor(nextKitchenRandom(room) * (max - min));
}

function kitchenRandomItem(room, array) {
  return array[Math.floor(nextKitchenRandom(room) * array.length)];
}

function sample(array, count, rng) {
  const pool = [...array];
  const result = [];
  while (result.length < count) result.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return result;
}

function itemInfo(name) {
  const item = INGREDIENT_INDEX.get(name);
  return { name, tags: [...(item?.tags ?? [])], color: item?.color ?? "#d8cdb8" };
}

export function rolesFor(room) {
  const order = room.playerOrder;
  const n = order.length;
  const set = ROLE_SETS[n] ?? [];
  if (!n || !set.length) return {};
  const offset = Math.max(0, (room.shift || 1) - 1);
  return Object.fromEntries(order.map((id, seat) => [id, set[(seat + offset) % n]]));
}

export function roleFor(room, playerId) {
  return rolesFor(room)[playerId] ?? null;
}

export function createRoomState(code, playerId, nickname, now = Date.now()) {
  return {
    code,
    phase: "lobby",
    players: { [playerId]: { nickname, lastSeen: now } },
    playerOrder: [playerId],
    hostId: playerId,
    createdAt: now,
    lastActivity: now,
    revision: 1,
    shift: 0,
    score: 0,
    totalServed: 0,
    totalMistakes: 0,
    totalWalkouts: 0,
    totalStars: 0,
    bestShift: 0,
    shiftStats: { served: 0, mistakes: 0, walkouts: 0, issued: 0, stars: 0, score: 0 },
    shiftSummary: null,
    result: null,
    orders: [],
    plates: {},
    kitchen: null,
    shiftDeadline: null,
    revealDeadline: null,
    reportDeadline: null,
    nextOrderAt: null,
  };
}

function bump(room) { room.revision += 1; }

export function newKitchen(shift, seed = randomBytes(4).readUInt32BE(0)) {
  seed >>>= 0;
  const rng = makeRandom(seed);
  // Keep drawing from the same seeded generator until every rule holds, so a seed still
  // reproduces the exact same kitchen.
  for (let attempt = 0; ; attempt += 1) {
    const kitchen = buildKitchen(shift, rng, attempt >= 24);
    if (kitchen) return { seed, rngState: rng.state, ...kitchen };
  }
}

function buildKitchen(shift, rng, allowLooseSwaps) {
  const outCount = Math.max(0, shift - 1);
  const safeIngredients = INGREDIENTS.filter(([, tags]) => !tags.some((tag) => ["dairy", "meat", "nuts"].includes(tag)));
  const restrictedIngredients = INGREDIENTS.filter(([, tags]) => tags.some((tag) => ["dairy", "meat", "nuts"].includes(tag)));
  const safeCount = outCount ? outCount * 2 + 3 : Math.floor(rng() * 4) + 5;
  const picked = [...sample(safeIngredients, safeCount, rng), ...sample(restrictedIngredients, 12 - safeCount, rng)];
  for (let index = picked.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    [picked[index], picked[other]] = [picked[other], picked[index]];
  }
  const bins = picked.map(([name, tags], index) => ({
    number: index + 1, name, tags: [...tags], color: BIN_COLORS[index], out: false,
  }));
  const perDish = { 1: 3, 2: 4, 3: 5 }[shift];
  const dishes = [];
  const usedNames = new Set();
  for (let index = 0; index < 6; index += 1) {
    let name;
    do { name = `${ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)]} ${FOODS[Math.floor(rng() * FOODS.length)]}`; }
    while (usedNames.has(name));
    usedNames.add(name);
    dishes.push({ id: `D${index + 1}`, name, ingredients: sample(picked, perDish, rng).map(([ingredient]) => ingredient) });
  }

  const swaps = {};
  if (outCount) {
    // Pick the out-of-stock bins and their substitutes together. A substitute must be safe for every
    // dietary modifier and must never already sit in a dish with the missing ingredient, so a swap
    // never quietly asks the cook to tap the same bin twice.
    const sharesDish = (a, b) => dishes.some((dish) => dish.ingredients.includes(a) && dish.ingredients.includes(b));
    const order = sample(bins, bins.length, rng);
    for (const strict of allowLooseSwaps ? [true, false] : [true]) {
      for (const bin of order) {
        if (Object.keys(swaps).length === outCount) break;
        const used = new Set([...Object.keys(swaps), ...Object.values(swaps)]);
        if (used.has(bin.name) || !isSafeBin(bin)) continue;
        const targets = bins.filter((candidate) => candidate !== bin && !used.has(candidate.name) && isSafeBin(candidate)
          && (!strict || !sharesDish(bin.name, candidate.name)));
        if (!targets.length) continue;
        bin.out = true;
        swaps[bin.name] = randomItem(targets, rng).name;
      }
    }
    if (Object.keys(swaps).length < outCount) return null;
  }
  // The Health Inspector's garnish is always in stock and safe for every dietary modifier.
  const garnishPool = bins.filter((bin) => !bin.out && isSafeBin(bin));
  const inspectorBin = randomItem(garnishPool.length ? garnishPool : bins.filter((bin) => !bin.out), rng).number;
  return { bins, dishes, swaps, inspectorRule: { bin: inspectorBin, announced: false } };
}

export function resolveRecipe(room, dish, modifier = null) {
  const byName = new Map(room.kitchen.bins.map((bin) => [bin.name, bin]));
  const blocked = RESTRICTED_TAGS[modifier] ?? null;
  const result = [];
  for (const name of dish.ingredients) {
    const original = INGREDIENT_INDEX.get(name);
    if (blocked && original?.tags.includes(blocked)) continue;
    const resolved = room.kitchen.swaps[name] ?? name;
    const resolvedInfo = INGREDIENT_INDEX.get(resolved);
    if (blocked && resolvedInfo?.tags.includes(blocked)) continue;
    if (byName.has(resolved) && !byName.get(resolved).out) result.push(resolved);
  }
  if (modifier?.startsWith("double ")) {
    // The extra scoop goes right after the first one, which is where players naturally tap it.
    const named = modifier.slice(7);
    const ingredient = room.kitchen.swaps[named] ?? named;
    const at = result.indexOf(ingredient);
    if (at !== -1) result.splice(at + 1, 0, ingredient);
  }
  return result;
}

function makeOrder(room, now) {
  const dish = kitchenRandomItem(room, room.kitchen.dishes);
  const options = [null];
  if (room.shift >= 2) {
    for (const modifier of Object.keys(RESTRICTED_TAGS)) if (resolveRecipe(room, dish, modifier).length) options.push(modifier);
    for (const ingredient of [...new Set(dish.ingredients)].sort()) options.push(`double ${ingredient}`);
  }
  const chance = { 1: 0, 2: 0.3, 3: 0.5 }[room.shift];
  const modifier = options.length > 1 && nextKitchenRandom(room) < chance ? kitchenRandomItem(room, options.slice(1)) : null;
  return {
    id: `S${room.shift}-O${room.shiftStats.issued + 1}`,
    table: kitchenRandomInt(room, 1, 7),
    dishId: dish.id,
    dish: dish.name,
    modifier,
    createdAt: now,
    deadline: now + 60_000,
  };
}

function spawnOrder(room, now) {
  room.orders.push(makeOrder(room, now));
  room.shiftStats.issued += 1;
  room.nextOrderAt = now + kitchenRandomInt(room, 20_000, 30_001);
  bump(room);
}

function beginShift(room, shift, now) {
  room.shift = shift;
  room.phase = "reveal";
  room.kitchen = newKitchen(shift);
  room.orders = [];
  room.plates = Object.fromEntries(room.playerOrder.map((id) => [id, []]));
  room.shiftStats = { served: 0, mistakes: 0, walkouts: 0, issued: 0, stars: 0, score: 0 };
  room.shiftSummary = null;
  room.result = null;
  room.revealDeadline = now + 5_000;
  room.shiftDeadline = now + 5_000 + SHIFT_LENGTH_MS;
  room.reportDeadline = null;
  room.nextOrderAt = room.revealDeadline;
  bump(room);
}

function finishShift(room, now) {
  const stats = room.shiftStats;
  const servedRate = stats.served / Math.max(1, stats.issued);
  let stars = stats.score > 0 ? 1 : 0;
  if (stars && servedRate >= 0.6) stars = 2;
  if (stars && servedRate >= 0.85 && stats.walkouts === 0) stars = 3;
  stats.stars = stars;
  room.totalStars += stars;
  room.bestShift = Math.max(room.bestShift, stats.score);
  room.shiftSummary = {
    shift: room.shift, served: stats.served, mistakes: stats.mistakes,
    walkouts: stats.walkouts, issued: stats.issued, score: stats.score, stars,
  };
  room.phase = "report";
  room.reportDeadline = now + 12_000;
  room.orders = [];
  room.result = null;
  bump(room);
}

export function advanceRoom(room, now = Date.now()) {
  let changed = false;
  if (room.phase === "reveal" && now >= room.revealDeadline) {
    room.phase = "shift";
    spawnOrder(room, now);
    bump(room);
    changed = true;
  }
  if (room.phase === "shift") {
    if (now >= room.shiftDeadline) {
      finishShift(room, now);
      return true;
    }
    const remainingOrders = room.orders.filter((order) => order.deadline > now);
    const expiredCount = room.orders.length - remainingOrders.length;
    if (expiredCount) {
      room.orders = remainingOrders;
      room.score -= 50 * expiredCount;
      room.totalWalkouts += expiredCount;
      room.shiftStats.walkouts += expiredCount;
      room.shiftStats.score -= 50 * expiredCount;
      room.result = { text: "A table walked out. −50 points", kind: "walkout", at: now };
      bump(room);
      changed = true;
    }
    if (now >= room.nextOrderAt) {
      if (room.orders.length < 4) spawnOrder(room, now);
      else room.nextOrderAt = now + kitchenRandomInt(room, 20_000, 30_001);
      bump(room);
      changed = true;
    }
  }
  if (room.phase === "report" && now >= room.reportDeadline) {
    if (room.shift < 3) beginShift(room, room.shift + 1, now);
    else { room.phase = "final"; room.reportDeadline = null; bump(room); }
    changed = true;
  }
  return changed;
}

export function transferHostIfNeeded(room, now = Date.now()) {
  const fresh = room.playerOrder.filter((id) => now - room.players[id].lastSeen < 45_000);
  if (fresh.includes(room.hostId)) return false;
  if (!fresh.length) return false;
  fresh.sort((a, b) => room.players[b].lastSeen - room.players[a].lastSeen);
  room.hostId = fresh[0];
  bump(room);
  return true;
}

function removePlayer(room, playerId) {
  if (!room.players[playerId]) return;
  delete room.players[playerId];
  room.playerOrder = room.playerOrder.filter((id) => id !== playerId);
  delete room.plates?.[playerId];
  if (room.hostId === playerId && room.playerOrder.length) room.hostId = room.playerOrder[0];
  bump(room);
}

function dropStalePlayers(room, keepId, now) {
  for (const id of [...room.playerOrder]) {
    if (id !== keepId && now - room.players[id].lastSeen > STALE_PLAYER_MS) removePlayer(room, id);
  }
}

function isCook(role) { return ["cook", "cook_odd", "cook_even"].includes(role); }

export function applyAction(room, playerId, action, data = {}, now = Date.now()) {
  const player = room.players[playerId];
  if (!player) throw new Error("This player is no longer in the kitchen.");
  const role = roleFor(room, playerId);
  const isHost = room.hostId === playerId;
  player.lastSeen = now;
  room.lastActivity = now;

  if (action === "leave") {
    if (!["lobby", "final"].includes(room.phase)) throw new Error("You can leave once the game is over.");
    removePlayer(room, playerId);
    return;
  }
  if (action === "remove") {
    if (!isHost) throw new Error("Only the host can remove players.");
    if (room.phase !== "lobby") throw new Error("Players can only be removed in the lobby.");
    const targetId = room.playerOrder[Number(data.seat)];
    if (!targetId || targetId === playerId || room.players[targetId].nickname !== data.nickname) throw new Error("That player already left.");
    removePlayer(room, targetId);
    return;
  }
  if (action === "start") {
    if (!isHost) throw new Error("Only the host can start the shift.");
    if (room.phase !== "lobby") throw new Error("This kitchen has already started.");
    dropStalePlayers(room, playerId, now);
    if (room.playerOrder.length < MIN_PLAYERS) throw new Error("You need at least 2 players to start.");
    beginShift(room, 1, now);
    return;
  }
  if (action === "next") {
    if (!isHost) throw new Error("Only the host can move to the next screen.");
    if (room.phase !== "report") throw new Error("The shift report is not ready yet.");
    if (room.shift < 3) beginShift(room, room.shift + 1, now);
    else { room.phase = "final"; room.reportDeadline = null; bump(room); }
    return;
  }
  if (action === "play-again") {
    if (!isHost || room.phase !== "final") throw new Error("Only the host can start a rematch.");
    room.score = 0;
    room.totalServed = 0;
    room.totalMistakes = 0;
    room.totalWalkouts = 0;
    room.totalStars = 0;
    room.bestShift = 0;
    dropStalePlayers(room, playerId, now);
    if (room.playerOrder.length < MIN_PLAYERS) throw new Error("You need at least 2 players for a rematch.");
    beginShift(room, 1, now);
    return;
  }
  if (room.phase !== "shift") throw new Error("That action is only available during a shift.");
  if (action === "announce") {
    if (role !== "inspector") throw new Error("Only the Health Inspector can announce the rule.");
    room.kitchen.inspectorRule.announced = true;
    room.result = { text: "The Health Inspector announced a new rule", kind: "info", at: now };
    bump(room);
    return;
  }
  if (["add", "undo", "clear", "serve"].includes(action) && !isCook(role)) {
    throw new Error("Only the Line Cook can handle the food.");
  }
  if (!["add", "undo", "clear", "serve"].includes(action)) throw new Error("That action isn't available here.");
  const plate = room.plates[playerId] ?? (room.plates[playerId] = []);
  if (action === "add") {
    const binNumber = Number(data.bin);
    if (!Number.isInteger(binNumber) || binNumber < 1 || binNumber > 12) throw new Error("Choose a pantry bin from 1 to 12.");
    const bin = room.kitchen.bins[binNumber - 1];
    if (bin.out) throw new Error("That bin is out of stock.");
    if (plate.length >= 10) throw new Error("The plate is full. Clear it or serve it first.");
    plate.push(binNumber);
    bump(room);
    return;
  }
  if (action === "undo") { plate.pop(); bump(room); return; }
  if (action === "clear") { plate.length = 0; bump(room); return; }

  const table = Number(data.table);
  if (!Number.isInteger(table) || table < 1 || table > 6) throw new Error("Choose a table from 1 to 6.");
  if ((role === "cook_odd" && table % 2 === 0) || (role === "cook_even" && table % 2 === 1)) throw new Error("This cook serves the other tables.");
  const made = plate.map((number) => room.kitchen.bins[number - 1].name);
  const matchingOrders = room.orders.filter((order) => order.table === table);
  let accepted = null;
  for (const order of matchingOrders) {
    const dish = room.kitchen.dishes.find((entry) => entry.id === order.dishId);
    const expected = resolveRecipe(room, dish, order.modifier);
    const rule = room.kitchen.inspectorRule;
    // Once announced, every order ends with one extra garnish scoop, even if the dish already uses it.
    if (rule.announced) expected.push(room.kitchen.bins[rule.bin - 1].name);
    const valid = room.shift === 3 ? made.length === expected.length && made.every((name, index) => name === expected[index])
      : made.length === expected.length && made.every((name) => expected.includes(name) && count(made, name) === count(expected, name));
    if (valid) { accepted = order; break; }
  }
  if (!accepted) {
    room.shiftStats.mistakes += 1;
    room.totalMistakes += 1;
    room.shiftDeadline = Math.max(now, room.shiftDeadline - 10_000);
    // Start the next attempt from an empty plate, so leftovers never spoil a correct retry.
    room.plates[playerId] = [];
    room.result = { text: "Wrong dish — plate cleared, −10 sec", kind: "mistake", at: now };
    bump(room);
    return;
  }
  room.orders = room.orders.filter((order) => order.id !== accepted.id);
  const patienceLeft = Math.max(0, accepted.deadline - now);
  const points = 100 + Math.floor(50 * Math.min(1, patienceLeft / 60_000));
  room.score += points;
  room.shiftStats.score += points;
  room.shiftStats.served += 1;
  room.totalServed += 1;
  room.plates[playerId] = [];
  room.result = { text: `Table ${table} served! +${points}`, kind: "success", at: now };
  bump(room);
}

function count(array, target) { return array.reduce((total, item) => total + Number(item === target), 0); }

export function roomView(room, playerId, now = Date.now()) {
  const role = roleFor(room, playerId);
  const me = room.players[playerId];
  if (!me) throw new Error("This player is no longer in the kitchen.");
  const roleMap = room.phase === "lobby" ? {} : rolesFor(room);
  const view = {
    phase: room.phase,
    roomCode: room.code,
    me: { nickname: me.nickname, role: ROLE_NAMES[role] ?? "", roleKey: role, job: ROLE_JOBS[role] ?? "", isHost: playerId === room.hostId },
    players: room.playerOrder.map((id, seat) => ({
      seat,
      nickname: room.players[id].nickname,
      online: now - room.players[id].lastSeen < AWAY_AFTER_MS,
      role: room.phase === "lobby" ? null : ROLE_NAMES[roleMap[id]] ?? "Waiting",
      isYou: id === playerId,
      isHost: id === room.hostId,
    })),
    shift: room.shift,
    score: room.score,
    totalServed: room.totalServed,
    totalMistakes: room.totalMistakes,
    totalWalkouts: room.totalWalkouts,
    totalStars: room.totalStars,
    teamWon: room.phase === "final" && room.totalStars >= 6,
    bestShift: room.bestShift,
    shiftStats: { ...room.shiftStats },
    shiftDeadline: room.shiftDeadline,
    revealDeadline: room.revealDeadline,
    reportDeadline: room.reportDeadline,
    shiftSummary: room.shiftSummary ? { ...room.shiftSummary } : null,
    result: room.result,
    inspectorAnnounced: Boolean(room.kitchen?.inspectorRule?.announced),
    revision: room.revision,
    serverNow: now,
  };
  const seesOrders = role === "tickets" || role === "guide";
  const seesRecipes = ["recipe", "recipe_pantry", "guide"].includes(role);
  const seesPantry = ["pantry", "recipe_pantry", "guide"].includes(role);
  if (room.phase === "shift" && seesOrders) view.orders = room.orders.map((order) => ({ ...order }));
  if (room.phase === "shift" && seesRecipes) {
    view.recipes = room.kitchen.dishes.map((dish) => ({ name: dish.name, ingredients: dish.ingredients.map(itemInfo) }));
  }
  if (room.phase === "shift" && seesPantry) {
    view.pantry = room.kitchen.bins.map(({ number, name, tags, color, out }) => ({ number, name, tags: [...tags], color, out }));
    view.swaps = { ...room.kitchen.swaps };
  }
  if (room.phase === "shift" && isCook(role)) {
    view.cookBins = room.kitchen.bins.map(({ number, color, out }) => ({ number, color, out }));
    view.plate = [...(room.plates[playerId] ?? [])];
  }
  if (room.phase === "shift" && role === "inspector") {
    const rule = room.kitchen.inspectorRule;
    view.inspectorRule = { text: `Finish every order with one extra scoop from bin ${rule.bin}, added last.`, announced: rule.announced, bin: rule.bin };
  }
  return view;
}
