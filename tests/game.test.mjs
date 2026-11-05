import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAction,
  advanceRoom,
  createRoomState,
  newKitchen,
  resolveRecipe,
  roleFor,
  roomView,
} from "../src/game-core.mjs";

const hostId = "host-player-00001";
const teammateId = "teammate-player-02";

function addSecondPlayer(room, now) {
  room.players[teammateId] = { nickname: "Mina", lastSeen: now };
  room.playerOrder.push(teammateId);
}

function serveFirstOrder(room, now) {
  const roles = room.playerOrder.map((id) => [id, roleFor(room, id)]);
  const cookId = roles.find(([, role]) => role === "cook")?.[0];
  const infoId = roles.find(([, role]) => role === "guide")?.[0];
  assert.ok(cookId, "one player should have the Line Cook role");
  assert.ok(infoId, "the other player should have the Kitchen Guide role");

  const order = room.orders[0];
  assert.ok(order, "the shift should issue a ticket");
  const dish = room.kitchen.dishes.find((entry) => entry.id === order.dishId);
  const expected = resolveRecipe(room, dish, order.modifier);
  const scoreBefore = room.score;
  const binNumbers = expected.map((name) => room.kitchen.bins.find((bin) => bin.name === name).number);
  for (const bin of binNumbers) applyAction(room, cookId, "add", { bin }, now);
  applyAction(room, cookId, "serve", { table: order.table }, now);
  assert.equal(room.shiftStats.served, 1, "the correct plate should score as served");
  assert.ok(room.score - scoreBefore >= 100, "a correct serve should earn points");
  assert.ok(room.score - scoreBefore <= 150, "the speed bonus should stay capped");

  const guideView = roomView(room, infoId, now);
  const cookView = roomView(room, cookId, now);
  assert.ok(guideView.orders?.length >= 0, "the guide should receive ticket data");
  assert.ok(guideView.recipes?.length === 6, "the guide should receive recipes");
  assert.ok(guideView.pantry?.length === 12, "the guide should receive the pantry map");
  assert.ok(cookView.cookBins?.length === 12, "the cook should receive numbered bins");
  assert.equal("recipes" in cookView, false, "the cook view must not include recipe data");
  assert.equal("pantry" in cookView, false, "the cook view must not include ingredient names");
  assert.equal("orders" in cookView, false, "the cook view must not include ticket data");
  assert.equal("hostId" in cookView, false, "the room view must not expose player session tokens");
  assert.ok(cookView.players.every((player) => !("id" in player)), "roster entries must not expose session tokens");
}

test("two players complete all three shifts with private role views and a final team score", () => {
  let now = 1_800_000_000_000;
  const room = createRoomState("ABCD", hostId, "Kenny", now);
  addSecondPlayer(room, now);

  applyAction(room, hostId, "start", {}, now);
  assert.equal(room.phase, "reveal");
  assert.equal(room.shift, 1);

  for (let shift = 1; shift <= 3; shift += 1) {
    now = room.revealDeadline + 1;
    advanceRoom(room, now);
    assert.equal(room.phase, "shift");
    assert.equal(room.shift, shift);
    serveFirstOrder(room, now + 1);

    now = room.shiftDeadline + 1;
    advanceRoom(room, now);
    assert.equal(room.phase, "report");
    assert.equal(room.shiftSummary.served, 1);
    assert.equal(room.shiftSummary.stars, 3);

    if (shift < 3) {
      applyAction(room, hostId, "next", {}, now + 1);
      assert.equal(room.phase, "reveal");
    }
  }

  applyAction(room, hostId, "next", {}, now + 2);
  assert.equal(room.phase, "final");
  assert.equal(room.totalServed, 3);
  assert.equal(room.totalStars, 9);
  assert.ok(room.score >= 300);
  assert.equal(room.totalWalkouts, 0);
  assert.equal(roomView(room, hostId, now + 3).teamWon, true);
});

test("a two-player room cannot start until its teammate joins", () => {
  const now = 1_800_000_000_000;
  const room = createRoomState("WXYZ", hostId, "Kenny", now);
  assert.throws(() => applyAction(room, hostId, "start", {}, now), /at least 2 players/);
  addSecondPlayer(room, now);
  assert.doesNotThrow(() => applyAction(room, hostId, "start", {}, now));
});

