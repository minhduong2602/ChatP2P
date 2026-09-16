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

## R2 file storage

When `VITE_FILE_API_URL` is configured, files use resumable 8 MiB multipart uploads to R2 instead of base64 WebSocket chunks. The sender chooses a lifetime of 1, 6, 12, or 24 hours. PartyKit creates a server-side room session for file permissions and revokes it when the user leaves. Room members can open **Files** to download active files; uploaders can manage their own files during the current connection and room owners can manage every file in the room.

The separate `/admin/storage` page inventories tracked and orphaned bucket objects. It uses `ADMIN_PASSWORD`, not the room password. Use **Keep** to extend a tracked object only to its hard 24-hour maximum.

### Provision Cloudflare resources

1. Authenticate Wrangler with `npx wrangler login`.
2. Create the buckets: `npx wrangler r2 bucket create chatp2p-files` and `npx wrangler r2 bucket create chatp2p-files-preview`.
3. Create D1 with `npx wrangler d1 create chatp2p-files`, then replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with the returned ID.
4. Run `npm run files:db:migrate`.
5. Add Worker secrets with `npx wrangler secret put FILE_API_SECRET` and `npx wrangler secret put ADMIN_PASSWORD`.
6. Deploy with `npm run files:deploy` and set its URL as `VITE_FILE_API_URL` in Vercel.
7. Add the same Worker URL and shared secret to PartyKit with `npx partykit env add FILE_API_URL` and `npx partykit env add FILE_API_SECRET`, then redeploy PartyKit.

The Worker cron deletes expired objects every ten minutes and aborts uploads left incomplete for three hours. Configure an R2 lifecycle rule that deletes objects after one day as a final cleanup layer; application access still stops exactly at the metadata expiry even if physical cleanup is delayed.
