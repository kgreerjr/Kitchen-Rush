(() => {
  const app = document.getElementById("app");
  const SESSION_KEY = "kitchen-rush-player-v1";
  const ICONS = {
    guide: "🧭", tickets: "🎟️", recipe: "📖", pantry: "🧺", recipe_pantry: "📚", cook: "🍳",
    cook_odd: "🍳", cook_even: "🍳", inspector: "🕵️",
  };
  let page = "home";
  let state = null;
  let session = readSession();
  let pollTimer = null;
  let pollInFlight = false;
  let toastTimer = null;
  let homeError = "";
  let clockTimer = null;
  let clockOffset = 0;
  let seenResultAt = undefined;
  // Taps are sent one at a time, in the order they were made. Sent all at once, they could reach
  // the server out of order on a phone connection and scramble a correct plate.
  let actionChain = Promise.resolve();
  let pendingActions = 0;

  function readSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); }
    catch { return null; }
  }
  function saveSession(next) {
    session = next;
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  }
  function makeId() {
    return globalThis.crypto?.randomUUID?.() || `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }
  async function api(operation, body = {}) {
    const response = await fetch("/.netlify/functions/game", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation, ...body }),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || "Something went wrong. Please try again.");
      error.status = response.status;
      throw error;
    }
    return result;
  }
  function showToast(message, kind = "") {
    let node = document.querySelector(".toast");
    if (!node) {
      node = document.createElement("div");
      node.setAttribute("role", "status");
      document.body.appendChild(node);
    }
    node.className = `toast ${kind}`;
    node.textContent = message;
    void node.offsetWidth;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), kind ? 3000 : 2400);
  }
  // Every phone pops the latest kitchen result (served, wrong dish, walkout) at the top of the
  // screen, so the cook sees it without scrolling. The first state after loading only records it.
  function announceResult() {
    const result = state?.result;
    const at = result?.at ?? null;
    if (seenResultAt === undefined) { seenResultAt = at; return; }
    if (at === seenResultAt) return;
    seenResultAt = at;
    if (result && state.phase === "shift") showToast(result.text, result.kind);
  }
  function acceptState(next) {
    // Never step backwards to an older copy of the kitchen (a slow poll can arrive after a newer reply).
    if (state && next && state.roomCode === next.roomCode && Number(next.revision) < Number(state.revision)) return;
    state = next;
    if (next && Number.isFinite(next.serverNow)) clockOffset = next.serverNow - Date.now();
  }
  function displayHomeError(message) {
    homeError = message;
    const node = document.getElementById("home-error");
    if (node) {
      node.textContent = message;
      node.classList.toggle("show", !!message);
    } else renderHome();
  }
  function openRoom(nextSession, initialState) {
    saveSession(nextSession);
    seenResultAt = undefined;
    acceptState(initialState);
    page = "room";
    homeError = "";
    startPolling();
    render();
  }
  async function restoreSession() {
    if (!session?.roomCode || !session?.playerId) { renderHome(); return; }
    try {
      const result = await api("state", session);
      seenResultAt = undefined;
      acceptState(result);
      page = "room";
      startPolling();
      render();
    } catch (error) {
      saveSession(null);
      state = null;
      page = "home";
      homeError = error.message;
      renderHome();
    }
  }
  async function pollState() {
    if (!session || page !== "room" || pollInFlight || pendingActions) return;
    pollInFlight = true;
    try {
      const incoming = await api("state", session);
      const changed = !state || incoming.revision !== state.revision;
      acceptState(incoming);
      if (changed) render();
    } catch (error) {
      if ([404, 410].includes(error.status)) {
        saveSession(null);
        state = null;
        page = "home";
        homeError = error.message;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        renderHome();
      }
    } finally {
      pollInFlight = false;
    }
  }
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollState, 1500);
  }
  // Show the cook's tap on the plate right away; the server's reply confirms it.
  function showTapNow(action, data) {
    if (!state || state.phase !== "shift" || !Array.isArray(state.plate)) return;
    if (action === "add") {
      const bin = state.cookBins?.[data.bin - 1];
      if (!bin || bin.out || state.plate.length >= 10) return;
      state.plate = [...state.plate, data.bin];
    } else if (action === "undo") state.plate = state.plate.slice(0, -1);
    else if (action === "clear") state.plate = [];
    else return;
    render();
  }
  function sendAction(action, data = {}) {
    if (!session) return Promise.resolve();
    const { roomCode, playerId } = session;
    showTapNow(action, data);
    pendingActions += 1;
    actionChain = actionChain.then(async () => {
      try {
        const updated = await api("action", { roomCode, playerId, action, data });
        if (updated.left) { pendingActions = 0; leaveForHome(); return; }
        // While more taps are still on their way, keep showing the plate as tapped.
        const plate = state?.plate;
        acceptState(updated);
        if (pendingActions > 1 && Array.isArray(plate) && Array.isArray(state?.plate)) state.plate = plate;
      } catch (error) {
        showToast(error.message);
      } finally {
        pendingActions = Math.max(0, pendingActions - 1);
        if (session && page === "room") render();
      }
    });
    return actionChain;
  }
  async function submitEntry(form) {
    const values = new FormData(form);
    const nickname = String(values.get("nickname") || "").trim().slice(0, 18);
    if (!nickname) { displayHomeError("Add a nickname first."); return; }
    const isJoin = form.dataset.form === "join";
    form.querySelectorAll("button").forEach((button) => { button.disabled = true; button.textContent = isJoin ? "Joining…" : "Opening kitchen…"; });
    try {
      const playerId = makeId();
      const response = await api(isJoin ? "join" : "create", {
        playerId, nickname,
        ...(isJoin ? { roomCode: String(values.get("roomCode") || "").trim().toUpperCase() } : {}),
      });
      openRoom({ roomCode: response.room.roomCode, playerId, nickname }, response.room);
    } catch (error) {
      displayHomeError(error.message);
      renderHome();
    }
  }
  async function leaveKitchen() {
    if (session) {
      try { await api("action", { roomCode: session.roomCode, playerId: session.playerId, action: "leave" }); }
      catch { /* the room may already be gone; going home is still right */ }
    }
    leaveForHome();
  }
  function leaveForHome() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    saveSession(null);
    state = null;
    page = "home";
    homeError = "";
    renderHome();
  }
  async function createFreshRoom() {
    try {
      const nickname = session?.nickname || state?.me?.nickname || "Chef";
      const playerId = makeId();
      const response = await api("create", { nickname, playerId });
      openRoom({ roomCode: response.room.roomCode, playerId, nickname }, response.room);
    } catch (error) {
      showToast(error.message);
    }
  }

  function shell(content, topRight = "") {
    return `<div class="app-shell"><div class="page">
      <header class="topbar">
        <a class="brand" href="#home" data-nav="home" aria-label="Kitchen Rush home"><span class="brand-mark">♨</span><span>Kitchen Rush</span></a>
        <nav class="top-links" aria-label="Main navigation">${topRight}</nav>
      </header>${content}</div></div>`;
  }
  function homeLinks() {
    return `<button class="link-button" data-nav="how">How to play</button><span class="link-button" aria-hidden="true">2–6 players</span>`;
  }
  function renderHome() {
    page = "home";
    const content = `<main class="home-grid">
      <section class="hero-copy">
        <div class="eyebrow">A co-op game for loud tables</div>
        <h1>Talk fast.<br><em>Serve right.</em></h1>
        <p class="hero-lede">Nobody can cook alone. Your crew splits up the orders, recipes, and pantry map. Only the Line Cook can touch the food.</p>
        <div class="hero-meta"><span>✦ 2–6 players</span><span>◷ 3 shifts</span><span>↗ Play in any browser</span></div>
        <div class="hero-visual" aria-hidden="true">
          <div class="ticket-sticker">TONIGHT'S SPECIAL<strong>Good communication</strong></div>
          <div class="plate-art"></div>
          <div class="ingredient-float a">🥑</div><div class="ingredient-float b">🌶️</div><div class="ingredient-float c">🥚</div>
        </div>
      </section>
      <section class="entry-card" aria-labelledby="welcome-title">
        <div class="eyebrow">The kitchen is open</div>
        <h2 id="welcome-title">Pull up a chair.</h2>
        <p>Create a kitchen for your crew or join one with a four-letter room code.</p>
        <form class="entry-form" data-form="create">
          <label><span class="field-label">Your nickname</span><input class="text-input" name="nickname" maxlength="18" autocomplete="nickname" placeholder="What should we call you?" required /></label>
          <button class="btn btn-primary btn-block" type="submit">Create kitchen <span aria-hidden="true">→</span></button>
        </form>
        <div class="entry-divider">or join your crew</div>
        <form class="entry-form" data-form="join">
          <label><span class="field-label">Your nickname</span><input class="text-input" name="nickname" maxlength="18" autocomplete="nickname" placeholder="What should we call you?" required /></label>
          <label><span class="field-label">4-letter room code</span><input class="text-input code-input" name="roomCode" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="ABCD" required /></label>
          <button class="btn btn-orange btn-block" type="submit">Join kitchen <span aria-hidden="true">→</span></button>
        </form>
        <div id="home-error" class="error-note ${homeError ? "show" : ""}" role="alert">${esc(homeError)}</div>
      </section>
    </main><div class="footer-note">No accounts. No installs. Just your team and a very busy kitchen.</div>`;
    app.innerHTML = shell(content, homeLinks());
  }
  function renderHow() {
    const roles = [
      ["🎟️", "Tickets", "Read the table, dish, and any dietary request. Keep the orders moving."],
      ["📖", "Recipe Book", "Know what belongs in each dish. Call ingredients out clearly."],
      ["🧺", "Pantry", "Know which numbered bin holds each ingredient and what can replace an out-of-stock item."],
      ["🍳", "Line Cook", "The only player who touches the food. Follow the calls, build a plate, and serve the right table."],
    ];
    const cards = roles.map(([icon, name, text]) => `<article class="role-card"><div class="role-icon">${icon}</div><h3>${name}</h3><p>${text}</p></article>`).join("");
    const content = `<main class="content-card">
      <div class="section-heading"><div><div class="eyebrow">Before the dinner rush</div><h2>How to play</h2><p>Your crew splits the puzzle across phones. Say what you know so the cook can make it.</p></div></div>
      <div class="how-grid">${cards}</div>
      <div class="rule-callout"><strong>The kitchen rule:</strong> only the Line Cook can touch the food. Everyone else reads information aloud. You have three shifts, new recipes every shift, and just three minutes to keep the tables happy. Earn 6 of 9 stars across the game to become Kitchen Champions.</div>
      <p class="muted tiny" style="margin:16px 0 0">With 2 players, one Kitchen Guide holds the tickets, recipes, and pantry map. At 3 players, Recipe Book and Pantry combine. With 5 or 6 players, the Health Inspector adds a surprise rule; with 6, two cooks split odd and even tables.</p>
      <div style="margin-top:22px"><button class="btn btn-primary" data-nav="home">Back to kitchen <span aria-hidden="true">→</span></button></div>
    </main>`;
    app.innerHTML = shell(content, `<button class="link-button" data-nav="home">Home</button>`);
  }
  function renderLobby() {
    const isHost = state.me.isHost;
    const players = state.players.map((player) => {
      const status = player.isHost ? '<span class="host-tag">Host</span>' : `<span class="status-tag ${player.online ? "" : "offline"}">${player.online ? "In kitchen" : "Away"}</span>`;
      const remove = isHost && !player.isYou ? `<button class="remove-btn" data-action="remove" data-seat="${player.seat}" data-nickname="${esc(player.nickname)}" aria-label="Remove ${esc(player.nickname)}">Remove</button>` : "";
      return `<li class="player-row"><span class="player-avatar">${esc((player.nickname || "?").slice(0, 1).toUpperCase())}</span><span class="player-name">${esc(player.nickname)}${player.isYou ? " <span class=\"muted tiny\">(you)</span>" : ""}</span>${status}${remove}</li>`;
    }).join("");
    const away = state.players.filter((player) => !player.online).length;
    const waiting = state.players.length < 2;
    const content = `<main class="lobby-grid">
      <section>
        <div class="room-banner"><div><div class="eyebrow">Your kitchen code</div><div class="room-code">${esc(state.roomCode)}</div></div><button class="copy-btn" data-action="copy">Copy code</button></div>
        <div class="section-heading" style="margin:22px 2px 0"><div><h2 style="font-size:26px;margin:0">The crew <span class="muted">· ${state.players.length}/6</span></h2><p>Share the code so your team can pull in.</p></div></div>
        <ul class="player-list">${players}</ul>
        ${away ? `<p class="away-note">${away === 1 ? "One player is" : `${away} players are`} away. ${isHost ? "Remove anyone who left so they don't get a role." : "Away players can be removed by the host."}</p>` : ""}
        <button class="btn btn-outline leave-btn" data-action="leave">Leave kitchen</button>
      </section>
      <aside class="lobby-aside">
        <section class="content-card"><div class="eyebrow">Ready when you are</div><h3 style="font-size:21px;margin-top:7px">Three shifts. One team.</h3><p class="muted tiny" style="line-height:1.55">Every player gets a different view. Keep your phone nearby and talk through each order.</p>
          <div class="wait-note">${waiting ? `Need ${2 - state.players.length} more player${state.players.length === 1 ? "" : "s"} before service can begin.` : `The kitchen is full enough. ${isHost ? "Start when everyone is ready." : "Waiting for the host to start."}`}</div>
          ${isHost ? `<button class="btn btn-primary btn-block" data-action="start" ${waiting ? "disabled" : ""}>Start the shift <span aria-hidden="true">→</span></button>` : `<div class="muted tiny">The host controls the start button.</div>`}
        </section>
        <section class="content-card"><h3>Quick reminder</h3><p class="muted tiny" style="line-height:1.6;margin:0">Tickets, recipes, and pantry details stay on their own phones. Read your information aloud to help the Line Cook.</p></section>
      </aside>
    </main>`;
    app.innerHTML = shell(content, `<button class="link-button" data-nav="how">How to play</button>`);
  }

  function timeLeft(deadline) { return Math.max(0, Number(deadline || 0) - (Date.now() + clockOffset)); }
  function clockText(ms) {
    const seconds = Math.ceil(Math.max(0, ms) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function gameHeader() {
    const remaining = timeLeft(state.shiftDeadline);
    return `<div class="game-topline"><div class="game-stats"><span class="shift-pill">SHIFT ${state.shift} / 3</span><span class="role-pill">${esc(state.me.role)}</span><span class="score-pill">✦ ${Number(state.score).toLocaleString()}</span><span class="shift-pill" data-countdown-deadline="${state.shiftDeadline || 0}">${clockText(remaining)}</span></div></div>`;
  }
  function teamSidePanel() {
    const team = state.players.map((player) => `<div class="swap-row"><strong>${esc(player.nickname)}</strong>${player.isYou ? " · you" : ""}${player.role ? `<span class="muted"> · ${esc(player.role)}</span>` : ""}</div>`).join("");
    return `<aside class="side-panel"><section class="content-card timer-card"><div><div class="timer-caption">Shift clock</div><div class="timer-value" data-countdown-deadline="${state.shiftDeadline || 0}">${clockText(timeLeft(state.shiftDeadline))}</div></div><div class="timer-ring">◷</div></section><section class="content-card"><h3>Your crew</h3><div class="swap-list">${team}</div></section></aside>`;
  }
  function roleHeading(title, text) { return `<div class="role-heading"><div class="eyebrow">${esc(state.me.role)} · shift ${state.shift}</div><h2>${title}</h2><p>${text}</p></div>`; }
  function orderCard(order) {
    const modifier = order.modifier ? `<span class="modifier-chip">${esc(order.modifier)}</span>` : "";
    return `<article class="order-card"><div class="order-top"><div style="flex:1"><div class="order-dish">${esc(order.dish)}</div>${modifier}</div><div class="table-chip">TABLE<br>${order.table}</div></div><div class="patience-track"><div class="patience-fill" data-patience="${order.deadline}" style="width:${Math.min(100, timeLeft(order.deadline) / 600)}%"></div></div><div class="patience-meta"><span>Patience</span><span data-patience-text="${order.deadline}">${Math.ceil(timeLeft(order.deadline) / 1000)} sec</span></div></article>`;
  }
  function ticketView() {
    const orders = state.orders || [];
    return `<div class="main-panel">${roleHeading("The tickets are in.", "Call the table, dish, and any modifier out loud. Keep the newest orders moving.")}
      ${orders.length ? `<div class="order-list">${orders.map(orderCard).join("")}</div>` : `<div class="empty-orders"><div><span>🧾</span>New ticket coming up. Get ready to call it out.</div></div>`}</div>`;
  }
  function guideView() {
    const orders = state.orders || [];
    return `<div class="main-panel">${roleHeading("Guide the whole kitchen.", "You hold every piece of information. Read tickets, recipes, and bin numbers to your partner, who alone can cook.")}
      <section class="content-card"><div class="section-heading"><div><h3>Open tickets</h3><p>Call out the table, dish, and modifier.</p></div></div>${orders.length ? `<div class="order-list">${orders.map(orderCard).join("")}</div>` : `<div class="empty-orders"><div><span>🧾</span>New ticket coming up.</div></div>`}</section>
      <div class="section-heading" style="margin:20px 0 12px"><div><h3>Recipe book</h3><p>Read the ingredients, then give their bin numbers.</p></div></div><div class="recipe-grid">${recipeCards()}</div>
      <section class="content-card" style="margin-top:15px"><div class="section-heading"><div><h3>Pantry map</h3><p>Call out the numbered bin for each ingredient.</p></div></div>${pantryMarkup()}</section></div>`;
  }
  function ingredientPill(ingredient, index) {
    const tags = ingredient.tags || [];
    const notes = tags.length ? `<small class="tag-note">${tags.map(esc).join(" · ")}</small>` : "";
    return `<span class="ingredient-tag">${index != null && state.shift === 3 ? `${index + 1}. ` : ""}${esc(ingredient.name)}${notes}</span>`;
  }
  function recipeCards() {
    return (state.recipes || []).map((dish) => `<article class="recipe-card"><h3>${esc(dish.name)}</h3><div class="ingredient-list">${dish.ingredients.map((ingredient, index) => ingredientPill(ingredient, index)).join("")}</div>${state.shift === 3 ? `<p class="order-note">Add in this order.</p>` : ""}</article>`).join("");
  }
  function pantryMarkup() {
    const bins = state.pantry || [];
    const swaps = Object.entries(state.swaps || {});
    return `<div class="pantry-grid">${bins.map((bin) => `<div class="pantry-bin ${bin.out ? "out" : ""}"><span class="bin-number" style="background:${esc(bin.color)}">${bin.number}</span><div><div class="bin-name">${esc(bin.name)}</div>${bin.tags.length ? `<div class="bin-tags">${bin.tags.map(esc).join(" · ")}</div>` : ""}</div></div>`).join("")}</div>${swaps.length ? `<div class="swap-list">${swaps.map(([from, to]) => `<div class="swap-row"><strong>${esc(from)}</strong> is out · use <strong>${esc(to)}</strong></div>`).join("")}</div>` : ""}`;
  }
  function recipeView() {
    const combined = ["recipe_pantry", "guide"].includes(state.me.roleKey);
    const title = combined ? "Recipes & pantry map." : "The recipe book is open.";
    const subtitle = combined ? "Read the recipe, then give the cook the bin number for each ingredient." : "Read the ingredient list aloud. From shift three onward, the order matters.";
    return `<div class="main-panel">${roleHeading(title, subtitle)}<div class="recipe-grid">${recipeCards()}</div>${combined ? `<section class="content-card" style="margin-top:15px"><div class="section-heading"><div><h3>Pantry map</h3><p>Tell the cook which numbered bin holds each ingredient.</p></div></div>${pantryMarkup()}</section>` : ""}</div>`;
  }
  function pantryView() {
    return `<div class="main-panel">${roleHeading("The pantry map.", "Call out the bin number, not just the ingredient. Watch for substitutions.")}<section class="content-card">${pantryMarkup()}</section></div>`;
  }
  function cookView() {
    const bins = state.cookBins || [];
    const plate = state.plate || [];
    const canServe = state.me.roleKey === "cook";
    const tableButtons = [1, 2, 3, 4, 5, 6].filter((n) => state.me.roleKey === "cook" || state.me.roleKey === "cook_odd" && n % 2 === 1 || state.me.roleKey === "cook_even" && n % 2 === 0);
    return `<div class="main-panel cook-panel">${roleHeading("Build what you hear.", "You are the only one who can touch the food. Your crew knows the names; your bins only show numbers.")}
      <div class="cook-layout"><section><div class="cook-bins">${bins.map((bin) => `<button class="cook-bin ${bin.out ? "out" : ""}" data-action="add" data-bin="${bin.number}" ${bin.out ? "disabled" : ""} aria-label="${bin.out ? "Out of stock, " : ""}bin ${bin.number}"><span class="bin-number" style="background:${esc(bin.color)}">${bin.number}</span><small>${bin.out ? "Out" : "Tap bin"}</small></button>`).join("")}</div><p class="serve-note bins-note">Each number maps to an ingredient your team is calling out. Bin colors help you keep your bearings; the number is always the guide.</p></section>
      <section class="plate-card"><h3>Your plate <span class="plate-counter">${plate.length} item${plate.length === 1 ? "" : "s"}</span></h3><div class="plate-surface">${plate.length ? plate.map((number) => `<span class="plate-token" style="background:${esc(bins[number - 1]?.color || "#8a968b")}">${number}</span>`).join("") : `<span class="plate-empty">Waiting for the first ingredient</span>`}</div><div class="plate-actions"><button class="btn btn-soft" data-action="undo" ${plate.length ? "" : "disabled"}>Undo</button><button class="btn btn-outline" data-action="clear" ${plate.length ? "" : "disabled"}>Clear</button></div><div class="field-label" style="margin:17px 0 5px">Serve to table</div><div class="table-select">${tableButtons.map((number) => `<button class="table-button" data-action="serve" data-table="${number}" aria-label="Serve table ${number}"><span class="tb-word">Table </span>${number}</button>`).join("")}</div><p class="serve-note">${canServe ? "Choose the table your team called out." : `You serve ${state.me.roleKey === "cook_odd" ? "odd" : "even"} tables only.`}</p></section></div></div>`;
  }
  function inspectorView() {
    const rule = state.inspectorRule;
    return `<div class="main-panel">${roleHeading("A rule of your own.", "This rule is secret until you decide the team is ready to hear it.")}
      <section class="inspector-rule"><div class="rule-icon">📜</div><div class="eyebrow">Secret rule</div><p>${esc(rule?.text || "Finish every order with one extra garnish scoop, added last.")}</p><button class="btn ${rule?.announced ? "btn-soft" : "btn-orange"}" data-action="announce" ${rule?.announced ? "disabled" : ""}>${rule?.announced ? "Rule announced ✓" : "Announce the rule"}</button><div class="inspector-state">${rule?.announced ? "Your team can now follow this rule for every order." : "Read it out loud, then tap announce. It applies to orders served after that."}</div></section></div>`;
  }
  function renderShift() {
    const role = state.me.roleKey;
    let content;
    if (role === "guide") content = guideView();
    else if (role === "tickets") content = ticketView();
    else if (role === "recipe" || role === "recipe_pantry") content = recipeView();
    else if (role === "pantry") content = pantryView();
    else if (role === "inspector") content = inspectorView();
    else content = cookView();
    const body = `<main>${gameHeader()}<div class="shift-layout">${content}${teamSidePanel()}</div></main>`;
    app.innerHTML = shell(body, `<button class="link-button" data-action="copy">Room ${esc(state.roomCode)}</button>`);
  }
  function renderReveal() {
    const role = state.me.roleKey;
    const roleTitle = state.me.role;
    const content = `<main class="reveal-screen"><div class="reveal-card"><div class="eyebrow">Shift ${state.shift} is about to begin</div><div class="reveal-icon">${ICONS[role] || "🍽️"}</div><h1>You're the ${esc(roleTitle)}.</h1><p>${esc(state.me.job)}</p><div class="countdown">First ticket in <strong data-countdown-deadline="${state.revealDeadline || 0}">${Math.ceil(timeLeft(state.revealDeadline) / 1000)}</strong></div></div><div class="footer-note">Keep this screen to yourself. Your teammate's phone may show something different.</div></main>`;
    app.innerHTML = shell(content, `<span class="shift-pill">SHIFT ${state.shift} / 3</span>`);
  }
  function starText(count) { return "★".repeat(Math.max(0, count)) + "☆".repeat(Math.max(0, 3 - count)); }
  function renderReport() {
    const summary = state.shiftSummary || { served: 0, mistakes: 0, walkouts: 0, score: 0, stars: 0 };
    const isLast = state.shift >= 3;
    const content = `<main class="report-screen"><div class="content-card"><div class="eyebrow">${isLast ? "Last shift complete" : `Shift ${state.shift} complete`}</div><h2>${isLast ? "One last look at the board." : "Nice work, kitchen."}</h2><p class="muted">${isLast ? "Your final shift report is in. Then the full score is yours." : "Catch your breath. The next kitchen is getting ready."}</p><div class="stars" aria-label="${summary.stars} stars">${starText(summary.stars)}</div><div class="summary-grid"><div class="summary-stat"><strong>${summary.served}</strong><span>Served</span></div><div class="summary-stat"><strong>${summary.mistakes}</strong><span>Mistakes</span></div><div class="summary-stat"><strong>${summary.walkouts}</strong><span>Walkouts</span></div><div class="summary-stat"><strong>${Number(summary.score).toLocaleString()}</strong><span>Shift score</span></div></div><div class="countdown">${isLast ? "Final score in" : "Next shift in"} <strong data-countdown-deadline="${state.reportDeadline || 0}">${Math.ceil(timeLeft(state.reportDeadline) / 1000)}</strong></div>${state.me.isHost ? `<div style="margin-top:22px"><button class="btn btn-primary" data-action="next">${isLast ? "See final score" : "Next shift"} <span aria-hidden="true">→</span></button></div>` : `<p class="muted tiny" style="margin:19px 0 0">The host can move on now. Otherwise the next screen opens automatically.</p>`}</div></main>`;
    app.innerHTML = shell(content, `<span class="shift-pill">SHIFT ${state.shift} / 3</span>`);
  }
  function renderFinal() {
    const verdict = state.teamWon ? "Kitchen champions!" : "The kitchen will be ready for a rematch.";
    const content = `<main class="final-screen"><div class="content-card"><div class="eyebrow">Kitchen closed</div><h2>${verdict}</h2><p class="muted">Earn 6 of 9 stars across the three shifts to win together.</p><div class="stars" aria-label="${state.totalStars} stars earned">★ <span style="font-family:'DM Sans',sans-serif;font-size:17px;letter-spacing:0;color:#77867c">${state.totalStars} / 9 stars</span></div><div class="final-score">${Number(state.score).toLocaleString()}</div><p class="muted">team points</p><div class="summary-grid"><div class="summary-stat"><strong>${state.totalServed}</strong><span>Dishes served</span></div><div class="summary-stat"><strong>${state.totalMistakes}</strong><span>Mistakes</span></div><div class="summary-stat"><strong>${state.totalWalkouts}</strong><span>Walkouts</span></div><div class="summary-stat"><strong>${Number(state.bestShift).toLocaleString()}</strong><span>Best shift</span></div></div>${state.me.isHost ? `<div class="final-buttons"><button class="btn btn-primary" data-action="play-again">Play again · new kitchen</button><button class="btn btn-outline" data-action="new-room">New room</button></div>` : `<p class="muted tiny">The host can start a fresh kitchen with this crew.</p><button class="btn btn-outline" data-action="leave">Back to home</button>`}</div><div class="footer-note">Every kitchen is a new puzzle. Bring your crew back for another round.</div></main>`;
    app.innerHTML = shell(content, `<span class="shift-pill">FINAL SCORE</span>`);
  }
  function render() {
    if (page === "home") return renderHome();
    if (page === "how") return renderHow();
    if (!state) return renderHome();
    if (state.phase === "lobby") renderLobby();
    else if (state.phase === "reveal") renderReveal();
    else if (state.phase === "shift") { renderShift(); announceResult(); }
    else if (state.phase === "report") renderReport();
    else renderFinal();
  }
  function updateClocks() {
    document.querySelectorAll("[data-countdown-deadline]").forEach((element) => {
      const deadline = Number(element.dataset.countdownDeadline || 0);
      if (element.classList.contains("shift-pill") || element.classList.contains("timer-value")) element.textContent = clockText(timeLeft(deadline));
      else element.textContent = String(Math.ceil(timeLeft(deadline) / 1000));
    });
    document.querySelectorAll("[data-patience]").forEach((element) => {
      const left = timeLeft(element.dataset.patience);
      element.style.width = `${Math.min(100, left / 600)}%`;
      element.style.background = left < 20_000 ? "#c94d43" : left < 35_000 ? "#e8a43a" : "";
    });
    document.querySelectorAll("[data-patience-text]").forEach((element) => {
      element.textContent = `${Math.ceil(timeLeft(element.dataset.patienceText) / 1000)} sec`;
    });
  }
  function renderHomeNavigation(where) {
    if (where === "how") { page = "how"; renderHow(); return; }
    page = "home"; renderHome();
  }

  app.addEventListener("submit", (event) => {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    submitEntry(form);
  });
  app.addEventListener("input", (event) => {
    if (event.target.name === "roomCode") event.target.value = event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  });
  app.addEventListener("click", async (event) => {
    const nav = event.target.closest("[data-nav]");
    if (nav) {
      event.preventDefault();
      renderHomeNavigation(nav.dataset.nav);
      return;
    }
    const control = event.target.closest("[data-action]");
    if (!control) return;
    const action = control.dataset.action;
    if (action === "copy") {
      try { await navigator.clipboard.writeText(state?.roomCode || ""); showToast("Room code copied."); }
      catch { showToast(`Room code: ${state?.roomCode || ""}`); }
      return;
    }
    if (action === "new-room") { await createFreshRoom(); return; }
    if (action === "home") { leaveForHome(); return; }
    if (action === "leave") { await leaveKitchen(); return; }
    if (action === "remove") return sendAction(action, { seat: Number(control.dataset.seat), nickname: control.dataset.nickname });
    if (action === "add") return sendAction(action, { bin: Number(control.dataset.bin) });
    if (action === "serve") return sendAction(action, { table: Number(control.dataset.table) });
    return sendAction(action);
  });

  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(updateClocks, 250);
  if (session) restoreSession(); else renderHome();
})();
