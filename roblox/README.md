# THE ZAR Roblox code integration

The website Worker already provides these server-to-server endpoints:

- `GET /api/game/config` — returns saved game settings.
- `POST /api/game/redeem` — validates a code and consumes one use.

Both endpoints require the header `Authorization: Bearer <GAME_API_KEY>`. The key must match the Cloudflare Worker secret named `GAME_API_KEY`. The secret value is never returned by the API.

## Install the redemption template

1. Open `TheZARCodeRedeem.server.lua`.
2. In Roblox Studio, create a **Script** under **ServerScriptService** and paste the file contents.
3. Replace `PASTE_THE_SAME_GAME_API_KEY_HERE` with the exact same secret value configured in Cloudflare. Do not send or commit the value.
4. In Roblox Studio, enable **Allow HTTP Requests** in the experience's security settings.
5. Publish the experience, then test with a code created in the website admin panel.

The script creates a `RemoteFunction` named `ZAR_RedeemCode` in ReplicatedStorage. A client-side interface can invoke it with `ZAR_RedeemCode:InvokeServer(codeText)`, then display the returned `ok`, `message`, and `reward` fields. The LocalScript must never contain the API key.

## Important limits

- This is a server-side code validation template, not a complete access gate or UI.
- A successful response does not automatically grant a game item or permanently authorize the player. Add that reward/access logic to the server script.
- The current template limits repeated requests and permits one successful redemption per player per server session. Persistent per-account claims would need a separate trusted database record.
- Do not mark an order as paid just because a code exists. The website currently has no connected payment processor.
