# Kitchen-Rush

A real-time co-op party game where 2–6 players join from their phones with a room code and each phone holds only one piece of the kitchen, so nobody can cook alone.

## Components

- **public/** - Mobile-first game screens (HTML, CSS, and JavaScript) for the lobby, every role view, shift reports, and the final score
- **src/game-core.mjs** - Game rules: seeded kitchen generation, role assignment and rotation, role-filtered views, scoring, and shift transitions
- **netlify/functions/game.ts** - Serverless API that stores each room in Netlify Blobs and applies player actions with conditional writes
- **tests/game.test.mjs** - node:test suite covering full games, role privacy, kitchen generation, the Health Inspector rule, lobby management, and retries after mistakes

## About

- Built a real-time multiplayer party game where the server sends each phone only its own role's data (tickets, recipes, pantry map, or the Line Cook's numbered bins), so the team has to talk to finish every order.
- Stored each room in Netlify Blobs and applied every player action through ETag-conditional writes with automatic retries, so simultaneous taps from different phones never overwrite each other.
- Wrote a seeded kitchen generator that builds a new puzzle every shift, with out-of-stock substitutions, dietary requests, and "double" orders, and verified it across 90,000 generated dishes with no unsolvable or ambiguous recipes.
- Fixed a bug where correct plates failed after the first round: a wrong serve left its ingredients on the plate, and taps could reach the server out of order on slow connections. Cleared the plate after mistakes, sent taps in order, and added regression tests.
- Demonstrates serverless design, shared-state concurrency, role-based data filtering, and automated testing with simulated full games for every room size.

## Built With

JavaScript | TypeScript | Node.js | Netlify Functions | Netlify Blobs | HTML | CSS

## Setup

1. Play the live version at https://kitchen-rush.netlify.app with one phone per player (2–6 players).
2. Run the tests with Node.js 22.13 or newer: `npm test`.
3. Deploy your own copy by connecting this repo to a Netlify site. Netlify builds the function and provides Blobs storage automatically, so no API keys or environment variables are needed.
4. For a local multiplayer server, run `npm install`, then `npx netlify dev` from a Netlify CLI session linked to a site.
