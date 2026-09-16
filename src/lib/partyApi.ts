import PartySocket from "partysocket";

export function partyHost(): string {
  const raw = (import.meta.env.VITE_PARTYKIT_HOST as string) || "localhost:1999";
  return raw.replace(/^https?:\/\//, "").replace(/^wss?:\/\//, "").replace(/\/.*$/, "");
}

export function partyProtocol(): "http" | "https" {
  return partyHost().startsWith("localhost") || partyHost().startsWith("127.0.0.1") ? "http" : "https";
}

export async function verifyOwnerPassword(password: string): Promise<boolean> {
  const response = await fetch(`${partyProtocol()}://${partyHost()}/auth/verify`, {
    method: "POST",
    body: password,
    cache: "no-store",
  });
  if (response.status === 401) return false;
  if (!response.ok) throw new Error(`Relay unavailable (${response.status})`);
  return true;
}

export async function requestInvite(roomId: string, password: string, action: "get" | "rotate"): Promise<string> {
  const response = await PartySocket.fetch(
    { host: partyHost(), room: roomId, path: "invite", protocol: partyProtocol() },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, action }),
      cache: "no-store",
    }
  );
  if (!response.ok) throw new Error(`Could not create invite link (${response.status})`);
  const body = await response.json() as { invite?: string };
  if (!body.invite || !/^[a-f0-9]{64}$/.test(body.invite)) throw new Error("Relay returned an invalid invite");
  return body.invite;
}
