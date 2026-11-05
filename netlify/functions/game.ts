import { getStore } from "@netlify/blobs";
import type { Context } from "@netlify/functions";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROOM_TTL_MS,
  applyAction,
  advanceRoom,
  createRoomState,
  roomView,
  transferHostIfNeeded,
} from "../../src/game-core.mjs";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ";
const MAX_CAS_ATTEMPTS = 16;

function createRoomsStore() {
  // Netlify provides a short-lived Blobs access context for function requests.
  // Build the client while handling each request so a warm function never
  // keeps using the token captured when its module was first loaded.
  return getStore({ name: "kitchen-rush-rooms", consistency: "strong" });
}

class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function cleanNickname(value: unknown) {
  const nickname = typeof value === "string" ? value.trim().slice(0, 18) : "";
  if (!nickname) throw new ApiError("Add a nickname first.");
  return nickname;
}

function cleanPlayerId(value: unknown) {
  const playerId = typeof value === "string" ? value : "";
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(playerId)) throw new ApiError("This player session is invalid. Refresh and try again.");
  return playerId;
}

function cleanCode(value: unknown) {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{4}$/.test(code)) throw new ApiError("Enter a 4-letter room code.");
  return code;
}

function newCode() {
  const crypto = globalThis.crypto;
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((byte) => CODE_CHARS[byte % CODE_CHARS.length]).join("");
}

async function createRoom(nickname: string, playerId: string) {
  const rooms = createRoomsStore();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = newCode();
    const room = createRoomState(code, playerId, nickname);
    const saved = await rooms.setJSON(code, room, { onlyIfNew: true });
    if (saved.modified) return roomView(room, playerId);
  }
  throw new ApiError("Could not open a room. Please try again.", 503);
}

async function withRoom<T>(code: string, operation: (room: any) => T): Promise<T> {
  const rooms = createRoomsStore();
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const entry = await rooms.getWithMetadata(code, { consistency: "strong", type: "json" });
    if (!entry || !entry.data) throw new ApiError("That kitchen has expired or the code is incorrect.", 404);
    const room = entry.data as any;
    if (Date.now() - room.lastActivity > ROOM_TTL_MS) {
      await rooms.delete(code);
      throw new ApiError("That kitchen expired after two hours without activity.", 404);
    }
    const before = JSON.stringify(room);
    const result = operation(room);
    if (JSON.stringify(room) === before) return result;
    if (!entry.etag) throw new ApiError("The kitchen could not be saved. Please try again.", 503);
    const saved = await rooms.setJSON(code, room, { onlyIfMatch: entry.etag });
    if (saved.modified) return result;
  }
  throw new ApiError("The kitchen is busy. Please try that again.", 409);
}

async function joinRoom(code: string, nickname: string, playerId: string) {
  return withRoom(code, (room) => {
    const now = Date.now();
    const existing = room.players[playerId];
    if (existing) {
      existing.nickname = nickname;
      existing.lastSeen = now;
    } else {
      if (room.phase !== "lobby") throw new ApiError("This kitchen has already started.", 409);
      if (room.playerOrder.length >= MAX_PLAYERS) throw new ApiError("This kitchen already has 6 players.", 409);
      room.players[playerId] = { nickname, lastSeen: now };
      room.playerOrder.push(playerId);
    }
    room.lastActivity = now;
    transferHostIfNeeded(room, now);
    room.revision += 1;
    return { playerId, room: roomView(room, playerId, now) };
  });
}

async function getState(code: string, playerId: string) {
  return withRoom(code, (room) => {
    const now = Date.now();
    const player = room.players[playerId];
    if (!player) throw new ApiError("This player is no longer in the kitchen.", 404);
    const before = JSON.stringify(room);
    advanceRoom(room, now);
    if (now - player.lastSeen >= 10_000) {
      player.lastSeen = now;
      room.lastActivity = now;
    }
    transferHostIfNeeded(room, now);
    if (JSON.stringify(room) !== before) room.revision += 1;
    return roomView(room, playerId, now);
  });
}

async function actionRoom(code: string, playerId: string, action: string, data: Record<string, unknown>) {
  return withRoom(code, (room) => {
    const now = Date.now();
    const player = room.players[playerId];
    if (!player) throw new ApiError("This player is no longer in the kitchen.", 404);
    advanceRoom(room, now);
    player.lastSeen = now;
    room.lastActivity = now;
    transferHostIfNeeded(room, now);
    try {
      applyAction(room, playerId, action, data, now);
    } catch (error) {
      if (error instanceof Error) throw new ApiError(error.message, 400);
      throw error;
    }
    // A player who just left has no view any more; tell the phone to go home.
    if (!room.players[playerId]) return { left: true };
    return roomView(room, playerId, now);
  });
}

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") return response({ error: "Use POST for game actions." }, 405);
  try {
    const text = await request.text();
    if (text.length > 64_000) throw new ApiError("Request is too large.", 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(text || "{}"); }
    catch { throw new ApiError("Please try that again with a valid request."); }
    const operation = body.operation;

    if (operation === "create") {
      const nickname = cleanNickname(body.nickname);
      const playerId = cleanPlayerId(body.playerId);
      return response({ playerId, room: await createRoom(nickname, playerId) });
    }
    if (operation === "join") {
      const nickname = cleanNickname(body.nickname);
      const playerId = cleanPlayerId(body.playerId);
      const roomCode = cleanCode(body.roomCode);
      return response(await joinRoom(roomCode, nickname, playerId));
    }
    if (operation === "state") {
      const playerId = cleanPlayerId(body.playerId);
      const roomCode = cleanCode(body.roomCode);
      return response(await getState(roomCode, playerId));
    }
    if (operation === "action") {
      const playerId = cleanPlayerId(body.playerId);
      const roomCode = cleanCode(body.roomCode);
      if (typeof body.action !== "string" || body.action.length > 32) throw new ApiError("That action isn't available here.");
      const data = body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : {};
      return response(await actionRoom(roomCode, playerId, body.action, data));
    }
    throw new ApiError("That game request isn't recognized.", 404);
  } catch (error) {
    if (error instanceof ApiError) return response({ error: error.message }, error.status);
    console.error("Kitchen Rush function error", error);
    return response({ error: "The kitchen had a hiccup. Please try again." }, 500);
  }
};