test("50 seeded kitchens per shift are reproducible, fully stocked, and solvable", () => {
  const blockedTags = new Set(["dairy", "meat", "nuts"]);
  for (let shift = 1; shift <= 3; shift += 1) {
    for (let seed = 1; seed <= 50; seed += 1) {
      const kitchen = newKitchen(shift, seed);
      assert.deepEqual(newKitchen(shift, seed), kitchen, "the saved seed should reproduce the exact kitchen");
      assert.equal(kitchen.bins.length, 12);
      assert.equal(kitchen.dishes.length, 6);
      assert.equal(kitchen.bins.filter((bin) => bin.out).length, shift - 1);
      assert.equal(Object.keys(kitchen.swaps).length, shift - 1);

      const room = { shift, kitchen };
      const bins = new Map(kitchen.bins.map((bin) => [bin.name, bin]));
      for (const dish of kitchen.dishes) {
        const base = resolveRecipe(room, dish);
        assert.equal(base.length, shift + 2);
        assert.ok(base.every((name) => bins.has(name) && !bins.get(name).out));
        for (const [modifier, blockedTag] of [["no dairy", "dairy"], ["no meat", "meat"], ["nut allergy", "nuts"]]) {
          const result = resolveRecipe(room, dish, modifier);
          if (result.length) {
            assert.ok(result.every((name) => bins.has(name) && !bins.get(name).out));
            assert.ok(result.every((name) => !bins.get(name).tags.includes(blockedTag)));
          }
        }
        assert.equal(new Set(base).size, base.length, "a substitution must never make a dish repeat a bin");
        for (const ingredient of new Set(base)) {
          const doubled = resolveRecipe(room, dish, `double ${ingredient}`);
          const at = base.indexOf(ingredient);
          assert.deepEqual(doubled, [...base.slice(0, at + 1), ingredient, ...base.slice(at + 1)], "the extra scoop sits right after the first");
        }
      }
      for (const [from, to] of Object.entries(kitchen.swaps)) {
        assert.equal(bins.get(from).out, true);
        assert.equal(bins.get(to).out, false);
        assert.ok(bins.get(to).tags.every((tag) => !blockedTags.has(tag)));
      }
    }
  }
});

test("all player counts get distinct roles and roles rotate between shifts", () => {
  for (let count = 2; count <= 6; count += 1) {
    const now = 1_800_000_000_000;
    const room = createRoomState("ABCD", hostId, "Chef", now);
    for (let seat = 1; seat < count; seat += 1) {
      const id = `teammate-${count}-${seat}-0001`;
      room.players[id] = { nickname: `Player ${seat}`, lastSeen: now };
      room.playerOrder.push(id);
    }
    applyAction(room, hostId, "start", {}, now);
    const first = room.playerOrder.map((id) => roleFor(room, id));
    assert.equal(new Set(first).size, count);
    advanceRoom(room, room.revealDeadline + 1);
    advanceRoom(room, room.shiftDeadline + 1);
    applyAction(room, hostId, "next", {}, room.reportDeadline - 1);
    const second = room.playerOrder.map((id) => roleFor(room, id));
    assert.ok(second.every((role, seat) => role !== first[seat]), `${count} player roles should rotate`);
  }
});

test("the Health Inspector garnish is safe, in stock, and always added last once announced", () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    for (let shift = 1; shift <= 3; shift += 1) {
      const kitchen = newKitchen(shift, seed);
      const garnish = kitchen.bins[kitchen.inspectorRule.bin - 1];
      assert.equal(garnish.out, false);
      assert.ok(garnish.tags.every((tag) => !["dairy", "meat", "nuts"].includes(tag)), "the garnish never breaks a dietary request");
    }
  }
  let now = 1_800_000_000_000;
  const room = createRoomState("INSP", hostId, "Host", now);
  for (let seat = 1; seat < 5; seat += 1) {
    const id = `inspector-test-${seat}-0001`;
    room.players[id] = { nickname: `P${seat}`, lastSeen: now };
    room.playerOrder.push(id);
  }
  applyAction(room, hostId, "start", {}, now);
  now = room.revealDeadline + 1;
  advanceRoom(room, now);
  const roles = Object.fromEntries(room.playerOrder.map((id) => [roleFor(room, id), id]));
  applyAction(room, roles.inspector, "announce", {}, now);
  const order = room.orders[0];
  // Make the dish already contain the garnish ingredient: the rule still asks for one extra scoop.
  const garnish = room.kitchen.bins[room.kitchen.inspectorRule.bin - 1].name;
  const dish = room.kitchen.dishes.find((entry) => entry.id === order.dishId);
  if (!dish.ingredients.includes(garnish)) dish.ingredients[0] = garnish;
  order.modifier = null;
  const plate = [...resolveRecipe(room, dish, null), garnish];
  const binOf = (name) => room.kitchen.bins.find((bin) => bin.name === name).number;
  for (const name of resolveRecipe(room, dish, null)) applyAction(room, roles.cook, "add", { bin: binOf(name) }, now);
  applyAction(room, roles.cook, "serve", { table: order.table }, now);
  assert.equal(room.shiftStats.mistakes, 1, "without the garnish the plate is wrong");
  applyAction(room, roles.cook, "clear", {}, now);
  for (const name of plate) applyAction(room, roles.cook, "add", { bin: binOf(name) }, now);
  applyAction(room, roles.cook, "serve", { table: order.table }, now);
  assert.equal(room.shiftStats.served, 1, "recipe plus one garnish scoop at the end is served");
});

