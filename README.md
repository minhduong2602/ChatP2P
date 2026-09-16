# ChatP2P

ChatP2P uses a PartyKit relay for room chat. The app owner signs in with a server-side password; invited guests open a room link and chat without entering a password.

## Configure

Set `VITE_PARTYKIT_HOST` for the web app to your PartyKit host (for example `my-chat.partykit.dev`). Configure these variables on PartyKit only:

- `APP_PASSWORD`: required owner password. The relay refuses all connections when this is missing.
- `APP_URL`: public web app URL, used as the allowed origin for password and invite API requests. For local development, leaving it unset allows localhost and 127.0.0.1.

Use `npx partykit env add APP_PASSWORD` and `npx partykit env add APP_URL` for deployment. Do not expose the password through a `VITE_` variable. Start the local relay with `npm run party:dev` and the web app with `npm run dev`.

## Share a room

The owner starts or joins a room, then uses **Copy Link**, its QR code, or the URL in the browser address bar once the link is ready. The URL contains `room` and a room-specific `invite` token; guests open it to enter the room directly. **New Link** replaces the token and blocks future joins with the old URL. People already connected can keep chatting. Earlier `room&pwd` links still work, but they contain the owner password and grant owner access.

Run `npm run lint`, `npm run build`, and `npx tsx --test tests/invite.test.ts` to verify the implementation.
