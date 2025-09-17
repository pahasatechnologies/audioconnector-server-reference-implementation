export interface LiveKitConfig {
  apiKey: string;
  apiSecret: string;
  wsUrl: string;
  roomPrefix: string;
  participantName: string;
}

export const getLiveKitConfig = (): LiveKitConfig => {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.LIVEKIT_WS_URL;

  if (!apiKey || !apiSecret || !wsUrl) {
    throw new Error('LiveKit configuration missing. Please set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_WS_URL');
  }

  return {
    apiKey,
    apiSecret,
    wsUrl,
    roomPrefix: process.env.LIVEKIT_ROOM_PREFIX || 'audiohook_',
    participantName: process.env.LIVEKIT_PARTICIPANT_NAME || 'genesys_caller'
  };
};