# AudioConnector Server Reference Guide

## LiveKit Bridge Integration

This implementation creates a bridge between Genesys AudioConnector and LiveKit conversational AI agents. The integration includes:

- **WebSocket Bridge**: Direct connection between Genesys and Ultravox
- **Conversational AI**: Complete voice agent powered by LiveKit agents
- **Audio Format Conversion**: Automatic conversion between PCMU (from Genesys) and PCM (for LiveKit)

### Purpose
This repository contains a sample implementation for an AudioConnector Server. This is to be used as a guide to help understand some of the basics of setting up an AudioConnector Server. It is not intended for production purposes. Protocol documentation can be found on the [Genesys Developer Portal](https://developer.genesys.cloud/devapps/audiohook/).

### Configuration

Before running the server, you need to configure your LiveKit credentials:

1. Set up a LiveKit server or use LiveKit Cloud
2. Get your API key and secret from the LiveKit dashboard
3. Update the `.env` file with your credentials:
   ```
   LIVEKIT_API_KEY=your_livekit_api_key_here
   LIVEKIT_API_SECRET=your_livekit_api_secret_here
   LIVEKIT_WS_URL=wss://your-livekit-server.com
   ```

### Things to look at to get started

#### LiveKit Bridge Service
The [LiveKitService](./src/services/livekit-service.ts) class handles the WebSocket bridge connection and audio format conversion between Genesys (PCMU) and LiveKit (PCM) formats.

#### The main session object
The [Session](./src/common/session.ts) class contains methods and logic that handle communicating with the AudioConnector Client and bridges to LiveKit.

The [DTMFService](./src/services/dtmf-service.ts) class is responsible for interpreting any DTMF digits received from the AudioConnector Client. A base implementation has been provded as a start, but will need to be adjusted to meet any specific requirements for the AudioConnector Server.

The [SecretService](./src/services/secret-service.ts) class is responsible for looking up the secret from a given API Key used during the initial authentication process. A fake implementation has been provided, and will need to be replaced to lookup secrets with whatever service they are stored in.

### Running the server

#### Requirements
This implementation was written using NodeJS 18.16.0 as a target. If you are using a Node version manager, there is a [nvmrc](./.nvmrc) file that specifies this version.

#### Steps to run the server locally
1) Run `npm install` in the root of the project.
2) Configure your LiveKit credentials in the `.env` file.
3) Run `npm run start` in the root of the project to start the server. The port can be adjusted from within the [environment](./.env) file.

### Bridge Features

The LiveKit bridge includes advanced audio processing:

- **Format Conversion**: Seamless conversion between PCMU (8kHz, µ-law) and PCM16 (16-bit linear)
- **Audio Smoothing**: Reduces clicks and pops during format conversion
- **Noise Gate**: Filters out background noise below configurable thresholds
- **Soft Limiting**: Prevents audio clipping with smooth compression
- **Direct Bridge**: No intermediate processing, just format conversion and forwarding

### Troubleshooting

- Ensure your LiveKit API key and secret are valid
- Check that the LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_WS_URL environment variables are set correctly
- Monitor the console logs for connection status and error messages
- Verify that your network allows WebSocket connections to your LiveKit server
- Make sure your LiveKit server is running and accessible