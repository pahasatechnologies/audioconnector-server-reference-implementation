export interface LiveKitConfig {
  tokenApiUrl: string;
  wsUrl: string;
  roomPrefix: string;
  participantName: string;
  orgId: string;
  email: string;
}

export const getLiveKitConfig = (): LiveKitConfig => {
  const tokenApiUrl = process.env.LIVEKIT_TOKEN_API_URL;
  const wsUrl = process.env.LIVEKIT_WS_URL;
  const orgId = process.env.LIVEKIT_ORG_ID;
  const email = process.env.LIVEKIT_EMAIL;

  if (!tokenApiUrl || !wsUrl || !orgId || !email) {
    throw new Error('LiveKit configuration missing. Please set LIVEKIT_TOKEN_API_URL, LIVEKIT_WS_URL, LIVEKIT_ORG_ID, and LIVEKIT_EMAIL');
  }

  return {
    tokenApiUrl,
    wsUrl,
    roomPrefix: process.env.LIVEKIT_ROOM_PREFIX || 'audiohook_',
    participantName: process.env.LIVEKIT_PARTICIPANT_NAME || 'genesys_caller',
    orgId,
    email
  };
};