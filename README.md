# AudioConnector Server Reference Guide

## Ultravox Bridge Integration

This implementation creates a bridge between Genesys AudioConnector and Ultravox conversational AI. The integration includes:

- **WebSocket Bridge**: Direct connection between Genesys and Ultravox
- **Conversational AI**: Complete voice agent powered by Ultravox
- **Audio Format Conversion**: Automatic conversion between PCMU (from Genesys) and PCM (for Ultravox)

### Purpose
This repository contains a sample implementation for an AudioConnector Server. This is to be used as a guide to help understand some of the basics of setting up an AudioConnector Server. It is not intended for production purposes. Protocol documentation can be found on the [Genesys Developer Portal](https://developer.genesys.cloud/devapps/audiohook/).

### Configuration

Before running the server, you need to configure your Ultravox API key:

1. Sign up for an Ultravox account at [https://dashboard.ultravox.ai/](https://dashboard.ultravox.ai/)
2. Get your API key from the dashboard
3. Update the `.env` file with your API key:
   ```
   ULTRAVOX_API_KEY=your_actual_api_key_here
   ```

### Things to look at to get started

#### Ultravox Bridge Service
The [UltravoxService](./src/services/ultravox-service.ts) class handles the WebSocket bridge connection and audio format conversion between Genesys (PCMU) and Ultravox (PCM) formats.

#### The main session object
The [Session](./src/common/session.ts) class contains methods and logic that handle communicating with the AudioConnector Client and bridges to Ultravox.

The [DTMFService](./src/services/dtmf-service.ts) class is responsible for interpreting any DTMF digits received from the AudioConnector Client. A base implementation has been provded as a start, but will need to be adjusted to meet any specific requirements for the AudioConnector Server.

The [SecretService](./src/services/secret-service.ts) class is responsible for looking up the secret from a given API Key used during the initial authentication process. A fake implementation has been provided, and will need to be replaced to lookup secrets with whatever service they are stored in.

### Running the server

#### Requirements
This implementation was written using NodeJS 18.16.0 as a target. If you are using a Node version manager, there is a [nvmrc](./.nvmrc) file that specifies this version.

#### Steps to run the server locally
1) Run `npm install` in the root of the project.
2) Configure your Ultravox API key in the `.env` file.
3) Run `npm run start` in the root of the project to start the server. The port can be adjusted from within the [environment](./.env) file.

### Bridge Features

The Ultravox bridge includes advanced audio processing:

- **Format Conversion**: Seamless conversion between PCMU (8kHz, µ-law) and PCM16 (16-bit linear)
- **Audio Smoothing**: Reduces clicks and pops during format conversion
- **Noise Gate**: Filters out background noise below configurable thresholds
- **Soft Limiting**: Prevents audio clipping with smooth compression
- **Direct Bridge**: No intermediate processing, just format conversion and forwarding

### Troubleshooting

- Ensure your Ultravox API key is valid and has sufficient credits
- Check that the ULTRAVOX_API_KEY environment variable is set correctly
- Monitor the console logs for connection status and error messages
- Verify that your network allows WebSocket connections to api.ultravox.ai