test("players who left never get a role", () => {
  const now = 1_800_000_000_000;
  const room = createRoomState("GHST", hostId, "Host", now);
  const ghost = "ghost-player-00001", friend = "friend-player-0001", away = "away-player-000001";
  room.players[ghost] = { nickname: "Ghost", lastSeen: now - 120_000 };
  room.players[friend] = { nickname: "Friend", lastSeen: now };
  room.players[away] = { nickname: "Texting", lastSeen: now - 40_000 };
  room.playerOrder.push(ghost, friend, away);

  const lobby = roomView(room, hostId, now);
  assert.deepEqual(lobby.players.map((player) => player.online), [true, false, true, false], "quiet phones show as Away");
  assert.ok(lobby.players.every((player, seat) => player.seat === seat));
  assert.ok(Number.isFinite(lobby.serverNow));

  assert.throws(() => applyAction(room, friend, "remove", { seat: 1, nickname: "Ghost" }, now), /Only the host/);
  assert.throws(() => applyAction(room, hostId, "remove", { seat: 1, nickname: "Someone else" }, now), /already left/);
  applyAction(room, hostId, "start", {}, now);
  assert.deepEqual(room.playerOrder, [hostId, friend, away], "a player gone 90+ seconds is dropped; a briefly away one stays");
  assert.equal(roleFor(room, ghost), null);
});

test("the host can remove a player, and leaving the lobby hands off the host", () => {
  const now = 1_800_000_000_000;
  const room = createRoomState("LEAV", hostId, "Host", now);
  const a = "player-a-00000001", b = "player-b-00000001";
  room.players[a] = { nickname: "A", lastSeen: now };
  room.players[b] = { nickname: "B", lastSeen: now };
  room.playerOrder.push(a, b);
  applyAction(room, hostId, "remove", { seat: 2, nickname: "B" }, now);
  assert.deepEqual(room.playerOrder, [hostId, a]);
  applyAction(room, hostId, "leave", {}, now);
  assert.deepEqual(room.playerOrder, [a]);
  assert.equal(room.hostId, a, "the next player becomes host");

  room.players[b] = { nickname: "B", lastSeen: now };
  room.playerOrder.push(b);
  applyAction(room, a, "start", {}, now);
  assert.throws(() => applyAction(room, b, "leave", {}, now), /once the game is over/, "nobody can vanish mid-shift and reshuffle roles");
});

test("after a wrong serve the plate is empty, so the correct retry is accepted in every shift", () => {
  let now = 1_800_000_000_000;
  const room = createRoomState("RTRY", hostId, "Kenny", now);
  addSecondPlayer(room, now);
  applyAction(room, hostId, "start", {}, now);
  for (let shift = 1; shift <= 3; shift += 1) {
    now = room.revealDeadline + 1;
    advanceRoom(room, now);
    const cookId = room.playerOrder.find((id) => roleFor(room, id) === "cook");
    const order = room.orders[0];
    const dish = room.kitchen.dishes.find((entry) => entry.id === order.dishId);
    const expected = resolveRecipe(room, dish, order.modifier);
    const binOf = (name) => room.kitchen.bins.find((bin) => bin.name === name && !bin.out).number;
    const wrong = room.kitchen.bins.find((bin) => !bin.out && !expected.includes(bin.name)).number;
    applyAction(room, cookId, "add", { bin: wrong }, now);
    applyAction(room, cookId, "serve", { table: order.table }, now);
    assert.equal(room.shiftStats.mistakes, 1);
    assert.deepEqual(room.plates[cookId], [], "the wrong plate is thrown out");
    for (const name of expected) applyAction(room, cookId, "add", { bin: binOf(name) }, now);
    applyAction(room, cookId, "serve", { table: order.table }, now);
    assert.equal(room.shiftStats.served, 1, `shift ${shift}: the correct retry is served`);
    now = room.shiftDeadline + 1;
    advanceRoom(room, now);
    if (shift < 3) applyAction(room, hostId, "next", {}, now);
  }
});
